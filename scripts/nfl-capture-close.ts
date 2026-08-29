/**
 * nfl-capture-close.ts — capture sharp closing prices for every pending
 * ledger leg kicking off soon (threat T3: a missed close is PERMANENTLY
 * unrecoverable — the /odds endpoint drops completed events and backfill is
 * forbidden by ruling 4).
 *
 *   npx tsx --env-file-if-exists=.env.local --env-file=.env \
 *     scripts/nfl-capture-close.ts [--window-hours 3] [--no-oddsapi]
 *
 * Benchmark chain (frozen — see nfl-clv-metric.ts):
 *   tier 1  pinnacle  — read from the NEWEST ARCHIVED scrape in
 *                       data/processed/nfl-live/closes/ (the nfl-closes
 *                       workflow runs scrape-pinnacle --strict --archive
 *                       immediately before this). The archive IS the
 *                       sourceFile the grader's close-verifier re-derives
 *                       from, so an uncommitted "latest" cache is never
 *                       load-bearing. Must be fresh (<30 min) to count.
 *   tier 2  lowvig → betonlineag — from a paid Odds API snapshot (3 credits),
 *                       trimmed to just those books and archived alongside.
 * A higher tier always wins; same tier → latest capture wins (the close).
 * All derivation goes through src/lib/nfl-receipts/close-derive.ts — the
 * same functions the grader uses to verify every close against committed
 * bytes, so capture and verification cannot drift apart.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnvConfig } from "@next/env";
import {
  defaultLedgerPath,
  loadLedger,
  recordClose,
  saveLedger,
  type LedgerRow,
} from "../src/lib/nfl-receipts/ledger";
import {
  derivePinnacleClose,
  deriveTier2Close,
  TIER2_BOOKS,
  type CloseTarget,
} from "../src/lib/nfl-receipts/close-derive";
import { fetchNflOdds, type OddsApiEvent } from "../src/lib/nfl-receipts/odds-entry";
import type { SharpEventLike } from "../src/lib/nfl-receipts/site-slate";

const PINNACLE_MAX_AGE_MIN = 30;

interface PinnacleArchive {
  fetchedAt: string;
  events: SharpEventLike[];
}

function targetOf(row: LedgerRow): CloseTarget {
  return {
    matchup: row.matchup,
    kickoffUtc: row.kickoffUtc,
    market: row.market,
    side: row.side,
    point: row.point,
  };
}

function newestPinnacleArchive(closesDir: string): { rel: string; data: PinnacleArchive } | null {
  if (!fs.existsSync(closesDir)) return null;
  const files = fs
    .readdirSync(closesDir)
    .filter((f) => f.startsWith("pinnacle-americanfootball_nfl-"))
    .sort();
  if (!files.length) return null;
  const rel = path.posix.join("data", "processed", "nfl-live", "closes", files[files.length - 1]);
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(closesDir, files[files.length - 1]), "utf8"),
    ) as PinnacleArchive;
    return { rel, data };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const argv = process.argv.slice(2);
  const wIdx = argv.indexOf("--window-hours");
  const windowHours = wIdx !== -1 ? Number(argv[wIdx + 1]) : 3;
  const useOddsApi = !argv.includes("--no-oddsapi");

  const root = process.cwd();
  const closesDir = path.join(root, "data", "processed", "nfl-live", "closes");
  const ledger = loadLedger(defaultLedgerPath());
  const nowMs = Date.now();

  // Rows still worth capturing: CLV-eligible, not kicked off, kicking off soon.
  const targets = ledger.rows.filter((r) => {
    if (r.status !== "pending" || r.entryPriceAmerican == null) return false;
    const t = Date.parse(r.kickoffUtc);
    return (
      Number.isFinite(t) && t > nowMs && t - nowMs <= windowHours * 3600_000
    );
  });
  if (targets.length === 0) {
    console.log(`no pending legs kick off within ${windowHours}h — nothing to capture`);
    return;
  }
  console.log(`${targets.length} legs kick off within ${windowHours}h`);

  // ── tier 1: newest COMMITTED pinnacle archive (scraped just before) ───────
  const archive = newestPinnacleArchive(closesDir);
  let pin: PinnacleArchive | null = null;
  let pinRel: string | null = null;
  if (archive) {
    const ageMin = (nowMs - Date.parse(archive.data.fetchedAt)) / 60_000;
    if (ageMin <= PINNACLE_MAX_AGE_MIN) {
      pin = archive.data;
      pinRel = archive.rel;
    } else {
      console.warn(
        `newest pinnacle archive is ${ageMin.toFixed(0)} min old (> ${PINNACLE_MAX_AGE_MIN}) — tier 1 skipped this tick (run scrape-pinnacle --leagues nfl --strict --archive data/processed/nfl-live/closes first)`,
      );
    }
  } else {
    console.warn("no pinnacle archive in closes/ — tier 1 skipped this tick");
  }

  let tier1 = 0;
  if (pin && pinRel) {
    for (const row of targets) {
      const close = derivePinnacleClose(targetOf(row), pin.events);
      if (!close) continue;
      recordClose(ledger, row.legId, {
        book: "pinnacle",
        tier: 1,
        sideAmerican: close.sideAmerican,
        otherAmerican: close.otherAmerican,
        capturedAt: pin.fetchedAt,
        minutesBeforeKickoff: Math.round(
          (Date.parse(row.kickoffUtc) - Date.parse(pin.fetchedAt)) / 60_000,
        ),
        sourceFile: pinRel,
      });
      tier1++;
    }
  }

  // ── tier 2: lowvig → betonlineag via Odds API, exact point only ───────────
  let tier2 = 0;
  if (useOddsApi) {
    const apiKey = process.env.THE_ODDS_API_KEY;
    if (!apiKey) {
      console.error("THE_ODDS_API_KEY missing and --no-oddsapi not passed — hard fail (a silent tier-2 skip would shrink coverage invisibly)");
      process.exit(1);
    }
    const snap = await fetchNflOdds(apiKey);
    // Archive a TRIMMED copy (tier-2 books only) so every counted close is
    // recomputable from committed bytes (threat T16 + the close-verifier).
    const trimmed = {
      fetchedAt: snap.fetchedAt,
      note: "trimmed to benchmark tier-2 books for close recomputation",
      events: snap.events.map((e) => ({
        id: e.id,
        commence_time: e.commence_time,
        home_team: e.home_team,
        away_team: e.away_team,
        bookmakers: (e.bookmakers ?? []).filter((b) => TIER2_BOOKS.includes(b.key)),
      })),
    };
    fs.mkdirSync(closesDir, { recursive: true });
    const stamp = snap.fetchedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const trimmedRel = path.posix.join(
      "data", "processed", "nfl-live", "closes", `oddsapi-tier2-${stamp}.json`,
    );
    fs.writeFileSync(path.join(root, trimmedRel), JSON.stringify(trimmed, null, 2));

    for (const row of targets) {
      const p = deriveTier2Close(targetOf(row), trimmed.events as OddsApiEvent[], TIER2_BOOKS);
      if (!p) continue;
      recordClose(ledger, row.legId, {
        book: p.book,
        tier: 2,
        sideAmerican: p.sideAmerican,
        otherAmerican: p.otherAmerican,
        capturedAt: snap.fetchedAt,
        minutesBeforeKickoff: Math.round(
          (Date.parse(row.kickoffUtc) - Date.parse(snap.fetchedAt)) / 60_000,
        ),
        sourceFile: trimmedRel,
      });
      tier2++;
    }
    console.log(`  quota remaining: ${snap.quotaRemaining}`);
  }

  saveLedger(ledger);
  const covered = targets.filter((r) => r.close).length;
  console.log(
    `captured: tier1(pinnacle)=${tier1} tier2=${tier2} · ${covered}/${targets.length} in-window legs now hold a close`,
  );
  // Dead-man's switch on the OUTCOME, not the plumbing (review finding 8):
  // a fresh Pinnacle file that matches zero in-window legs (join failure,
  // every point moved) is exactly as fatal as a dead feed — legs are about
  // to kick off with no benchmark close and no recovery path.
  if (covered === 0 && targets.length > 0) {
    console.error(
      "ZERO in-window legs hold a close after this tick — failing loud while the close is still capturable (dead-man's switch)",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("CAPTURE FAILED:", err);
  process.exit(1);
});
