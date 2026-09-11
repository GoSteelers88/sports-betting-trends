/**
 * nfl-live-week.ts — ONE-OFF live-week selection runner for Experiment No. 5.
 *
 *   npx tsx --env-file=.env scripts/nfl-live-week.ts [season] [week]
 *
 * Runs the SAME blind-pick machinery as the backtest loop (nfl-week.ts) against
 * a live/future week, then applies the durable doctrine's selection discipline
 * as a deterministic post-pass. READ-ONLY against loop state: never advances
 * cursor.json, never upserts picks-log.jsonl. Board is written to
 * data/private/nfl-loop/live-boards/ (private, gitignored).
 *
 * Doctrine rules encoded in the post-pass (see lessons/nfl-doctrine.md):
 *   1. Calibration haircut: raw confidence in [0.60, 0.70) → −4pp.
 *   2. ML is the primary vehicle; when the model lays ≥4.5 ATS, prefer ML.
 *   3. Edge floor 3% (quant desk) vs de-vigged two-way moneyline; non-divisional
 *      games require a higher bar (+2pp → 5%).
 *   4. Home favorites with raw confidence in [0.54, 0.60) are a documented trap:
 *      require a secondary edge (divisional or dome; rest is neutral in week 1).
 *   5. Totals de-emphasized: 65%+ confidence floor, else dropped.
 *   6. Parlay: top-3 ML legs by edge, distinct games, per-leg haircut already
 *      applied; report combined prob + EV at the listed prices.
 *
 * All edges are model-vs-market at TODAY's look-ahead lines — a live pick, not
 * a backtest. CLV verdict comes later (entry price vs close).
 *
 * ── 2026 DOCTRINE TIGHTENING (2026-08-29, after the negative 2025 holdout) ──
 * Decision doc: docs/research/2026-08-29-doctrine-2026-tightening.md
 *   T1. The ML floor becomes CONJUNCTIVE: the edge must clear the floor under
 *       BOTH the haircut raw confidence (pre-existing gate, evaluateGame) and
 *       the per-market CALIBRATED probability (this post-pass). Calibrated-
 *       only would be LOOSER (the walk's ML map corrects upward) and would
 *       re-assert the exact claim the holdout refuted. Floors unchanged
 *       (3% div / 5% non-div).
 *   T2. ATS legs are RETIRED for 2026 — every ATS slice was negative out of
 *       sample (overall 48.6%, dogs −3.6%, favorites −14.9%). Reads still
 *       print; verdict is always PASS.
 *   T3. Totals likewise (51.6% < 52.4% BE out of sample, −12.1% in-walk).
 * Tightening only: this pass can flip PLAY → PASS, never PASS → PLAY.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultStateDir,
  loadGames,
  gamesForCursor,
  assertSpreadConvention,
  loadInjuries,
  loadPlayerStats,
  loadGradedRows,
  buildBlindWeek,
  type Cursor,
  type BlindGame,
  type GamePick,
} from "../src/lib/nfl-loop";
import { makeClaudePickFn } from "../src/lib/nfl-agent";
import {
  calibrate,
  fitBetaCalibration,
  kellyStakeFraction,
} from "../src/lib/nfl-calibration";
import {
  americanToDecimal,
  expectedValue,
} from "../src/lib/devig";
import {
  applyForecasts,
  applyReferees,
  computeEpaFeatures,
  espnInjuriesToRows,
  gateFairProb,
  mergeInjuryRows,
  type EspnInjuryFile,
  type OfficialsFile,
  type TeamGameEpa,
  type WeatherFile,
} from "../src/lib/nfl-live-inputs";
import { loadLiveGradedRows } from "../src/lib/nfl-live-grade";
import { QUANT_DESK_CONFIG } from "../src/lib/quant-desk/engine";

const B = "\x1b[1m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const RED = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const C = "\x1b[36m";

const EDGE_FLOOR = QUANT_DESK_CONFIG.edgeFloor; // 3%
const NON_DIV_EDGE_FLOOR = EDGE_FLOOR + 0.02; // doctrine: higher bar off-division
const TOTAL_CONF_FLOOR = 0.65; // doctrine: totals need 65%+
const HAIRCUT_PP = 0.04; // doctrine: 60–70% band overconfidence
const ATS_LAY_CEILING = 4.5; // doctrine: prefer ML when laying this or more

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function ml(n: number | null): string {
  if (n == null) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

type BoardLeg = {
  gameId: string;
  matchup: string;
  market: "moneyline" | "ats" | "total";
  selection: string;
  priceAmerican: number;
  rawConfidence: number;
  haircutConfidence: number;
  marketFairProb: number | null;
  edge: number | null;
  evPct: number | null;
  divGame: boolean;
  dome: boolean;
  doctrineNotes: string[];
  verdict: "PLAY" | "PASS";
  passReason?: string;
  /** rawConfidence through the beta-calibration map fitted on the walk's
   *  graded record (research rec 3) — the probability the stake is sized on. */
  calibratedConfidence?: number;
  /** Quarter-Kelly fraction of bankroll, computed IN CODE from the calibrated
   *  probability at the actual price. 0 for PASS legs. The model never sizes. */
  stakeFraction?: number;
};

function haircut(conf: number): number {
  return conf >= 0.6 && conf < 0.7 ? conf - HAIRCUT_PP : conf;
}

function evaluateGame(g: BlindGame, p: GamePick): BoardLeg[] {
  const legs: BoardLeg[] = [];
  const matchup = `${g.away} @ ${g.home}`;
  const dome = g.context.roof === "dome" || g.context.roof === "closed";
  const div = g.context.divGame === true;
  const raw = p.confidence;
  const adj = haircut(raw);
  const notesBase: string[] = [];
  if (adj !== raw) notesBase.push(`haircut −4pp (60–70% band): ${pct(raw)} → ${pct(adj)}`);
  if (div) notesBase.push("divisional (profit engine, floor 3%)");
  else notesBase.push("non-divisional (raised floor 5%)");
  if (dome) notesBase.push("dome environment (directional +)");

  // ── Moneyline (the doctrine's primary vehicle) ────────────────────────────
  const am = g.market.awayMoneyline;
  const hm = g.market.homeMoneyline;
  if (am != null && hm != null) {
    const side = p.moneylineSide;
    const price = side === "home" ? hm : am;
    const other = side === "home" ? am : hm;
    // T4 (2026-09-10): the gate's fair probability is the HIGHEST across the
    // four devig methods (multiplicative / odds-weighted / power / Shin) — the
    // smallest edge. Until T4 this was the naive proportional split alone,
    // which research rec 7 flagged as the one method that mints phantom dog
    // value. Tightening-only; measured 0/16 verdict flips on the wk1 board.
    const fairProb: number | null = gateFairProb(price, other);
    const edge = fairProb == null ? null : adj - fairProb;
    const ev = expectedValue(adj, price);
    const notes = [...notesBase];
    const floor = div ? EDGE_FLOOR : NON_DIV_EDGE_FLOOR;

    let verdict: BoardLeg["verdict"] = "PASS";
    let passReason: string | undefined;

    const isHomeFav = side === "home" && hm < 0;
    const trapBand = isHomeFav && raw >= 0.54 && raw < 0.6;
    const secondaryEdge = div || dome; // rest is 7v7 across week 1 → neutral
    if (edge == null) {
      passReason = "no de-viggable two-way price";
    } else if (trapBand && !secondaryEdge) {
      passReason = "home-favorite 54–60% trap, no secondary edge";
      notes.push("doctrine trap: home chalk in 54–60% band");
    } else if (edge < floor) {
      passReason = `edge ${pct(edge)} < floor ${pct(floor)}`;
    } else {
      verdict = "PLAY";
      if (trapBand) notes.push("trap band but secondary edge present");
    }

    legs.push({
      gameId: g.gameId,
      matchup,
      market: "moneyline",
      selection: `${side === "home" ? g.home : g.away} ML`,
      priceAmerican: price,
      rawConfidence: raw,
      haircutConfidence: adj,
      marketFairProb: fairProb,
      edge,
      evPct: ev,
      divGame: div,
      dome,
      doctrineNotes: notes,
      verdict,
      passReason,
    });
  }

  // ── ATS (secondary; doctrine: don't lay 4.5+ when the read is "team wins") ─
  if (g.market.spreadLineHome != null) {
    const side = p.atsSide;
    const homeSpread = g.market.spreadLineHome;
    const sideSpread = side === "home" ? homeSpread : -homeSpread;
    const laying = sideSpread < 0 ? Math.abs(sideSpread) : 0;
    const notes = [...notesBase];
    let verdict: BoardLeg["verdict"] = "PASS";
    let passReason: string | undefined;
    if (laying >= ATS_LAY_CEILING) {
      passReason = `laying ${laying} ≥ ${ATS_LAY_CEILING} — doctrine says take the ML instead`;
    } else if (adj < 0.6) {
      passReason = `confidence ${pct(adj)} below ATS selectivity bar (60%)`;
    } else {
      verdict = "PLAY";
    }
    legs.push({
      gameId: g.gameId,
      matchup,
      market: "ats",
      selection: `${side === "home" ? g.home : g.away} ${sideSpread > 0 ? "+" : ""}${sideSpread}`,
      priceAmerican: -110,
      rawConfidence: raw,
      haircutConfidence: adj,
      marketFairProb: null,
      edge: null,
      evPct: null,
      divGame: div,
      dome,
      doctrineNotes: notes,
      verdict,
      passReason,
    });
  }

  // ── Total (weak market — 65% floor or drop) ───────────────────────────────
  if (g.market.totalLine != null) {
    const notes = [...notesBase, "totals de-emphasized (−12.1% ROI in record)"];
    let verdict: BoardLeg["verdict"] = "PASS";
    let passReason: string | undefined;
    if (adj < TOTAL_CONF_FLOOR) {
      passReason = `confidence ${pct(adj)} < totals floor ${pct(TOTAL_CONF_FLOOR)}`;
    } else {
      verdict = "PLAY";
      notes.push("clears the 65% totals floor — still requires environmental corroboration");
    }
    const price = p.totalSide === "over" ? g.market.overOdds ?? -110 : g.market.underOdds ?? -110;
    legs.push({
      gameId: g.gameId,
      matchup,
      market: "total",
      selection: `${p.totalSide.toUpperCase()} ${g.market.totalLine}`,
      priceAmerican: price,
      rawConfidence: raw,
      haircutConfidence: adj,
      marketFairProb: null,
      edge: null,
      evPct: null,
      divGame: div,
      dome,
      doctrineNotes: notes,
      verdict,
      passReason,
    });
  }

  return legs;
}

async function main(): Promise<void> {
  const season = Number(process.argv[2] ?? 2026);
  const week = Number(process.argv[3] ?? 1);
  const cursor: Cursor = { season, phase: "REG", week };

  const dir = defaultStateDir();
  const games = loadGames(dir);
  assertSpreadConvention(games);

  // Rolling lessons memo is deliberately EMPTY here: lessons-current.md is
  // within-backtest-season chatter (currently 2015-era teams). Only the durable
  // cross-season doctrine applies to a live week — makeClaudePickFn loads and
  // gates it internally.
  // ── Live-week inputs (2026-09-10; see src/lib/nfl-live-inputs.ts) ─────────
  // The backtest gets weather/injuries from nflverse after the fact; a live
  // board must bring its own. Every source degrades to "unknown" (null / empty)
  // and is COUNTED below, so the receipt records what the model actually saw.
  const processed = path.join(process.cwd(), "data", "processed");
  const readJsonIf = <T,>(p: string): T | null => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as T;
    } catch {
      return null;
    }
  };
  const weekIds = new Set(gamesForCursor(games, cursor).map((g) => g.gameId));
  const wxFile = readJsonIf<WeatherFile>(path.join(processed, "nfl-weather.json"));
  const wxForWeek =
    wxFile && wxFile.season === season && wxFile.week === week ? (wxFile.forecasts ?? []) : [];
  const wx = applyForecasts(games.filter((g) => weekIds.has(g.gameId)), wxForWeek);
  const wxById = new Map(wx.games.map((g) => [g.gameId, g]));
  const gamesWx = games.map((g) => wxById.get(g.gameId) ?? g);

  // Referees (nflverse officials via nfl:ingest-live → nfl-officials.json).
  const refFile = readJsonIf<OfficialsFile>(path.join(processed, "nfl-officials.json"));
  const refForWeek =
    refFile && refFile.season === season && refFile.week === week ? (refFile.referees ?? []) : [];
  const refByOldId = new Map<string, string>(refForWeek.map((r) => [r.oldGameId, r.referee]));
  const refs = applyReferees(gamesWx.filter((g) => weekIds.has(g.gameId)), refByOldId);
  const refById = new Map(refs.games.map((g) => [g.gameId, g]));
  const gamesLive = gamesWx.map((g) => refById.get(g.gameId) ?? g);

  const espn = readJsonIf<EspnInjuryFile>(path.join(processed, "injuries-nfl.json"));
  const espnConv = espn ? espnInjuriesToRows(espn, cursor) : { rows: [], unresolvedTeams: [] };
  const nflverseInj = loadInjuries(dir);
  const injuries = mergeInjuryRows(nflverseInj, espnConv.rows, cursor);

  const epaFile = readJsonIf<{ generatedAt?: string; rows?: TeamGameEpa[] }>(path.join(processed, "nfl-epa.json"));
  const epa = epaFile?.rows?.length ? computeEpaFeatures(epaFile.rows, cursor) : undefined;

  const blind = buildBlindWeek(gamesLive, cursor, "", injuries, loadPlayerStats(dir), epa ? { epa } : {});
  if (blind.games.length === 0) {
    console.error(`${RED}No games found for ${season} REG wk${week}. Run npm run nfl:ingest?${R}`);
    process.exit(1);
  }

  // Coverage of the live inputs — printed and persisted with the board.
  const inputs = {
    injuries: {
      source: espn ? "espn+nflverse" : "nflverse-only",
      espnFetchedAt: espn?.fetchedAt ?? null,
      rowsForWeek: injuries.filter((r) => r.season === season && r.week === week && r.gameType === "REG").length,
      gamesWithAnyRow: blind.games.filter((g) => g.injuries.away.length + g.injuries.home.length > 0).length,
      unresolvedTeams: espnConv.unresolvedTeams,
    },
    weather: {
      fileGeneratedAt: wxFile?.generatedAt ?? null,
      fileMatchesWeek: !!wxFile && wxFile.season === season && wxFile.week === week,
      outdoorGamesWithForecast: wx.applied,
      domeGames: wx.skippedDome,
      outdoorGamesMissing: wx.missing,
    },
    epa: {
      fileGeneratedAt: epaFile?.generatedAt ?? null,
      teamsWithFeatures: epa?.size ?? 0,
      gamesWithBothSides: blind.games.filter((g) => g.context.epa?.away && g.context.epa?.home).length,
    },
    referee: {
      fileGeneratedAt: refFile?.generatedAt ?? null,
      fileMatchesWeek: !!refFile && refFile.season === season && refFile.week === week,
      gamesWithReferee: blind.games.filter((g) => g.context.referee.trim() !== "").length,
      missing: refs.missing,
    },
    neutralSiteGames: blind.games.filter((g) => g.context.neutralSite).map((g) => g.gameId),
  };
  console.log(
    `  ${D}inputs: injuries ${inputs.injuries.rowsForWeek} rows / ${inputs.injuries.gamesWithAnyRow}/${blind.games.length} games (${inputs.injuries.source}) · ` +
      `weather ${inputs.weather.outdoorGamesWithForecast}/${blind.games.length - inputs.weather.domeGames} outdoor · ` +
      `epa ${inputs.epa.gamesWithBothSides}/${blind.games.length} games · neutral ${inputs.neutralSiteGames.length}${R}`,
  );
  if (inputs.injuries.unresolvedTeams.length) console.warn(`  ${Y}ESPN teams not resolved: ${inputs.injuries.unresolvedTeams.join(", ")}${R}`);
  if (inputs.weather.outdoorGamesMissing.length) console.warn(`  ${Y}no forecast for: ${inputs.weather.outdoorGamesMissing.join(", ")}${R}`);

  // --print-blind: dump exactly what the model would see and stop BEFORE the
  // Claude call — the no-spend way to verify the inputs landed.
  if (process.argv.includes("--print-blind")) {
    console.log(JSON.stringify({ inputs, games: blind.games }, null, 1));
    return;
  }
  console.log(
    `${C}Live-week selection${R} ${B}${season} REG wk${week}${R} ${D}(${blind.games.length} games, blind pick + doctrine post-pass)${R}\n`,
  );

  const pickFn = makeClaudePickFn();
  const picks = await pickFn(blind);
  console.log(`  picks returned: ${picks.length}/${blind.games.length} games\n`);

  const byId = new Map(blind.games.map((g) => [g.gameId, g]));
  const board: BoardLeg[] = [];
  const pickMeta: Array<{ gameId: string; rationale: string; keyFactors: string[] }> = [];
  for (const p of picks) {
    const g = byId.get(p.gameId);
    if (!g) continue;
    board.push(...evaluateGame(g, p));
    pickMeta.push({ gameId: p.gameId, rationale: p.rationale, keyFactors: p.keyFactors });
  }

  // Calibrated staking (research rec 3): fit beta-calibration maps on the
  // walk's graded record, then size every PLAY leg at quarter-Kelly IN CODE.
  // Does not touch PLAY/PASS decisions — sizing only. Maps are PER MARKET
  // (pooled fallback under 20 samples): confidence is one game-level number
  // copied to all three rows, but realized rates differ by market — ML
  // favorites won ~66% while ATS ran ~55%, so a pooled map would overstake
  // ATS legs (review finding 2).
  // The live calibration record (live-graded.jsonl, written by nfl:grade-live)
  // joins the fit ONLY behind --with-live-calibration. Default off: a refit is
  // not tightening-only, and per-market maps need >= 20 rows before they
  // leave the pooled fallback — inert for the first weeks regardless.
  const liveCal = process.argv.includes("--with-live-calibration") ? loadLiveGradedRows(dir) : [];
  const gradedForCal = [...loadGradedRows(dir), ...liveCal].filter((r) => r.result !== "push");
  console.log(
    `  ${D}calibration record: backtest ${gradedForCal.length - liveCal.filter((r) => r.result !== "push").length} rows` +
      (liveCal.length ? ` + live ${liveCal.filter((r) => r.result !== "push").length} rows (--with-live-calibration)` : " (live record NOT included — pass --with-live-calibration to add it)") +
      `${R}`,
  );
  const toSamples = (rows: typeof gradedForCal) =>
    rows.map((r) => ({ score: r.confidence, won: r.result === "win" }));
  const pooledCal = fitBetaCalibration(toSamples(gradedForCal));
  const calFor = (market: BoardLeg["market"]) => {
    const rows = gradedForCal.filter((r) => r.market === market);
    return rows.length >= 20 ? fitBetaCalibration(toSamples(rows)) : pooledCal;
  };
  const calMaps = {
    ats: calFor("ats"),
    moneyline: calFor("moneyline"),
    total: calFor("total"),
  };
  for (const [mkt, m] of Object.entries(calMaps)) {
    console.log(
      `  ${D}calibration[${mkt}]: n=${m.n} a=${m.a.toFixed(2)} b=${m.b.toFixed(2)} c=${m.c.toFixed(2)}${R}`,
    );
  }
  console.log("");
  for (const leg of board) {
    leg.calibratedConfidence = calibrate(calMaps[leg.market], leg.rawConfidence);
    leg.stakeFraction =
      leg.verdict === "PLAY"
        ? kellyStakeFraction(leg.calibratedConfidence, leg.priceAmerican)
        : 0;
    // A PLAY leg can legitimately carry stake 0.00% — doctrine says play,
    // Kelly says the calibrated probability has no edge at this price.
  }

  // ── 2026 doctrine tightening post-pass (see header; tightening ONLY) ──────
  for (const leg of board) {
    if (leg.market === "ats" || leg.market === "total") {
      if (leg.verdict === "PLAY") {
        leg.verdict = "PASS";
        leg.passReason = `2026 doctrine: ${leg.market} retired — no ${leg.market} slice survived the 2025 holdout`;
        leg.stakeFraction = 0;
      }
      leg.doctrineNotes.push("market retired for 2026 (negative holdout) — read shown, never played");
      continue;
    }
    // Moneyline: the SECOND gate of the conjunctive floor — calibrated edge
    // must also clear. The edge field becomes the calibrated edge (the number
    // a surviving PLAY is judged on); the raw edge stays in the notes.
    if (leg.marketFairProb == null || leg.calibratedConfidence == null) continue;
    const rawEdge = leg.edge;
    const calEdge = leg.calibratedConfidence - leg.marketFairProb;
    leg.edge = calEdge;
    leg.doctrineNotes.push(
      `2026 gate: calibrated edge ${pct(calEdge)} (raw-conf edge was ${rawEdge == null ? "—" : pct(rawEdge)}) — calibration transferred, raw edge did not`,
    );
    const floor = leg.divGame ? EDGE_FLOOR : NON_DIV_EDGE_FLOOR;
    if (leg.verdict === "PLAY" && calEdge < floor) {
      leg.verdict = "PASS";
      leg.passReason = `calibrated edge ${pct(calEdge)} < floor ${pct(floor)} (2026 doctrine: gate on calibrated probability)`;
      leg.stakeFraction = 0;
    }
  }

  // ── Full slate table ───────────────────────────────────────────────────────
  console.log(`${B}Full slate — model reads${R} ${D}(conf = raw → after doctrine haircut)${R}`);
  for (const p of picks) {
    const g = byId.get(p.gameId);
    if (!g) continue;
    const adj = haircut(p.confidence);
    const mlLeg = board.find((l) => l.gameId === p.gameId && l.market === "moneyline");
    const edgeStr =
      mlLeg?.edge == null
        ? "  —  "
        : `${mlLeg.edge >= 0 ? "+" : ""}${(mlLeg.edge * 100).toFixed(1)}pp`;
    console.log(
      `  ${(g.away + " @ " + g.home).padEnd(12)} ${D}${g.kickoff.slice(0, 10)}${R}  ` +
        `ML ${B}${(p.moneylineSide === "home" ? g.home : g.away).padEnd(3)}${R} ${ml(mlLeg?.priceAmerican ?? null).padStart(5)}  ` +
        `conf ${pct(p.confidence)}${adj !== p.confidence ? `→${pct(adj)}` : "      "}  ` +
        `fair ${mlLeg?.marketFairProb == null ? "  —  " : pct(mlLeg.marketFairProb)}  edge ${edgeStr}` +
        `${g.context.divGame ? `  ${C}DIV${R}` : ""}${g.context.roof === "dome" || g.context.roof === "closed" ? `  ${Y}DOME${R}` : ""}`,
    );
  }

  // ── Playable board ─────────────────────────────────────────────────────────
  const plays = board.filter((l) => l.verdict === "PLAY");
  console.log(`\n${B}DOCTRINE BOARD — playable${R} ${D}(${plays.length} legs survived)${R}`);
  if (plays.length === 0) {
    console.log(`  ${D}Nothing clears the floors. The honest board is empty.${R}`);
  }
  for (const l of plays) {
    console.log(
      `  ${G}PLAY${R} ${B}${l.selection.padEnd(14)}${R} ${ml(l.priceAmerican).padStart(5)}  [${l.market}] ${l.matchup.padEnd(12)}` +
        `  conf ${pct(l.haircutConfidence)}${l.edge != null ? `  edge ${G}+${(l.edge * 100).toFixed(1)}pp${R}` : ""}` +
        `${l.evPct != null ? `  EV ${l.evPct >= 0 ? G : RED}${(l.evPct * 100).toFixed(1)}%${R}` : ""}` +
        `  stake ${B}${((l.stakeFraction ?? 0) * 100).toFixed(2)}%${R} ${D}(cal ${pct(l.calibratedConfidence ?? l.rawConfidence)})${R}`,
    );
    for (const n of l.doctrineNotes) console.log(`       ${D}· ${n}${R}`);
  }

  // ── Near-misses (why the rest died) ───────────────────────────────────────
  const passes = board.filter((l) => l.verdict === "PASS");
  console.log(`\n${B}Killed by doctrine${R} ${D}(${passes.length} legs)${R}`);
  for (const l of passes) {
    console.log(
      `  ${RED}PASS${R} ${l.selection.padEnd(14)} [${l.market}] ${l.matchup.padEnd(12)}  ${D}${l.passReason}${R}`,
    );
  }

  // ── Parlay (doctrine discipline: 3 ML legs, distinct games, edge floor) ───
  const mlPlays = plays
    .filter((l) => l.market === "moneyline" && l.edge != null)
    .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0));
  console.log(`\n${B}Parlay check${R}`);
  if (mlPlays.length >= 3) {
    const legs = mlPlays.slice(0, 3);
    const combProb = legs.reduce((s, l) => s * l.haircutConfidence, 1);
    const combDec = legs.reduce((s, l) => s * americanToDecimal(l.priceAmerican), 1);
    const evParlay = combProb * combDec - 1;
    const breakEven = 1 / combDec;
    console.log(`  3-leg ML parlay ${D}(top edges, distinct games)${R}:`);
    for (const l of legs) console.log(`    · ${l.selection} ${ml(l.priceAmerican)} ${D}(${l.matchup}, conf ${pct(l.haircutConfidence)})${R}`);
    console.log(
      `  combined ${B}${pct(combProb)}${R} to win vs break-even ${pct(breakEven)} at ${D}${combDec.toFixed(2)}x${R}` +
        `  →  EV ${evParlay >= 0 ? G + "+" : RED}${(evParlay * 100).toFixed(1)}%${R}`,
    );
    console.log(`  ${D}Doctrine reminder: ~${pct(combProb)} win rate is the EXPECTED math — the edge is per-leg, not win rate.${R}`);
  } else {
    console.log(`  ${D}Fewer than 3 playable ML legs (${mlPlays.length}) — no parlay. Doctrine forbids padding with weak legs.${R}`);
  }

  // ── Persist the board (private, read-only vs loop state) ──────────────────
  const outDir = path.join(dir, "live-boards");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${season}-REG-wk${week}.json`);
  // Boards are IMMUTABLE once written (season-plan ruling): a rerun would
  // silently replace the original entry prices with later lines and destroy
  // the receipt. Refuse unless the operator explicitly forces it.
  if (fs.existsSync(outPath) && !process.argv.includes("--force")) {
    console.error(
      `${RED}Refusing to overwrite ${outPath} — boards are immutable receipts. ` +
        `Re-run with --force only if you intend to replace the original entry prices.${R}`,
    );
    process.exit(1);
  }
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        cursor,
        note:
          "Live-week doctrine board. Entry prices are look-ahead nflverse lines at generation time. " +
          "Grade + CLV vs close manually or via a future harness. NOT written to picks-log.jsonl.",
        // The maps stakes were sized with — refit from picks-log.jsonl every
        // run, so the receipt records WHICH map produced these fractions.
        calibration: calMaps,
        // What the model actually SAW this week (2026-09-10): injury rows,
        // forecast coverage, EPA coverage, neutral sites. A board built on a
        // feed outage says so here instead of pretending.
        inputs,
        board,
        rationales: pickMeta,
      },
      null,
      2,
    ),
  );
  console.log(`\n  ${D}board written → ${outPath}${R}`);
  console.log(
    `  ${D}Entry prices locked at today's look-ahead lines — the live verdict is CLV vs close, not the backtest ROI.${R}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
