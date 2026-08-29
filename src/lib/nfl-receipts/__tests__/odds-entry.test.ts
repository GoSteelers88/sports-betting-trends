import { describe, expect, it } from "vitest";
import { extractPrice, mainPoint, type OddsApiEvent } from "../odds-entry";

const EVENT: OddsApiEvent = {
  id: "abc123",
  sport_key: "americanfootball_nfl",
  commence_time: "2026-09-13T17:00:00Z",
  home_team: "Philadelphia Eagles",
  away_team: "Kansas City Chiefs",
  bookmakers: [
    {
      key: "fanduel",
      title: "FanDuel",
      markets: [
        {
          key: "h2h",
          outcomes: [
            { name: "Philadelphia Eagles", price: -170 },
            { name: "Kansas City Chiefs", price: 145 },
          ],
        },
        {
          key: "spreads",
          outcomes: [
            { name: "Philadelphia Eagles", price: -110, point: -3.5 },
            { name: "Kansas City Chiefs", price: -110, point: 3.5 },
          ],
        },
        {
          key: "totals",
          outcomes: [
            { name: "Over", price: -108, point: 47.5 },
            { name: "Under", price: -112, point: 47.5 },
          ],
        },
      ],
    },
    {
      key: "draftkings",
      title: "DraftKings",
      markets: [
        {
          key: "h2h",
          outcomes: [
            { name: "Philadelphia Eagles", price: -165 }, // better home price
            { name: "Kansas City Chiefs", price: 140 },
          ],
        },
        {
          key: "spreads",
          outcomes: [
            // moved point — must never satisfy a -3.5 request
            { name: "Philadelphia Eagles", price: -105, point: -4 },
            { name: "Kansas City Chiefs", price: -115, point: 4 },
          ],
        },
      ],
    },
    {
      key: "lowvig",
      title: "LowVig",
      markets: [
        {
          key: "h2h",
          outcomes: [
            { name: "Philadelphia Eagles", price: -172 },
            { name: "Kansas City Chiefs", price: 152 },
          ],
        },
      ],
    },
  ],
};

describe("extractPrice (threat T10/T12: real prices, exact points)", () => {
  it("best-price mode finds the numerically best two-sided price", () => {
    const p = extractPrice(EVENT, "moneyline", "home", null, "all")!;
    expect(p.book).toBe("draftkings"); // -165 beats -170 and -172
    expect(p.american).toBe(-165);
    expect(p.otherAmerican).toBe(140);
  });

  it("priority mode honors the CALLER's order, not the API response order", () => {
    // lowvig is listed LAST in the event's bookmakers; it must still win a
    // ["lowvig", "fanduel"] request (review finding 7).
    const p = extractPrice(EVENT, "moneyline", "away", null, ["lowvig", "fanduel"])!;
    expect(p.book).toBe("lowvig");
    expect(p.american).toBe(152);
    // and when the first-priority book lacks the market, fall to the next
    const q = extractPrice(EVENT, "total", "over", 47.5, ["lowvig", "fanduel"])!;
    expect(q.book).toBe("fanduel");
  });

  it("a moved point is skipped, never substituted", () => {
    const p = extractPrice(EVENT, "ats", "home", -3.5, "all")!;
    expect(p.book).toBe("fanduel"); // DK moved to -4 and must not match
    const none = extractPrice(EVENT, "ats", "home", -2.5, "all");
    expect(none).toBeNull();
  });

  it("away spread uses the mirrored point at the same book", () => {
    const p = extractPrice(EVENT, "ats", "away", 3.5, "all")!;
    expect(p.american).toBe(-110);
    expect(p.otherAmerican).toBe(-110);
  });

  it("totals share the point across both sides", () => {
    const p = extractPrice(EVENT, "total", "under", 47.5, "all")!;
    expect(p.american).toBe(-112);
    expect(p.otherAmerican).toBe(-108);
  });
});

describe("mainPoint (control-arm line selection)", () => {
  it("takes the modal point; smaller absolute point breaks ties", () => {
    expect(mainPoint(EVENT, "total", "over")).toBe(47.5);
    // spreads: fanduel -3.5, draftkings -4 → tie broken toward |−3.5|
    expect(mainPoint(EVENT, "ats", "home")).toBe(-3.5);
  });
});
