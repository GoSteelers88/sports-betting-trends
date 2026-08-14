// nfl-dream.ts — the periodic Opus CONSOLIDATION for Experiment No. 5 (the
// private NFL Backtest Learning Loop). This is the "learn toward the goal"
// mechanism: distinct from the per-week reflection memo (nfl-agent.ts →
// makeClaudeReflectFn, which writes lessons-current.md), the DREAM reads the
// FULL record across all seasons and distills DURABLE, cross-season doctrine.
//
// ── Separation of concerns (Hickey: decision vs effect) ──────────────────────
//   assembleNflDreamPayload()  — PURE. Reads the graded logs (via the loop's own
//        computeStatRecord / runNflParlayBacktest) into a compact read-only
//        payload. No network, no clock beyond the injected nowIso. Unit-tested.
//   consolidateNflDream()      — the imperative shell. Calls the injected Opus
//        seam, attaches the structured result, writes the doctrine file. The
//        seam (DreamFn) is injected so tests never spend on Opus.
//
// ── QUARANTINE (load-bearing) ────────────────────────────────────────────────
// NFL is NOT in IN_SCOPE_LEAGUES — so this module NEVER imports prisma and NEVER
// writes AgentMemory. Every output stays under data/private/nfl-loop/. The live
// NBA/MLB pipeline cannot see anything this produces. The dream is a READ over
// the record + a WRITE to one private doctrine file — it never re-grades,
// re-picks, or mutates the picks logs.
//
// ── HONESTY (load-bearing) ───────────────────────────────────────────────────
// The full record was graded against nflverse ~CLOSING lines (CLV ≈ 0), so every
// win rate / ROI in it is an OPTIMISTIC UPPER BOUND, not live-achievable. The
// model is well-calibrated (predicted ≈ realized), but the dry-run numbers do NOT
// transfer to live betting. The system prompt forces the doctrine to encode this:
// the lever is SELECTIVITY (single-game), not a path to a 70% parlay win rate
// (mathematically capped by the multiplication of leg probabilities). Lessons are
// DIRECTIONAL — "validate live" — never claims of live edge.

import fs from "node:fs";
import path from "node:path";
import { MODELS } from "./agent/client";
import {
  computeStatRecord,
  lessonsDir,
  loadLessonsCurrent,
  type Cursor,
  type GameType,
  type GradedRow,
  type GradedPropRow,
  type StatRecord,
  type SplitStat,
  type CalibrationBucket,
  type Market,
} from "./nfl-loop";
import {
  runNflParlayBacktest,
  computeNflParlayStats,
  NFL_PARLAY_CONFIG,
  type NflParlayStats,
} from "./nfl-parlay";

// ─────────────────────────────────────────────────────────────────────────────
// Paths — the doctrine lives beside the rolling weekly memo but is a SEPARATE,
// durable file. lessons-current.md rolls (last 4 weeks); nfl-doctrine.md is the
// consolidated cross-season learning, overwritten idempotently each dream.
// ─────────────────────────────────────────────────────────────────────────────

export function nflDoctrinePath(dir: string): string {
  return path.join(lessonsDir(dir), "nfl-doctrine.md");
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage bound — the leak guard's anchor
// ─────────────────────────────────────────────────────────────────────────────
// The doctrine is consolidated from the FULL graded record. The latest game it
// "knows about" is its COVERAGE BOUND: the max (season, phase, week) tuple in the
// gameRows it was built from. The pick path injects the doctrine ONLY for cursor
// weeks STRICTLY AFTER this bound — otherwise a re-run of the historical backtest
// would feed future-derived lessons into a past-week pick, silently contaminating
// the leak-free record (the experiment's entire scientific value). The bound is
// stamped into a parseable header comment so the loader can gate on it.

export type DoctrineCoverage = {
  generatedAt: string;
  season: number;
  phase: GameType;
  week: number;
};

export type LoadedDoctrine = {
  /** The lessons body (no header), or "" when absent. */
  text: string;
  /** Coverage bound parsed from the header, or null when absent/unparseable. */
  coverage: DoctrineCoverage | null;
};

/** Same chronological ordering the loop uses for weeks: REG (0) before POST (1). */
function phaseRank(p: GameType): number {
  return p === "REG" ? 0 : 1;
}

/**
 * Is `cursor` STRICTLY AFTER the coverage bound? Mirrors the loop's week
 * ordering exactly: season asc, then phaseRank (REG before POST) asc, then week
 * asc. Returns true only when the cursor's week is later than the latest game the
 * doctrine knows about — i.e. when injecting the doctrine cannot leak a future
 * result into a past pick.
 */
export function cursorAfterCoverage(cursor: Cursor, cov: DoctrineCoverage): boolean {
  if (cursor.season !== cov.season) return cursor.season > cov.season;
  const cr = phaseRank(cursor.phase);
  const br = phaseRank(cov.phase);
  if (cr !== br) return cr > br;
  return cursor.week > cov.week;
}

/** The max (season, phase, week) tuple across the rows — the latest game the
 *  doctrine built from these rows can possibly "know about". Null on empty. */
export function maxCoverage(rows: GradedRow[]): { season: number; phase: GameType; week: number } | null {
  let best: { season: number; phase: GameType; week: number } | null = null;
  for (const r of rows) {
    if (
      !best ||
      r.season > best.season ||
      (r.season === best.season && phaseRank(r.phase) > phaseRank(best.phase)) ||
      (r.season === best.season && r.phase === best.phase && r.week > best.week)
    ) {
      best = { season: r.season, phase: r.phase, week: r.week };
    }
  }
  return best;
}

const COVERAGE_RE = /<!--\s*coverage:\s*season=(\d+)\s+phase=(REG|POST)\s+week=(\d+)\s+generated=(\S+)\s*-->/;

/** Parse the coverage header from a raw doctrine file. Null when absent. */
export function parseDoctrineCoverage(raw: string): DoctrineCoverage | null {
  const m = raw.match(COVERAGE_RE);
  if (!m) return null;
  return { season: Number(m[1]), phase: m[2] as GameType, week: Number(m[3]), generatedAt: m[4] };
}

/** Load the durable cross-season doctrine AND its coverage bound. Returns empty
 *  text + null coverage when absent so the caller degrades cleanly. */
export function loadNflDoctrine(dir: string): LoadedDoctrine {
  const p = nflDoctrinePath(dir);
  if (!fs.existsSync(p)) return { text: "", coverage: null };
  const raw = fs.readFileSync(p, "utf8");
  return { text: raw, coverage: parseDoctrineCoverage(raw) };
}

/** Write (overwrite) the durable doctrine file ATOMICALLY (temp + rename, so a
 *  crash mid-write can never leave truncated markdown the loader would inject).
 *  Idempotent — re-running the dream replaces the file in place. Stamps a
 *  parseable COVERAGE header (max season/phase/week in `gameRows`) that the leak
 *  guard reads back to decide whether a given cursor week may see the doctrine. */
export function writeNflDoctrine(
  dir: string,
  generatedAt: string,
  lessons: string,
  gameRows: GradedRow[],
): void {
  const ldir = lessonsDir(dir);
  fs.mkdirSync(ldir, { recursive: true });
  const cov = maxCoverage(gameRows);
  // A doctrine built from no rows has no coverage; default to a bound so distant
  // in the past that NOTHING is after it (season -1) → it is never injected.
  // (consolidateNflDream already no-ops on empty rows, so this is belt-and-braces.)
  const season = cov?.season ?? -1;
  const phase = cov?.phase ?? "REG";
  const week = cov?.week ?? 0;
  const body =
    `# NFL durable cross-season doctrine\n\n` +
    `<!-- coverage: season=${season} phase=${phase} week=${week} generated=${generatedAt} -->\n` +
    `<!-- Generated by the NFL dream (Experiment No. 5). DRY-RUN vs ~closing lines:\n` +
    `     all win rates / ROI below are OPTIMISTIC UPPER BOUNDS, not live edge.\n` +
    `     Directional only — validate live. Coverage bound above is the LATEST game\n` +
    `     the doctrine knows about; the pick path injects it ONLY for cursor weeks\n` +
    `     strictly after that bound, so a backtest re-run never leaks future lessons\n` +
    `     into a past pick. Generated: ${generatedAt} -->\n\n` +
    `${lessons.trim()}\n`;
  const finalPath = nflDoctrinePath(dir);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, body);
  fs.renameSync(tmpPath, finalPath); // atomic on the same filesystem
}

// ─────────────────────────────────────────────────────────────────────────────
// The read-only payload — what the dream reasons over
// ─────────────────────────────────────────────────────────────────────────────

/** A prop record row: win/loss/push/no-data + sample size, per stat. Derived
 *  here (the loop has no prop-record helper) — pure tally, no network. */
export type PropStatRecord = {
  stat: string;
  wins: number;
  losses: number;
  pushes: number;
  noData: number;
  n: number; // decisive (win + loss)
  winRate: number | null;
  overShare: number | null; // among decisive, share where the OVER hit (directional bias)
};

export type NflDreamPayload = {
  generatedAt: string;
  // headline counts so a reader/operator can sanity-check the sample at a glance
  recordSummary: {
    gameRows: number;
    propRows: number;
    seasons: number[];
    overallByMarket: Record<Market, { record: string; winRate: number | null; roiPct: number | null; n: number }>;
    calibrationGapPp: number | null; // mean |realized − predicted| across decisive buckets, in pp
    parlay: {
      settled: number;
      wins: number;
      losses: number;
      winRatePct: number | null;
      yieldPct: number | null;
      roiPct: number;
      avgLegEdge: number | null;
    };
  };
  // the rich structures the LLM reasons over (situational splits + calibration)
  statRecord: StatRecord;
  propRecord: PropStatRecord[];
  parlayStats: NflParlayStats;
  currentWeeklyMemo: string; // the rolling lessons-current.md (the per-week layer)
};

/** Tally the prop log into a per-stat record. Pure. `no-data` rows count toward
 *  noData (and are excluded from the decisive win-rate denominator). The over/under
 *  share is reconstructed from side+result the same way computeStatRecord does for
 *  game totals, so a directional bias per stat is visible. */
export function computePropStatRecord(rows: GradedPropRow[]): PropStatRecord[] {
  const byStat = new Map<
    string,
    { wins: number; losses: number; pushes: number; noData: number; over: number; decisive: number }
  >();
  for (const r of rows) {
    let b = byStat.get(r.stat);
    if (!b) {
      b = { wins: 0, losses: 0, pushes: 0, noData: 0, over: 0, decisive: 0 };
      byStat.set(r.stat, b);
    }
    if (r.result === "no-data") {
      b.noData++;
      continue;
    }
    if (r.result === "win") b.wins++;
    else if (r.result === "loss") b.losses++;
    else b.pushes++;
    if (r.result !== "push") {
      b.decisive++;
      // over-win OR under-loss ⇒ the stat went OVER the threshold
      if (
        (r.side === "over" && r.result === "win") ||
        (r.side === "under" && r.result === "loss")
      ) {
        b.over++;
      }
    }
  }
  return [...byStat.keys()]
    .sort()
    .map((stat) => {
      const b = byStat.get(stat)!;
      return {
        stat,
        wins: b.wins,
        losses: b.losses,
        pushes: b.pushes,
        noData: b.noData,
        n: b.decisive,
        winRate: b.decisive > 0 ? +(b.wins / b.decisive).toFixed(4) : null,
        overShare: b.decisive > 0 ? +(b.over / b.decisive).toFixed(4) : null,
      };
    });
}

function fmtRecord(s: SplitStat): string {
  return `${s.wins}-${s.losses}-${s.pushes}`;
}

/** Mean absolute calibration gap (|realized − predicted|) across decisive
 *  buckets, weighted by bucket n, expressed in percentage points. Null when no
 *  bucket has a realized rate. This is the single number that says "is the model
 *  honest about its own confidence?". */
function meanCalibrationGapPp(buckets: CalibrationBucket[]): number | null {
  let wsum = 0;
  let nsum = 0;
  for (const b of buckets) {
    if (b.realized == null) continue;
    wsum += Math.abs(b.realized - b.predicted) * b.n;
    nsum += b.n;
  }
  if (nsum === 0) return null;
  return +((wsum / nsum) * 100).toFixed(2);
}

/**
 * Assemble the read-only dream payload from the FULL graded record. PURE: takes
 * the already-loaded rows + nowIso, returns the payload. Reuses the loop's own
 * computeStatRecord (situational splits + calibration) and runNflParlayBacktest /
 * computeNflParlayStats — never recomputes the record by hand.
 */
export function assembleNflDreamPayload(
  gameRows: GradedRow[],
  propRows: GradedPropRow[],
  weeklyMemo: string,
  nowIso: string,
): NflDreamPayload {
  const statRecord = computeStatRecord(gameRows);
  const propRecord = computePropStatRecord(propRows);
  const parlayBook = runNflParlayBacktest(gameRows, propRows, nowIso);
  const parlayStats = computeNflParlayStats(parlayBook);

  const seasons = [...new Set(gameRows.map((r) => r.season))].sort((a, b) => a - b);

  const overallByMarket = {
    ats: marketSummary(statRecord.overall.ats),
    moneyline: marketSummary(statRecord.overall.moneyline),
    total: marketSummary(statRecord.overall.total),
  } as Record<Market, { record: string; winRate: number | null; roiPct: number | null; n: number }>;

  return {
    generatedAt: nowIso,
    recordSummary: {
      gameRows: gameRows.length,
      propRows: propRows.length,
      seasons,
      overallByMarket,
      calibrationGapPp: meanCalibrationGapPp(statRecord.calibration),
      parlay: {
        settled: parlayStats.settledCount,
        wins: parlayStats.wins,
        losses: parlayStats.losses,
        winRatePct: parlayStats.winRatePct,
        yieldPct: parlayStats.yieldPct,
        roiPct: parlayStats.roiPct,
        avgLegEdge: parlayStats.avgLegsEdge,
      },
    },
    statRecord,
    propRecord,
    parlayStats,
    currentWeeklyMemo: weeklyMemo,
  };
}

function marketSummary(s: SplitStat): { record: string; winRate: number | null; roiPct: number | null; n: number } {
  return { record: fmtRecord(s), winRate: s.winRate, roiPct: s.roiPct, n: s.n };
}

// ─────────────────────────────────────────────────────────────────────────────
// The Opus consolidation — injected seam so tests never spend
// ─────────────────────────────────────────────────────────────────────────────

/** Given the assembled payload, return the consolidated doctrine markdown. The
 *  real implementation calls Opus; tests inject a deterministic stub. */
export type DreamFn = (payload: NflDreamPayload) => Promise<string>;

export type NflDreamResult = {
  generatedAt: string;
  recordSummary: NflDreamPayload["recordSummary"];
  lessons: string; // markdown — the durable doctrine
  keyMetrics: {
    gameRows: number;
    propRows: number;
    calibrationGapPp: number | null;
    atsWinRate: number | null;
    parlayYieldPct: number | null;
    parlayWinRatePct: number | null;
  };
};

export type ConsolidateDeps = {
  dir: string;
  gameRows: GradedRow[];
  propRows: GradedPropRow[];
  weeklyMemo?: string; // defaults to loadLessonsCurrent(dir)
  dreamFn: DreamFn;
  nowIso?: string;
  /** When false, skip the doctrine-file write (used by dry-run/test paths). */
  write?: boolean;
};

/**
 * Run the consolidation: assemble → call the dream seam → write the doctrine.
 * No-ops politely on an empty record (no game rows) — returns null without
 * calling the seam, so the script can print a friendly notice and the dream
 * never spends on nothing.
 */
export async function consolidateNflDream(deps: ConsolidateDeps): Promise<NflDreamResult | null> {
  if (deps.gameRows.length === 0) return null;

  const nowIso = deps.nowIso ?? new Date().toISOString();
  const weeklyMemo = deps.weeklyMemo ?? loadLessonsCurrent(deps.dir);
  const payload = assembleNflDreamPayload(deps.gameRows, deps.propRows, weeklyMemo, nowIso);

  const lessons = (await deps.dreamFn(payload)).trim();

  if (deps.write !== false) {
    writeNflDoctrine(deps.dir, nowIso, lessons, deps.gameRows);
  }

  return {
    generatedAt: nowIso,
    recordSummary: payload.recordSummary,
    lessons,
    keyMetrics: {
      gameRows: payload.recordSummary.gameRows,
      propRows: payload.recordSummary.propRows,
      calibrationGapPp: payload.recordSummary.calibrationGapPp,
      atsWinRate: payload.recordSummary.overallByMarket.ats.winRate,
      parlayYieldPct: payload.recordSummary.parlay.yieldPct,
      parlayWinRatePct: payload.recordSummary.parlay.winRatePct,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The real Opus implementation (constructed lazily so report/test paths need no key)
// ─────────────────────────────────────────────────────────────────────────────

export function dreamSystemPrompt(): string {
  return [
    "You are the consolidation reviewer for a PRIVATE NFL betting backtest",
    "(Experiment No. 5). You are given the FULL graded record across multiple",
    "seasons: situational splits, calibration buckets, a prop record by stat, and",
    "a parlay backtest. Your job is to distill DURABLE, CROSS-SEASON doctrine for",
    "your future self — the lessons that should sharpen the NEXT picks, props, and",
    "parlays. This is the periodic consolidation OVER THE WHOLE RECORD, distinct",
    "from the rolling per-week memo (which you also see, for continuity).",
    "",
    "HARD CONSTRAINTS — these are load-bearing; violating them makes the doctrine LIE:",
    "  (a) DRY-RUN vs ~CLOSING LINES. Every win rate / ROI / yield in the record was",
    "      graded against nflverse ~closing lines (CLV ≈ 0). They are an OPTIMISTIC",
    "      UPPER BOUND — NOT live-achievable. NEVER imply these numbers transfer to",
    "      live betting. Frame EVERY lesson as DIRECTIONAL and tag it 'validate live'.",
    "  (b) The single-game lever toward a higher WIN RATE is SELECTIVITY — bet only",
    "      the best-calibrated, highest-edge situations — NOT volume. Single-game",
    "      ATS/ML is already well-calibrated; say where to be MORE selective.",
    "  (c) NEVER claim a path to a 70% PARLAY win rate. A 3-leg parlay's win prob is",
    "      the PRODUCT of its legs' win probs (~0.6^3 ≈ 0.22), so ~70% is",
    "      mathematically impossible at real odds. The correct parlay objective is",
    "      +EV via LEG SELECTION (higher-probability FAVORITE legs, distinct games),",
    "      not chasing a win-rate number. State this multiplication math explicitly.",
    "  (d) FLAG SMALL-N as noise. Any split with n < 30 decisive is tentative; n < 15",
    "      is basically noise. Tag each lesson with its sample size and a confidence",
    "      (tentative / moderate / strong) keyed to n. Do not build a rule on a",
    "      single favorable split.",
    "  (e) Lessons must be ACTIONABLE by the next pick/prop/parlay prompt — concrete",
    "      enough that the analyst can apply them ('be more selective on road",
    "      favorites of 7+; their cover rate is ~X over n=Y — validate live'), not",
    "      vague platitudes.",
    "  (f) SITUATIONAL ONLY — NO SPECIFIC INSTANCES. This doctrine is replayed into",
    "      FUTURE picks, INCLUDING re-runs of past weeks. Naming a concrete game,",
    "      team, week, or date would leak a RESULT into a re-pick of that very game.",
    "      Therefore: express EVERY lesson as a SITUATIONAL RULE carrying ONLY a",
    "      sample size — e.g. 'road favorites of 7+ underperformed ATS, n=Y' or",
    "      'dome unders hit at ~X%, n=Z'. NEVER name a specific team, city, player,",
    "      game, matchup, week number, season, or date as the SUBJECT of a lesson.",
    "      (You may reference the abstract phase 'regular season vs postseason' as a",
    "      situation, but never a specific week like 'Wk17'.) This is non-negotiable:",
    "      a single named instance invalidates the leak-free record. It also makes",
    "      the doctrine more DURABLE — a rule about a situation generalizes; a note",
    "      about one game does not.",
    "",
    "Cover, in order:",
    "  1. CALIBRATION — is predicted ≈ realized? Where is the model over/under-",
    "     confident? (The mean calibration gap is provided.)",
    "  2. MARKETS — which of ATS / moneyline / total to LEAN ON vs DE-EMPHASIZE,",
    "     with the record behind each.",
    "  3. SITUATIONS — the splits (favorite/dog, home/away, divisional, dome/outdoor,",
    "     rest advantage, wind, temp): where best/worst calibrated and most/least",
    "     profitable; where to be MORE selective. Name the n on each.",
    "  4. PROPS — per-stat guidance from the prop record (which stats, over/under",
    "     lean, sample size).",
    "  5. PARLAYS — leg-selection guidance (favorite legs, distinct games, the +EV",
    "     floor) and the multiplication-math reality from constraint (c).",
    "",
    "Write tight MARKDOWN doctrine (<= ~900 words): a short calibration headline,",
    "then sections (## Markets, ## Situations, ## Props, ## Parlays) as bulleted,",
    "numbered-evidence lessons. No preamble, no JSON. Every quantitative claim",
    "carries its n and a 'validate live' / directional caveat — and per constraint",
    "(f), is phrased as a SITUATION with a sample size, never as a named game,",
    "team, player, week, or date.",
  ].join("\n");
}

export function dreamUserPrompt(payload: NflDreamPayload): string {
  // Send the rich record as compact JSON — the splits + calibration are the
  // signal. The weekly memo gives continuity with the per-week layer.
  const record = JSON.stringify(
    {
      recordSummary: payload.recordSummary,
      situationalSplits: payload.statRecord.splits,
      baseRates: payload.statRecord.baseRates,
      calibration: payload.statRecord.calibration,
      propRecordByStat: payload.propRecord,
      parlay: {
        config: {
          legsPerParlay: NFL_PARLAY_CONFIG.legsPerParlay,
          edgeFloorPct: NFL_PARLAY_CONFIG.edgeFloor * 100,
          longshotMaxAmerican: NFL_PARLAY_CONFIG.longshotMaxAmerican,
          haircutPerLegPct: NFL_PARLAY_CONFIG.haircutPerLegProb * 100,
        },
        stats: payload.parlayStats,
      },
    },
    null,
    1,
  );
  return [
    `FULL NFL backtest record — seasons ${payload.recordSummary.seasons.join(", ")}, ` +
      `${payload.recordSummary.gameRows} graded game-market rows, ` +
      `${payload.recordSummary.propRows} graded prop rows.`,
    "Remember: graded vs ~closing lines → optimistic upper bound, directional only.",
    "",
    "THE RECORD (situational splits + calibration + prop record + parlay backtest):",
    record,
    "",
    payload.currentWeeklyMemo.trim()
      ? `ROLLING PER-WEEK MEMO (the short-horizon layer, for continuity):\n${payload.currentWeeklyMemo.trim()}`
      : "(No rolling per-week memo yet.)",
    "",
    "Write the durable cross-season doctrine now (markdown, per the system rules).",
  ].join("\n");
}

/** The real dream seam. Constructed lazily by the script so report/test paths
 *  never need an API key. Defaults to MODELS.dream (Opus, season-boundary
 *  dreams); the walk-completion dream passes MODELS.nflDreamFinal (Fable 5).
 *  Never a hardcoded string. */
export function makeClaudeNflDreamFn(model: string = MODELS.dream): DreamFn {
  return async (payload: NflDreamPayload): Promise<string> => {
    // Lazy import keeps the client (and its env-var requirement) off the pure path.
    const { getAnthropic } = await import("./agent/client");
    const client = getAnthropic();
    // Fable 5's thinking is always on and counts against max_tokens, so the
    // final dream needs headroom well past the doctrine's own length (the same
    // trap that truncated the loop's picks on Sonnet 5, 2026-08-14). Opus 4.7
    // runs thinking-off when the param is omitted, so 4096 stays right there.
    // Streaming for both keeps one code path and rides out Fable's long turns.
    const maxTokens = model === MODELS.nflDreamFinal ? 24000 : 4096;
    const res = await client.messages
      .stream({
        model,
        max_tokens: maxTokens,
        system: dreamSystemPrompt(),
        messages: [{ role: "user", content: dreamUserPrompt(payload) }],
      })
      .finalMessage();
    const { logSpend } = await import("./nfl-spend");
    logSpend(model, res.usage, "dream", "doctrine");
    if (res.stop_reason === "refusal") {
      throw new Error(
        `dream call refused by ${model} safety classifiers — doctrine unchanged; ` +
          `re-run on MODELS.dream (Opus) if it recurs`,
      );
    }
    if (res.stop_reason === "max_tokens") {
      throw new Error(
        `dream call truncated at max_tokens (${maxTokens}) on ${model} — ` +
          `a cut-off doctrine must never be written; doctrine unchanged`,
      );
    }
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
    }
    return text.trim();
  };
}
