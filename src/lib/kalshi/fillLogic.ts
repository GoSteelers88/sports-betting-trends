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
