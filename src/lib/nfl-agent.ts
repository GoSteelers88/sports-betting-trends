// nfl-agent.ts — the Claude calls for Experiment No. 5: the private NFL Backtest
// Learning Loop.
//
// Two impure functions, both gated behind dependency injection so the runner can
// swap them out and tests never touch the network:
//
//   makeClaudePickFn()  → PickFn  : blind week in, validated GamePick[] out
//   makeClaudeReflectFn() → ReflectFn : graded week in, a short lessons memo out
//
// Both reuse the repo's Anthropic client + MODELS map (src/lib/agent/client.ts) —
// never a new SDK client, never a hardcoded model string. Output is forced to
// JSON and validated; malformed games are dropped (logged), not guessed.

import { getAnthropic, MODELS } from "./agent/client";
import { defaultStateDir } from "./nfl-loop";
import {
  cursorAfterCoverage,
  loadNflDoctrine,
  type LoadedDoctrine,
} from "./nfl-dream";
import {
  type BlindWeek,
  type Cursor,
  type GamePick,
  type GradedRow,
  type GradedPropRow,
  type PropPick,
  type PropStat,
  type Side,
} from "./nfl-loop";

// ─── Injected seams ──────────────────────────────────────────────────────────

/** Given a blind week, return one pick set per game. Implementations: the real
 *  Claude call below, or a deterministic stub in tests. */
export type PickFn = (week: BlindWeek) => Promise<GamePick[]>;

/** Given a blind week, return prop picks for players with a directional view. */
export type PropPickFn = (week: BlindWeek) => Promise<PropPick[]>;

/** Given the week + its graded rows + graded prop rows, return a short lessons memo. */
export type ReflectFn = (
  week: BlindWeek,
  graded: GradedRow[],
  gradedProps: GradedPropRow[],
) => Promise<string>;

// ─────────────────────────────────────────────────────────────────────────────
// Validation — the structured-output contract. Never trust the model's JSON.
// ─────────────────────────────────────────────────────────────────────────────

function asSide(v: unknown): Side | null {
  return v === "home" || v === "away" ? v : null;
}

function asOverUnder(v: unknown): "over" | "under" | null {
  return v === "over" || v === "under" ? v : null;
}

function asNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Validate one raw pick object against the blind game it claims to be for.
 *  Echoed lines (atsSpreadHome / totalLine) are filled from the market when the
 *  model omits them, so grading always has a number. Returns null if unusable. */
export function validatePick(
  raw: unknown,
  week: BlindWeek,
): GamePick | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const gameId = typeof o.gameId === "string" ? o.gameId : null;
  if (!gameId) return null;
  const game = week.games.find((g) => g.gameId === gameId);
  if (!game) return null; // hallucinated game id

  const atsSide = asSide(o.atsSide);
  const moneylineSide = asSide(o.moneylineSide);
  const totalSide = asOverUnder(o.totalSide);
  if (!atsSide || !moneylineSide || !totalSide) return null;

  // Echoed lines: prefer the model's, fall back to the real market line.
  const atsSpreadHome = asNum(o.atsSpreadHome) ?? game.market.spreadLineHome;
  const totalLine = asNum(o.totalLine) ?? game.market.totalLine;
  if (atsSpreadHome == null || totalLine == null) return null; // no line to grade against

  let confidence = asNum(o.confidence) ?? 0.5;
  if (confidence > 1) confidence = confidence / 100; // tolerate 0-100 scale
  confidence = Math.max(0, Math.min(1, confidence));

  const rationale =
    typeof o.rationale === "string" ? o.rationale.slice(0, 800) : "";

  // keyFactors: the auditable, specific-factor list. We require at least one
  // non-empty factor so the per-game reasoning can't silently collapse to "".
  const keyFactors = asKeyFactors(o.keyFactors);
  if (keyFactors.length === 0) return null;

  return {
    gameId,
    atsSide,
    atsSpreadHome,
    moneylineSide,
    totalSide,
    totalLine,
    confidence,
    rationale,
    keyFactors,
  };
}

/** Coerce a raw keyFactors value into a clean string[] of short, deduped,
 *  non-empty factors. Accepts an array of strings (the contract) and tolerates a
 *  single string by splitting on ';' or newlines. Caps count + length so a
 *  pathological response can't bloat the log. */
export function asKeyFactors(v: unknown): string[] {
  let raw: unknown[];
  if (Array.isArray(v)) raw = v;
  else if (typeof v === "string") raw = v.split(/[;\n]+/);
  else return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const f = item.trim().slice(0, 160);
    if (!f) continue;
    const k = f.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
    if (out.length >= 8) break;
  }
  return out;
}

/** Extract the first JSON object/array from model text (fenced or bare). Mirrors
 *  the analyst's parsePicks isolation. */
export function extractJson(text: string): unknown {
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const firstObj = cleaned.indexOf("{");
  const firstArr = cleaned.indexOf("[");
  let start = -1;
  let end = -1;
  if (firstArr >= 0 && (firstArr < firstObj || firstObj < 0)) {
    start = firstArr;
    end = cleaned.lastIndexOf("]");
  } else {
    start = firstObj;
    end = cleaned.lastIndexOf("}");
  }
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/** Parse + validate a full model response into GamePick[]. Drops malformed
 *  games rather than inventing them; logs the count dropped. */
export function parsePickResponse(text: string, week: BlindWeek): GamePick[] {
  const json = extractJson(text);
  const arr = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { picks?: unknown }).picks)
      ? (json as { picks: unknown[] }).picks
      : [];
  const out: GamePick[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of arr) {
    const p = validatePick(raw, week);
    if (!p) {
      dropped++;
      continue;
    }
    if (seen.has(p.gameId)) continue; // one pick set per game
    seen.add(p.gameId);
    out.push(p);
  }
  if (dropped > 0) {
    console.warn(`[nfl-agent] dropped ${dropped} malformed pick row(s)`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

function pickSystemPrompt(): string {
  return [
    "You are an NFL betting analyst in a controlled backtest. You see ONLY",
    "pre-game information for one week's slate; you have NO knowledge of the",
    "outcomes. The market lines shown are ~closing lines, so they are sharp and",
    "hard to beat — treat each line as the consensus baseline you must justify",
    "deviating from. Only deviate when a specific, nameable factor is mispriced.",
    "",
    "BE SPECIFIC. For EVERY game, reason through the FULL factor checklist below",
    "before committing any pick. Do not skip factors; if a factor is missing or",
    "neutral, that itself is information. Cite the actual values, not vibes",
    "(e.g. 'home favored by 4 but starting LT is Out (ankle)', not 'injuries').",
    "",
    "PER-GAME FACTOR CHECKLIST (weigh EACH, every game):",
    "  1. Market lines — spread (spreadLineHome, negative = home favored), total",
    "     (totalLine), and moneylines. This is the baseline to beat.",
    "  2. Injuries — injuries.away / injuries.home list (player, position,",
    "     status: Out/Doubtful/Questionable, injury). Weigh POSITION and DEPTH:",
    "     a QB/OL/CB1 Out moves a line far more than a backup. Doubtful ≈ likely",
    "     out; Questionable is a coin flip. These reports are pre-game (not",
    "     look-ahead). An empty list means no reported injuries for that team.",
    "  3. Rest / bye edge — awayRest vs homeRest (days). A bye (13+) or a short",
    "     week (e.g. 4 after a Thursday game) is a real edge; note who has it.",
    "  4. Divisional game — divGame=true games are tighter, more familiar, often",
    "     play under the spread and closer than the number.",
    "  5. Home / away — home field, travel, and crowd; West-to-East body clock.",
    "  6. Dome vs outdoor + surface — roof (dome/closed/outdoors/open) and",
    "     surface (grass/turf). Dome/turf favors passing & pace (totals lean up).",
    "  7. Weather — temp and wind. WIND is the big totals/passing lever: 15+ mph",
    "     suppresses passing, deep balls and kicks → lean UNDER and toward the",
    "     run. Cold/precip dampens scoring. Dome games negate weather.",
    "  8. QB matchup — awayQb vs homeQb. A backup/rookie or a clear talent gap is",
    "     a primary driver; name the QBs you are leaning on.",
    "  9. Coaching — awayCoach vs homeCoach: aggressiveness, situational edges.",
    " 10. Referee — referee tendencies (flag-heavy crews nudge totals up; some",
    "     crews call more DPI/holding). Note it only when it plausibly matters.",
    " 11. Standings / form to-date — awayRecord / homeRecord (W-L, points for /",
    "     against). Use scoring margins as a form/strength proxy, not just W-L.",
    " 12. Lessons memo — apply the carried-forward corrections from past weeks.",
    "",
    "For EVERY game return a pick across all three markets:",
    "  - ats: which side covers (home/away)",
    "  - moneyline: who wins outright (home/away)",
    "  - total: over or under",
    "Echo the line you're taking in atsSpreadHome (the HOME spread) and totalLine.",
    "Set confidence in 0..1 honestly — high only when a concrete factor edge",
    "justifies fading a sharp line; near 0.5 when you are basically with the market.",
    "",
    "Respond with JSON ONLY — an object: {\"picks\": [ ... ]} where each item is:",
    "{",
    '  "gameId": string (exactly as given),',
    '  "atsSide": "home"|"away",',
    '  "atsSpreadHome": number (the home spread),',
    '  "moneylineSide": "home"|"away",',
    '  "totalSide": "over"|"under",',
    '  "totalLine": number,',
    '  "confidence": number 0..1 (edge conviction for this game),',
    '  "keyFactors": string[] (3-6 SHORT items, each naming a specific factor',
    "     from the checklist that moved a pick — e.g. \"home QB out (concussion)\",",
    "     \"18mph wind -> under\", \"away team off bye, +7 rest\", \"divisional, take points\"),",
    '  "rationale": string (2-4 sentences that CITE the specific factors and',
    "     values behind EACH of the three market picks — not vague)",
    "}",
    "No prose outside the JSON.",
  ].join("\n");
}

/** Format the durable cross-season doctrine for prompt injection. Clearly
 *  labeled + caveated so the model treats it as DIRECTIONAL guidance distinct
 *  from the rolling weekly memo, never as a claim of live edge. Empty string
 *  when no doctrine file exists (clean degradation). */
function doctrineBlock(doctrine: string): string {
  const d = doctrine.trim();
  if (!d) return "";
  return [
    "",
    "",
    "DURABLE CROSS-SEASON DOCTRINE (consolidated by the periodic dream over the",
    "FULL backtest record — distinct from the rolling weekly memo above; these are",
    "DIRECTIONAL lessons measured vs ~closing lines, so treat them as priors to",
    "VALIDATE, not guarantees. Apply them as selectivity guidance):",
    d,
  ].join("\n");
}

/**
 * The LEAK GUARD. Given the loaded doctrine and the BlindWeek being picked,
 * return the doctrine text ONLY when the week's cursor is STRICTLY AFTER the
 * doctrine's coverage bound — otherwise "".
 *
 * THE LEAK THIS PREVENTS: the doctrine is consolidated from the FULL 2023–2025
 * record. Re-running the historical backtest (reset cursor → nfl:seed) with a
 * doctrine present would inject FUTURE-derived lessons (e.g. consolidated from
 * week 17) into a PAST-week pick (e.g. week 5 of the same season). That silently
 * contaminates the leak-free record, which is the experiment's entire scientific
 * value. Going FORWARD (2026 picks vs a 2023–25 doctrine) the cursor is after the
 * bound, so the doctrine is injected legitimately. A RE-RUN of any week ≤ the
 * coverage bound gets NO doctrine, keeping the blind prompt clean.
 *
 * Also emits the forensic trail (FIX 2): exactly one log line per call recording
 * whether the picks for this week saw doctrine, so an auditor can tell after the
 * fact whether a run's picks were exposed to future-derived doctrine.
 */
export function gateDoctrineForWeek(
  loaded: LoadedDoctrine,
  week: BlindWeek,
): string {
  const text = loaded.text.trim();
  if (!text || !loaded.coverage) return "";
  const cursor: Cursor = { season: week.season, phase: week.phase, week: week.week };
  const cov = loaded.coverage;
  if (cursorAfterCoverage(cursor, cov)) {
    console.log(
      `[nfl-agent] doctrine injected: generated=${cov.generatedAt} ` +
        `coverage=${cov.season}/${cov.phase}/wk${cov.week}, bytes=${loaded.text.length}`,
    );
    return loaded.text;
  }
  console.log(
    `[nfl-agent] doctrine present but gated out (cursor <= coverage) — blind prompt clean`,
  );
  return "";
}

export function pickUserPrompt(week: BlindWeek, doctrine = ""): string {
  const header =
    `Season ${week.season} ${week.phase} week ${week.week}. ${week.games.length} games.`;
  const lessons = week.lessons.trim()
    ? `\n\nLESSONS FROM PAST WEEKS (apply these):\n${week.lessons.trim()}`
    : "\n\n(No lessons yet — this is an early week.)";
  const doctrineText = doctrineBlock(doctrine);
  // Send the blind games as compact JSON; this is exactly the no-leakage payload
  // (markets + context + per-game scoped injuries, no post-game fields).
  const slate = JSON.stringify(week.games, null, 1);
  return [
    `${header}${lessons}${doctrineText}`,
    "",
    "SLATE (pre-game only — each game carries its market, context, and the",
    "injury reports for ONLY its two teams):",
    slate,
    "",
    `Work the full factor checklist for EACH game, then return picks JSON for all ${week.games.length} games.`,
  ].join("\n");
}

function reflectSystemPrompt(): string {
  return [
    "You are reviewing your own NFL betting week in a backtest learning loop.",
    "You are given how each pick graded (win/loss/push across ATS, moneyline,",
    "total) and how any player prop picks graded. Write a SHORT lessons memo",
    "(<=400 words) for your future self: what patterns cost you, what worked,",
    "and one or two concrete adjustments to make next week (e.g. 'stop taking",
    "road favorites of 7+', 'unders in 20+ mph wind hit', 'over on pass yds",
    "for QBs vs weak pass defense'). Be specific and self-critical. Include",
    "prop observations when props were graded. Plain prose, no JSON, no preamble.",
  ].join("\n");
}

function reflectUserPrompt(
  week: BlindWeek,
  graded: GradedRow[],
  gradedProps: GradedPropRow[],
): string {
  const lines = graded.map((r) => {
    const conf = (r.confidence * 100).toFixed(0);
    return `${r.matchup} | ${r.market} ${r.selection} | ${r.result} | conf ${conf}% | ${r.favored} ${r.homeAway}${r.divGame ? " div" : ""}${r.dome ? " dome" : " outdoor"} | restAdv ${r.restAdvantage} | wind ${r.wind ?? "?"}`;
  });
  const w = graded.filter((r) => r.result === "win").length;
  const l = graded.filter((r) => r.result === "loss").length;
  const p = graded.filter((r) => r.result === "push").length;

  // Props section — only decided results (no no-data)
  const decidedProps = gradedProps.filter((r) => r.result !== "no-data");
  const propLines = decidedProps.map((r) => {
    const conf = (r.confidence * 100).toFixed(0);
    const actual = r.actualValue != null ? r.actualValue.toFixed(1) : "?";
    return `${r.player} (${r.position}, ${r.team}) | ${r.stat} ${r.side} ${r.threshold} | actual ${actual} | ${r.result} | conf ${conf}%`;
  });

  const parts = [
    `Season ${week.season} ${week.phase} week ${week.week} graded results (${w}-${l}-${p}):`,
    "",
    ...lines,
  ];

  if (propLines.length > 0) {
    const pw = decidedProps.filter((r) => r.result === "win").length;
    const pl = decidedProps.filter((r) => r.result === "loss").length;
    const pp = decidedProps.filter((r) => r.result === "push").length;
    parts.push(
      "",
      `PROP RESULTS (${pw}-${pl}-${pp} decided):`,
      "",
      ...propLines,
    );
  }

  parts.push("", "Write the lessons memo.");
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Real Claude implementations (constructed only when an API key is present)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Props pick function — separate Claude call (after game picks)
// ─────────────────────────────────────────────────────────────────────────────

/** Standard industry thresholds used in prop prompts. */
const PROP_THRESHOLDS: Record<PropStat, number> = {
  passYds: 250,
  passTDs: 1.5,
  rushYds: 75,
  recYds: 50,
  recTDs: 0.5,
};

function propsSystemPrompt(): string {
  return [
    "You are an NFL prop analyst in a controlled backtest. You see ONLY",
    "pre-game player context (season averages up to but NOT including this",
    "week, injury status) and game matchup info (standings, roof, weather,",
    "opponent implied strength). Standard industry thresholds are provided.",
    "",
    "Project over/under based on: opponent run/pass defense (implied by",
    "standings and scoring margins), weather (dome/wind), injuries, and",
    "usage trend (receptions/targets for receivers). Return ONLY players",
    "where you have a genuine directional view. Skip players where the",
    "season average is basically on the threshold with nothing to differentiate.",
    "",
    "Respond with a JSON array of PropPick objects (or [] if no clear views):",
    "[",
    "  {",
    '    "player": string (exactly as in the player context),',
    '    "team": string,',
    '    "position": string (QB/RB/WR/TE),',
    '    "stat": "passYds"|"passTDs"|"rushYds"|"recYds"|"recTDs",',
    '    "threshold": number (echo the standard threshold for that stat),',
    '    "side": "over"|"under",',
    '    "confidence": number 0..1,',
    '    "rationale": string (<=200 chars, cite specific factors)',
    "  }",
    "]",
    "",
    "Standard thresholds:",
    `  passYds: ${PROP_THRESHOLDS.passYds}, passTDs: ${PROP_THRESHOLDS.passTDs}, rushYds: ${PROP_THRESHOLDS.rushYds}, recYds: ${PROP_THRESHOLDS.recYds}, recTDs: ${PROP_THRESHOLDS.recTDs}`,
    "",
    "No prose outside the JSON array.",
  ].join("\n");
}

export function propsUserPrompt(week: BlindWeek, doctrine = ""): string {
  const header = `Season ${week.season} ${week.phase} week ${week.week}. ${week.playerContexts.length} players with prior-week context.`;
  const doctrineText = doctrineBlock(doctrine);
  const gamesContext = week.games.map((g) => ({
    gameId: g.gameId,
    away: g.away,
    home: g.home,
    awayRecord: g.awayRecord,
    homeRecord: g.homeRecord,
    roof: g.context.roof,
    wind: g.context.wind,
    temp: g.context.temp,
  }));
  return [
    `${header}${doctrineText}`,
    "",
    "GAME MATCHUPS (standings + environment):",
    JSON.stringify(gamesContext, null, 1),
    "",
    "PLAYER CONTEXTS (season averages from prior weeks only — no current-week data):",
    JSON.stringify(week.playerContexts, null, 1),
    "",
    "Return your prop picks as a JSON array. Return [] if you have no clear directional views.",
  ].join("\n");
}

/** Validate one raw prop pick object. Returns null if unusable. */
export function validatePropPick(raw: unknown, week: BlindWeek): PropPick | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const player = typeof o.player === "string" ? o.player.trim() : null;
  if (!player) return null;

  // Player must exist in playerContexts
  const ctx = week.playerContexts.find(
    (c) => c.player.toLowerCase() === player.toLowerCase(),
  );
  if (!ctx) return null;

  const team = typeof o.team === "string" ? o.team.trim() : ctx.team;
  const position = typeof o.position === "string" ? o.position.trim() : ctx.position;

  const stat = o.stat as PropStat;
  const VALID_STATS: PropStat[] = ["passYds", "passTDs", "rushYds", "recYds", "recTDs"];
  if (!VALID_STATS.includes(stat)) return null;

  const side = o.side === "over" || o.side === "under" ? o.side : null;
  if (!side) return null;

  // Threshold: prefer model's echo, fall back to standard
  const threshold =
    typeof o.threshold === "number" && Number.isFinite(o.threshold)
      ? o.threshold
      : PROP_THRESHOLDS[stat];

  let confidence =
    typeof o.confidence === "number" && Number.isFinite(o.confidence)
      ? o.confidence
      : 0.5;
  if (confidence > 1) confidence = confidence / 100;
  confidence = Math.max(0, Math.min(1, confidence));

  const rationale =
    typeof o.rationale === "string" && o.rationale.trim().length > 0
      ? o.rationale.trim().slice(0, 200)
      : null;
  if (!rationale) return null;

  return { player, team, position, stat, threshold, side, confidence, rationale };
}

/** Parse + validate a props model response. Drops malformed picks; logs count. */
function parsePropsResponse(text: string, week: BlindWeek): PropPick[] {
  const json = extractJson(text);
  const arr = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { picks?: unknown }).picks)
      ? (json as { picks: unknown[] }).picks
      : [];
  const out: PropPick[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of arr) {
    const p = validatePropPick(raw, week);
    if (!p) { dropped++; continue; }
    const dedupeKey = `${p.player}|${p.stat}`;
    if (seen.has(dedupeKey)) continue; // one pick per player+stat
    seen.add(dedupeKey);
    out.push(p);
  }
  if (dropped > 0) {
    console.warn(`[nfl-agent] props: dropped ${dropped} malformed prop pick(s)`);
  }
  return out;
}

export function makeClaudePropsPickFn(): PropPickFn {
  // Load the durable cross-season doctrine + its coverage bound ONCE (empty until
  // the first dream writes it — clean degradation). The bound is then checked
  // PER-WEEK by gateDoctrineForWeek so a backtest re-run of a week ≤ coverage gets
  // NO doctrine (the leak guard). Injected text is clearly labeled as directional.
  const loaded = loadNflDoctrine(defaultStateDir());
  return async (week: BlindWeek): Promise<PropPick[]> => {
    if (week.playerContexts.length === 0) return [];
    const doctrine = gateDoctrineForWeek(loaded, week);
    const client = getAnthropic();
    const res = await client.messages.create({
      model: MODELS.nflLoop,
      max_tokens: 4096,
      system: propsSystemPrompt(),
      messages: [{ role: "user", content: propsUserPrompt(week, doctrine) }],
    });
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
    }
    return parsePropsResponse(text, week);
  };
}

export function makeClaudePickFn(): PickFn {
  // Load the durable cross-season doctrine + its coverage bound ONCE (empty until
  // the first dream writes it). The bound is checked PER-WEEK by
  // gateDoctrineForWeek: the doctrine is injected as DIRECTIONAL selectivity
  // guidance ONLY for weeks strictly after coverage — a re-run of a covered week
  // gets "" (the leak guard). Separated from the rolling weekly memo (week.lessons).
  const loaded = loadNflDoctrine(defaultStateDir());
  return async (week: BlindWeek): Promise<GamePick[]> => {
    if (week.games.length === 0) return [];
    const doctrine = gateDoctrineForWeek(loaded, week);
    const client = getAnthropic();
    const res = await client.messages.create({
      model: MODELS.nflLoop,
      max_tokens: 8192,
      system: pickSystemPrompt(),
      messages: [{ role: "user", content: pickUserPrompt(week, doctrine) }],
    });
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
    }
    return parsePickResponse(text, week);
  };
}

export function makeClaudeReflectFn(): ReflectFn {
  return async (
    week: BlindWeek,
    graded: GradedRow[],
    gradedProps: GradedPropRow[],
  ): Promise<string> => {
    if (graded.length === 0) return "(no graded picks this week — nothing to learn)";
    const client = getAnthropic();
    const res = await client.messages.create({
      model: MODELS.nflLoop,
      max_tokens: 1500,
      system: reflectSystemPrompt(),
      messages: [{ role: "user", content: reflectUserPrompt(week, graded, gradedProps) }],
    });
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
    }
    return text.trim().slice(0, 5000);
  };
}
