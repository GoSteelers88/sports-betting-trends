import { PositionSize, NormalizedSnapshot } from "./types";
import { config } from "./config";

/**
 * Position Sizing — REWRITTEN
 *
 * OLD BUGS (3 critical):
 *   1. winProb = pFair + edge
 *      → Conflates EVENT probability with TRADE win probability.
 *      → If pFair = 0.60 and edge = 0.08, old code says winProb = 0.68
 *        But that's the event prob, NOT the prob our trade wins.
 *
 *   2. odds = pFair / (1 - pFair)
 *      → Uses event odds, not trade payout odds.
 *      → On Kalshi: if we buy YES at $0.45, our payout is $1.00.
 *        Profit = $0.55 per dollar risked. odds = 0.55/0.45 = 1.22
 *
 *   3. No Kalshi fee awareness
 *      → Kalshi charges 7% on PROFITS (not wagers).
 *      → This reduces effective odds and must be in the Kelly formula.
 *
 * NEW:
 *   - winProb = estimated from edge magnitude + leader confidence
 *   - odds = actual Kalshi payout odds (price-based), adjusted for 7% fee
 *   - Per-market loss limits to prevent death spirals
 *   - Bankroll cap at 5% per trade
 */

const KALSHI_FEE_RATE = 0.07; // 7% on profits

// ─── Core Kelly (unchanged formula, but now called with correct inputs) ──────

export function kellyFraction(
  winProb: number,
  netOdds: number // actual net odds after fees
): number {
  if (winProb <= 0 || winProb >= 1 || netOdds <= 0) return 0;
  const q = 1 - winProb;
  const k = (winProb * netOdds - q) / netOdds;
  return Math.max(0, k);
}

export function halfKelly(
  winProb: number,
  netOdds: number,
  bankroll: number
): number {
  const k = kellyFraction(winProb, netOdds);
  return bankroll * k * (config.sizing?.kellyFraction ?? 0.4);
}

// ─── NEW: Kalshi-aware position sizing ───────────────────────────────────────

export interface KalshiSizingInput {
  /** Edge magnitude (gap between markets, 0-1 scale) */
  edge: number;
  /** Leader confidence from determineLeaderLagger (0-1) */
  leaderConfidence: number;
  /** Current Kalshi price for the side we're buying (0-1) */
  kalshiPrice: number;
  /** Current bankroll in dollars */
  bankroll: number;
  /** Cumulative P/L for this specific market */
  marketCumulativePnl?: number;
  /** Per-market loss limit (default -500) */
  marketLossLimit?: number;
}

export interface KalshiPositionResult {
  /** Recommended dollar amount to wager */
  recommended: number;
  /** After all caps applied */
  capped: number;
  /** Win probability estimate used */
  winProbEstimate: number;
  /** Net odds after Kalshi fee */
  netOdds: number;
  /** Reasons for any caps applied */
  limitReasons: string[];
  /** Whether trade was blocked entirely */
  blocked: boolean;
  blockReason?: string;
}

export function computeKalshiPositionSize(
  input: KalshiSizingInput
): KalshiPositionResult {
  const {
    edge,
    leaderConfidence,
    kalshiPrice,
    bankroll,
    marketCumulativePnl = 0,
    marketLossLimit = -500,
  } = input;

  const reasons: string[] = [];

  // ── BLOCK: Per-market loss limit ──
  if (marketCumulativePnl <= marketLossLimit) {
    return {
      recommended: 0,
      capped: 0,
      winProbEstimate: 0,
      netOdds: 0,
      limitReasons: [`Market loss limit hit: $${marketCumulativePnl.toFixed(2)} <= $${marketLossLimit}`],
      blocked: true,
      blockReason: "per_market_loss_limit",
    };
  }

  // ── BLOCK: No edge ──
  if (edge <= 0) {
    return {
      recommended: 0,
      capped: 0,
      winProbEstimate: 0,
      netOdds: 0,
      limitReasons: ["No edge detected"],
      blocked: true,
      blockReason: "no_edge",
    };
  }

  // ── Step 1: Estimate TRADE win probability ──
  // This is NOT the event probability. This is: "given that we detected
  // a leader move with this edge and confidence, how often does our trade win?"
  // From backtest: base rate ~55%, scaled by edge and confidence
  let winProb = 0.50 + edge * leaderConfidence * 2;
  winProb = Math.min(0.75, Math.max(0.35, winProb));

  // ── Step 2: Calculate ACTUAL Kalshi payout odds ──
  // If we buy YES at price P, on win we get $1.00.
  // Gross profit per dollar risked = (1 - P) / P
  // Kalshi takes 7% of profit → net profit = gross * (1 - 0.07)
  const grossProfitPerDollar = (1 - kalshiPrice) / Math.max(kalshiPrice, 0.01);
  const netProfitPerDollar = grossProfitPerDollar * (1 - KALSHI_FEE_RATE);

  if (netProfitPerDollar <= 0) {
    return {
      recommended: 0,
      capped: 0,
      winProbEstimate: winProb,
      netOdds: 0,
      limitReasons: ["Negative net odds after fee"],
      blocked: true,
      blockReason: "negative_odds",
    };
  }

  // ── Step 3: Kelly sizing with correct inputs ──
  const kellyAmount = halfKelly(winProb, netProfitPerDollar, bankroll);

  if (kellyAmount <= 0) {
    return {
      recommended: 0,
      capped: 0,
      winProbEstimate: winProb,
      netOdds: netProfitPerDollar,
      limitReasons: ["Kelly says no bet (edge doesn't overcome odds)"],
      blocked: true,
      blockReason: "kelly_negative",
    };
  }

  // ── Step 4: Apply caps ──
  let capped = kellyAmount;

  // Cap 1: Max 5% of bankroll per trade
  const bankrollCap = bankroll * 0.05;
  if (capped > bankrollCap) {
    capped = bankrollCap;
    reasons.push(`Capped at 5% bankroll ($${bankrollCap.toFixed(2)})`);
  }

  // Cap 2: Absolute minimum $10
  if (capped < 10) {
    return {
      recommended: kellyAmount,
      capped: 0,
      winProbEstimate: winProb,
      netOdds: netProfitPerDollar,
      limitReasons: ["Position below $10 minimum"],
      blocked: true,
      blockReason: "below_minimum",
    };
  }

  return {
    recommended: Math.round(kellyAmount * 100) / 100,
    capped: Math.round(capped * 100) / 100,
    winProbEstimate: Math.round(winProb * 1000) / 1000,
    netOdds: Math.round(netProfitPerDollar * 1000) / 1000,
    limitReasons: reasons,
    blocked: false,
  };
}

// ─── Legacy adapter ──────────────────────────────────────────────────────────

/**
 * @deprecated Use computeKalshiPositionSize() for the autopilot.
 * This preserves the old interface for non-autopilot callers.
 */
export function computePositionSize(
  edge: number,
  pFair: number,
  poly: NormalizedSnapshot,
  kalshi: NormalizedSnapshot,
  bankroll: number
): PositionSize {
  const reasons: string[] = [];

  // FIX: winProb is trade win probability, not event probability
  const winProb = Math.min(0.75, Math.max(0.35, 0.50 + edge * 2));

  // FIX: odds based on actual Kalshi price, not pFair
  const kalshiPrice = kalshi.midpoint;
  const grossOdds = (1 - kalshiPrice) / Math.max(kalshiPrice, 0.01);
  const netOdds = grossOdds * (1 - KALSHI_FEE_RATE);

  const kellyAmount = halfKelly(winProb, netOdds, bankroll);
  const kellyApplied = kellyAmount;

  // Depth cap
  const minDepth = Math.min(poly.depthAtBest, kalshi.depthAtBest);
  const depthCap = minDepth * (config.sizing?.maxDepthParticipation ?? 0.30);
  let capped = Math.min(kellyAmount, depthCap);

  if (capped < kellyAmount) {
    reasons.push(
      `Capped at ${((config.sizing?.maxDepthParticipation ?? 0.30) * 100).toFixed(0)}% of depth (${minDepth})`
    );
  }

  if (capped < 1) {
    reasons.push("Position below minimum size");
    capped = 0;
  }

  return { recommended: kellyAmount, capped, kellyApplied, limitReasons: reasons };
}
