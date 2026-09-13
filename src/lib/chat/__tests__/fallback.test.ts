// THE HONEST FALLBACK.
//
// MEASURED 2026-09-12: every Lane B failure — a calendar question, a prop
// question, and a named matchup whose price the desk was literally holding —
// shipped the same 317-character matchup-shaped constant that named nothing:
//
//   "I don't have a clean live read on that game right now — the numbers I'd
//    need aren't in front of me… Ask me about a different NBA, MLB, or WNBA
//    game…"
//
// These tests pin the two properties that replaced it: the fallback is SHAPED to
// the question, and it NAMES what was missing, with a refresh date when the
// payload carried one.

import { describe, it, expect } from "vitest";
import { collectGaps, describeGaps, buildLaneBFallback } from "../fallback";
import { checkLeak } from "../grounding";

// The real payload shapes, trimmed — captured from the live tool layer on
// 2026-09-12.
const STALE_MODEL = JSON.stringify({
  generatedAt: "2026-09-09T00:38:33.098Z",
  edges: [],
  note: "No games could be joined between the odds feed and the model.",
  dataWarning:
    "DATA WARNING: mlb-model-output.json is 94h old (stale > 6h). Numbers may not reflect the current slate — treat with caution and prefer skipping rather than picking on stale data.",
});
const EMPTY_PROPS_BOARD = JSON.stringify({
  available: false,
  league: "MLB",
  note: "no fresh MLB prop board right now",
});
const STALE_MODEL_PROPS = JSON.stringify({
  available: false,
  league: "MLB",
  note: "no MLB model prop projections for tonight's slate right now",
  generatedAt: "2026-09-09T00:37:37.027Z",
  stale: true,
});
const HEALTHY = JSON.stringify({
  fetchedAt: "2026-09-12T22:43:46.264Z",
  events: [{ homeTeam: "Atlanta Braves", awayTeam: "Philadelphia Phillies" }],
});

describe("collectGaps", () => {
  it("turns a staleness banner into a named feed plus its refresh date", () => {
    const gaps = collectGaps([STALE_MODEL]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.what).toBe("the MLB model");
    expect(gaps[0]!.since).toBe(" since September 8");
  });

  it("turns an available:false note into the tool's own words", () => {
    const gaps = collectGaps([EMPTY_PROPS_BOARD]);
    expect(gaps[0]!.what).toBe("no fresh MLB prop board right now");
  });

  it("dates an available:false payload that carries a generatedAt", () => {
    const gaps = collectGaps([STALE_MODEL_PROPS]);
    expect(gaps[0]!.since).toBe(" since September 8");
  });

  it("reports NOTHING for a healthy payload", () => {
    expect(collectGaps([HEALTHY])).toEqual([]);
  });

  it("skips unparseable payloads instead of throwing", () => {
    expect(collectGaps(["not json", HEALTHY])).toEqual([]);
  });

  it("de-duplicates and caps at three so the reply stays a sentence, not a wall", () => {
    const many = [
      STALE_MODEL,
      STALE_MODEL, // duplicate → one entry
      EMPTY_PROPS_BOARD,
      STALE_MODEL_PROPS,
      JSON.stringify({ available: false, note: "no NBA sharp/soft prop feed right now" }),
    ];
    const gaps = collectGaps(many);
    expect(gaps).toHaveLength(3);
  });

  it("names the odds snapshot and the player-prop feed by their real names", () => {
    const gaps = collectGaps([
      JSON.stringify({
        dataWarning: "DATA WARNING: latest-player-props.json is 94h old (stale > 6h).",
        generatedAt: "2026-09-09T00:36:06.185Z",
      }),
      JSON.stringify({
        dataWarning:
          "DATA WARNING: latest-odds-api-baseball_mlb.json is 9h old (stale > 6h).",
      }),
    ]);
    expect(gaps.map((g) => g.what)).toEqual([
      "the NBA player-prop feed",
      "the MLB odds snapshot",
    ]);
  });
});

describe("describeGaps", () => {
  it("renders one gap plainly", () => {
    expect(describeGaps([{ what: "the MLB model", since: " since September 8" }])).toBe(
      "the MLB model since September 8"
    );
  });
  it("joins several readably", () => {
    const s = describeGaps([
      { what: "the MLB model", since: " since September 8" },
      { what: "no fresh MLB prop board right now", since: "" },
    ]);
    expect(s).toBe("the MLB model since September 8; and no fresh MLB prop board right now");
  });
  it("renders nothing for no gaps", () => {
    expect(describeGaps([])).toBe("");
  });
});

describe("buildLaneBFallback — shaped to the question", () => {
  const gaps = collectGaps([STALE_MODEL, EMPTY_PROPS_BOARD]);

  it("REGRESSION: a SCHEDULE question never gets a matchup-shaped answer", () => {
    const r = buildLaneBFallback({ scope: "schedule", mode: "bets", league: "MLB", gaps });
    expect(r).toContain("today's board");
    expect(r).not.toMatch(/that game/i);
    expect(r).not.toMatch(/a different NBA, MLB, or WNBA game/i);
  });

  it("a SLATE question gets a board-level answer, not 'that game'", () => {
    const r = buildLaneBFallback({ scope: "slate", mode: "bets", league: "MLB", gaps });
    expect(r).toContain("MLB board");
    expect(r).not.toMatch(/that game/i);
    expect(r).toContain("no read means no bet");
  });

  it("a MATCHUP question keeps the doctrine framing", () => {
    const r = buildLaneBFallback({ scope: "matchup", mode: "bets", league: "MLB", gaps });
    expect(r).toContain("no read means no bet");
  });

  it("a STATS turn never uses the bets doctrine", () => {
    const r = buildLaneBFallback({ scope: "slate", mode: "stats", league: "NHL", gaps });
    expect(r).toContain("NHL");
    expect(r).toContain("won't guess");
    expect(r).not.toContain("no bet");
  });

  it("EVERY shape names what was missing, with its date", () => {
    for (const scope of ["matchup", "slate", "schedule"] as const) {
      const r = buildLaneBFallback({ scope, mode: "bets", league: "MLB", gaps });
      expect(r).toContain("What's missing:");
      expect(r).toContain("the MLB model since September 8");
      expect(r).toContain("no fresh MLB prop board right now");
    }
  });

  it("omits the 'what's missing' clause entirely when there is nothing to name", () => {
    const r = buildLaneBFallback({ scope: "matchup", mode: "bets", league: "MLB", gaps: [] });
    expect(r).not.toContain("What's missing");
  });

  it("is GUARD-CLEAN in every shape — a fallback must never re-trip the leak guard", () => {
    for (const scope of ["matchup", "slate", "schedule"] as const) {
      for (const mode of ["bets", "stats"] as const) {
        const r = buildLaneBFallback({ scope, mode, league: "MLB", gaps });
        expect(checkLeak(r).leaked).toBe(false);
      }
    }
  });

  it("never mentions the desk's plumbing, even while naming a stale file", () => {
    const r = buildLaneBFallback({ scope: "slate", mode: "bets", league: "MLB", gaps });
    expect(r.toLowerCase()).not.toContain("tool");
    expect(r.toLowerCase()).not.toContain("loading");
    expect(r.toLowerCase()).not.toContain(".json");
  });
});
