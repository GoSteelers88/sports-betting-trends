/**
 * nfl-capture-close.ts — capture sharp closing prices for every pending
 * ledger leg kicking off soon (threat T3: a missed close is PERMANENTLY
 * unrecoverable on the free tier — the /odds endpoint drops completed events
 * and backfill is forbidden by ruling 4).
 *
 *   npx tsx --env-file-if-exists=.env.local --env-file=.env \
 *     scripts/nfl-capture-close.ts [--window-hours 6] [--no-oddsapi]
 *
 * Benchmark chain (frozen — see nfl-clv-metric.ts):
 *   tier 1  pinnacle  — read from latest-sharp-pinnacle-americanfootball_nfl.json,
 *                       which the nfl-closes workflow scrapes STRICT + archives
 *                       to data/processed/nfl-live/closes/ immediately before
 *                       this script runs. Must be fresh (<30 min) to count.
 *   tier 2  lowvig → betonlineag — from a paid Odds API snapshot (3 credits),
 *                       trimmed to just those books and archived alongside.
 * A higher tier always wins; same tier → latest capture wins (the close).
 * Spread/total closes must match the leg's EXACT point — a moved point is
 * skipped, never substituted (threat T12).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnvConfig } from "@next/env";
import { franchiseKey, sameGame } from "../src/lib/nfl-receipts/teams";
import {
  defaultLedgerPath,
  loadLedger,
  recordClose,
  saveLedger,
  type LedgerRow,
} from "../src/lib/nfl-receipts/ledger";
import {
  fetchNflOdds,
  extractPrice,
  type OddsApiEvent,
} from "../src/lib/nfl-receipts/odds-entry";
import type { SharpEvent } from "./scrape-pinnacle";

const TIER2_BOOKS = ["lowvig", "betonlineag"]; // frozen priority order
const PINNACLE_MAX_AGE_MIN = 30;

interface PinnacleFile {
  fetchedAt: string;
  events: SharpEvent[];
}

function rowGame(row: LedgerRow): { kickoffUtc: string; home: string; away: string } {
  const [away, home] = row.matchup.split(" @ ");
  return { kickoffUtc: row.kickoffUtc, home: home ?? "", away: away ?? "" };
}

function latestClosesFile(closesDir: string, prefix: string): string | null {
  if (!fs.existsSync(closesDir)) return null;
  const files = fs
    .readdirSync(closesDir)
    .filter((f) => f.startsWith(prefix))
    .sort();
  return files.length ? path.join(closesDir, files[files.length - 1]) : null;
}

function pinnacleClose(
  row: LedgerRow,
  pin: PinnacleFile,
): { sideAmerican: number; otherAmerican: number } | null {
  const game = rowGame(row);
  const ev = pin.events.find((e) =>
    sameGame(game, { kickoffUtc: e.commence_time, home: e.home_team, away: e.away_team }),
  );
  if (!ev) return null;
  if (row.market === "moneyline") {
    if (!ev.moneyline) return null;
    return row.side === "home"
      ? { sideAmerican: ev.moneyline.home, otherAmerican: ev.moneyline.away }
      : { sideAmerican: ev.moneyline.away, otherAmerican: ev.moneyline.home };
  }
  if (row.market === "ats") {
    if (!ev.spread || row.point == null) return null;
    // spread.point is the HOME line; our row.point is relative to row.side.
    const homePoint = row.side === "home" ? row.point : -row.point;
    if (ev.spread.point !== homePoint) return null; // moved point — never substitute
    return row.side === "home"
      ? { sideAmerican: ev.spread.home, otherAmerican: ev.spread.away }
      : { sideAmerican: ev.spread.away, otherAmerican: ev.spread.home };
  }
  if (!ev.total || row.point == null) return null;
  if (ev.total.point !== row.point) return null;
  return row.side === "over"
    ? { sideAmerican: ev.total.over, otherAmerican: ev.total.under }
    : { sideAmerican: ev.total.under, otherAmerican: ev.total.over };
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const argv = process.argv.slice(2);
  const wIdx = argv.indexOf("--window-hours");
  const windowHours = wIdx !== -1 ? Number(argv[wIdx + 1]) : 6;
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

  // ── tier 1: pinnacle (scraped immediately before by the workflow) ─────────
  const pinPath = path.join(
    root,
    "data",
    "processed",
    "latest-sharp-pinnacle-americanfootball_nfl.json",
  );
  let pin: PinnacleFile | null = null;
  if (fs.existsSync(pinPath)) {
    const parsed = JSON.parse(fs.readFileSync(pinPath, "utf8")) as PinnacleFile;
    const ageMin = (nowMs - Date.parse(parsed.fetchedAt)) / 60_000;
    if (ageMin <= PINNACLE_MAX_AGE_MIN) pin = parsed;
    else
      console.warn(
        `pinnacle snapshot is ${ageMin.toFixed(0)} min old (> ${PINNACLE_MAX_AGE_MIN}) — tier 1 skipped this tick`,
      );
  } else {
    console.warn("no pinnacle snapshot on disk — tier 1 skipped this tick");
  }
  const pinArchive = latestClosesFile(closesDir, "pinnacle-americanfootball_nfl-");

  let tier1 = 0;
  if (pin) {
    for (const row of targets) {
      const close = pinnacleClose(row, pin);
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
        sourceFile: pinArchive ? path.relative(root, pinArchive) : "latest-sharp-pinnacle-americanfootball_nfl.json",
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
    // recomputable from committed bytes (threat T16).
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
    const trimmedPath = path.join(closesDir, `oddsapi-tier2-${stamp}.json`);
    fs.writeFileSync(trimmedPath, JSON.stringify(trimmed, null, 2));

    const byPair = new Map<string, OddsApiEvent>();
    for (const e of trimmed.events as OddsApiEvent[]) {
      const hk = franchiseKey(e.home_team);
      const ak = franchiseKey(e.away_team);
      if (hk && ak) byPair.set(`${ak}@${hk}`, e);
    }
    for (const row of targets) {
      const g = rowGame(row);
      const ev = byPair.get(`${franchiseKey(g.away)}@${franchiseKey(g.home)}`);
      if (!ev) continue;
      const p = extractPrice(ev, row.market, row.side, row.point, TIER2_BOOKS);
      if (!p) continue;
      recordClose(ledger, row.legId, {
        book: p.book,
        tier: 2,
        sideAmerican: p.american,
        otherAmerican: p.otherAmerican,
        capturedAt: snap.fetchedAt,
        minutesBeforeKickoff: Math.round(
          (Date.parse(row.kickoffUtc) - Date.parse(snap.fetchedAt)) / 60_000,
        ),
        sourceFile: path.relative(root, trimmedPath),
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
