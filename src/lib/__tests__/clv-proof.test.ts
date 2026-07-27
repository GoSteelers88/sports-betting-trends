// Unit tests for the CLV-proof harness. The tick/settle logic is pure given
// (boards, store, now), so we drive it with synthetic boards across time.

import { describe, it, expect } from "vitest";
import {
  tick,
  settleEntry,
  report,
  type ClvProofEntry,
} from "../clv-proof";
import type { FairValueBoard, EvGame } from "../fair-value";
import { probToAmerican, americanToImpliedProb } from "../devig";

// Build a one-game board with a chosen best-soft price and sharp fair prob for
// the away side. (home is the mirror; we only assert on away.)
function board(opts: {
  commence: string;
  awaySoft: number;
  awayFairProb: number;
  suspicious?: boolean;
}): FairValueBoard {
  const awayFairAmerican = probToAmerican(opts.awayFairProb);
  const game: EvGame = {
    league: "MLB",
    commence_time: opts.commence,
    matchup: "Pittsburgh Pirates @ Houston Astros",
    home_team: "Houston Astros",
    away_team: "Pittsburgh Pirates",
    overround: 0.04,
    method: "multiplicative",
    sides: [
      {
        side: "home",
        team: "Houston Astros",
        fairProb: 1 - opts.awayFairProb,
        fairAmerican: probToAmerican(1 - opts.awayFairProb),
        sharpAmerican: -120,
        bestSoft: { book: "fanduel", american: -120, impliedProb: americanToImpliedProb(-120) },
        evPct: -0.05,
        clvCents: -5,
        clvProbPoints: -1.1,
        kelly: 0,
        suspicious: false,
      },
      {
        side: "away",
        team: "Pittsburgh Pirates",
        fairProb: opts.awayFairProb,
        fairAmerican: awayFairAmerican,
        sharpAmerican: +120,
        bestSoft: { book: "betus", american: opts.awaySoft, impliedProb: americanToImpliedProb(opts.awaySoft) },
        evPct: opts.awayFairProb * (1 + (opts.awaySoft > 0 ? opts.awaySoft / 100 : 100 / -opts.awaySoft)) - 1,
        clvCents: 0,
        clvProbPoints: 0,
        kelly: 0,
        suspicious: opts.suspicious ?? false,
      },
    ],
  };
  return {
    league: "MLB",
    sharpFetchedAt: null,
    softFetchedAt: null,
    gamesMatched: 1,
    sharpGames: 1,
    softGames: 1,
    unmatched: [],
    games: [game],
  };
}

const COMMENCE = "2026-06-05T00:10:00Z";
const T_MINUS_5H = new Date("2026-06-04T19:10:00Z").getTime();
const T_MINUS_1H = new Date("2026-06-04T23:10:00Z").getTime();
const T_PLUS_3H = new Date("2026-06-05T03:10:00Z").getTime();

describe("tick — entry / close / settle lifecycle", () => {
  it("locks an entry once and refreshes the close as the line moves", () => {
    const store = { updatedAt: "", entries: [] as ClvProofEntry[] };

    // ENTRY @ T-5h: away fair 45%, best soft +130.
    tick([{ league: "MLB", board: board({ commence: COMMENCE, awaySoft: +130, awayFairProb: 0.45 }) }], store, T_MINUS_5H);
    expect(store.entries.length).toBe(2); // home + away
    const away0 = store.entries.find((e) => e.side === "away")!;
    expect(away0.entrySoftPrice).toBe(+130);
    expect(away0.entrySoftBook).toBe("betus");
    expect(away0.settled).toBe(false);

    // CLOSE refresh @ T-1h: the sharp line moved TOWARD the away side (now 50%
    // fair) — but the entry price stays locked at +130.
    tick([{ league: "MLB", board: board({ commence: COMMENCE, awaySoft: +118, awayFairProb: 0.5 }) }], store, T_MINUS_1H);
    expect(store.entries.length).toBe(2); // no new entries
    const away1 = store.entries.find((e) => e.side === "away")!;
    expect(away1.entrySoftPrice).toBe(+130); // locked
    expect(away1.closeSharpFairProb).toBeCloseTo(0.5, 5); // close moved
    expect(away1.settled).toBe(false);

    // SETTLE @ T+3h: game started. Entry +130 vs a 50% close → beat the close.
    tick([{ league: "MLB", board: board({ commence: COMMENCE, awaySoft: +118, awayFairProb: 0.5 }) }], store, T_PLUS_3H);
    const away2 = store.entries.find((e) => e.side === "away")!;
    expect(away2.settled).toBe(true);
    expect(away2.beatClose).toBe(true); // +130 implies ~43.5% < 50% close
    expect(away2.clvCents!).toBeGreaterThan(0);
    expect(away2.evVsClose!).toBeGreaterThan(0); // 0.5 * 2.3 - 1 = +0.15
  });

  it("wouldBet honours the 2% playable floor (logs all, flags only ≥2%)", () => {
    // away fair 50%. +102 ≈ +1% EV → logged but NOT a play; +110 ≈ +5% → a play.
    const sub = { updatedAt: "", entries: [] as ClvProofEntry[] };
    tick([{ league: "MLB", board: board({ commence: COMMENCE, awaySoft: +102, awayFairProb: 0.5 }) }], sub, T_MINUS_5H);
    expect(sub.entries.find((e) => e.side === "away")!.wouldBet).toBe(false);

    const sup = { updatedAt: "", entries: [] as ClvProofEntry[] };
    tick([{ league: "MLB", board: board({ commence: COMMENCE, awaySoft: +110, awayFairProb: 0.5 }) }], sup, T_MINUS_5H);
    expect(sup.entries.find((e) => e.side === "away")!.wouldBet).toBe(true);
  });

  it("does not create an entry outside the betting window (too far out)", () => {
    const store = { updatedAt: "", entries: [] as ClvProofEntry[] };
    const tooEarly = new Date("2026-06-03T00:10:00Z").getTime(); // ~48h out
    tick([{ league: "MLB", board: board({ commence: COMMENCE, awaySoft: +130, awayFairProb: 0.45 }) }], store, tooEarly);
    expect(store.entries.length).toBe(0);
  });

  it("skips suspicious sides (quarantined artifacts never enter the proof)", () => {
    const store = { updatedAt: "", entries: [] as ClvProofEntry[] };
    const s = tick(
      [{ league: "MLB", board: board({ commence: COMMENCE, awaySoft: +400, awayFairProb: 0.45, suspicious: true }) }],
      store,
      T_MINUS_5H,
    );
    expect(s.skippedSuspicious).toBeGreaterThan(0);
    expect(store.entries.find((e) => e.side === "away")).toBeUndefined();
  });
});

describe("settleEntry — beat-close math", () => {
  it("a price worse than the close does NOT beat it", () => {
    const e = {
      entrySoftPrice: -130, // implies ~56.5%
      closeSharpFairProb: 0.5, // close says 50%
      closeSharpFairAmerican: probToAmerican(0.5),
      settled: false,
    } as ClvProofEntry;
    settleEntry(e);
    expect(e.beatClose).toBe(false); // 56.5% > 50%
    expect(e.clvCents!).toBeLessThan(0);
    expect(e.evVsClose!).toBeLessThan(0);
  });
});

describe("report — aggregation", () => {
  it("computes beat-close rate and averages over settled entries", () => {
    const mk = (beat: boolean, would: boolean): ClvProofEntry =>
      ({
        id: Math.random().toString(),
        league: "MLB",
        settled: true,
        wouldBet: would,
        beatClose: beat,
        clvCents: beat ? 5 : -5,
        clvProbPoints: beat ? 1.1 : -1.1,
        evVsClose: beat ? 0.03 : -0.03,
      }) as ClvProofEntry;
    const store = {
      updatedAt: "",
      entries: [mk(true, true), mk(true, false), mk(false, true), mk(false, false)],
    };
    const r = report(store);
    expect(r.settled).toBe(4);
    expect(r.byScope.all_settled.n).toBe(4);
    expect(r.byScope.all_settled.beatCloseRate).toBe(0.5);
    expect(r.byScope.would_bet_only.n).toBe(2);
    expect(r.byScope.would_bet_only.beatCloseRate).toBe(0.5);
  });
});
