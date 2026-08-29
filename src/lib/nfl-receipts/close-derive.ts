// close-derive.ts — the ONE implementation of "what is this leg's close in
// this snapshot", shared by capture (nfl-capture-close.ts) and the grader's
// close-verifier (round-2 review ruling: a forged `close` object on a pending
// row would grade a forged verdict; every graded number must derive from
// committed bytes).
//
// Capture records a close by deriving it from a snapshot file it just
// committed; the verifier re-derives the same close from the same committed
// file and refuses to grade on any mismatch. Because both sides call the
// functions below, a divergence means the LEDGER changed — not the code.

import * as fs from "node:fs";
import * as path from "node:path";
import { sameGame } from "./teams";
import { extractPrice, type OddsApiEvent } from "./odds-entry";
import type { SharpEventLike } from "./site-slate";
import type { BoardMarket, LegSide } from "./board";
import type { CapturedClose, Ledger } from "./ledger";

/** Frozen tier-2 fallback priority (pre-registration §3). */
export const TIER2_BOOKS = ["lowvig", "betonlineag"];

export interface CloseTarget {
  matchup: string; // "AWAY @ HOME" — abbrs or full names, franchiseKey bridges
  kickoffUtc: string;
  market: BoardMarket;
  side: LegSide;
  point: number | null;
}

export function targetGame(t: CloseTarget): { kickoffUtc: string; home: string; away: string } {
  const [away, home] = t.matchup.split(" @ ");
  return { kickoffUtc: t.kickoffUtc, home: home ?? "", away: away ?? "" };
}

/** Tier-1: the leg's two-sided close from a Pinnacle archive's events.
 *  Exact-point discipline throughout — a moved main line derives nothing. */
export function derivePinnacleClose(
  t: CloseTarget,
  events: SharpEventLike[],
): { sideAmerican: number; otherAmerican: number } | null {
  const game = targetGame(t);
  const ev = events.find((e) =>
    sameGame(game, { kickoffUtc: e.commence_time, home: e.home_team, away: e.away_team }),
  );
  if (!ev) return null;
  if (t.market === "moneyline") {
    if (!ev.moneyline) return null;
    return t.side === "home"
      ? { sideAmerican: ev.moneyline.home, otherAmerican: ev.moneyline.away }
      : { sideAmerican: ev.moneyline.away, otherAmerican: ev.moneyline.home };
  }
  if (t.market === "ats") {
    if (!ev.spread || t.point == null) return null;
    // spread.point is the HOME line; the target's point is side-relative.
    const homePoint = t.side === "home" ? t.point : -t.point;
    if (ev.spread.point !== homePoint) return null;
    return t.side === "home"
      ? { sideAmerican: ev.spread.home, otherAmerican: ev.spread.away }
      : { sideAmerican: ev.spread.away, otherAmerican: ev.spread.home };
  }
  if (!ev.total || t.point == null) return null;
  if (ev.total.point !== t.point) return null;
  return t.side === "over"
    ? { sideAmerican: ev.total.over, otherAmerican: ev.total.under }
    : { sideAmerican: ev.total.under, otherAmerican: ev.total.over };
}

/** Tier-2: the leg's close from an Odds API snapshot's events, restricted to
 *  the given books in priority order (capture passes TIER2_BOOKS; the
 *  verifier passes [the stored book] so verification is book-specific). */
export function deriveTier2Close(
  t: CloseTarget,
  events: OddsApiEvent[],
  books: string[],
): { book: string; sideAmerican: number; otherAmerican: number } | null {
  const game = targetGame(t);
  const ev = events.find((e) =>
    sameGame(game, { kickoffUtc: e.commence_time, home: e.home_team, away: e.away_team }),
  );
  if (!ev) return null;
  const p = extractPrice(ev, t.market, t.side, t.point, books);
  return p ? { book: p.book, sideAmerican: p.american, otherAmerican: p.otherAmerican } : null;
}

// ─── The grader-side verifier ────────────────────────────────────────────────

export interface CloseVerifyFailure {
  legId: string;
  reason: string;
}

interface SnapshotFile {
  fetchedAt: string;
  events: unknown[];
}

/** Re-derive every recorded close from the committed snapshot it names.
 *  Any row whose close cannot be reproduced byte-for-byte from its
 *  sourceFile is a failure — the grader treats failures like orphans:
 *  refuse to grade anything. */
export function verifyCloses(ledger: Ledger, root = process.cwd()): {
  verified: number;
  failures: CloseVerifyFailure[];
} {
  let verified = 0;
  const failures: CloseVerifyFailure[] = [];
  const cache = new Map<string, SnapshotFile | null>();

  const loadSnapshot = (rel: string): SnapshotFile | null => {
    if (cache.has(rel)) return cache.get(rel)!;
    const abs = path.join(root, rel);
    let parsed: SnapshotFile | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(abs, "utf8")) as SnapshotFile;
    } catch {
      parsed = null;
    }
    cache.set(rel, parsed);
    return parsed;
  };

  for (const row of ledger.rows) {
    const close: CapturedClose | undefined = row.close;
    if (!close) continue;
    const fail = (reason: string) => failures.push({ legId: row.legId, reason });

    const snap = loadSnapshot(close.sourceFile);
    if (!snap || !Array.isArray(snap.events)) {
      fail(`close sourceFile missing/unparseable: ${close.sourceFile}`);
      continue;
    }
    // The close must be bound to the SPECIFIC snapshot instant it names —
    // same-tier-later-wins makes "any snapshot roughly agrees" insufficient.
    if (snap.fetchedAt !== close.capturedAt) {
      fail(
        `close capturedAt ${close.capturedAt} != sourceFile fetchedAt ${snap.fetchedAt}`,
      );
      continue;
    }

    const target: CloseTarget = {
      matchup: row.matchup,
      kickoffUtc: row.kickoffUtc,
      market: row.market,
      side: row.side,
      point: row.point,
    };

    if (close.tier === 1) {
      if (close.book !== "pinnacle") {
        fail(`tier-1 close claims book "${close.book}"`);
        continue;
      }
      const derived = derivePinnacleClose(target, snap.events as SharpEventLike[]);
      if (!derived) {
        fail(`tier-1 close not derivable from ${close.sourceFile}`);
        continue;
      }
      if (
        derived.sideAmerican !== close.sideAmerican ||
        derived.otherAmerican !== close.otherAmerican
      ) {
        fail(
          `tier-1 close mismatch: stored ${close.sideAmerican}/${close.otherAmerican}, derived ${derived.sideAmerican}/${derived.otherAmerican}`,
        );
        continue;
      }
    } else {
      const derived = deriveTier2Close(target, snap.events as OddsApiEvent[], [close.book]);
      if (!derived) {
        fail(`tier-2 close not derivable from ${close.sourceFile} at book ${close.book}`);
        continue;
      }
      if (
        derived.sideAmerican !== close.sideAmerican ||
        derived.otherAmerican !== close.otherAmerican
      ) {
        fail(
          `tier-2 close mismatch at ${close.book}: stored ${close.sideAmerican}/${close.otherAmerican}, derived ${derived.sideAmerican}/${derived.otherAmerican}`,
        );
        continue;
      }
    }
    verified++;
  }
  return { verified, failures };
}
