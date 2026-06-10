// Unit tests for the PEAD watchdog's pure logic — reconcile() and
// revenueConfirmed() take plain data, no broker or DB.

import { describe, it, expect } from "vitest";
import { reconcile, revenueConfirmed, type BookOpenRow } from "../stocks/peadWatchdog";

const NOW = new Date("2026-06-10T16:00:00.000Z");
const row = (overrides: Partial<BookOpenRow> = {}): BookOpenRow => ({
  symbol: "ACME",
  qty: 10,
  exitDue: "2026-07-01T15:05:00.000Z", // not due
  entrySpy: 500,
  ...overrides,
});

describe("reconcile", () => {
  it("is silent when book and broker agree", () => {
    expect(reconcile([row()], [{ symbol: "ACME", qty: 10 }], NOW)).toEqual([]);
  });

  it("tolerates fractional rounding inside 1%", () => {
    expect(reconcile([row({ qty: 10.0 })], [{ symbol: "ACME", qty: 9.95 }], NOW)).toEqual([]);
  });

  it("flags a book position the broker does not hold", () => {
    const issues = reconcile([row()], [], NOW);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("NOT held in Alpaca");
  });

  it("flags a quantity mismatch beyond tolerance", () => {
    const issues = reconcile([row({ qty: 10 })], [{ symbol: "ACME", qty: 5 }], NOW);
    expect(issues[0]).toContain("qty mismatch");
  });

  it("flags broker orphans not in the book", () => {
    const issues = reconcile([], [{ symbol: "GHST", qty: 3 }], NOW);
    expect(issues[0]).toContain("orphan");
  });

  it("flags exits more than a day overdue, but not freshly due ones", () => {
    const overdue = reconcile(
      [row({ exitDue: "2026-06-08T15:05:00.000Z" })],
      [{ symbol: "ACME", qty: 10 }],
      NOW,
    );
    expect(overdue.some((i) => i.includes("exit overdue"))).toBe(true);

    const freshlyDue = reconcile(
      [row({ exitDue: "2026-06-10T15:05:00.000Z" })], // due 55 min ago — normal
      [{ symbol: "ACME", qty: 10 }],
      NOW,
    );
    expect(freshlyDue).toEqual([]);
  });

  it("flags a missing SPY benchmark leg", () => {
    const issues = reconcile([row({ entrySpy: null })], [{ symbol: "ACME", qty: 10 }], NOW);
    expect(issues[0]).toContain("SPY benchmark");
  });
});

describe("revenueConfirmed", () => {
  it("confirms when revenue met or beat the estimate", () => {
    expect(revenueConfirmed(100, 110)).toBe(true);
    expect(revenueConfirmed(100, 100)).toBe(true);
    expect(revenueConfirmed(100, 90)).toBe(false);
  });

  it("is null when either leg is missing or the estimate is nonsensical", () => {
    expect(revenueConfirmed(null, 110)).toBeNull();
    expect(revenueConfirmed(100, null)).toBeNull();
    expect(revenueConfirmed(0, 110)).toBeNull();
  });
});
