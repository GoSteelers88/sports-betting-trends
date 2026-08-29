/**
 * nfl-publish-board.ts — turn the PRIVATE doctrine board into the PUBLIC,
 * immutable, real-priced receipt at data/processed/nfl-live/.
 *
 *   npx tsx --env-file-if-exists=.env.local --env-file=.env \
 *     scripts/nfl-publish-board.ts <season> <week> [--model-board <path>] [--dry-run]
 *
 * Pipeline (every step hard-fails — a board with fabricated or missing data
 * must never publish looking intentional):
 *   1. Load the private model board (nfl-live-week.ts output). Its nflverse
 *      look-ahead prices are placeholder-grade and are DISCARDED here.
 *   2. FREE Odds API /events call → kickoffs + event ids for the whole slate.
 *   3. PAID /odds snapshot (h2h,spreads,totals · us) → the entry prices.
 *      Committed verbatim to snapshots/entry-<season>-wkNN.json (provenance).
 *   4. Re-price every model leg at the BEST real price for its exact point;
 *      a moved/missing point → leg publishes with entryPrice null and is
 *      permanently CLV-ineligible (never backfilled — ruling 4).
 *   5. Per-leg 12h kickoff gate — gated legs are DROPPED (listed with
 *      reasons); the board itself never delays (ruling 5).
 *   6. Control arm (frozen rule in src/lib/nfl-receipts/control-arm.ts):
 *      one deterministic placebo leg per PLAY leg, priced from the SAME
 *      snapshot at the same instant.
 *   7. Write board-<season>-wkNN.json (refuses to overwrite — boards are
 *      immutable), register its SHA256 in ledger.json, seed ledger rows.
 *
 * The publish path data/processed/nfl-live/ is verified NOT gitignored by
 * src/lib/nfl-receipts/__tests__/gitignore-anchor.test.ts (threat T6).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnvConfig } from "@next/env";
import { franchiseKey } from "../src/lib/nfl-receipts/teams";
import { legId, sha256OfFile } from "../src/lib/nfl-receipts/leg-id";
import {
  boardFileName,
  kickoffGate,
  type BoardMarket,
  type DroppedLeg,
  type LegSide,
  type PublishedBoard,
  type PublishedLeg,
} from "../src/lib/nfl-receipts/board";
import {
  drawControl,
  type ControlCandidate,
} from "../src/lib/nfl-receipts/control-arm";
import {
  fetchNflEvents,
  fetchNflOdds,
  extractPrice,
  mainPoint,
  type OddsApiEvent,
} from "../src/lib/nfl-receipts/odds-entry";
import {
  defaultLedgerPath,
  loadLedger,
  registerBoard,
  saveLedger,
  seedRowsFromBoard,
} from "../src/lib/nfl-receipts/ledger";
import { americanToDecimal } from "../src/lib/nfl-devig";

interface ModelLeg {
  gameId: string;
  matchup: string;
  market: BoardMarket;
  selection: string;
  verdict: "PLAY" | "PASS";
  passReason?: string;
  rawConfidence: number;
  haircutConfidence: number;
  calibratedConfidence?: number;
  stakeFraction?: number;
  edge?: number | null;
  evPct?: number | null;
  doctrineNotes?: string[];
}

interface ModelBoard {
  generatedAt: string;
  cursor: { season: number; week: number };
  board: ModelLeg[];
}

function fail(msg: string): never {
  console.error(`PUBLISH ABORTED: ${msg}`);
  process.exit(1);
}

/** nflverse gameId "2026_01_KC_PHI" → { awayAbbr, homeAbbr } */
function teamsFromGameId(gameId: string): { awayAbbr: string; homeAbbr: string } {
  const parts = gameId.split("_");
  if (parts.length !== 4) fail(`unparseable gameId "${gameId}"`);
  return { awayAbbr: parts[2], homeAbbr: parts[3] };
}

function parseSelection(
  leg: ModelLeg,
  awayAbbr: string,
  homeAbbr: string,
): { side: LegSide; point: number | null } {
  if (leg.market === "moneyline") {
    const team = leg.selection.replace(/\s+ML$/i, "").trim();
    if (team === homeAbbr) return { side: "home", point: null };
    if (team === awayAbbr) return { side: "away", point: null };
    fail(`moneyline selection "${leg.selection}" matches neither ${awayAbbr} nor ${homeAbbr}`);
  }
  if (leg.market === "ats") {
    const m = leg.selection.match(/^(\S+)\s+([+-]?\d+(?:\.\d+)?)$/);
    if (!m) fail(`unparseable ATS selection "${leg.selection}"`);
    const [, team, pt] = m;
    const side: LegSide =
      team === homeAbbr ? "home" : team === awayAbbr ? "away" : (fail(
        `ATS selection team "${team}" matches neither ${awayAbbr} nor ${homeAbbr}`,
      ) as never);
    return { side, point: Number(pt) };
  }
  const m = leg.selection.match(/^(OVER|UNDER)\s+(\d+(?:\.\d+)?)$/i);
  if (!m) fail(`unparseable total selection "${leg.selection}"`);
  return { side: m[1].toLowerCase() as LegSide, point: Number(m[2]) };
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const season = Number(process.argv[2]);
  const week = Number(process.argv[3]);
  if (!Number.isInteger(season) || !Number.isInteger(week))
    fail("usage: nfl-publish-board.ts <season> <week> [--model-board <path>] [--dry-run]");
  const dryRun = process.argv.includes("--dry-run");
  const mbFlag = process.argv.indexOf("--model-board");
  const modelBoardPath =
    mbFlag !== -1
      ? process.argv[mbFlag + 1]
      : path.join(
          process.cwd(),
          "data",
          "private",
          "nfl-loop",
          "live-boards",
          `${season}-REG-wk${week}.json`,
        );

  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) fail("THE_ODDS_API_KEY missing — run with --env-file-if-exists=.env.local --env-file=.env");
  if (!fs.existsSync(modelBoardPath))
    fail(`model board not found: ${modelBoardPath} — run nfl-live-week.ts first`);

  const outDir = path.join(process.cwd(), "data", "processed", "nfl-live");
  const boardFile = boardFileName(season, week);
  const boardPath = path.join(outDir, boardFile);
  if (fs.existsSync(boardPath))
    fail(`${boardFile} already exists — boards are immutable; corrections go to ledger errata`);

  const model = JSON.parse(fs.readFileSync(modelBoardPath, "utf8")) as ModelBoard;
  if (model.cursor.season !== season || model.cursor.week !== week)
    fail(
      `model board is ${model.cursor.season} wk${model.cursor.week}, not ${season} wk${week}`,
    );

  // ── 2+3: slate (free) + entry snapshot (paid) ─────────────────────────────
  console.log("fetching slate (/events, free) + entry snapshot (/odds, paid)…");
  const events = await fetchNflEvents(apiKey);
  const snapshot = await fetchNflOdds(apiKey);
  console.log(
    `  slate: ${events.length} events · snapshot: ${snapshot.events.length} events · quota remaining ${snapshot.quotaRemaining}`,
  );

  // Kickoffs keyed by franchise pair; the /events slate is authoritative.
  // The endpoint returns the WHOLE remaining season (272 events observed),
  // so divisional pairs appear twice — keep the EARLIEST upcoming event per
  // pair, or a week-1 game would inherit its December rematch's kickoff.
  const keepEarliest = (map: Map<string, OddsApiEvent>, e: OddsApiEvent) => {
    const hk = franchiseKey(e.home_team);
    const ak = franchiseKey(e.away_team);
    if (!hk || !ak) return;
    const key = `${ak}@${hk}`;
    const cur = map.get(key);
    if (!cur || Date.parse(e.commence_time) < Date.parse(cur.commence_time))
      map.set(key, e);
  };
  const byPair = new Map<string, OddsApiEvent>();
  for (const e of events) keepEarliest(byPair, e);
  const oddsByPair = new Map<string, OddsApiEvent>();
  for (const e of snapshot.events) keepEarliest(oddsByPair, e);

  const nowMs = Date.now();
  const legs: PublishedLeg[] = [];
  const dropped: DroppedLeg[] = [];
  const playGameIds = new Set(
    model.board.filter((l) => l.verdict === "PLAY").map((l) => l.gameId),
  );

  // ── 4+5: re-price at real entry, gate on kickoff ──────────────────────────
  for (const leg of model.board) {
    const { awayAbbr, homeAbbr } = teamsFromGameId(leg.gameId);
    const ak = franchiseKey(awayAbbr);
    const hk = franchiseKey(homeAbbr);
    if (!ak || !hk) fail(`unknown team abbr in ${leg.gameId}`);
    const pairKey = `${ak}@${hk}`;
    const slateEvent = byPair.get(pairKey);
    const kickoffUtc = slateEvent?.commence_time ?? null;

    const gate = kickoffGate(kickoffUtc, nowMs);
    const { side, point } = parseSelection(leg, awayAbbr, homeAbbr);
    if (gate) {
      dropped.push({
        gameId: leg.gameId,
        matchup: leg.matchup,
        market: leg.market,
        selection: leg.selection,
        reason: gate,
        kickoffUtc,
      });
      continue;
    }

    const oddsEvent = oddsByPair.get(pairKey);
    const price = oddsEvent
      ? extractPrice(oddsEvent, leg.market, side, point, "all")
      : null;

    const id = legId({
      boardFile,
      gameId: leg.gameId,
      market: leg.market,
      selection: leg.selection,
      point,
    });
    legs.push({
      legId: id,
      role: leg.verdict === "PLAY" ? "play" : "pass",
      gameId: leg.gameId,
      matchup: leg.matchup,
      kickoffUtc: kickoffUtc!,
      market: leg.market,
      selection: leg.selection,
      side,
      point,
      entryPriceAmerican: price?.american ?? null,
      entryOtherSideAmerican: price?.otherAmerican ?? null,
      priceProvenance: price
        ? {
            book: price.book,
            snapshotFile: `snapshots/entry-${season}-wk${String(week).padStart(2, "0")}.json`,
            snapshotFetchedAt: snapshot.fetchedAt,
            oddsApiEventId: price.oddsApiEventId,
          }
        : null,
      clvEligible: price != null,
      verdict: leg.verdict,
      passReason: leg.passReason,
      rawConfidence: leg.rawConfidence,
      haircutConfidence: leg.haircutConfidence,
      calibratedConfidence: leg.calibratedConfidence,
      stakeFraction: leg.stakeFraction,
      edge: leg.edge,
      evPct: leg.evPct,
      doctrineNotes: leg.doctrineNotes,
    });
  }

  // ── 6: control arm — one placebo per PLAY leg, same snapshot ──────────────
  const playLegs = legs.filter((l) => l.role === "play");
  for (const play of playLegs) {
    const pool: ControlCandidate[] = [];
    for (const [pairKey, slateEvent] of byPair) {
      // pool key is the slate; prices come from the odds snapshot
      const oddsEvent = oddsByPair.get(pairKey);
      const gid = slateEvent.commence_time.slice(0, 10) + "_" + pairKey; // synthetic, stable
      // exclude games carrying ANY play leg (frozen rule step 1)
      const carriesPlay = playLegs.some((l) => {
        const t = teamsFromGameId(l.gameId);
        return `${franchiseKey(t.awayAbbr)}@${franchiseKey(t.homeAbbr)}` === pairKey;
      });
      if (carriesPlay || !oddsEvent) continue;

      const prices: ControlCandidate["prices"] = {};
      if (play.market === "moneyline") {
        for (const s of ["home", "away"] as const) {
          const p = extractPrice(oddsEvent, "moneyline", s, null, "all");
          if (p) prices[s] = { american: p.american, otherAmerican: p.otherAmerican, point: null, book: p.book, oddsApiEventId: p.oddsApiEventId };
        }
      } else if (play.market === "ats") {
        const mp = mainPoint(oddsEvent, "ats", "home");
        if (mp != null) {
          for (const s of ["home", "away"] as const) {
            const pt = s === "home" ? mp : -mp;
            const p = extractPrice(oddsEvent, "ats", s, pt, "all");
            if (p) prices[s] = { american: p.american, otherAmerican: p.otherAmerican, point: pt, book: p.book, oddsApiEventId: p.oddsApiEventId };
          }
        }
      } else {
        const mp = mainPoint(oddsEvent, "total", "over");
        if (mp != null) {
          for (const s of ["over", "under"] as const) {
            const p = extractPrice(oddsEvent, "total", s, mp, "all");
            if (p) prices[s] = { american: p.american, otherAmerican: p.otherAmerican, point: mp, book: p.book, oddsApiEventId: p.oddsApiEventId };
          }
        }
      }
      if (Object.keys(prices).length === 0) continue;
      pool.push({
        gameId: gid,
        matchup: `${slateEvent.away_team} @ ${slateEvent.home_team}`,
        kickoffUtc: slateEvent.commence_time,
        publishable: kickoffGate(slateEvent.commence_time, nowMs) === null,
        prices,
      });
    }

    const draw = drawControl(play.legId, play.market, pool);
    if (!draw) {
      console.warn(`  control: empty pool for ${play.selection} — publishing unpaired`);
      continue;
    }
    // The play's legId is baked into the control's selection so control
    // identity is PER PAIR: two plays drawing the same game+side must not
    // collide into one ledger row (review finding 3). The frozen draw rule
    // is untouched — only the label carries the pairing.
    const controlSelection = `CONTROL[${play.legId}]:${draw.side}${draw.point != null ? ` ${draw.point}` : ""}`;
    const controlId = legId({
      boardFile,
      gameId: draw.gameId,
      market: play.market,
      selection: controlSelection,
      point: draw.point,
    });
    play.pairId = controlId;
    legs.push({
      legId: controlId,
      role: "control",
      pairId: play.legId,
      gameId: draw.gameId,
      matchup: draw.matchup,
      kickoffUtc: draw.kickoffUtc,
      market: play.market,
      selection: controlSelection,
      side: draw.side,
      point: draw.point,
      entryPriceAmerican: draw.american,
      entryOtherSideAmerican: draw.otherAmerican,
      priceProvenance:
        draw.american != null && draw.book
          ? {
              book: draw.book,
              snapshotFile: `snapshots/entry-${season}-wk${String(week).padStart(2, "0")}.json`,
              snapshotFetchedAt: snapshot.fetchedAt,
              oddsApiEventId: draw.oddsApiEventId ?? "",
            }
          : null,
      clvEligible: draw.american != null && draw.otherAmerican != null,
      verdict: "CONTROL",
    });
  }

  // ── Parlay block — prints only when ≥3 ML PLAY legs survived (ruling 8) ───
  const mlPlays = legs.filter(
    (l) => l.role === "play" && l.market === "moneyline" && l.entryPriceAmerican != null,
  );
  const parlay =
    mlPlays.length >= 3
      ? (() => {
          const top = [...mlPlays]
            .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0))
            .slice(0, 3);
          // A play leg without a confidence is a broken model board — fail
          // loud rather than print a 0% parlay (review finding 13).
          for (const l of top)
            if (l.haircutConfidence == null)
              fail(`parlay leg ${l.selection} missing haircutConfidence`);
          const combinedProb = top.reduce((s, l) => s * l.haircutConfidence!, 1);
          const combinedDecimal = top.reduce(
            (s, l) => s * americanToDecimal(l.entryPriceAmerican!),
            1,
          );
          return {
            legIds: top.map((l) => l.legId),
            combinedProb,
            combinedDecimal,
            evPct: (combinedProb * combinedDecimal - 1) * 100,
          };
        })()
      : null;

  // Every legId on a board must be unique — the ledger upserts by legId, so a
  // collision would silently collapse two published legs into one row.
  const ids = legs.map((l) => l.legId);
  if (new Set(ids).size !== ids.length) fail("duplicate legId on board — refusing to publish");

  const snapshotRel = `snapshots/entry-${season}-wk${String(week).padStart(2, "0")}.json`;
  const board: PublishedBoard = {
    schemaVersion: 1,
    season,
    week,
    publishedAt: new Date(nowMs).toISOString(),
    entrySnapshotFile: snapshotRel,
    entrySnapshotFetchedAt: snapshot.fetchedAt,
    oddsApiQuotaUsedAtPublish: snapshot.quotaUsed,
    modelBoardSource: path.basename(modelBoardPath),
    legs,
    dropped,
    parlay,
    note:
      "Immutable receipt. Entry prices are real book prices from the committed snapshot; " +
      "legs without a two-sided price at their exact point are shown but permanently excluded " +
      "from the CLV ledger. The verdict metric is devigged CLV vs the sharp close, PLAY arm " +
      "minus control arm. No ROI claim is made or implied (2025 holdout: negative).",
  };

  const plays = legs.filter((l) => l.role === "play").length;
  const priced = legs.filter((l) => l.clvEligible).length;
  console.log(
    `\nboard: ${legs.length} legs (${plays} PLAY, ${legs.filter((l) => l.role === "control").length} control) · ${priced} CLV-eligible · ${dropped.length} dropped by kickoff gate`,
  );
  for (const d of dropped) console.log(`  dropped: ${d.selection} [${d.market}] — ${d.reason}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  // ── 7: write board + snapshot, register in ledger ─────────────────────────
  fs.mkdirSync(path.join(outDir, "snapshots"), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, snapshotRel),
    JSON.stringify({ events, snapshot }, null, 2),
  );
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
  const sha = sha256OfFile(boardPath);

  const ledger = loadLedger(defaultLedgerPath());
  registerBoard(ledger, {
    file: boardFile,
    sha256: sha,
    publishedAt: board.publishedAt,
    season,
    week,
    publishRunId: process.env.GITHUB_RUN_ID ?? "local",
    errata: [],
  });
  seedRowsFromBoard(ledger, board);
  saveLedger(ledger);

  console.log(`\npublished ${boardFile}`);
  console.log(`  sha256 ${sha}`);
  console.log(`  entry snapshot → ${snapshotRel}`);
  console.log(`  ledger seeded → data/processed/nfl-live/ledger.json`);
  console.log(
    `\nnext: commit these three files in ONE commit (the commit SHA is the notary), then verify with npm run nfl:notary`,
  );
}

main().catch((err) => {
  console.error("PUBLISH ABORTED:", err);
  process.exit(1);
});
