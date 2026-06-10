// Unit tests for the Kalshi fill-reality logic. firstTradeThrough/fillVerdict
// are pure, so we drive them with candle/position fixtures — no network, no DB.

import { describe, it, expect } from "vitest";
import {
  firstTradeThrough,
  seriesFromEventTicker,
  fillVerdict,
  fillWindowEndMs,
  type FillCandle,
} from "../kalshi/fillLogic";

const candle = (endTs: number, askLow: number | null, tradeLow: number | null): FillCandle => ({
  endTs,
  askLow,
  tradeLow,
});

describe("firstTradeThrough", () => {
  it("returns the first candle whose ask-low trades through the bid", () => {
    const candles = [candle(100, 0.9, null), candle(200, 0.86, null), candle(300, 0.8, null)];
    expect(firstTradeThrough(candles, 0.86)).toBe(200);
  });

  it("treats an exact touch of the bid as a fill (<=, matching the backtest)", () => {
    expect(firstTradeThrough([candle(100, 0.85, null)], 0.85)).toBe(100);
  });

  it("uses trade-low when ask-low is absent", () => {
    const candles = [candle(100, null, 0.9), candle(200, null, 0.84)];
    expect(firstTradeThrough(candles, 0.85)).toBe(200);
  });

  it("skips candles with no price data instead of treating them as fills", () => {
    const candles = [candle(100, null, null), candle(200, 0.84, null)];
    expect(firstTradeThrough(candles, 0.85)).toBe(200);
  });

  it("returns null when the price never reaches the bid", () => {
    const candles = [candle(100, 0.9, 0.91), candle(200, 0.88, 0.89)];
    expect(firstTradeThrough(candles, 0.85)).toBeNull();
  });

  it("returns null for an empty candle set", () => {
    expect(firstTradeThrough([], 0.85)).toBeNull();
  });
});

describe("seriesFromEventTicker", () => {
  it("takes the first dash segment", () => {
    expect(seriesFromEventTicker("KXHIGHNY-26JUN10")).toBe("KXHIGHNY");
    expect(seriesFromEventTicker("KXBTC-26JUN10-B105")).toBe("KXBTC");
  });

  it("returns the whole ticker when there is no dash", () => {
    expect(seriesFromEventTicker("KXNODASHEVER")).toBe("KXNODASHEVER");
  });
});

describe("fillVerdict", () => {
  const base = {
    status: "closed",
    closeTime: "2026-06-08T00:00:00.000Z",
    closedAt: "2026-06-08T04:00:00.000Z",
    fillCheckedAt: null as string | null,
    fillConfirmedAt: null as string | null,
  };

  it("is confirmed whenever a trade-through was recorded, even mid-window", () => {
    expect(
      fillVerdict({ ...base, status: "open", fillConfirmedAt: "2026-06-07T01:00:00.000Z" }),
    ).toBe("confirmed");
  });

  it("is pending for open positions without a confirmation", () => {
    expect(fillVerdict({ ...base, status: "open" })).toBe("pending");
  });

  it("is pending for closed positions never checked", () => {
    expect(fillVerdict(base)).toBe("pending");
  });

  it("is pending when the check has not covered the full window yet", () => {
    expect(fillVerdict({ ...base, fillCheckedAt: "2026-06-07T12:00:00.000Z" })).toBe("pending");
  });

  it("is missed once closed and the check covers through market close", () => {
    expect(fillVerdict({ ...base, fillCheckedAt: "2026-06-08T00:00:00.000Z" })).toBe("missed");
  });

  it("caps the window at settle detection when that precedes market close", () => {
    // Early-determined market: we settled it well before its scheduled close.
    const early = {
      ...base,
      closeTime: "2026-07-01T00:00:00.000Z",
      closedAt: "2026-06-08T04:00:00.000Z",
    };
    expect(fillWindowEndMs(early)).toBe(Date.parse("2026-06-08T04:00:00.000Z"));
    expect(fillVerdict({ ...early, fillCheckedAt: "2026-06-08T04:00:00.000Z" })).toBe("missed");
  });
});
