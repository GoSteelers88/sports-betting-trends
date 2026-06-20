// data-freshness.ts — one honest answer to "is this data/processed JSON old
// enough that serving it as live would be a lie?"
//
// THE DISEASE THIS KILLS: stale-but-parseable JSON rendering as if it were
// today's data. It bit the prop pipeline three times — a May-6 scrape-props
// file served by /api/props/today, a 37-day-stale gamelog driving the
// projection board, a weekend slate the weekday-only cron never measured.
// None of those surfaced an error; they just showed wrong numbers with full
// confidence. The fix is a single, tested freshness primitive every reader
// can apply, plus a `Freshness` envelope a UI/API can render as a "stale"
// badge instead of silently trusting the bytes.
//
// Pure + deterministic — no fs, no clock except the injected `nowMs`, so it
// unit-tests without mocks and callers stay in control of "now".

export type FreshnessStatus = "fresh" | "stale" | "unknown";

export interface Freshness {
  /** The timestamp we judged against (the file's own generatedAt/fetchedAt). */
  generatedAt: string | null;
  /** Age in hours, or null when the timestamp is missing/unparseable. */
  ageHours: number | null;
  /** Threshold the age was compared against (hours). */
  maxAgeHours: number;
  /**
   * "fresh"   — has a valid timestamp AND age ≤ maxAgeHours.
   * "stale"   — has a valid timestamp but age > maxAgeHours.
   * "unknown" — no parseable timestamp at all (treated as NOT fresh: a file
   *             with no provenance cannot be trusted as live).
   */
  status: FreshnessStatus;
  /** Convenience: status === "fresh". The single gate most callers want. */
  isFresh: boolean;
}

/**
 * Judge a single timestamp against a max age. The cornerstone primitive.
 *
 * A missing/empty/unparseable timestamp is "unknown" → NOT fresh. We refuse to
 * treat a file with no provenance as live; the alternative (assume fresh) is
 * exactly the silent-staleness failure we're hunting.
 */
export function assessFreshness(
  generatedAt: string | null | undefined,
  maxAgeHours: number,
  nowMs: number = Date.now(),
): Freshness {
  const max = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 0;
  if (generatedAt == null || generatedAt === "") {
    return { generatedAt: null, ageHours: null, maxAgeHours: max, status: "unknown", isFresh: false };
  }
  const t = new Date(generatedAt).getTime();
  if (!Number.isFinite(t)) {
    return { generatedAt: null, ageHours: null, maxAgeHours: max, status: "unknown", isFresh: false };
  }
  // Clamp negative ages (a clock-skewed future timestamp) to 0 — a file stamped
  // slightly in the future is fresh, not "−2h old".
  const ageHours = +Math.max(0, (nowMs - t) / 3_600_000).toFixed(2);
  const status: FreshnessStatus = ageHours <= max ? "fresh" : "stale";
  return { generatedAt, ageHours, maxAgeHours: max, status, isFresh: status === "fresh" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-registered max ages, per data family. These encode the cadence each feed
// is SUPPOSED to refresh at, plus slack for a missed run. A reader past these
// is, by definition, not "today's" data.
//
//   PROPS_QUOTE  — sharp/soft prop quotes refresh on the daily props-board
//                  cron; 30h covers a single missed run without going stale on
//                  a normal day. (A two-day gap = genuinely stale → flag it.)
//   GAMELOG      — player game-logs are a multi-day rolling window refreshed
//                  nightly; 48h tolerates one missed nightly ingest. Past that,
//                  the projection board is reading history that excludes the
//                  most recent games → flag, don't pretend.
//   PITCHERS     — probable starters are a same-day fact; a list older than 30h
//                  describes yesterday's slate.
//   ODDS_SNAPSHOT— the live odds snapshot; 24h is generous for a daily slate.
// ─────────────────────────────────────────────────────────────────────────────
export const MAX_AGE_HOURS = {
  PROPS_QUOTE: 30,
  GAMELOG: 48,
  PITCHERS: 30,
  ODDS_SNAPSHOT: 24,
} as const;
