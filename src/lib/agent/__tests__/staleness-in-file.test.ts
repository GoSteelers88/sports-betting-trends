// B1 — freshness must come from the DATA'S OWN in-file timestamp, never the
// filesystem mtime (Vercel bundle resets mtime → false STALE; GH Actions
// checkout resets it to now → genuinely-old files read FRESH, the inverse bug).
//
// The four acceptance cases (asserted across loadJsonWithStatus [via its
// freshnessFromData helper + a live readStat round-trip], readStat/staleNote,
// AND health.ts):
//   1. in-file timestamp 10min ago → FRESH (no warning), regardless of mtime.
//   2. in-file timestamp 2 days old → STALE warning.
//   3. bare array / no timestamp field → UNKNOWN-freshness warning (never silent-fresh).
//   4. unparseable timestamp → UNKNOWN (never NaN-fresh).

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import {
  freshnessFromData as freshnessIndex,
} from "../tools/index";
import {
  readStat,
  staleNote,
  freshnessFromData as freshnessStats,
} from "../tools/stats";
import { ageHoursFromData, checkHealth } from "../health";

const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
// "+00:00"-offset form (not "Z") — Date.parse must handle it.
const tenMinAgoOffset = tenMinAgo.replace("Z", "+00:00");

describe("freshnessFromData — index.ts (loadJsonWithStatus's freshness rule)", () => {
  it("fresh in-file timestamp 10min ago → not stale, not unknown", () => {
    const f = freshnessIndex({ fetchedAt: tenMinAgo, events: [] });
    expect(f.unknown).toBe(false);
    expect(f.ageMs).toBeLessThan(6 * 60 * 60 * 1000); // under the 6h STALE floor
  });

  it("handles a +00:00 offset timestamp (not just Z)", () => {
    const f = freshnessIndex({ generatedAt: tenMinAgoOffset });
    expect(f.unknown).toBe(false);
    expect(f.ageMs).toBeLessThan(6 * 60 * 60 * 1000);
  });

  it("2-day-old in-file timestamp → real age well over the stale floor", () => {
    const f = freshnessIndex({ updatedAt: twoDaysAgo });
    expect(f.unknown).toBe(false);
    expect(f.ageMs!).toBeGreaterThan(6 * 60 * 60 * 1000);
  });

  it("bare array (no envelope timestamp) → UNKNOWN, never silent-fresh", () => {
    const f = freshnessIndex([{ team: "Bruins", wins: 41, losses: 12 }]);
    expect(f.unknown).toBe(true);
    expect(f.ageMs).toBeNull();
  });

  it("unparseable timestamp → UNKNOWN (never NaN-fresh)", () => {
    const f = freshnessIndex({ fetchedAt: "not-a-date" });
    expect(f.unknown).toBe(true);
    expect(f.ageMs).toBeNull();
  });

  it("absent timestamp field on an object → UNKNOWN", () => {
    const f = freshnessIndex({ events: [], season: "2026" });
    expect(f.unknown).toBe(true);
  });
});

describe("freshnessFromData — stats.ts mirrors the same rule", () => {
  it("fresh / stale / bare-array / unparseable", () => {
    expect(freshnessStats({ fetchedAt: tenMinAgo }).unknownFreshness).toBe(false);
    expect(freshnessStats({ generatedAt: twoDaysAgo }).ageMs!).toBeGreaterThan(
      6 * 60 * 60 * 1000
    );
    expect(freshnessStats([1, 2, 3]).unknownFreshness).toBe(true);
    expect(freshnessStats({ updatedAt: "garbage" }).unknownFreshness).toBe(true);
  });
});

describe("ageHoursFromData — health.ts mirrors the same rule", () => {
  it("fresh → small positive hours; stale → large; unknown → null", () => {
    expect(ageHoursFromData({ fetchedAt: tenMinAgo })).toBeLessThan(1);
    expect(ageHoursFromData({ generatedAt: twoDaysAgo })!).toBeGreaterThan(24);
    expect(ageHoursFromData([{ team: "x" }])).toBeNull(); // bare array → unknown
    expect(ageHoursFromData({ fetchedAt: "nope" })).toBeNull(); // unparseable → unknown, NOT 0/fresh
    expect(ageHoursFromData({ events: [] })).toBeNull(); // absent field → unknown
  });
});

// ─── Live round-trip through readStat + staleNote (proves the WHOLE path, not
//     just the helper). We write throwaway fixtures into data/processed and
//     clean them up. mtime is "now" for all of them — the age must still come
//     from the in-file timestamp, proving mtime is NOT the source. ───────────
const PROCESSED = path.resolve(process.cwd(), "data", "processed");
const written: string[] = [];
function writeFixture(name: string, body: unknown): string {
  const file = `__staleness_test_${name}.json`;
  fs.writeFileSync(path.join(PROCESSED, file), JSON.stringify(body), "utf8");
  written.push(file);
  return file;
}
afterAll(() => {
  for (const f of written) {
    try {
      fs.unlinkSync(path.join(PROCESSED, f));
    } catch {
      /* ignore */
    }
  }
});

describe("readStat + staleNote live round-trip (mtime-now, in-file timestamp wins)", () => {
  it("case 1: mtime now but fetchedAt 10min ago → NO warning", () => {
    const file = writeFixture("fresh", { fetchedAt: tenMinAgo, teams: [] });
    const { ageMs, missing, unknownFreshness } = readStat(file, {});
    expect(missing).toBe(false);
    expect(unknownFreshness).toBe(false);
    expect(staleNote(file, ageMs, missing, unknownFreshness)).toBeUndefined();
  });

  it("case 2: mtime now but generatedAt 2 days ago → STALE warning", () => {
    const file = writeFixture("stale", { generatedAt: twoDaysAgo, teams: [] });
    const { ageMs, missing, unknownFreshness } = readStat(file, {});
    const warn = staleNote(file, ageMs, missing, unknownFreshness);
    expect(warn).toBeTruthy();
    expect(warn!.toLowerCase()).toContain("stale");
  });

  it("case 3: bare array / no timestamp → UNKNOWN-freshness warning (never silent-fresh)", () => {
    const file = writeFixture("bare", [{ team: "Bruins", wins: 41, losses: 12 }]);
    const { ageMs, missing, unknownFreshness } = readStat<unknown[]>(file, []);
    expect(missing).toBe(false);
    expect(unknownFreshness).toBe(true);
    const warn = staleNote(file, ageMs, missing, unknownFreshness);
    expect(warn).toBeTruthy();
    expect(warn!.toLowerCase()).toContain("no freshness metadata");
  });

  it("case 4: unparseable timestamp → UNKNOWN (never NaN-fresh)", () => {
    const file = writeFixture("nan", { fetchedAt: "not-a-timestamp", teams: [] });
    const { ageMs, unknownFreshness } = readStat(file, {});
    expect(unknownFreshness).toBe(true);
    expect(ageMs).toBeNull();
    expect(staleNote(file, ageMs, false, unknownFreshness)!.toLowerCase()).toContain(
      "no freshness metadata"
    );
  });
});

describe("checkHealth uses in-file timestamps (health.ts, B1)", () => {
  it("a genuinely-old odds file (mtime irrelevant) surfaces a stale reason via its timestamp", () => {
    // We can't point checkHealth at a temp file (fixed filenames), so this proves
    // the RULE that drives it: an old in-file timestamp yields >STALENESS_HOURS.
    expect(ageHoursFromData({ fetchedAt: twoDaysAgo, events: [] })!).toBeGreaterThan(4);
    // And a present-but-timestamp-less file → null → checkHealth emits the
    // "no freshness metadata" reason rather than treating it as fresh.
    expect(ageHoursFromData({ events: [] })).toBeNull();
  });

  it("checkHealth returns a well-formed report (smoke — does not throw)", () => {
    const h = checkHealth("MLB");
    expect(h.league).toBe("MLB");
    expect(Array.isArray(h.staleReasons)).toBe(true);
    expect(Array.isArray(h.entries)).toBe(true);
  });
});
