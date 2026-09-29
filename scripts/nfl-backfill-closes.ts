/**
 * nfl-backfill-closes.ts — Amendment 2 (2026-09-29): recover tier-2 closes for
 * legs whose live capture was missed, from The Odds API's stored historical
 * snapshots.
 *
 *   npx tsx --env-file-if-exists=.env.local --env-file=.env \
 *     scripts/nfl-backfill-closes.ts [--apply]
 *
 * Without --apply: prints the plan and its credit cost; spends nothing.
 *
 * Why this is needed: 2026-09-06 -> 09-28 the capture cron fired a median
 * 159 min late, so 128 legs kicked off with no close. Pinnacle (tier 1) keeps
 * no history — those are gone. The Odds API keeps 5-minute snapshots of the
 * tier-2 books (lowvig, betonlineag), so the tier-2 close IS recoverable.
 *
 * Rules (see docs/research/2026-08-29-nfl-receipts-preregistration.md,
 * Amendment 2):
 *   - one historical request per distinct kickoff, dated kickoff-1min; the
 *     returned snapshot must be BEFORE kickoff and no more than 30 min before
 *   - tier 2 only, exact-point discipline via the same deriveTier2Close the
 *     grader verifies with; a leg whose exact point is gone stays no_close
 *   - the trimmed snapshot is committed under closes/ with fetchedAt = the
 *     vendor's snapshot instant and retrievedAt = now, and every recovered
 *     close carries backfilledAt so it is never mistaken for a live capture
 *   - never replaces an existing close (live captures always win)
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
import { deriveTier2Close, TIER2_BOOKS, verifyCloses } from "../src/lib/nfl-receipts/close-derive";
import { fetchNflOddsHistorical, type OddsApiEvent } from "../src/lib/nfl-receipts/odds-entry";

const MARKETS = "h2h,spreads,totals";
const CREDITS_PER_CALL = 10 * MARKETS.split(",").length;
const MAX_STALENESS_MIN = 30;

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const apply = process.argv.includes("--apply");
  const root = process.cwd();
  const closesDir = path.join(root, "data", "processed", "nfl-live", "closes");
  const ledger = loadLedger(defaultLedgerPath());
  const nowMs = Date.now();

  const missed = ledger.rows.filter(
    (r) =>
      r.entryPriceAmerican != null &&
      !r.close &&
      (r.status === "no_close" || r.status === "pending") &&
      Date.parse(r.kickoffUtc) < nowMs,
  );
  const byKickoff = new Map<string, LedgerRow[]>();
  for (const r of missed) byKickoff.set(r.kickoffUtc, [...(byKickoff.get(r.kickoffUtc) ?? []), r]);
  const kickoffs = [...byKickoff.keys()].sort();

  console.log(
    `${missed.length} legs without a close across ${kickoffs.length} kickoffs · cost ${kickoffs.length * CREDITS_PER_CALL} credits`,
  );
  if (!apply) {
    for (const k of kickoffs) console.log(`  ${k}  ${byKickoff.get(k)!.length} legs`);
    console.log("\nplan only — re-run with --apply to fetch and record");
    return;
  }

  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) throw new Error("THE_ODDS_API_KEY missing (it lives in .env.local)");
  fs.mkdirSync(closesDir, { recursive: true });
  const retrievedAt = new Date().toISOString();

  let recovered = 0;
  let pointGone = 0;
  let quota = "unknown";
  for (const k of kickoffs) {
    const kMs = Date.parse(k);
    const dateIso = new Date(kMs - 60_000).toISOString().replace(/\.\d+Z$/, "Z");
    const snap = await fetchNflOddsHistorical(apiKey, dateIso, { markets: MARKETS, bookmakers: TIER2_BOOKS });
    quota = snap.quotaRemaining;
    const snapMs = Date.parse(snap.timestamp);
    const leadMin = (kMs - snapMs) / 60_000;
    if (!(leadMin > 0) || leadMin > MAX_STALENESS_MIN) {
      console.warn(`  ${k}: snapshot ${snap.timestamp} is ${leadMin.toFixed(1)} min before kickoff — outside (0, ${MAX_STALENESS_MIN}], skipped`);
      continue;
    }

    const stamp = snap.timestamp.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const rel = path.posix.join("data", "processed", "nfl-live", "closes", `oddsapi-tier2-historical-${stamp}.json`);
    const file = {
      fetchedAt: snap.timestamp,
      retrievedAt,
      source: "The Odds API /v4/historical (vendor snapshot taken pre-kickoff, retrieved after)",
      note: "Amendment 2 backfill — trimmed to benchmark tier-2 books for close recomputation",
      events: snap.events.map((e) => ({
        id: e.id,
        commence_time: e.commence_time,
        home_team: e.home_team,
        away_team: e.away_team,
        bookmakers: (e.bookmakers ?? []).filter((b) => TIER2_BOOKS.includes(b.key)),
      })),
    };
    fs.writeFileSync(path.join(root, rel), JSON.stringify(file, null, 2));

    let here = 0;
    for (const row of byKickoff.get(k)!) {
      const p = deriveTier2Close(
        { matchup: row.matchup, kickoffUtc: row.kickoffUtc, market: row.market, side: row.side, point: row.point },
        file.events as OddsApiEvent[],
        TIER2_BOOKS,
      );
      if (!p) {
        pointGone++;
        continue;
      }
      recordClose(ledger, row.legId, {
        book: p.book,
        tier: 2,
        sideAmerican: p.sideAmerican,
        otherAmerican: p.otherAmerican,
        capturedAt: snap.timestamp,
        minutesBeforeKickoff: Math.round(leadMin),
        sourceFile: rel,
        backfilledAt: retrievedAt,
      });
      here++;
    }
    recovered += here;
    console.log(`  ${k}: snapshot T-${leadMin.toFixed(1)}m · ${here}/${byKickoff.get(k)!.length} legs recovered`);
  }

  // Frozen anchor: every close must re-derive from the committed bytes it
  // names — the same check the grader refuses to run without.
  const check = verifyCloses(ledger, root);
  if (check.failures.length > 0) {
    for (const f of check.failures) console.error(`  VERIFY FAIL ${f.legId}: ${f.reason}`);
    throw new Error(`${check.failures.length} recovered close(s) failed re-derivation — ledger NOT saved`);
  }
  saveLedger(ledger);
  console.log(
    `\nrecovered ${recovered}/${missed.length} · exact point gone (stay no_close): ${pointGone} · verified ${check.verified} · quota remaining ${quota}`,
  );
}

main().catch((err) => {
  console.error("BACKFILL FAILED:", err);
  process.exit(1);
});
