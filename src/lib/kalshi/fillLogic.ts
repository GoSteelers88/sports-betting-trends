/**
 * fillLogic.ts — pure fill-reality logic for the Kalshi paper trail.
 *
 * The paper engine ASSUMES every resting bid fills. The 23k-market backtest
 * (scripts/flb-adverse-selection.ts) showed only ~74% of resting bids actually
 * trade through — and the ones that do are adversely selected (filled
 * favorites won 85.4% vs 97.7% for missed). This module mirrors the
 * backtest's criterion exactly so the live numbers are directly comparable:
 * a resting YES bid at P is "confirmed" once any later hourly candle's
 * ask-low or trade-low prints at or below P.
 *
 * Pure module — no DB, no fetch — so it stays unit-testable.
 */

export interface FillCandle {
  endTs: number; // unix seconds — end of the candle period
  askLow: number | null; // yes_ask.low_dollars
  tradeLow: number | null; // price.low_dollars
}

/** Unix ts (seconds) of the first candle that trades through the bid, or null. */
export function firstTradeThrough(candles: FillCandle[], bid: number): number | null {
  for (const c of candles) {
    const lows = [c.askLow, c.tradeLow].filter((v): v is number => v != null);
    if (lows.length > 0 && Math.min(...lows) <= bid) return c.endTs;
  }
  return null;
}

/** Kalshi series ticker is the event ticker's first dash segment (KXFOO-26JUN10 → KXFOO). */
export function seriesFromEventTicker(eventTicker: string): string {
  const i = eventTicker.indexOf("-");
  return i > 0 ? eventTicker.slice(0, i) : eventTicker;
}

export type FillVerdict = "confirmed" | "missed" | "pending";

export interface FillVerdictInput {
  status: string;
  closeTime: string; // ISO — market close
  closedAt: string | null; // ISO — when we settled the paper position
  fillCheckedAt: string | null; // ISO — how far the candle check has covered
  fillConfirmedAt: string | null; // ISO — first trade-through, if any
}

/** The end of the window a fill could have happened in (ms), or null if unknowable. */
export function fillWindowEndMs(p: Pick<FillVerdictInput, "closeTime" | "closedAt">): number | null {
  const close = Date.parse(p.closeTime);
  const settled = p.closedAt ? Date.parse(p.closedAt) : NaN;
  const candidates = [close, settled].filter(Number.isFinite);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/**
 * Final verdict for a position. "missed" only once the position is closed AND
 * the candle check has covered the full entry→close window; anything earlier
 * stays "pending" so we never misreport a fill that hasn't had time to happen.
 */
export function fillVerdict(p: FillVerdictInput): FillVerdict {
  if (p.fillConfirmedAt) return "confirmed";
  if (p.status !== "closed" || !p.fillCheckedAt) return "pending";
  const windowEnd = fillWindowEndMs(p);
  if (windowEnd === null) return "pending";
  return Date.parse(p.fillCheckedAt) >= windowEnd ? "missed" : "pending";
}

// ── Fees (Kalshi fee schedule, verified via series fee_type 2026-06-10) ─────
// Trading fee = ceil-to-cent(rate × C × P × (1−P)). Takers pay rate 0.07 on
// "quadratic" series; makers pay 0 there. Series tagged
// "quadratic_with_maker_fees" (Fed/CPI/payrolls/GDP-type) charge makers at
// the quarter rate 0.0175.

const TAKER_RATE = 0.07;
const MAKER_RATE = 0.0175;
export const MAKER_FEE_TYPE = "quadratic_with_maker_fees";

function quadraticFeeUsd(rate: number, price: number, contracts: number): number {
  if (!(price > 0 && price < 1) || contracts <= 0) return 0;
  return Math.ceil(rate * contracts * price * (1 - price) * 100) / 100;
}

export function takerFeeUsd(price: number, contracts: number): number {
  return quadraticFeeUsd(TAKER_RATE, price, contracts);
}

/** Maker fee for an entry — zero unless the series charges maker fees. */
export function makerFeeUsd(price: number, contracts: number, feeType: string | null): number {
  if (feeType !== MAKER_FEE_TYPE) return 0;
  return quadraticFeeUsd(MAKER_RATE, price, contracts);
}

// ── Fill timing — the adverse-selection fingerprint ─────────────────────────
// Early fills at stable prices are benign; fills late in the window (price
// collapsing through the bid en route to NO) are the adverse signature.

export interface FillTiming {
  hours: number; // entry → first trade-through
  fraction: number; // position of the fill inside the entry→close window, 0..1
}

export function fillTiming(
  p: Pick<FillVerdictInput, "closeTime" | "closedAt" | "fillConfirmedAt"> & { openedAt: string },
): FillTiming | null {
  if (!p.fillConfirmedAt) return null;
  const opened = Date.parse(p.openedAt);
  const filled = Date.parse(p.fillConfirmedAt);
  const windowEnd = fillWindowEndMs(p);
  if (!Number.isFinite(opened) || !Number.isFinite(filled) || windowEnd === null) return null;
  const span = windowEnd - opened;
  return {
    hours: Math.max(0, (filled - opened) / 3_600_000),
    fraction: span > 0 ? Math.min(1, Math.max(0, (filled - opened) / span)) : 0,
  };
}

export const LATE_FILL_FRACTION = 0.75; // fills in the last quarter of the window

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
