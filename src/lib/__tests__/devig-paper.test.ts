// Unit tests for the de-vig paper book. open/settle/stats are pure given
// (book, entries|finals, now), so we drive them with fixtures — no network.

import { describe, it, expect } from "vitest";
import {
  computeStats,
  openFromEntries,
  settleBets,
  stakeFor,
  writeSnapshot,
  DEVIG_PAPER_CONFIG,
  type DevigPaperBook,
  type DevigPaperBet,
} from "../devig-paper";
import type { ClvProofEntry } from "../clv-proof";
import type { GameFinal } from "../espn-finals";

function emptyBook(): DevigPaperBook {
  return { updatedAt: "", bets: [], ledger: [] };
}

const COMMENCE = "2026-06-10T23:10:00Z";
const PREGAME = new Date("2026-06-10T20:00:00Z").getTime(); // 3h before
const POSTGAME = new Date("2026-06-11T03:00:00Z").getTime(); // after

function entry(over: Partial<ClvProofEntry> = {}): ClvProofEntry {
  return {
    id: "MLB|2026-06-10|astrospirates|away",
    league: "MLB",
    matchup: "Pittsburgh Pirates @ Houston Astros",
    commenceTime: COMMENCE,
    side: "away",
    team: "Pittsburgh Pirates",
    entryAt: "2026-06-10T19:00:00Z",
    entryHoursToGame: 4,
    entrySoftPrice: +130, // soft price we'd take
    entrySoftBook: "betus",
    entrySharpFairProb: 0.5, // de-vigged fair → +130 is +EV
    entrySharpFairAmerican: -100,
    entryEvVsSharp: 0.15, // 0.5 * 2.3 - 1
    wouldBet: true,
    closeAt: "",
    closeSharpFairProb: 0.5,
    closeSharpFairAmerican: -100,
    settled: false,
    clvCents: null,
    beatClose: null,
    evVsClose: null,
    ...over,
  } as ClvProofEntry;
}

const PIRATES_WIN: GameFinal = {
  league: "MLB",
  homeTeam: "Houston Astros",
  awayTeam: "Pittsburgh Pirates",
  homeScore: 2,
  awayScore: 5,
  date: COMMENCE,
};
const PIRATES_LOSE: GameFinal = { ...PIRATES_WIN, homeScore: 6, awayScore: 1 };

describe("stakeFor — quarter-Kelly sizing", () => {
  it("sizes a +EV bet, caps at maxStakePctEquity, floors tiny bets to 0", () => {
    const s = stakeFor(0.5, +130, 10_000);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(DEVIG_PAPER_CONFIG.maxStakePctEquity * 10_000 + 0.01);
    // a no-edge bet → 0 stake
    expect(stakeFor(0.5, -110, 10_000)).toBe(0);
    // tiny equity → below min stake → 0
    expect(stakeFor(0.5, +130, 100)).toBe(0);
  });
});

describe("openFromEntries", () => {
  it("opens a bet for a fresh wouldBet entry on an unstarted game", () => {
    const book = emptyBook();
    const { opened } = openFromEntries(book, [entry()], PREGAME);
    expect(opened).toBe(1);
    expect(book.bets[0].team).toBe("Pittsburgh Pirates");
    expect(book.bets[0].oddsAmerican).toBe(+130);
    expect(book.bets[0].stakeUsd).toBeGreaterThan(0);
    expect(book.bets[0].status).toBe("open");
  });

  it("does not double-book the same entry id", () => {
    const book = emptyBook();
    openFromEntries(book, [entry()], PREGAME);
    const { opened } = openFromEntries(book, [entry()], PREGAME);
    expect(opened).toBe(0);
    expect(book.bets).toHaveLength(1);
  });

  it("skips non-wouldBet entries and below-floor EV", () => {
    const book = emptyBook();
    const r1 = openFromEntries(book, [entry({ id: "x1", wouldBet: false })], PREGAME);
    const r2 = openFromEntries(book, [entry({ id: "x2", entryEvVsSharp: 0.005 })], PREGAME);
    expect(r1.opened).toBe(0);
    expect(r2.opened).toBe(0);
    expect(book.bets).toHaveLength(0);
  });

  it("skips a game that has already started (can't bet it at entry price)", () => {
    const book = emptyBook();
    const { opened, skipped } = openFromEntries(book, [entry()], POSTGAME);
    expect(opened).toBe(0);
    expect(skipped).toBe(1);
  });

  it("ignores out-of-scope leagues", () => {
    const book = emptyBook();
    const { opened } = openFromEntries(book, [entry({ id: "nfl1", league: "NFL" })], PREGAME);
    expect(opened).toBe(0);
  });
});

describe("settleBets — grade against ESPN finals", () => {
  function bookWithOpenBet(): DevigPaperBook {
    const book = emptyBook();
    openFromEntries(book, [entry()], PREGAME);
    return book;
  }

  it("a winning bet pays stake × (decimal − 1)", () => {
    const book = bookWithOpenBet();
    const stake = book.bets[0].stakeUsd;
    const n = settleBets(book, new Map([["MLB", [PIRATES_WIN]]]), POSTGAME);
    expect(n).toBe(1);
    const bet = book.bets[0];
    expect(bet.status).toBe("won");
    expect(bet.pnlUsd).toBeCloseTo(+(stake * (2.3 - 1)).toFixed(2), 1); // +130 → dec 2.3
    expect(bet.finalScore).toContain("Pittsburgh Pirates 5");
  });

  it("a losing bet loses the stake", () => {
    const book = bookWithOpenBet();
    const stake = book.bets[0].stakeUsd;
    settleBets(book, new Map([["MLB", [PIRATES_LOSE]]]), POSTGAME);
    expect(book.bets[0].status).toBe("lost");
    expect(book.bets[0].pnlUsd).toBe(+(-stake).toFixed(2));
  });

  it("does not settle a game that hasn't started yet", () => {
    const book = bookWithOpenBet();
    const n = settleBets(book, new Map([["MLB", [PIRATES_WIN]]]), PREGAME);
    expect(n).toBe(0);
    expect(book.bets[0].status).toBe("open");
  });

  it("leaves a bet open when no matching final is found", () => {
    const book = bookWithOpenBet();
    const n = settleBets(book, new Map([["MLB", []]]), POSTGAME);
    expect(n).toBe(0);
    expect(book.bets[0].status).toBe("open");
  });
});

describe("computeStats", () => {
  it("derives equity, ROI, yield and record from settled bets", () => {
    const book = emptyBook();
    // one win (+100 net on $100), one loss (−$100)
    book.bets.push(
      { id: "a", league: "MLB", matchup: "", team: "A", side: "home", commenceTime: "", entryAt: "", oddsAmerican: +100, book: "x", fairProb: 0.55, evVsSharp: 0.05, stakeUsd: 100, status: "won", finalScore: "", pnlUsd: 100, settledAt: "t" } as DevigPaperBet,
      { id: "b", league: "MLB", matchup: "", team: "B", side: "home", commenceTime: "", entryAt: "", oddsAmerican: -110, book: "x", fairProb: 0.55, evVsSharp: 0.03, stakeUsd: 100, status: "lost", finalScore: "", pnlUsd: -100, settledAt: "t" } as DevigPaperBet,
    );
    const s = computeStats(book);
    expect(s.realizedPnlUsd).toBe(0); // +100 − 100
    expect(s.equityUsd).toBe(DEVIG_PAPER_CONFIG.startingBankrollUsd);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRatePct).toBe(50);
    expect(s.totalStakedUsd).toBe(200);
    expect(s.yieldPct).toBe(0);
  });

  it("counts open-bet stake as exposure, not realized", () => {
    const book = emptyBook();
    openFromEntries(book, [entry()], PREGAME);
    const s = computeStats(book);
    expect(s.openCount).toBe(1);
    expect(s.exposureUsd).toBeGreaterThan(0);
    expect(s.realizedPnlUsd).toBe(0);
    expect(s.cashUsd).toBe(+(s.equityUsd - s.exposureUsd).toFixed(2));
  });
});

describe("writeSnapshot", () => {
  it("appends an equity-curve point", () => {
    const book = emptyBook();
    writeSnapshot(book, "2026-06-10T20:00:00Z");
    expect(book.ledger).toHaveLength(1);
    expect(book.ledger[0].equityUsd).toBe(DEVIG_PAPER_CONFIG.startingBankrollUsd);
  });
});
