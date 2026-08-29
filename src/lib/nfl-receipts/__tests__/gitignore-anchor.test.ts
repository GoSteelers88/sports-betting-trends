// The CI anchor for threat T6: the publish path must stay un-gitignored.
// `.gitignore:59` swallows data/processed/latest-odds-api*.json and :96
// swallows data/private/ — the documented WNBA incident was a `git add ||
// true` on an ignored path vanishing silently. If anyone ever adds a rule
// that catches data/processed/nfl-live/, this test fails the suite before a
// board can vanish.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function isIgnored(p: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", p], { stdio: "ignore" });
    return true; // exit 0 = ignored
  } catch {
    return false; // exit 1 = not ignored
  }
}

describe("gitignore anchor (threat T6)", () => {
  it("the receipts publish paths are NOT ignored", () => {
    expect(isIgnored("data/processed/nfl-live/board-2026-wk01.json")).toBe(false);
    expect(isIgnored("data/processed/nfl-live/ledger.json")).toBe(false);
    expect(isIgnored("data/processed/nfl-live/closes/pinnacle-americanfootball_nfl-x.json")).toBe(false);
    expect(isIgnored("data/processed/nfl-live/snapshots/entry-2026-wk01.json")).toBe(false);
    expect(isIgnored("data/processed/cfb-shadow/closes/pinnacle-americanfootball_ncaaf-x.json")).toBe(false);
  });

  it("sanity: check-ignore itself works (a known-ignored path reads ignored)", () => {
    // NOT the real NFL-named file — that one is tracked and tracked files
    // bypass ignore rules; an untracked name under the same pattern is the
    // honest probe.
    expect(isIgnored("data/processed/latest-odds-api-hypothetical.json")).toBe(true);
    expect(isIgnored("data/private/nfl-loop/live-boards/2026-REG-wk1.json")).toBe(true);
  });
});
