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
  "Ask me about a different NBA or MLB game, or come back once tonight's lines have firmed up.";

export type GroundingVerdict = {
  grounded: boolean;
  // The numeric tokens we could not trace to any tool result.
  ungrounded: string[];
};

// ─── The grounding whitelist ─────────────────────────────────────────────────
//
// We collect numbers ONLY from these VALUE keys, walking the parsed tool-result
// objects. Two buckets, because percents and prices ground differently:
//
//   PRICE_KEYS  — raw American odds / lines / points. A ±1 tolerance is fine
//                 here (-110 vs -111 is the same bet to a bettor); these are
//                 NEVER a valid backing for a percent/edge claim.
//   PROB_KEYS   — probabilities (0–1 decimals) and edges (0–1 fractions, or the
//                 occasional already-percentized field). These are the ONLY
//                 valid backing for a percent/edge claim, and they match TIGHTLY
//                 (the claimed percent must be within ~0.5pp of value*100).
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
  "evPct", // already a percent (e.g. 7.4 means 7.4%) — handled below
  "clvBeatRatePct", // already a percent
  "confidence", // 0–1 prop confidence
]);

// Keys whose value is ALREADY expressed as a percent (e.g. 7.4 = 7.4%), so we
// must NOT multiply by 100 when percentizing.
const ALREADY_PERCENT_KEYS: ReadonlySet<string> = new Set([
  "evPct",
  "clvBeatRatePct",
]);

// Price / line / point value keys → contribute price-grounding values (±1).
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
  "softAmerican",
  "projected",
  "stddev",
  "rollingMean",
  "clvCents",
  "avgClvCents",
  "expectedMargin",
  "k9",
  "fbVelocity",
  "velocityDelta",
  "woba",
  "xwoba",
  "xwobaGap",
  "recentAvgPoints",
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
  "tool_use_id",
  "pickId",
  "bookCount",
  "nGames",
  "pa",
  "ip",
  "iterations",
  "openCount",
  "settledCount",
  "wins",
  "losses",
  "count",
  "weight",
]);

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
  const re = /([+-]?\d+(?:\.\d+)?)(\s*%)?/g;
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

  return { percents, prices };
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

  for (const claim of claims) {
    const bare = String(Math.abs(Math.trunc(claim.value)));
    if (ALWAYS_OK.has(bare)) continue;

    if (claim.isPercent) {
      // Percent/edge claim → ONLY a percentized prob/edge value can back it, and
      // only within a tight tolerance. A "10% edge" must match a real
      // edge/prob, not a timestamp "10" or a price "-110".
      if (!groundsAsPercent(claim.value, hay.percents)) {
        ungrounded.push(claim.raw);
      }
      continue;
    }

    // Non-percent claim. It might still be a probability stated as a decimal
    // ("model has them at 0.58"): a 0–1 value grounds against percents (×100).
    // Otherwise it's a price/line and grounds against prices with ±1.
    if (claim.value > 0 && claim.value < 1) {
      if (!groundsAsPercent(claim.value * 100, hay.percents)) {
        ungrounded.push(claim.raw);
      }
      continue;
    }

    if (!groundsAsPrice(claim.value, hay.prices)) {
      ungrounded.push(claim.raw);
    }
  }

  return { grounded: ungrounded.length === 0, ungrounded };
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
