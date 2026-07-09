import { describe, it, expect } from "vitest";
import {
  getStandings,
  getTeamEfficiency,
  getPlayerGamelog,
  getPropsBoard,
  buildPropsBoardResult,
  getModelPropBoard,
  projectModelPropBoard,
  getProbablePitchers,
  getMlbTeamStats,
  getParlayBook,
  getDeskRecord,
  buildStatsHandlers,
  STATS_TOOL_NAMES,
  STATS_TOOL_DEFINITIONS,
  BET_SHAPED_STATS_TOOL_NAMES,
  PURE_STATS_TOOL_NAMES,
  readStat,
  staleNote,
  type DeskRecord,
} from "@/lib/agent/tools/stats";
import type { SharpProp, SoftPropQuote } from "@/lib/props-board";
import type { MlbPropPlaysBoard } from "@/lib/mlb-prop-plays";
import type { MlbPropSlateStatus } from "@/lib/mlb-prop-plays-loader";

// These tests run against the REAL committed snapshots in data/processed. They
// assert structure + degradation, not brittle exact numbers (the snapshots
// refresh on cron). Every tool must return an object and never throw.

describe("readStat / staleNote", () => {
  it("degrades to fallback + missing:true on a missing file", () => {
    const r = readStat<{ x: number }>("__does-not-exist__.json", { x: 1 });
    expect(r.missing).toBe(true);
    expect(r.ageMs).toBeNull();
    expect(r.data).toEqual({ x: 1 });
  });

  it("reads a real file with missing:false and a numeric age", () => {
    const r = readStat<{ props?: unknown[] }>("latest-sharp-props-mlb.json", {});
    expect(r.missing).toBe(false);
    expect(typeof r.ageMs).toBe("number");
  });

  it("staleNote returns a DATA ERROR string when missing", () => {
    const note = staleNote("foo.json", null, true);
    expect(note).toMatch(/DATA ERROR: foo\.json is missing/);
  });

  it("staleNote returns a DATA WARNING string when stale", () => {
    const sevenHours = 7 * 60 * 60 * 1000;
    const note = staleNote("foo.json", sevenHours, false);
    expect(note).toMatch(/DATA WARNING: foo\.json is 7\.0h old/);
  });

  it("staleNote returns undefined when fresh", () => {
    expect(staleNote("foo.json", 1000, false)).toBeUndefined();
  });
});

describe("getStandings", () => {
  it("happy path: NBA returns a teams array with the expected shape", () => {
    const r = getStandings("NBA");
    expect(r.available).toBe(true);
    expect(Array.isArray(r.teams)).toBe(true);
    expect(r.teams!.length).toBeGreaterThan(0);
    const t = r.teams![0];
    expect(t).toHaveProperty("team");
    expect(t).toHaveProperty("wins");
    expect(t).toHaveProperty("winPct");
    expect(t).toHaveProperty("conference");
  });

  it("WNBA has no standings file → available:false, no throw", () => {
    const r = getStandings("WNBA");
    expect(r.available).toBe(false);
    expect(r.teams).toBeUndefined();
  });

  it("also reads MLB standings", () => {
    const r = getStandings("MLB");
    expect(r.available).toBe(true);
    expect(r.teams!.length).toBeGreaterThan(0);
  });
});

describe("getTeamEfficiency", () => {
  it("happy path: NBA returns teams sorted by netRtg desc", () => {
    const r = getTeamEfficiency("NBA");
    expect(r.available).toBe(true);
    expect(Array.isArray(r.teams)).toBe(true);
    expect(r.teams!.length).toBeGreaterThan(1);
    expect(r.teams![0]).toHaveProperty("team");
    expect(r.teams![0]).toHaveProperty("netRtg");
    // sorted desc: first netRtg >= last netRtg
    const first = r.teams![0].netRtg ?? -Infinity;
    const last = r.teams![r.teams!.length - 1].netRtg ?? -Infinity;
    expect(first).toBeGreaterThanOrEqual(last);
  });

  it("MLB has no efficiency file → available:false", () => {
    const r = getTeamEfficiency("MLB");
    expect(r.available).toBe(false);
  });
});

describe("getPlayerGamelog", () => {
  // NOTE: these run against the live, cron-refreshed snapshot. To avoid a time
  // bomb tied to a SPECIFIC player (e.g. "Christian Yelich" rolling out of the
  // 14-day window), we derive the target player FROM the current snapshot: read
  // the raw gamelog file, pick whatever player is present, and assert the lookup
  // logic (exact + last-name fallback) resolves THAT player. If the snapshot is
  // empty we assert the degradation path instead. Tests the behavior, not a row.
  function anyMlbGamelogPlayer(): string | null {
    const { data, missing } = readStat<{
      players?: Record<string, { displayName?: string }>;
    }>("player-gamelogs-mlb.json", {});
    if (missing || !data.players) return null;
    const first = Object.values(data.players)[0];
    return first?.displayName ?? null;
  }

  it("exact + last-name lookup resolves a player that IS in the window (or degrades)", () => {
    const name = anyMlbGamelogPlayer();
    if (name === null) {
      // Empty/missing snapshot → must degrade, never throw.
      const r = getPlayerGamelog("MLB", "Anyone");
      expect(r.available).toBe(false);
      return;
    }
    // Exact (case-insensitive) resolves the player.
    const exact = getPlayerGamelog("MLB", name);
    expect(exact.available).toBe(true);
    expect(exact.player).toBe(name);
    expect(Array.isArray(exact.games)).toBe(true);

    // Last-name fallback resolves the same player.
    const lastName = name.trim().split(/\s+/).pop()!;
    const loose = getPlayerGamelog("MLB", lastName);
    expect(loose.available).toBe(true);
    expect(loose.player).toBe(name);
  });

  it("player-not-found path returns available:false + knownPlayerCount (when snapshot present)", () => {
    const r = getPlayerGamelog("MLB", "Zzzz Nonexistent Player");
    expect(r.available).toBe(false);
    // knownPlayerCount is a number regardless; note wording depends on presence.
    expect(typeof r.knownPlayerCount).toBe("number");
    if ((r.knownPlayerCount ?? 0) > 0) {
      expect(r.note).toMatch(/not in the MLB game-log window/);
    }
  });

  it("empty player param → available:false, no throw", () => {
    const r = getPlayerGamelog("MLB", "");
    expect(r.available).toBe(false);
  });

  it("league with no gamelog file (NFL) → available:false", () => {
    const r = getPlayerGamelog("NFL", "Anyone");
    expect(r.available).toBe(false);
  });
});

describe("getPropsBoard (disk shell — degradation only)", () => {
  // The committed feeds are cron snapshots; against the real clock they will
  // usually be past their commence/freshness window, so we assert the shell
  // returns a well-formed object and never throws — the JOIN LOGIC + guards are
  // pinned deterministically below via the pure core with fixtures + injected now.
  it("MLB returns a well-formed object, never throws", () => {
    const r = getPropsBoard("MLB");
    expect(typeof r.available).toBe("boolean");
    if (r.available) {
      expect(typeof r.count).toBe("number");
      expect(Array.isArray(r.playable)).toBe(true);
      expect(Array.isArray(r.topByEv)).toBe(true);
      expect(r.topByEv!.length).toBeLessThanOrEqual(15);
      for (const row of r.playable!) expect(row.playable).toBe(true);
    } else {
      expect(typeof r.note).toBe("string");
    }
  });

  it("NBA has sharp but no soft feed → available:false (correct)", () => {
    const r = getPropsBoard("NBA");
    expect(r.available).toBe(false);
    // Either the missing-soft note or the fresh/commence gate — both are the
    // honest-empty path; NBA can never be available (no soft feed exists).
    expect(typeof r.note).toBe("string");
  });

  it("league with no props feed (NFL) → available:false", () => {
    const r = getPropsBoard("NFL");
    expect(r.available).toBe(false);
    expect(r.note).toMatch(/no sharp\/soft prop feed for NFL/);
  });
});

describe("buildPropsBoardResult (pure core — phantom-join guard + commence filter)", () => {
  // A fixed "now": 2026-07-09T20:00:00Z. Upcoming games are AFTER it.
  const NOW_MS = Date.parse("2026-07-09T20:00:00Z");
  const UPCOMING = "2026-07-09T23:00:00Z"; // after now
  const PAST = "2026-07-09T18:00:00Z"; // before now
  const freshTs = new Date(NOW_MS - 60_000).toISOString(); // 1 min old → fresh

  function sharpProp(commence: string): SharpProp {
    return {
      player: "Aaron Judge",
      units: "HomeRuns",
      line: 0.5,
      overAmerican: -110,
      underAmerican: -110,
      fairOverProb: 0.6, // fair prob well above the soft implied → +EV Over
      cutoffAt: commence,
    };
  }

  function softQuote(commence: string): SoftPropQuote {
    return {
      player: "Aaron Judge",
      market: "batter_home_runs", // → PROP_TYPE_MAP "HomeRuns"
      line: 0.5,
      side: "Over",
      american: +120, // soft price generous vs fair 0.6 → clears playable floor
      book: "fanduel",
      commence,
      gameId: "g1",
      team: "NYY",
      opponent: "BOS",
    };
  }

  type Feed<T> = {
    data: T;
    ageMs: number | null;
    missing: boolean;
    unknownFreshness: boolean;
  };
  function feed<T>(data: T, ageMs: number | null, unknownFreshness = false): Feed<T> {
    return { data, ageMs, missing: false, unknownFreshness };
  }

  it("both feeds fresh + upcoming → available:true with a joined row", () => {
    const r = buildPropsBoardResult(
      "MLB",
      feed({ fetchedAt: freshTs, props: [sharpProp(UPCOMING)] }, 60_000),
      feed({ fetchedAt: freshTs, quotes: [softQuote(UPCOMING)] }, 60_000),
      NOW_MS,
      "latest-sharp-props-mlb.json",
      "latest-soft-props-mlb.json",
    );
    expect(r.available).toBe(true);
    expect(r.count).toBe(1);
    expect(r.topByEv![0].player).toBe("Aaron Judge");
  });

  it("PHANTOM-JOIN GUARD: fresh sharp + STALE soft (past freshness) → available:false, no join", () => {
    const staleAgeMs = 7 * 60 * 60 * 1000; // 7h > STALE_AGE_MS (6h)
    const r = buildPropsBoardResult(
      "MLB",
      feed({ fetchedAt: freshTs, props: [sharpProp(UPCOMING)] }, 60_000),
      // soft: game still "upcoming" by commence, but fetchedAt age is stale →
      // fresh sharp lines must NOT be priced against these old soft prices.
      feed({ fetchedAt: new Date(NOW_MS - staleAgeMs).toISOString(), quotes: [softQuote(UPCOMING)] }, staleAgeMs),
      NOW_MS,
      "latest-sharp-props-mlb.json",
      "latest-soft-props-mlb.json",
    );
    expect(r.available).toBe(false);
    expect(r.count).toBeUndefined();
    expect(r.note).toMatch(/no fresh MLB prop board/);
  });

  it("PHANTOM-JOIN GUARD: fresh sharp + soft whose newest commence already passed → available:false", () => {
    const r = buildPropsBoardResult(
      "MLB",
      feed({ fetchedAt: freshTs, props: [sharpProp(UPCOMING)] }, 60_000),
      // soft fetchedAt looks fresh, but every game in it already started →
      // it's yesterday's slate re-stamped; refuse the join.
      feed({ fetchedAt: freshTs, quotes: [softQuote(PAST)] }, 60_000),
      NOW_MS,
      "latest-sharp-props-mlb.json",
      "latest-soft-props-mlb.json",
    );
    expect(r.available).toBe(false);
    expect(r.note).toMatch(/no fresh MLB prop board/);
  });

  it("COMMENCE FILTER: rows whose game has started are dropped; only upcoming remain", () => {
    const startedSharp = { ...sharpProp(PAST), player: "Started Player" };
    const startedSoft = { ...softQuote(PAST), player: "Started Player" };
    const r = buildPropsBoardResult(
      "MLB",
      feed(
        { fetchedAt: freshTs, props: [sharpProp(UPCOMING), startedSharp] },
        60_000,
      ),
      feed(
        { fetchedAt: freshTs, quotes: [softQuote(UPCOMING), startedSoft] },
        60_000,
      ),
      NOW_MS,
      "latest-sharp-props-mlb.json",
      "latest-soft-props-mlb.json",
    );
    expect(r.available).toBe(true);
    // Only the upcoming game survived; the started one was filtered out.
    expect(r.count).toBe(1);
    for (const row of r.topByEv!) {
      expect(new Date(row.commence).getTime()).toBeGreaterThan(NOW_MS);
    }
    expect(r.topByEv!.some((row) => row.player === "Started Player")).toBe(false);
  });

  it("honest-empty preserved: sharp present + soft empty → available:false (not weakened)", () => {
    const r = buildPropsBoardResult(
      "MLB",
      feed({ fetchedAt: freshTs, props: [sharpProp(UPCOMING)] }, 60_000),
      feed({ fetchedAt: freshTs, quotes: [] }, 60_000),
      NOW_MS,
      "latest-sharp-props-mlb.json",
      "latest-soft-props-mlb.json",
    );
    expect(r.available).toBe(false);
    expect(r.note).toMatch(/no MLB sharp\/soft prop feed/);
  });

  it("unknown-freshness soft (no fetchedAt) is treated as stale → available:false", () => {
    const r = buildPropsBoardResult(
      "MLB",
      feed({ fetchedAt: freshTs, props: [sharpProp(UPCOMING)] }, 60_000),
      feed({ quotes: [softQuote(UPCOMING)] }, null, true),
      NOW_MS,
      "latest-sharp-props-mlb.json",
      "latest-soft-props-mlb.json",
    );
    expect(r.available).toBe(false);
    expect(r.note).toMatch(/no fresh MLB prop board/);
  });
});

describe("getModelPropBoard / projectModelPropBoard", () => {
  // A slate that is honestly "tonight's": odds snapshot fresh + a game still
  // upcoming. The commence/odds gate passes with this; started-slate tests pass
  // the "no upcoming game" variant.
  const FRESH_UPCOMING_SLATE: MlbPropSlateStatus = {
    oddsFresh: true,
    newestCommenceMs: Date.now() + 3 * 60 * 60 * 1000,
    hasUpcomingGame: true,
  };
  // Every game already started (finished/started-slate): fresh odds, but nothing
  // upcoming. This is the exploit's wall-clock condition.
  const STARTED_SLATE: MlbPropSlateStatus = {
    oddsFresh: true,
    newestCommenceMs: Date.now() - 12 * 60 * 60 * 1000,
    hasUpcomingGame: false,
  };

  // A minimal fresh board with an HR group + a hits group, one player each,
  // matching the MlbPropPlaysBoard shape (buildMlbPropPlays' output).
  function boardFixture(): MlbPropPlaysBoard {
    const rung = (threshold: number, label: string, modelProb: number) => ({
      threshold,
      label,
      modelProb,
      marketProb: null,
      edge: null,
      bestPrice: null,
      bestBook: null,
      evPct: null,
      playable: false,
    });
    const ladder = (
      player: string,
      stat: "batter_home_runs" | "batter_hits",
      statLabel: string,
      kind: "batter",
    ) => ({
      player,
      team: "New York Yankees",
      stat,
      statLabel,
      kind,
      mean: 1,
      method: "negative-binomial" as const,
      nGames: 8,
      derived: false,
      lowConfidence: false,
      rungs: [rung(1, "1+", 0.42), rung(2, "2+", 0.12)],
      topEdge: null,
      hasPlayable: false,
    });
    return {
      generatedAt: "2026-05-21T12:00:00Z",
      windowAgeHours: 6,
      stale: false,
      groups: [
        {
          stat: "batter_home_runs",
          label: "Home Runs",
          kind: "batter",
          ladders: [ladder("Aaron Judge", "batter_home_runs", "Home Runs", "batter")],
        },
        {
          stat: "batter_hits",
          label: "Hits",
          kind: "batter",
          ladders: [ladder("Juan Soto", "batter_hits", "Hits", "batter")],
        },
      ],
      modeledStats: ["Home Runs", "Hits"],
      totalPlayers: 2,
    };
  }

  it("projects the projection shape: HR headline + other stats, all model-labeled", () => {
    const r = projectModelPropBoard(boardFixture(), FRESH_UPCOMING_SLATE);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.league).toBe("MLB");
    expect(r.kind).toBe("model_projection"); // unmistakably MODEL, not +EV
    expect(r.generatedAt).toBe("2026-05-21T12:00:00Z");
    expect(r.stale).toBe(false);
    expect(r.totalPlayers).toBe(2);
    // HR ladder surfaced prominently with player/team/stat/threshold/model prob.
    expect(r.homeRuns.length).toBe(1);
    const hr = r.homeRuns[0];
    expect(hr.player).toBe("Aaron Judge");
    expect(hr.team).toBe("New York Yankees");
    expect(hr.stat).toBe("batter_home_runs");
    expect(hr.topRungs[0].threshold).toBe(1);
    expect(hr.topRungs[0].modelProb).toBeCloseTo(0.42, 4);
    // Other stat groups exclude HR and carry their own players.
    expect(r.otherStats.some((g) => g.stat === "batter_home_runs")).toBe(false);
    const hits = r.otherStats.find((g) => g.stat === "batter_hits")!;
    expect(hits.players[0].player).toBe("Juan Soto");
  });

  // A board whose rungs carry a full market overlay — INCLUDING a sharp-confirmed
  // rung — proving that the CHAT projection strips the play fields from EVERY
  // rung, not just the no-sharp ones. This is the reviewers' blocker: pre-fix,
  // the sharp-confirmed rung leaked playable:true/evPct/bestPrice/bestBook to chat.
  function overlaidBoard(): MlbPropPlaysBoard {
    return {
      generatedAt: "2026-05-21T12:00:00Z",
      windowAgeHours: 6,
      stale: false,
      groups: [
        {
          stat: "batter_home_runs",
          label: "Home Runs",
          kind: "batter",
          ladders: [
            {
              player: "Aaron Judge",
              team: "New York Yankees",
              stat: "batter_home_runs",
              statLabel: "Home Runs",
              kind: "batter",
              mean: 0.5,
              method: "negative-binomial" as const,
              nGames: 8,
              derived: false,
              lowConfidence: false,
              rungs: [
                // NO-SHARP rung: soft-only, playable off the model prob alone.
                {
                  threshold: 1,
                  label: "1+",
                  modelProb: 0.363,
                  marketProb: null,
                  edge: null,
                  bestPrice: 200,
                  bestBook: "DraftKings",
                  evPct: 8.87,
                  playable: true,
                },
                // SHARP-CONFIRMED rung: a real de-vigged sharp line mapped here.
                {
                  threshold: 2,
                  label: "2+",
                  modelProb: 0.14,
                  marketProb: 0.1,
                  edge: 0.04,
                  bestPrice: 650,
                  bestBook: "FanDuel",
                  evPct: 12.5,
                  playable: true,
                },
              ],
              topEdge: 0.04,
              hasPlayable: true,
            },
          ],
        },
      ],
      modeledStats: ["Home Runs"],
      totalPlayers: 1,
    };
  }

  it("DISCIPLINE: the chat projection carries NO play/market field on ANY rung (sharp-confirmed included)", () => {
    const r = projectModelPropBoard(overlaidBoard(), FRESH_UPCOMING_SLATE);
    expect(r.available).toBe(true);
    if (!r.available) return;

    // Board-wide quantifier: NOT ONE rung — HR headline or any other stat — may
    // expose a play/market/price/edge field. Re-adding one to the chat view goes
    // red here. (These fields don't exist on ModelPropRung, so we assert via the
    // key set, which is the structural guarantee.)
    const bannedKeys = [
      "playable",
      "evPct",
      "edge",
      "bestPrice",
      "bestBook",
      "marketProb",
      "marketFair",
      "sharpConfirmed",
    ];
    const allRungs = [r.homeRuns[0], ...r.otherStats.flatMap((s) => s.players)]
      .flatMap((p) => p.topRungs);
    expect(allRungs.length).toBeGreaterThan(0);
    for (const rung of allRungs) {
      // The projection headline SURVIVES…
      expect(typeof rung.modelProb).toBe("number");
      expect(typeof rung.threshold).toBe("number");
      // …and no market/play field is present at all.
      for (const k of bannedKeys) {
        expect(rung).not.toHaveProperty(k);
      }
      // Exactly the projection keys, nothing more.
      expect(Object.keys(rung).sort()).toEqual(["label", "modelProb", "threshold"]);
    }
  });

  it("STARTED SLATE: fresh files but every game already commenced → NO play fields + available:false", () => {
    // The finished-game exploit: prop files fresh per the 30h budget, but the
    // whole slate has already started. The chat gate must refuse to present it as
    // tonight's board — regardless of any overlay the board carries.
    const r = projectModelPropBoard(overlaidBoard(), STARTED_SLATE);
    expect(r.available).toBe(false);
    if (r.available) {
      // Belt-and-suspenders: even if a future regression made it available, NO
      // rung may carry a play/market field.
      const allRungs = [r.homeRuns[0], ...r.otherStats.flatMap((s) => s.players)]
        .flatMap((p) => p.topRungs);
      for (const rung of allRungs) {
        expect(rung).not.toHaveProperty("playable");
        expect(rung).not.toHaveProperty("evPct");
        expect(rung).not.toHaveProperty("bestPrice");
      }
      return;
    }
    expect(r.note).toMatch(/no MLB model prop projections/);
  });

  it("STALE ODDS: odds snapshot past budget → available:false even with an upcoming-looking board", () => {
    const staleOdds: MlbPropSlateStatus = {
      oddsFresh: false,
      newestCommenceMs: Date.now() + 3 * 60 * 60 * 1000,
      hasUpcomingGame: true,
    };
    const r = projectModelPropBoard(overlaidBoard(), staleOdds);
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.note).toMatch(/no MLB model prop projections/);
  });

  it("empty board → available:false with an honest note (no data-mechanics narration)", () => {
    const empty: MlbPropPlaysBoard = {
      generatedAt: null,
      windowAgeHours: null,
      stale: false,
      groups: [],
      modeledStats: [],
      totalPlayers: 0,
    };
    const r = projectModelPropBoard(empty, FRESH_UPCOMING_SLATE);
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.note).toMatch(/no MLB model prop projections/);
    // No banned data-mechanics words in the note.
    expect(r.note).not.toMatch(/freshness budget|gamelog|game-log/i);
    expect(r.stale).toBe(false);
  });

  it("stale board (fresh slate) → available:false, provenance preserved, clean note", () => {
    const stale: MlbPropPlaysBoard = {
      generatedAt: "2026-04-01T00:00:00Z",
      windowAgeHours: 999,
      stale: true,
      groups: [],
      modeledStats: [],
      totalPlayers: 0,
    };
    const r = projectModelPropBoard(stale, FRESH_UPCOMING_SLATE);
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.stale).toBe(true);
    expect(r.generatedAt).toBe("2026-04-01T00:00:00Z");
    expect(r.note).toMatch(/no MLB model prop projections/);
    // Clean, in-character note — no mechanics narration.
    expect(r.note).not.toMatch(/freshness budget|gamelog|game-log/i);
  });

  it("getModelPropBoard (disk shell) returns a well-formed result against real snapshots", () => {
    // Runs against committed data/processed — assert SHAPE + fail-soft, not a
    // specific slate (which is cron-tied). Either available with the projection
    // fields, or a clean available:false.
    const r = getModelPropBoard();
    expect(r.league).toBe("MLB");
    if (r.available) {
      expect(r.kind).toBe("model_projection");
      expect(Array.isArray(r.homeRuns)).toBe(true);
      expect(Array.isArray(r.otherStats)).toBe(true);
      expect(typeof r.totalPlayers).toBe("number");
    } else {
      expect(typeof r.note).toBe("string");
    }
  });

  it("is registered + bet-shaped (stripped from stats mode, kept in bets mode)", () => {
    expect(STATS_TOOL_NAMES).toContain("get_model_prop_board");
    expect(BET_SHAPED_STATS_TOOL_NAMES).toContain("get_model_prop_board");
    // Bet-shaped ⇒ NOT in the pure-stats (stats-mode) surface.
    expect(PURE_STATS_TOOL_NAMES).not.toContain("get_model_prop_board");
    // Handler exists and returns a well-formed object.
    const handlers = buildStatsHandlers(null);
    const out = handlers.get_model_prop_board({}) as { league: string; available: boolean };
    expect(out.league).toBe("MLB");
    expect(typeof out.available).toBe("boolean");
  });
});

describe("getProbablePitchers", () => {
  // Off-season / off-day → no games. Assert SHAPE, not a non-empty slate.
  it("returns a well-formed object; when games are present they carry the shape", () => {
    const r = getProbablePitchers();
    if (!r.available) {
      // Degradation path: no probables today. Must not throw, must explain.
      expect(typeof r.note === "string" || typeof r.dataWarning === "string").toBe(true);
      return;
    }
    expect(Array.isArray(r.games)).toBe(true);
    for (const g of r.games!) {
      expect(g).toHaveProperty("homeTeam");
      expect(g).toHaveProperty("awayTeam");
      expect(g.homePitcher).toHaveProperty("name");
      expect(g.awayPitcher).toHaveProperty("name");
    }
  });

  it("any statcast row present is a well-formed object (name join shape)", () => {
    const r = getProbablePitchers();
    const withSc = (r.games ?? []).find(
      (g) => g.homePitcher.statcast || g.awayPitcher.statcast
    );
    if (withSc) {
      const sc = withSc.homePitcher.statcast ?? withSc.awayPitcher.statcast;
      expect(sc).toBeDefined();
      expect(typeof sc).toBe("object");
    }
  });
});

describe("getMlbTeamStats", () => {
  // Derive a real team key from the batting file so we don't hardcode a team
  // that could roll out of the snapshot; degrade cleanly if empty.
  function anyBattingTeam(): string | null {
    const { data, missing } = readStat<{ teams?: Record<string, unknown> }>(
      "mlb-batting.json",
      {}
    );
    if (missing || !data.teams) return null;
    return Object.keys(data.teams)[0] ?? null;
  }

  it("a team present in the snapshot resolves at least one of batting/bullpen/weather", () => {
    const team = anyBattingTeam();
    if (team === null) {
      const r = getMlbTeamStats("Cardinals");
      // Empty snapshot → degrade, never throw.
      expect(typeof r.available).toBe("boolean");
      return;
    }
    const r = getMlbTeamStats(team);
    expect(r.available).toBe(true);
    expect(r.batting || r.bullpen || r.weather).toBeTruthy();
  });

  it("unknown team → available:false, no throw", () => {
    const r = getMlbTeamStats("Nonexistent Fake Team XYZ");
    expect(r.available).toBe(false);
  });

  it("empty team param → available:false", () => {
    const r = getMlbTeamStats("");
    expect(r.available).toBe(false);
  });
});

describe("getParlayBook", () => {
  it("returns a well-formed object; when present carries openParlays + ledger shape", () => {
    const r = getParlayBook();
    // available reflects file presence; either way the shape must be sane.
    if (r.available) {
      expect(Array.isArray(r.openParlays)).toBe(true);
      if (r.latestLedger) {
        expect(r.latestLedger).toHaveProperty("equityUsd");
        expect(r.latestLedger).toHaveProperty("ts");
      }
    } else {
      expect(typeof r.note === "string" || typeof r.dataWarning === "string").toBe(true);
    }
  });
});

describe("getDeskRecord", () => {
  it("null record → available:false with note", () => {
    const r = getDeskRecord(null);
    expect(r.available).toBe(false);
    expect((r as { note: string }).note).toBe("desk record not loaded");
  });

  it("fixture record → available:true and spreads the record", () => {
    const fixture: DeskRecord = {
      byLeague: [
        {
          league: "MLB",
          windowDays: 30,
          total: 40,
          wins: 22,
          losses: 18,
          pushes: 0,
          pnlUnits: 3.5,
          roi: 0.087,
        },
      ],
      overall: {
        total: 40,
        wins: 22,
        losses: 18,
        pnlUnits: 3.5,
        roi: 0.087,
      },
    };
    const r = getDeskRecord(fixture);
    expect(r.available).toBe(true);
    expect((r as { overall: DeskRecord["overall"] }).overall.total).toBe(40);
    expect((r as { byLeague: DeskRecord["byLeague"] }).byLeague[0].league).toBe(
      "MLB"
    );
  });
});

describe("STATS_TOOL_NAMES + STATS_TOOL_DEFINITIONS", () => {
  it("names and definitions are 1:1 and aligned", () => {
    expect(STATS_TOOL_NAMES.length).toBe(9);
    expect(STATS_TOOL_DEFINITIONS.length).toBe(9);
    const defNames = STATS_TOOL_DEFINITIONS.map((d) => d.name).sort();
    expect(defNames).toEqual([...STATS_TOOL_NAMES].sort());
  });

  it("every definition has an object input_schema with properties + required", () => {
    for (const d of STATS_TOOL_DEFINITIONS) {
      expect(d.input_schema.type).toBe("object");
      expect(typeof d.input_schema.properties).toBe("object");
      expect(Array.isArray(d.input_schema.required)).toBe(true);
      expect(d.description.length).toBeGreaterThan(20);
    }
  });

  it("no-param tools declare empty properties + required", () => {
    for (const name of ["get_probable_pitchers", "get_parlay_book", "get_desk_record", "get_model_prop_board"]) {
      const d = STATS_TOOL_DEFINITIONS.find((x) => x.name === name)!;
      expect(Object.keys(d.input_schema.properties)).toEqual([]);
      expect(d.input_schema.required).toEqual([]);
    }
  });
});

describe("buildStatsHandlers", () => {
  it("maps every tool name to a callable handler", () => {
    const handlers = buildStatsHandlers(null);
    for (const name of STATS_TOOL_NAMES) {
      expect(typeof handlers[name]).toBe("function");
    }
  });

  it("get_standings handler routes input.league through", () => {
    const handlers = buildStatsHandlers(null);
    const out = handlers.get_standings({ league: "NBA" }) as {
      available: boolean;
    };
    expect(out.available).toBe(true);
  });

  it("get_desk_record handler ignores input and uses injected record", () => {
    const fixture: DeskRecord = {
      byLeague: [],
      overall: { total: 0, wins: 0, losses: 0, pnlUnits: 0, roi: null },
    };
    const handlers = buildStatsHandlers(fixture);
    const out = handlers.get_desk_record({ anything: true }) as {
      available: boolean;
    };
    expect(out.available).toBe(true);

    const nullHandlers = buildStatsHandlers(null);
    const out2 = nullHandlers.get_desk_record({}) as { available: boolean };
    expect(out2.available).toBe(false);
  });

  it("get_mlb_team_stats + get_player_gamelog handlers route their params (return an object)", () => {
    const handlers = buildStatsHandlers(null);
    // These assert the handler DISPATCHES the input through to the tool and
    // returns a well-formed object — not that a specific live row exists (which
    // would be a cron-tied time bomb). Availability depends on the snapshot.
    const teamOut = handlers.get_mlb_team_stats({ team: "Cardinals" }) as {
      available: boolean;
    };
    expect(typeof teamOut.available).toBe("boolean");
    const glOut = handlers.get_player_gamelog({
      league: "MLB",
      player: "Christian Yelich",
    }) as { available: boolean };
    expect(typeof glOut.available).toBe("boolean");
  });
});
