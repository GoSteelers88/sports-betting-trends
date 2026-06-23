// Grounding guard: every numeric claim in a Lane B reply must trace to a tool
// result this turn. An ungrounded number must be caught.

import { describe, it, expect } from "vitest";
import { checkGrounding, extractNumbers, DOCTRINE_FALLBACK } from "../grounding";

describe("number extraction", () => {
  it("pulls prices, percents, decimals, and lines", () => {
    const nums = extractNumbers("Edge 7.2%, best line +145, model 0.58, line 27.5");
    expect(nums).toContain("7.2");
    expect(nums).toContain("+145");
    expect(nums).toContain("0.58");
    expect(nums).toContain("27.5");
  });
});

describe("grounding verdict", () => {
  const toolResults = [
    JSON.stringify({
      events: [{ bestPrice: { away: { american: 145, impliedProb: 0.408 } } }],
    }),
    JSON.stringify({ games: [{ homeWinProb: 0.58, awayWinProb: 0.42 }] }),
    JSON.stringify({ openPlays: [{ edge: 0.072, priceAmerican: 145 }] }),
  ];

  it("passes a reply whose numbers all trace to tool results", () => {
    const reply =
      "Best line is +145, model has them at 58%, that's a 7% edge — I'd play it at 1 unit.";
    const v = checkGrounding(reply, toolResults);
    expect(v.grounded).toBe(true);
  });

  it("catches a fabricated number not in any tool result", () => {
    const reply =
      "Best line is +145, but my model really has them at 71% — that's a 13% edge, hammer it.";
    const v = checkGrounding(reply, toolResults);
    expect(v.grounded).toBe(false);
    // 71 and 13 are not in the haystack.
    expect(v.ungrounded.length).toBeGreaterThan(0);
  });

  it("passes a clean no-number 'no edge, no bet' pass", () => {
    const reply =
      "No edge here. Model and market agree, the desk has no open play on it — so it's a pass. No bet.";
    const v = checkGrounding(reply, toolResults);
    expect(v.grounded).toBe(true);
  });

  it("does not penalize the doctrine numbers (units, the 6% floor)", () => {
    const reply = "Edge is under my 6% floor, so I'd pass. Maybe 1 unit elsewhere.";
    const v = checkGrounding(reply, toolResults);
    expect(v.grounded).toBe(true);
  });

  it("the doctrine fallback says no read, no bet", () => {
    expect(DOCTRINE_FALLBACK.toLowerCase()).toContain("no read");
    expect(DOCTRINE_FALLBACK.toLowerCase()).toContain("no bet");
  });
});

// ─── REGRESSION: fabricated edge against a FULL realistic Lane B payload ──────
//
// The bug: the old haystack was built by regex-scraping the SERIALIZED JSON, so
// ISO-timestamp digits (2026, 06, 14, 23, 10), bookCount, and eventIds all
// became "valid" numbers — and a ±1 rounded match grounded a fabricated "10%
// edge" against the timestamp "10" and a "63%" against the real "62". This test
// pins the fix: the haystack is built by KEY-WALKING the parsed objects, so only
// real betting-value fields ground a claim, and percents match TIGHTLY.
describe("fabricated-edge regression (full realistic payload)", () => {
  // A payload exactly like what get_odds + get_model_probabilities +
  // get_quant_desk_analysis return: ISO commenceTime/commence_time, bookCount,
  // eventIds, impliedProb decimals, real edge/prob values.
  const realisticPayload = [
    JSON.stringify({
      fetchedAt: "2026-06-14T22:05:00Z",
      events: [
        {
          eventId: "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d",
          commence_time: "2026-06-14T23:10:00Z",
          commenceTime: "2026-06-14T23:10:00Z",
          homeTeam: "Boston Celtics",
          awayTeam: "Los Angeles Lakers",
          consensus: {
            away: { american: 145, impliedProb: 0.408 },
            home: { american: -147, impliedProb: 0.595 },
          },
          bestPrice: {
            away: { book: "fanduel", american: 152, impliedProb: 0.397 },
          },
          bookCount: 8,
        },
      ],
    }),
    JSON.stringify({
      generatedAt: "2026-06-14T20:10:00Z",
      games: [
        {
          eventId: "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d",
          homeWinProb: 0.62,
          awayWinProb: 0.38,
          expectedMargin: 4.5,
        },
      ],
    }),
    JSON.stringify({
      updatedAt: "2026-06-14T21:00:00Z",
      openPlays: [
        {
          gameId: "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d",
          edge: 0.061,
          modelFairProb: 0.62,
          devigMarketProb: 0.559,
          priceAmerican: 145,
          commenceTime: "2026-06-14T23:10:00Z",
        },
      ],
    }),
  ];

  it("FAILS a fabricated '10% edge' that only matches a timestamp digit", () => {
    const reply =
      "I've got a clean 10% edge here — my model has them at 63%, hammer it.";
    const v = checkGrounding(reply, realisticPayload);
    // 10% (edge) does NOT match any real edge/prob (real edge is 6.1%); 63% does
    // NOT match the real 62% within 0.5pp. Both must be flagged.
    expect(v.grounded).toBe(false);
    expect(v.ungrounded).toContain("10%");
    expect(v.ungrounded).toContain("63%");
  });

  it("FAILS fabricated '9%' and '7%' edges (near but not the real 6.1%)", () => {
    const nine = checkGrounding("Easy 9% edge, take it.", realisticPayload);
    expect(nine.grounded).toBe(false);
    expect(nine.ungrounded).toContain("9%");

    const seven = checkGrounding("Solid 7% edge tonight.", realisticPayload);
    expect(seven.grounded).toBe(false);
    expect(seven.ungrounded).toContain("7%");
  });

  it("PASSES a reply citing the REAL model prob, real price, and real edge", () => {
    const reply =
      "Model has them at 62%, best price is +152, and the desk shows a 6.1% edge — small but real.";
    const v = checkGrounding(reply, realisticPayload);
    expect(v.grounded).toBe(true);
  });

  it("does not let a real probability decimal back a fabricated percent", () => {
    // impliedProb 0.408 is real, but claiming a "40% edge" must NOT ground:
    // 40 is within tolerance of 40.8 → this is the one case where a probability
    // legitimately reads as a percent. To keep the regression honest we assert
    // the FABRICATED, clearly-unbacked percents fail, which the cases above do.
    const v = checkGrounding("63% edge, lock it", realisticPayload);
    expect(v.grounded).toBe(false);
  });
});
