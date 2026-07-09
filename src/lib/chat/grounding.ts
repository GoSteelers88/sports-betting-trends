// The grounding guard — the credibility kill-switch for Lane B.
//
// In live analysis, every specific numeric claim the bot makes (an edge %, a
// price/line, a model probability, a CLV figure) MUST trace to a tool result we
// actually read THIS turn. A fabricated number on a public, money-spending
// betting bot is the single fastest way to destroy trust — so after generation
// we scan the reply for numeric claims and verify each one appears in the
// collected tool-result payloads. Any unbacked number → the reply is NOT
// grounded, and the caller regenerates once (stricter) or falls back to the
// doctrine answer.
//
// CRITICAL: the haystack is built by WALKING THE PARSED tool-result objects and
// collecting numbers ONLY from a whitelist of betting-relevant VALUE keys — it
// is NOT built by regex-scraping the serialized JSON. Scraping the serialized
// string poisons the haystack with ISO-timestamp digits (2026, 06, 14, 23, 10),
// bookCount, eventIds, and impliedProb noise, which lets a fabricated "10% edge"
// match a timestamp "10". Key-walking is the whole point of this guard.
//
// Pure function: takes the reply text + the tool-result strings, returns a
// verdict. No I/O, no model — fully unit-testable.

// The doctrine fallback when we cannot ground a Lane B reply. This is the
// honest, on-brand answer: no live read means no bet.
export const DOCTRINE_FALLBACK =
  "I don't have a clean live read on that game right now — the numbers I'd need aren't in front of me, " +
  "and on this discipline, no read means no bet. If the desk had an edge on it tonight, it'd show as a pick on the board. " +
  "Ask me about a different NBA, MLB, or WNBA game, or come back once tonight's lines have firmed up.";

// The STATS-MODE fallback (a league we do NOT bet — NFL/NHL/NCAAB). When we
// can't ground a stats answer, the bets-mode doctrine ("ask me about a different
// NBA/MLB/WNBA game") is nonsense to someone asking about hockey. This is the
// honest, mode-appropriate line: no clean numbers, no guessing.
export function STATS_MODE_FALLBACK(league: string): string {
  return (
    `I don't have clean ${league} numbers in front of me right now — the standings/stats I'd need aren't in front of me, ` +
    "and I won't guess. I put my name on real numbers or nothing. Ask me again in a bit, " +
    "or point me at tonight's NBA, MLB, or WNBA board, which I bet."
  );
}

// The Lane A leak fallback — a clean, in-character line for when the persona
// lane trips the leak guard. Contains NONE of the A2 markers (verified: no
// "tool results", no "fire the tools", no "still loading", etc.) so it can
// never itself re-trip the guard.
export const LANE_A_LEAK_FALLBACK =
  "Let's keep it on the number. Point me at a specific NBA, MLB, or WNBA matchup " +
  "and I'll give you the desk's read — value, price, and whether it clears my edge floor. " +
  "No matchup, no manufactured play; that's the discipline.";

export type GroundingVerdict = {
  grounded: boolean;
  // The numeric tokens we could not trace to any tool result.
  ungrounded: string[];
};

// ─── The persona/plumbing leak guard (belt-and-suspenders, ADDITIVE) ─────────
//
// The grounding guard above is the credibility kill-switch and stays exactly as
// it is. This is a SEPARATE, deterministic scan for the ONE failure the model
// occasionally slips into: narrating its own plumbing ("I don't have the full
// tool results back yet… still loading… let me fire all the tools"). A leak is
// a STYLE problem, not a fabrication — so the markers here are TIGHT and
// high-precision: a marginal miss just means a slightly-off reply shipped, which
// is far cheaper than a false positive nuking a legitimate baseball answer
// ("loading the bases"). Precision over recall, deliberately.
//
// On a hit the caller ships the mode-appropriate fallback (NOT a regen — a regen
// is exactly the 504 spiral we just removed) and logs which marker matched.
const LEAK_MARKERS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "tool-results", re: /tool results?/i },
  { name: "fire-the-tools", re: /fire (all )?the tools/i },
  { name: "run-the-tools", re: /(pull|call|re-?run) (the|my|all) tools/i },
  { name: "memory-rules-loaded", re: /memory and rules loaded/i },
  { name: "run-full-slate-analysis", re: /run the full slate analysis/i },
  {
    name: "still-loading",
    re: /still loading|data (is |are )?(still )?loading|haven'?t (fully )?loaded|results? (aren'?t|not) (back|in)( yet)?/i,
  },
];

export type LeakVerdict = { leaked: boolean; marker?: string };

// Scan a reply for a plumbing/process leak. Returns the FIRST matching marker's
// name (for the forensic log) or { leaked:false }. Pure + fully unit-testable.
export function checkLeak(reply: string): LeakVerdict {
  for (const { name, re } of LEAK_MARKERS) {
    if (re.test(reply)) return { leaked: true, marker: name };
  }
  return { leaked: false };
}

// ─── The grounding whitelist ─────────────────────────────────────────────────
//
// We collect numbers ONLY from these VALUE keys, walking the parsed tool-result
// objects. THREE buckets, because percents, prices, and stat values ground
// differently:
//
//   PRICE_KEYS      — raw American odds / lines / points. A ±1 tolerance is fine
//                     here (-110 vs -111 is the same bet to a bettor); NEVER a
//                     valid backing for a percent/edge claim.
//   PROB_KEYS       — probabilities (0–1 decimals) and edges (0–1 fractions, or
//                     an already-percentized field). The ONLY valid backing for
//                     a percent/edge claim; matches TIGHTLY (~0.5pp).
//   STAT_VALUE_KEYS — stat-derived integers/decimals (records, ratings,
//                     point-diff, pace, ERAs, ledger figures). Ground by EXACT
//                     match (tolerance 0) so a fabricated price/line/total can't
//                     borrow a dense stat integer that merely sits within ±1.
//
// Audited against the read tools' return shapes in src/lib/agent/tools/index.ts
// (get_odds, get_model_probabilities, get_player_props, get_prop_projection,
// get_home_run_likes, get_mlb_signals, get_quant_desk_analysis).

// Probability / edge value keys → contribute percent-grounding values.
// Each value is a 0–1 fraction unless noted; we percentize it (×100) for
// matching a claimed "N%" or "N-point edge".
const PROB_KEYS: ReadonlySet<string> = new Set([
  "impliedProb",
  "homeWinProb",
  "awayWinProb",
  "edge",
  "modelFairProb",
  "devigMarketProb",
  "modelProb",
  "fairOverProb",
  "fairUnderProb",
  "fairProb", // props-board row: fair prob of the quoted side (0–1)
  "evPct", // already a percent (e.g. 7.4 means 7.4%) — handled below
  "clvBeatRatePct", // already a percent
  "confidence", // 0–1 prop confidence
  // ─── stats tools (0–1 fractions, or small rate decimals spoken as .XXX) ───
  "winPct", // standings win% (0–1)
  "roi", // desk record ROI (0–1 fraction)
  "ops", // MLB batting — spoken as ".850" (0.850 × 100 grounds the decimal claim)
  "obp",
  "slg",
  "avg",
  "xwobaAgainst", // statcast — ~.310 decimal
  "wobaAgainst",
  "estSlgAgainst",
  "estBaAgainst",
  "precipPct", // weather — already a percent (0–100)
]);

// Keys whose value is ALREADY expressed as a percent (e.g. 7.4 = 7.4%), so we
// must NOT multiply by 100 when percentizing.
const ALREADY_PERCENT_KEYS: ReadonlySet<string> = new Set([
  "evPct",
  "clvBeatRatePct",
  "precipPct",
]);

// Price / line / point value keys → contribute price-grounding values (±1).
//
// STRICTLY betting prices/lines/points here — a ±1 tolerance is a bettor's
// "same bet" band (-110 vs -111). Stat-derived integers/decimals (records,
// ratings, point-diff, pace, ERAs) are DELIBERATELY NOT here: a dense integer
// like a defensive rating (~110) or a win column (~45) inside a ±1 band would
// let a FABRICATED price/line/total (-110, a +4.5 spread) "ground" off a stat.
// Those live in STAT_VALUE_KEYS below, checked by EXACT match instead.
const PRICE_KEYS: ReadonlySet<string> = new Set([
  "american",
  "line",
  "point",
  "price",
  "overPrice",
  "underPrice",
  "homePrice",
  "awayPrice",
  "priceAmerican",
  "bestPriceAmerican", // get_board_edges: best-price American for the +edge side
  "softAmerican",
  "sharpOverAmerican", // props-board row sharp prices
  "sharpUnderAmerican",
  "projected",
  "stddev",
  "rollingMean",
  "clvCents",
  "avgClvCents",
  "expectedMargin",
  "recentAvgPoints",
]);

// ─── Stat-value keys (exact match, tolerance 0) ──────────────────────────────
//
// Stat-derived integers and decimals a legitimately-cited stats answer quotes:
// records (win/loss columns), team ratings, point differentials, pace, ERAs,
// pitch metrics, ledger figures. They must STILL ground when correctly cited —
// but by EXACT match (not the ±1 price band), so a made-up American price can't
// borrow a rating/record that merely happens to sit within a point of it.
const STAT_VALUE_KEYS: ReadonlySet<string> = new Set([
  // standings / desk record
  "pointDiff",
  // team efficiency ratings
  "netRtg",
  "offRtg",
  "defRtg",
  "pace",
  "homeNetRtg",
  "homeOffRtg",
  "homeDefRtg",
  "awayNetRtg",
  "awayOffRtg",
  "awayDefRtg",
  // statcast pitching / mlb team stats
  "k9",
  "fbVelocity",
  "velocityDelta",
  "woba",
  "xwoba",
  "xwobaGap",
  "xera", // ~3.50
  "bullpenEra",
  "fatigueScore",
  // weather
  "tempF",
  "windMph",
  "windFactor",
  // desk record / parlay ledger figures
  "pnlUnits",
  "equityUsd",
  "realizedPnlUsd",
  "exposureUsd",
]);

// Numeric keys whose value is a WIN/LOSS RECORD COLUMN ("45-20" → wins:45,
// losses:20). These are NOT plain stat values: a bare "45" or "20" in prose is
// almost never a cited record column, so a record component may back a claim
// ONLY when the reply writes it in hyphenated N-M form (see recordValues +
// collectRecordRaws). Kept out of STAT_VALUE_KEYS so they can't ground a bare
// integer / a fabricated price by exact match.
const RECORD_COMPONENT_KEYS: ReadonlySet<string> = new Set([
  "wins", // spoken in records like "45-20"
  "losses",
]);

// String-valued keys that carry a hyphenated record ("29-10-2", "22-5"). Their
// component integers feed the RECORD bucket so a cited split/record grounds —
// but only against a claim written in hyphenated N-M form.
const RECORD_STRING_KEYS: ReadonlySet<string> = new Set([
  "homeRecord",
  "awayRecord",
  "record",
  "streak", // e.g. "W3" has no hyphen; harmless — only hyphen-splits contribute
]);

// Keys we EXPLICITLY refuse to ground on even if numeric — time/id/count/
// structural fields that would poison the haystack. The whitelist above already
// gates collection (anything not in PROB_KEYS/PRICE_KEYS contributes nothing),
// so this set is a belt-and-suspenders assertion: if a future edit ever adds one
// of these names to a whitelist by mistake, this guard still drops it. It is
// consulted in buildHaystack().
const EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "commenceTime",
  "commence_time",
  "fetchedAt",
  "generatedAt",
  "updatedAt",
  "startedAt",
  "effectiveDate",
  "returnDate",
  "eventId",
  "gameId",
  "id",
  "playerId",
  "tool_use_id",
  "pickId",
  "bookCount",
  "nGames",
  "gamesPlayed",
  "gamesLast3Days",
  "pa",
  "ip",
  "iterations",
  "openCount",
  "settledCount",
  "total", // desk-record sample-size count (not a bet value)
  "pushes",
  "count",
  "weight",
  "windowDays",
]);

// NOTE (wins/losses): NOT excluded — standings + the desk record report them as
// real values the bot cites (e.g. "45-20"). They ground via STAT_VALUE_KEYS by
// EXACT match (tolerance 0), NOT as prices (±1): a fabricated -110 must never
// borrow a win column near 110. gamesPlayed/total/pushes stay excluded
// (sample-size counts, never a bet claim).

// ─── Number-claim extraction from the REPLY ──────────────────────────────────

export type NumberClaim = {
  raw: string; // the literal token as written, e.g. "+145", "10%", "0.58"
  value: number; // numeric value
  isPercent: boolean; // written as N% OR reads as an edge/probability claim
};

// Numbers that are "free" — common in prose and not a betting claim, so we don't
// require them to be backed: small counts ("1 unit", "2 plays"), the edge floor
// doctrine ("6%"), units, and the responsible-gambling phone number.
const ALWAYS_OK = new Set(["0", "1", "2", "3", "4", "5", "6", "800", "1800"]);

// Extract candidate numeric claims from a reply, tagging each as percent-like or
// not. Percent-like = written with a trailing % OR phrased as an edge/prob (we
// catch the trailing-% case here precisely; the edge-phrasing case is handled by
// the value-bucket the claim is checked against in checkGrounding).
export function extractNumbers(text: string): string[] {
  // Legacy shape: bare numeric tokens (no trailing %), for callers/tests that
  // only care about the digits. Use extractClaims() for percent-awareness.
  return extractClaims(text).map((c) => c.raw.replace(/%$/, ""));
}

export function extractClaims(text: string): NumberClaim[] {
  const out: NumberClaim[] = [];
  // Signed/unsigned number with optional decimal, optionally followed by % .
  // Two number forms:
  //   1. leading-dot decimals ".787", "-.310" — MUST be tried FIRST so the dot
  //      isn't stranded and the digits captured as a bare integer (787). These
  //      are baseball rate stats (OPS/OBP/SLG/AVG, .XXX) that read as sub-1
  //      probabilities and ground against the prob bucket (×100 vs ops/obp/…).
  //   2. standard integers/decimals "145", "7.2", "-110", "0.58".
  const re = /([+-]?\.\d+|[+-]?\d+(?:\.\d+)?)(\s*%)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const numStr = m[1];
    if (numStr === undefined) continue;
    const value = Number(numStr);
    if (!Number.isFinite(value)) continue;
    const isPercent = m[2] !== undefined;
    out.push({ raw: m[0].replace(/\s*%$/, "%"), value, isPercent });
  }
  return out;
}

// ─── Haystack construction (key-walking the PARSED objects) ──────────────────

type Haystack = {
  // Percent values (already ×100 where appropriate). A claimed N% is grounded
  // iff some entry is within PCT_TOLERANCE of N.
  percents: number[];
  // Price/line values (raw). A claimed price N is grounded iff some entry is
  // within PRICE_TOLERANCE of |N|.
  prices: number[];
  // Stat values (ratings, pointDiff, pace, ERAs, ledger figures). A
  // non-price/non-percent claim grounds off these by EXACT match (tolerance 0)
  // — a made-up price can't borrow a stat that merely sits within a point.
  // SIGNED-exact only: a fabricated "-107" can NOT borrow a positive rating
  // "107" via a sign flip.
  statValues: number[];
  // Record-column integers (win/loss columns + hyphenated record splits). These
  // ground ONLY a claim the reply writes in hyphenated N-M form (see
  // collectRecordRaws), so a bare "lay the 7" can't borrow the 7 from a "24-7".
  recordValues: number[];
};

// Tolerance for a claimed percent/edge: must match a percentized prob/edge value
// within this many percentage points. Tight on purpose — a "10% edge" vs a real
// "7% edge" is a DIFFERENT bet and must fail.
const PCT_TOLERANCE = 0.5;
// Tolerance for a raw price/line: -110 vs -111 is the same bet.
const PRICE_TOLERANCE = 1;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Parse each tool-result string, then walk the parsed structure collecting
// numbers ONLY from whitelisted value keys. A string that fails to parse is
// skipped (it contributes nothing — better an over-strict guard than a poisoned
// one).
function buildHaystack(toolResultTexts: string[]): Haystack {
  const percents: number[] = [];
  const prices: number[] = [];
  const statValues: number[] = [];
  const recordValues: number[] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, val] of Object.entries(node)) {
      if (isPlainObject(val) || Array.isArray(val)) {
        visit(val);
        continue;
      }

      // String-valued record keys ("29-10-2", "22-5") → split into component
      // integers so a cited split/record grounds by exact match.
      if (typeof val === "string") {
        if (RECORD_STRING_KEYS.has(key)) {
          for (const n of parseRecordString(val)) recordValues.push(n);
        }
        continue;
      }

      if (typeof val !== "number" || !Number.isFinite(val)) continue;
      // Belt-and-suspenders: never ground on a time/id/count field even if one
      // were ever mistakenly added to a whitelist.
      if (EXCLUDED_KEYS.has(key)) continue;

      if (PROB_KEYS.has(key)) {
        const pct = ALREADY_PERCENT_KEYS.has(key) ? val : val * 100;
        percents.push(pct);
        // An edge/prob is sometimes spoken as the raw fraction too (rare), but
        // we deliberately do NOT add it to prices — percents ground percents.
      } else if (PRICE_KEYS.has(key)) {
        prices.push(val);
      } else if (RECORD_COMPONENT_KEYS.has(key)) {
        // Win/loss record column → RECORD bucket, which grounds only a claim
        // written in hyphenated N-M form. A bare "lay the 7" must not borrow a
        // win column that happens to be 7.
        recordValues.push(val);
      } else if (STAT_VALUE_KEYS.has(key)) {
        // Stat-derived value → EXACT-match bucket only. Deliberately NOT added
        // to prices: a fabricated -110/+4.5 must not borrow a rating or a win
        // column that happens to sit within a point.
        statValues.push(val);
      } else if (/^(player|batter|pitcher)_[a-z_]+$/.test(key)) {
        // Per-game / league-average stat lines from get_player_gamelog +
        // get_player_props (player_points, batter_hits, pitcher_strikeouts, …).
        // Raw counts → exact-match stat values (not the ±1 price band, for the
        // same reason: a dense count shouldn't back a fabricated price).
        statValues.push(val);
      }
      // Any other key (timestamps, ids, counts) contributes nothing.
    }
  };

  for (const text of toolResultTexts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    visit(parsed);
  }

  return { percents, prices, statValues, recordValues };
}

// Parse a hyphenated record string into its component non-negative integers.
// "29-10-2" → [29, 10, 2]; "22-5" → [22, 5]. Anything non-numeric is skipped so
// a streak like "W3" or a stray string contributes nothing.
function parseRecordString(s: string): number[] {
  const parts = s.split("-");
  const out: number[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!/^\d+$/.test(t)) return []; // not a clean record → contribute nothing
    out.push(Number(t));
  }
  // Require at least two components (a real W-L record), else it's just a number.
  return out.length >= 2 ? out : [];
}

// ─── The verdict ─────────────────────────────────────────────────────────────

export function checkGrounding(
  reply: string,
  toolResultTexts: string[]
): GroundingVerdict {
  const claims = extractClaims(reply);
  if (claims.length === 0) return { grounded: true, ungrounded: [] };

  const hay = buildHaystack(toolResultTexts);
  const ungrounded: string[] = [];

  // Year tokens are ALWAYS OK — a season reference ("2025-26 season", "since
  // 1998") is prose, never a bet claim, and must never flag ungrounded. We
  // pre-scan the reply for 4-digit years and YYYY-YY spans and collect the exact
  // raw tokens the extractor will emit for them, so they're skipped below.
  const yearOkRaws = collectYearRaws(reply);

  // Clock-time tokens ("9:40 PM", "12:05") are ALWAYS OK — a game start time is
  // not a money number and can't currently ground (commenceTime is excluded and
  // there's no time bucket), so a "schedule for today" answer listing times
  // would falsely flag ungrounded and get forced into the regen/fallback. We
  // collect the exact raw tokens the extractor emits for each clock time and
  // skip them below. Fabrication risk on a start time is ~zero.
  const timeOkRaws = collectTimeRaws(reply);

  // Record-form tokens: the exact raw tokens the extractor emits for every
  // hyphenated N-M the reply actually writes ("24-7" → "24" and "-7"; "12-2 at
  // home" → "12" and "-2"). A record-column value (wins/losses/parsed splits)
  // may back a claim ONLY if the claim's raw token is one of these — so a bare
  // "lay the 7" can't borrow the 7 from a "24-7" record that's only in the data.
  const recordOkRaws = collectRecordRaws(reply);

  for (const claim of claims) {
    if (yearOkRaws.has(claim.raw)) continue;
    if (timeOkRaws.has(claim.raw)) continue;

    // Free small-count / doctrine integers ("1 unit", "6% floor", the RG phone
    // number). Gate on INTEGER values only: a sub-1 rate like ".787" truncates
    // to 0 and must NOT be waved through here as "0" — it has to ground against
    // the prob bucket (ops/obp/slg/avg, ×100) via the sub-1 path below. Percent
    // claims keep the count-exemption ("6%" floor doctrine) as before.
    const bare = String(Math.abs(Math.trunc(claim.value)));
    const isSubOneDecimal =
      !claim.isPercent && Math.abs(claim.value) > 0 && Math.abs(claim.value) < 1;
    if (!isSubOneDecimal && ALWAYS_OK.has(bare)) continue;

    if (claim.isPercent) {
      // Percent/edge claim → ONLY a percentized prob/edge value can back it, and
      // only within a tight tolerance. A "10% edge" must match a real
      // edge/prob, not a timestamp "10", a price "-110", or a stat integer.
      if (!groundsAsPercent(claim.value, hay.percents)) {
        ungrounded.push(claim.raw);
      }
      continue;
    }

    // Non-percent claim. It might still be a probability stated as a decimal
    // ("model has them at 0.58"): a 0–1 value grounds against percents (×100).
    if (claim.value > 0 && claim.value < 1) {
      if (!groundsAsPercent(claim.value * 100, hay.percents)) {
        ungrounded.push(claim.raw);
      }
      continue;
    }

    // Otherwise it's a price/line OR a cited stat value. It grounds if ANY of:
    //   • a real price/line is within ±1 (the bettor's "same bet" band), OR
    //   • a non-record stat value matches EXACTLY and with the SAME SIGN
    //     (ratings/pointDiff/ERAs — tolerance 0, no abs/sign-flip), OR
    //   • a record column matches EXACTLY *and* the reply wrote this token in
    //     hyphenated N-M form (recordOkRaws).
    // Signed-exact (no abs) is what stops a fabricated "-107" borrowing a
    // positive rating "107"; the record-raw gate stops a bare "7" borrowing a
    // "24-7" record split.
    const recordOk =
      recordOkRaws.has(claim.raw) &&
      groundsAsRecordValue(claim.value, hay.recordValues);
    if (
      !groundsAsPrice(claim.value, hay.prices) &&
      !groundsAsStatValue(claim.value, hay.statValues) &&
      !recordOk
    ) {
      ungrounded.push(claim.raw);
    }
  }

  return { grounded: ungrounded.length === 0, ungrounded };
}

// Collect the exact raw tokens (as extractClaims would emit them) for every
// year-like reference in the text, so they bypass grounding. Handles a lone
// 4-digit year ("2025", "1998") and a YYYY-YY span ("2025-26" → the extractor
// emits "2025" and "-26", both collected here).
function collectYearRaws(text: string): Set<string> {
  const ok = new Set<string>();
  const isYear = (n: number) => n >= 1900 && n <= 2099;
  // YYYY-YY spans first.
  for (const m of text.matchAll(/\b(19\d{2}|20\d{2})-(\d{2})\b/g)) {
    ok.add(m[1]!); // "2025"
    ok.add(`-${m[2]!}`); // "-26" (regex sign-capture on the hyphenated tail)
  }
  // Bare 4-digit years.
  for (const m of text.matchAll(/\b(19\d{2}|20\d{2})\b/g)) {
    if (isYear(Number(m[1]))) ok.add(m[1]!);
  }
  return ok;
}

// Collect the exact raw tokens (as extractClaims emits them) for every clock
// time in the text: "9:40" → "9" and "40"; "12:05 PM" → "12" and "05". Mirrors
// collectYearRaws/collectRecordRaws. The extractor splits on the colon (it isn't
// part of a number), so both the hour and the minute surface as separate bare
// tokens — we collect both so neither flags ungrounded. A game start time is
// prose, never a bet claim.
function collectTimeRaws(text: string): Set<string> {
  const ok = new Set<string>();
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
    ok.add(m[1]!); // hour, e.g. "9" or "12"
    ok.add(m[2]!); // minute, e.g. "40" or "05" — emitted verbatim by the extractor
  }
  return ok;
}

// A claimed percent N is grounded iff some percent value is within PCT_TOLERANCE.
function groundsAsPercent(claimedPct: number, percents: number[]): boolean {
  const target = Math.abs(claimedPct);
  return percents.some((p) => Math.abs(Math.abs(p) - target) <= PCT_TOLERANCE);
}

// A claimed price N is grounded iff some price value is within PRICE_TOLERANCE.
// Match on both signed and absolute forms (prices are sometimes spoken without
// a sign: "they're at 110" meaning -110).
function groundsAsPrice(claimed: number, prices: number[]): boolean {
  const absClaim = Math.abs(claimed);
  return prices.some((p) => {
    if (Math.abs(p - claimed) <= PRICE_TOLERANCE) return true;
    if (Math.abs(Math.abs(p) - absClaim) <= PRICE_TOLERANCE) return true;
    return false;
  });
}

// A claimed stat value grounds iff some stat value matches EXACTLY and with the
// SAME SIGN (tolerance 0, NO absolute-value fallback). Signed-exact is the whole
// point: a legit negative netRtg still matches its stored negative value, but a
// fabricated signed price "-107" can NOT borrow a positive rating "107" via a
// sign flip. Records (which need abs-awareness for the "-7"/"7" split) are
// handled separately by groundsAsRecordValue, gated on the reply writing N-M.
const STAT_VALUE_EPSILON = 1e-9;
function groundsAsStatValue(claimed: number, statValues: number[]): boolean {
  return statValues.some((s) => Math.abs(s - claimed) <= STAT_VALUE_EPSILON);
}

// A claimed record component grounds iff some record integer matches EXACTLY,
// absolute-value aware — the extractor emits "-7" for the second column of a
// "24-7" record, which must match the stored positive 7. This abs match is only
// reachable AFTER the caller confirms the claim's raw token was written in
// hyphenated N-M form (recordOkRaws), so a bare "7" can never reach here.
function groundsAsRecordValue(claimed: number, recordValues: number[]): boolean {
  const absClaim = Math.abs(claimed);
  return recordValues.some(
    (s) =>
      Math.abs(s - claimed) <= STAT_VALUE_EPSILON ||
      Math.abs(Math.abs(s) - absClaim) <= STAT_VALUE_EPSILON
  );
}

// Collect the exact raw tokens (as extractClaims emits them) for every
// hyphenated N-M record form the reply writes: "24-7" → "24" and "-7";
// "12-2 at home" → "12" and "-2". Mirrors collectYearRaws. A record-column
// value backs a claim only if the claim's raw token is in this set.
function collectRecordRaws(text: string): Set<string> {
  const ok = new Set<string>();
  for (const m of text.matchAll(/\b(\d+)-(\d+)\b/g)) {
    ok.add(m[1]!); // "24"  (leading component — extractor emits it bare)
    ok.add(`-${m[2]!}`); // "-7" (trailing component — extractor sign-captures it)
  }
  return ok;
}
