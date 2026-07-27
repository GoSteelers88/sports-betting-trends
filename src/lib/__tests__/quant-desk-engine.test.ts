import { describe, it, expect } from "vitest";
import {
  scan,
  isPlayable,
  rejectReason,
  stakeFor,
  drawdownBreached,
  computeStats,
  openFromOpportunities,
  refreshCloses,
  settleBet,
  finalizeClv,
  betId,
  QUANT_DESK_CONFIG,
} from "../quant-desk/engine";
import { emptyBook, type FairValue, type MarketLine, type QuantBook, type QuantBet } from "../quant-desk/types";

const game = { gameId: "g1", matchup: "Away @ Home", commenceTime: "2099-01-01T00:00:00Z" };

function fv(key: string, prob: number, estimate = false): FairValue {
  return { key, market: "moneyline", selection: key, modelFairProb: prob, estimate, basis: "test" };
}
function ml(key: string, devig: number, price: number): MarketLine {
  return { key, devigMarketProb: devig, priceAmerican: price, book: "soft", sharpFavorsThis: devig > 0.5 };
}

describe("scan", () => {
  it("joins fairs to lines by key and computes edge", () => {
    const opps = scan("MLB", game, [fv("a", 0.6)], [ml("a", 0.55, -120)]);
    expect(opps).toHaveLength(1);
    expect(opps[0].edge).toBeCloseTo(0.05, 5);
  });

  it("drops a fair with no matching line", () => {
    const opps = scan("MLB", game, [fv("a", 0.6), fv("b", 0.5)], [ml("a", 0.55, -120)]);
    expect(opps).toHaveLength(1);
    expect(opps[0].fair.key).toBe("a");
  });

  it("skips non-finite probabilities", () => {
    const opps = scan("MLB", game, [fv("a", NaN)], [ml("a", 0.55, -120)]);
    expect(opps).toHaveLength(0);
  });
});

describe("playability gates", () => {
  it("plays an edge >= floor on the sharp-favored side", () => {
    const [opp] = scan("MLB", game, [fv("a", 0.62)], [ml("a", 0.55, -120)]);
    expect(isPlayable(opp)).toBe(true);
    expect(rejectReason(opp)).toBeNull();
  });

  it("rejects an edge below floor", () => {
    const [opp] = scan("MLB", game, [fv("a", 0.56)], [ml("a", 0.55, -120)]);
    expect(isPlayable(opp)).toBe(false);
    expect(rejectReason(opp)).toMatch(/< floor/);
  });

  it("rejects a too-good-to-be-true edge above the ceiling (artifact)", () => {
    const [opp] = scan("MLB", game, [fv("a", 0.95)], [ml("a", 0.60, -120)]);
    expect(isPlayable(opp)).toBe(false);
    expect(rejectReason(opp)).toMatch(/ceiling/);
  });

  it("rejects fading the sharp (model likes a side the sharp makes a dog)", () => {
    // model 0.55 on a side the sharp de-vigs to 0.45 (sharp favors the OTHER side)
    const [opp] = scan("MLB", game, [fv("a", 0.55)], [ml("a", 0.45, 130)]);
    expect(opp.edge).toBeCloseTo(0.10, 5);
    expect(isPlayable(opp)).toBe(false);
    expect(rejectReason(opp)).toMatch(/disagrees with sharp direction/);
  });
});

describe("sizing", () => {
  it("returns 0 when there is no edge", () => {
    // fair 0.50 at -110 → negative Kelly → no bet
    expect(stakeFor(0.5, -110, 10_000)).toBe(0);
  });

  it("caps the stake at the per-bet equity cap", () => {
    // a huge edge would want > 2% of equity; the cap holds it to exactly 2%.
    const stake = stakeFor(0.9, 100, 10_000);
    expect(stake).toBeLessThanOrEqual(QUANT_DESK_CONFIG.maxStakePctEquity * 10_000 + 0.01);
  });

  it("floors out sub-minimum stakes to 0", () => {
    // tiny edge on a small book → below $10 min
    expect(stakeFor(0.51, -110, 100)).toBe(0);
  });
});

describe("drawdown rail", () => {
  it("does not trip above the floor", () => {
    const stats = computeStats(makeBook(0)); // even
    expect(drawdownBreached(stats)).toBe(false);
  });

  it("trips when equity is >= 20% below start", () => {
    const stats = computeStats(makeBook(-2500)); // -25%
    expect(drawdownBreached(stats)).toBe(true);
  });

  it("openFromOpportunities pauses all opens when the rail is active", () => {
    const book = makeBook(-3000); // -30% → rail active
    const [opp] = scan("MLB", game, [fv("a", 0.62)], [ml("a", 0.55, -120)]);
    const res = openFromOpportunities(book, [opp], Date.parse("2098-01-01T00:00:00Z"));
    expect(res.railActive).toBe(true);
    expect(res.opened).toBe(0);
  });
});

describe("open + idempotency", () => {
  it("opens a playable, future, well-sized bet exactly once", () => {
    const book = emptyBook();
    const [opp] = scan("MLB", game, [fv("a", 0.62)], [ml("a", 0.55, -120)]);
    const now = Date.parse("2098-01-01T00:00:00Z");
    const first = openFromOpportunities(book, [opp], now);
    expect(first.opened).toBe(1);
    expect(book.bets).toHaveLength(1);
    // re-running with the same opportunity is a no-op (idempotent by id)
    const second = openFromOpportunities(book, [opp], now);
    expect(second.opened).toBe(0);
    expect(second.skippedHeld).toBe(1);
    expect(book.bets).toHaveLength(1);
  });

  it("will not open a game that has already started", () => {
    const book = emptyBook();
    const past = { ...game, commenceTime: "2000-01-01T00:00:00Z" };
    const [opp] = scan("MLB", past, [fv("a", 0.62)], [ml("a", 0.55, -120)]);
    const res = openFromOpportunities(book, [opp], Date.now());
    expect(res.opened).toBe(0);
    expect(res.skippedStarted).toBe(1);
  });
});

describe("CLV", () => {
  it("finalizeClv flags beating the close when entry implies a lower prob than the close fair", () => {
    const bet = baseBet({ priceAmerican: 150, closeDevigMarketProb: 0.5, closeFairAmerican: 100 });
    finalizeClv(bet);
    // entry +150 implies 0.40 < 0.50 close fair → beat the close; clv = 150 − 100 = +50
    expect(bet.beatClose).toBe(true);
    expect(bet.clvCents).toBe(50);
  });

  it("flags NOT beating the close on a worse price", () => {
    const bet = baseBet({ priceAmerican: -150, closeDevigMarketProb: 0.5, closeFairAmerican: 100 });
    finalizeClv(bet);
    // entry -150 implies 0.60 > 0.50 → did not beat the close
    expect(bet.beatClose).toBe(false);
  });
});

describe("settle + accounting", () => {
  it("a won bet pays decimal-1 × stake and updates the derived stats", () => {
    const book = emptyBook();
    const bet = baseBet({ priceAmerican: 100, stakeUsd: 100 });
    book.bets.push(bet);
    settleBet(bet, "won", "score", Date.now());
    expect(bet.pnlUsd).toBe(100); // +100 odds, $100 stake → +$100
    const stats = computeStats(book);
    expect(stats.wins).toBe(1);
    expect(stats.realizedPnlUsd).toBe(100);
    expect(stats.equityUsd).toBe(QUANT_DESK_CONFIG.startingBankrollUsd + 100);
  });

  it("a lost bet loses the stake; a void returns it", () => {
    const won = baseBet({ priceAmerican: -110, stakeUsd: 110 });
    settleBet(won, "lost", null, Date.now());
    expect(won.pnlUsd).toBe(-110);
    const v = baseBet({ priceAmerican: -110, stakeUsd: 110 });
    settleBet(v, "void", null, Date.now());
    expect(v.pnlUsd).toBe(0);
  });

  it("computeStats CLV headline counts only settled bets with finite CLV", () => {
    const book = emptyBook();
    const a = baseBet({ id: betId("MLB", "g1", "a"), priceAmerican: 150, closeDevigMarketProb: 0.5, closeFairAmerican: 100 });
    settleBet(a, "won", null, Date.now()); // beats close
    const b = baseBet({ id: betId("MLB", "g2", "b"), priceAmerican: -150, closeDevigMarketProb: 0.5, closeFairAmerican: 100 });
    settleBet(b, "lost", null, Date.now()); // does not beat close
    book.bets.push(a, b);
    const stats = computeStats(book);
    expect(stats.clvSettledCount).toBe(2);
    expect(stats.clvBeatRatePct).toBe(50);
  });
});

describe("refreshCloses", () => {
  it("updates an open pre-game bet's close from the latest sharp fair", () => {
    const book = emptyBook();
    const bet = baseBet({ id: "MLB|g1|a", commenceTime: "2099-01-01T00:00:00Z", closeDevigMarketProb: 0.55 });
    book.bets.push(bet);
    const map = new Map([["MLB|g1|a", 0.60]]);
    const n = refreshCloses(book, map, Date.parse("2098-12-31T00:00:00Z"));
    expect(n).toBe(1);
    expect(bet.closeDevigMarketProb).toBeCloseTo(0.60, 5);
  });

  it("does not move the close once the game has started", () => {
    const book = emptyBook();
    const bet = baseBet({ id: "MLB|g1|a", commenceTime: "2000-01-01T00:00:00Z", closeDevigMarketProb: 0.55 });
    book.bets.push(bet);
    const map = new Map([["MLB|g1|a", 0.60]]);
    const n = refreshCloses(book, map, Date.now());
    expect(n).toBe(0);
    expect(bet.closeDevigMarketProb).toBeCloseTo(0.55, 5);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function baseBet(over: Partial<QuantBet>): QuantBet {
  return {
    id: "MLB|g1|a",
    sport: "MLB",
    gameId: "g1",
    matchup: "Away @ Home",
    market: "moneyline",
    selection: "a ML",
    commenceTime: "2099-01-01T00:00:00Z",
    entryAt: "2098-12-31T00:00:00Z",
    priceAmerican: -110,
    book: "soft",
    modelFairProb: 0.55,
    devigMarketProb: 0.52,
    edge: 0.03,
    stakeUsd: 100,
    estimate: false,
    closeAt: "2098-12-31T00:00:00Z",
    closeDevigMarketProb: 0.52,
    closeFairAmerican: -108,
    clvCents: null,
    clvProbPoints: null,
    beatClose: null,
    status: "open",
    finalScore: null,
    pnlUsd: null,
    settledAt: null,
    ...over,
  };
}

/** A book whose realized P&L equals `pnl` (one settled bet carrying it). */
function makeBook(pnl: number): QuantBook {
  const book = emptyBook();
  const bet = baseBet({ stakeUsd: Math.abs(pnl) || 1, status: pnl >= 0 ? "won" : "lost", pnlUsd: pnl });
  book.bets.push(bet);
  return book;
}
