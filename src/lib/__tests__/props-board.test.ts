// Unit tests for the props +EV board's pure logic — parsing, player
// matching, and the sharp↔soft join with EV gating.

import { describe, it, expect } from "vitest";
import {
  playerFromDescription,
  assembleSharpProp,
  samePlayer,
  buildPropsBoard,
  type SharpProp,
  type SoftPropQuote,
} from "../props-board";

describe("playerFromDescription", () => {
  it("takes the text before the first parenthesis", () => {
    expect(playerFromDescription("Brandon Sproat (Total Strikeouts)(must start)")).toBe(
      "Brandon Sproat",
    );
    expect(playerFromDescription("Nick Kurtz (Home Runs)(must start)")).toBe("Nick Kurtz");
  });
});

describe("assembleSharpProp", () => {
  it("de-vigs the two-way prices into a fair over probability", () => {
    const p = assembleSharpProp({
      description: "Brandon Sproat (Total Strikeouts)(must start)",
      units: "Strikeouts",
      line: 4.5,
      overAmerican: 123,
      underAmerican: -164,
      cutoffAt: "2026-06-11T01:05:00+00:00",
    })!;
    expect(p.player).toBe("Brandon Sproat");
    // implied: over 0.4484, under 0.6212 → fair over ≈ 0.419
    expect(p.fairOverProb).toBeGreaterThan(0.4);
    expect(p.fairOverProb).toBeLessThan(0.44);
  });
});

describe("samePlayer", () => {
  it("matches exact names, accents, and last-name + initial", () => {
    expect(samePlayer("Brandon Sproat", "Brandon Sproat")).toBe(true);
    expect(samePlayer("José Ramírez", "Jose Ramirez")).toBe(true);
    expect(samePlayer("B. Sproat", "Brandon Sproat")).toBe(true);
  });

  it("rejects different players sharing a last name initial pattern", () => {
    expect(samePlayer("Brandon Sproat", "Bobby Sprout")).toBe(false);
    expect(samePlayer("Will Smith", "Wilson Contreras")).toBe(false);
  });
});

describe("buildPropsBoard", () => {
  const sharp: SharpProp[] = [
    {
      player: "Brandon Sproat",
      units: "Strikeouts",
      line: 4.5,
      overAmerican: 123,
      underAmerican: -164,
      fairOverProb: 0.42,
      cutoffAt: "2026-06-11T01:05:00+00:00",
    },
  ];
  const quote = (overrides: Partial<SoftPropQuote> = {}): SoftPropQuote => ({
    player: "Brandon Sproat",
    market: "pitcher_strikeouts",
    line: 4.5,
    side: "Over",
    american: 160, // fair 0.42 → dec 2.6 × 0.42 = 1.092 → +9.2% EV
    book: "draftkings",
    commence: "2026-06-11T00:05:00Z",
    ...overrides,
  });

  it("joins on player + prop type + exact line and prices the quoted side", () => {
    const rows = buildPropsBoard(sharp, [quote()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].evPct).toBeCloseTo(9.2, 1);
    expect(rows[0].playable).toBe(true);
    expect(rows[0].suspicious).toBe(false);
  });

  it("prices the under from the complement probability", () => {
    const rows = buildPropsBoard(sharp, [quote({ side: "Under", american: -120 })]);
    // fair under 0.58 × dec 1.8333 − 1 ≈ +6.3%
    expect(rows[0].evPct).toBeCloseTo(6.3, 1);
  });

  it("skips mismatched lines instead of comparing different totals", () => {
    expect(buildPropsBoard(sharp, [quote({ line: 5.5 })])).toHaveLength(0);
  });

  it("quarantines too-good-to-be-true edges as suspicious, not playable", () => {
    const rows = buildPropsBoard(sharp, [quote({ american: 400 })]); // +110% EV
    expect(rows[0].suspicious).toBe(true);
    expect(rows[0].playable).toBe(false);
  });

  it("ignores unmapped prop markets", () => {
    expect(buildPropsBoard(sharp, [quote({ market: "batter_stolen_bases" })])).toHaveLength(0);
  });
});
