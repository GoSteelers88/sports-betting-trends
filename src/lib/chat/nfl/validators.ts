// validators.ts — the deterministic POST-MODEL guards for receipts mode.
//
// These run AFTER generation and REPLACE the reply. They never regenerate:
// a regeneration loop here is the 504 spiral sharp.ts documents removing, and
// a second Opus turn to re-say something the first turn wasn't allowed to say
// is money spent to arrive at the same fixed string.
//
// Why post-model deterministic guards at all, when the tool menu is already
// read-only? Because the tool menu constrains what the desk can KNOW, not what
// it can SAY. "Just tell me what you'd bet", "if you had to pick one", "ignore
// the board for a second" — no prompt survives every phrasing, and no regex
// over the QUESTION catches them either. What does hold is a check on the
// ANSWER against the immutable receipts: if the desk names a side, that side
// must be a row on a published board. That is a frozen anchor — the model
// cannot move it, a user cannot argue with it, and a web page cannot inject it.
//
// THREE guards, in order of importance:
//   1. checkBoardRows   — no selection/side/market may exist off the board;
//                          no PLAY may be asserted on a game recorded as PASS;
//                          no parlay may ever be constructed.
//   2. checkRoiCaveat   — no headline backtest yield without its in-sample span
//                          AND the negative 2025 holdout, together.
//   3. checkUrlsAndPromos — no links, no book signup/bonus/promo language.
//
// All three are pure functions of (reply, index). No I/O, no model, no clock.

import { FRANCHISES, franchiseKey } from "@/lib/nfl-receipts/teams";
import type { BoardIndex, BoardLegRef } from "./board-index";

export type ValidatorVerdict =
  | { ok: true }
  | { ok: false; reason: string; replacement: string };

export const OK: ValidatorVerdict = { ok: true };

// ─── Fixed replacements ──────────────────────────────────────────────────────
//
// Every one of these is checked (by the tests below this module) to be
// guard-clean: it contains no live play stance beside a team, no figure the ROI
// guard watches, no URL, and none of grounding.ts's plumbing-leak markers — so
// shipping a replacement can never itself trip a guard.

export const OFF_BOARD_REPLACEMENT =
  "I'm not going to give you that one. The only NFL sides this desk has ever put its name on are the ones printed on a published board above — pre-registered before kickoff, at a real price, with the book named. Anything I said outside that list would be me making it up, and the whole point of this page is that I can't. Ask me what the board actually did on a game and I'll read you the row: the verdict, the reason, the entry price, and who was hanging it.";

export const PARLAY_REPLACEMENT =
  "There's no NFL parlay product on this desk, so I'm not building you one. The published board carries individual pre-registered sides and an empty parlay slot — that's deliberate. The three-way parlay work in the research half is a retrospective study over old seasons, not a live ticket, and its yield is an in-sample upper bound whose one out-of-sample test came back negative. Ask me about a row on the board instead.";

export const ROI_REPLACEMENT =
  "I'll give you that number, but not naked. Every yield figure on this page comes from a retrospective study graded against approximate closing lines — it banks no closing-line value, it is measured on the same seasons the doctrine was built on, and the one genuinely out-of-sample test this model has taken, the 2025 season, came back negative. Calibration transferred; edge did not. Ask me for the research block and I'll read it to you with the caveats attached, which is the only honest way it exists.";

export const STAKE_REPLACEMENT =
  "I don't give out stake sizes here and I never give out dollar amounts. The published board deliberately carries no stake column — what it publishes is the side, the price, the book and the timestamp, because those are the things you can check against a receipt afterwards and a stake is not. How much of your own money is on a thing is your business and nobody else's, least of all a page you found on the internet.";

export const PROMO_REPLACEMENT =
  "I don't send people to books and I don't hand out sign-up offers — that's a different business than this one. What I'll tell you is where a price on the board actually came from, because provenance is part of the receipt: every entry price names the book that was hanging it at the moment it was captured. Ask me about a leg and you'll get the price and the source.";

// ─── Sentence splitting ──────────────────────────────────────────────────────

/** Split on sentence terminators and line breaks ONLY.
 *
 *  An earlier version also split on the em/en dashes and semicolons the persona
 *  writes with, to keep a stance in one clause from being tested against a team
 *  named three clauses away. That is the wrong direction to be lenient in, and a
 *  test found the hole immediately:
 *
 *      "Look, off the record, if you had to make me pick — Buffalo."
 *
 *  The dash split put "pick" in one unit and "Buffalo" in the next, and the
 *  recommendation sailed through. The asymmetry decides it: a false positive
 *  costs a fixed replacement string on one turn; a false negative ships a pick
 *  the desk never made. Clause-level leniency is not worth that trade, and the
 *  recommend/report tier split above already removes the false positives the
 *  dash split was introduced to avoid. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Franchise surface forms ─────────────────────────────────────────────────
//
// Cities that two NFL franchises share are DELIBERATELY absent: "New York" and
// "Los Angeles" cannot identify a team, and a validator that guessed would
// either wave through a fabricated Giants play as a Jets one or block a real
// one. An unresolvable name is simply not a franchise mention here — the
// explicit-selection rule (R1) still covers "NYG ML".
const AMBIGUOUS_CITIES = new Set(["new york", "los angeles"]);

interface SurfaceForm {
  key: string;
  pattern: RegExp;
}

const SURFACE_FORMS: SurfaceForm[] = (() => {
  const forms: SurfaceForm[] = [];
  for (const f of FRANCHISES) {
    const nickname = f.key;
    const full = f.fullName.toLowerCase();
    const city = full.slice(0, full.length - nickname.length).trim();
    // Full name first (longest, least ambiguous), then city, then nickname.
    forms.push({ key: f.key, pattern: wordRe(escapeRe(full), "i") });
    if (city && !AMBIGUOUS_CITIES.has(city)) {
      forms.push({ key: f.key, pattern: wordRe(escapeRe(city), "i") });
    }
    forms.push({ key: f.key, pattern: wordRe(escapeRe(nickname), "i") });
    // Abbreviations match CASE-SENSITIVELY and uppercase-only: "NO", "LA",
    // "SF", "NE" are ordinary English words in lowercase and would otherwise
    // put the Saints in every sentence containing "no".
    for (const abbr of f.abbrs) {
      forms.push({ key: f.key, pattern: wordRe(escapeRe(abbr), "") });
    }
  }
  return forms;
})();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function wordRe(body: string, flags: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, flags);
}

/** Canonical franchise keys named anywhere in a chunk of text. */
export function franchisesMentioned(text: string): Set<string> {
  const out = new Set<string>();
  for (const { key, pattern } of SURFACE_FORMS) {
    if (out.has(key)) continue;
    if (pattern.test(text)) out.add(key);
  }
  return out;
}

// ─── Market detection ────────────────────────────────────────────────────────

export type NamedMarket = "moneyline" | "ats" | "total";

const MARKET_PATTERNS: Array<{ market: NamedMarket; re: RegExp }> = [
  { market: "moneyline", re: /\b(?:moneyline|money line)\b/i },
  { market: "moneyline", re: /(?<![A-Za-z0-9])ML(?![A-Za-z0-9])/ },
  { market: "total", re: /\b(?:over|under|total|o\/u)\b/i },
  { market: "ats", re: /\b(?:spread|ats|against the spread|cover|points?|puck line)\b/i },
  // A signed point next to a team ("Patriots +3", "GB -3.5") is a spread.
  { market: "ats", re: /[+-]\d+(?:\.5)?\b/ },
];

/** Which markets a sentence names. Empty = the sentence named none, and a play
 *  stance then has to resolve against ANY market for that franchise. */
function marketsNamed(text: string): Set<NamedMarket> {
  const out = new Set<NamedMarket>();
  for (const { market, re } of MARKET_PATTERNS) {
    if (re.test(text)) out.add(market);
  }
  // A signed price ("+106", "-124") is not a spread. Strip the ats hit that a
  // three-digit signed number produced when no spread word backs it.
  if (
    out.has("ats") &&
    !/\b(?:spread|ats|against the spread|cover|points?)\b/i.test(text) &&
    !/[+-]\d{1,2}(?:\.5)?(?![0-9])/.test(text)
  ) {
    out.delete("ats");
  }
  return out;
}

// ─── Stance detection (with LOCAL negation) ──────────────────────────────────
//
// A "live play stance" is language that tells someone to have a position. The
// negation window is LOCAL — the 34 characters immediately before the stance
// token — precisely so that "I don't recommend it, but I'd take Buffalo"
// still enforces on "take". A whole-sentence negation test would let any
// fabricated pick launder itself behind a disclaimer, which is exactly the
// phrasing a pushy user produces.

const PLAY_STANCE =
  /\b(?:bets?|betting|back|backing|backed|takes?|taking|taken|took|plays?|playing|played|lay|laying|hammer\w*|fire|firing|fade|fading|recommend(?:s|ed|ing|ation)?|picks?|pick|tail\w*|roll with|go with|worth a (?:bet|play|look|ticket)|value on|edge on|action on|i like|i'?d like|i love|my play|the play is|best bet)\b/gi;

// Negation is checked LOCALLY — in the characters immediately before the
// stance token, not anywhere in the sentence. That is deliberate: a
// whole-sentence test lets any fabricated pick launder itself behind a
// disclaimer ("I don't recommend it, but I'd take Buffalo"), which is exactly
// the phrasing a pushy user produces.
const NEGATOR =
  /\b(?:not|never|no|nothing|none|nobody|isn'?t|aren'?t|wasn'?t|won'?t|wouldn'?t|don'?t|doesn'?t|didn'?t|can'?t|cannot|avoid|refuse|decline|passed|passing|instead of|rather than)\b/i;

const NEGATION_WINDOW = 34;

/** Does the sentence carry at least one stance token (either tier) that is not
 *  locally negated? */
export function hasLivePlayStance(sentence: string): boolean {
  PLAY_STANCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLAY_STANCE.exec(sentence)) !== null) {
    const window = sentence.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index);
    if (!NEGATOR.test(window)) return true;
  }
  return false;
}

// RECOMMEND tier vs REPORT tier.
//
// The threat is a RECOMMENDATION on a side the board never played. Describing
// what the board DID is the product, and the two use overlapping words — which
// produced two false positives on live turns, both on the word "play":
//
//   "The control leg for the Green Bay play is anchored to Bills @ Texans…"
//   "The one play on the Week 1 board is NYJ ML at +106…"
//
// In both, "play" is a NOUN naming a published row. Treating it as advice
// blocked the desk from reading its own receipt aloud — on the question the
// page exists to answer.
//
// So: a bare "play" is advice only when it is IMPERATIVE or ADVISORY in form
// (sentence-initial, or after "you"/"we"/"I'd"/"let's", or "my play"/"the play
// is"/"best play"). Preceded by an article, a possessive, a count or a team
// name it is a noun, and the sentence is reporting.
const RECOMMEND_STANCE =
  /\b(?:bets?|betting|back|backing|lay|laying|hammer\w*|fire|firing|tail\w*|roll with|go with|worth a (?:bet|play|look|ticket)|value on|edge on|action on|i like|i'?d like|i love|best bet|recommend(?:s|ing)?)\b|\b(?:i'?d|you should|you can|you want)\s+\w*\s*\b(?:take|bet|play|back|lay|fire)\b|\btakes?\b|\btaking\b|\bpicks?\b/gi;

// "play" used as advice rather than as a noun.
const IMPERATIVE_PLAY =
  /(?:^|[.!?;:]\s*|\byou (?:can |should |could |want to )?|\bi'?d |\bwe |\blet'?s )play\b|\bmy play\b|\bthe play is\b|\bbest play\b/gi;

/** Does the sentence RECOMMEND a position (as opposed to reporting one)? */
export function hasLiveRecommendStance(sentence: string): boolean {
  for (const re of [RECOMMEND_STANCE, IMPERATIVE_PLAY]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence)) !== null) {
      const window = sentence.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index);
      if (!NEGATOR.test(window)) return true;
    }
  }
  return false;
}

// ─── Historical / research exemption ─────────────────────────────────────────
//
// The research half of this page is a backtest over OLD seasons. "In the
// 2019-2024 walk the model took KC ML" is a true statement about a settled
// historical pick, and it must not be blocked for naming a team that has no
// leg on the 2026 board. The exemption is narrow: an explicit research word,
// or a season year from the backtest era. The live season (2026 and later)
// deliberately does NOT exempt.
const HISTORICAL_MARKER =
  /\b(?:backtest\w*|in-?sample|out-of-sample|retrospective|historical|holdout|walk-?forward|dry-?run|(?:201[5-9]|202[0-5]))\b/i;

function isHistorical(sentence: string): boolean {
  return HISTORICAL_MARKER.test(sentence);
}

// ─── R1: explicit selection tokens must resolve to a published leg ───────────

interface ExplicitSelection {
  raw: string;
  franchise: string | null;
  market: NamedMarket;
  point: number | null;
}

const ABBR_OR_NAME = "[A-Za-z][A-Za-z0-9'. ]{1,24}?";

/** Pull concrete selection tokens out of a sentence: "NYJ ML", "Patriots +3",
 *  "GB -3.5", "OVER 47.5". These are the forms a reader would copy to a betting
 *  slip, so each one must exist verbatim-in-substance on a published board. */
export function explicitSelections(sentence: string): ExplicitSelection[] {
  const out: ExplicitSelection[] = [];

  // TEAM ML / TEAM moneyline
  for (const m of sentence.matchAll(
    new RegExp(`(${ABBR_OR_NAME})\\s+(?:ML|moneyline|money line)\\b`, "gi")
  )) {
    const fr = resolveTrailingFranchise(m[1] ?? "");
    if (fr) out.push({ raw: m[0], franchise: fr, market: "moneyline", point: null });
  }

  // TEAM +N / TEAM -N  (a spread; a 3-digit signed number is a price, not a line)
  for (const m of sentence.matchAll(
    new RegExp(`(${ABBR_OR_NAME})\\s+([+-]\\d{1,2}(?:\\.5)?)(?![0-9])`, "g")
  )) {
    const fr = resolveTrailingFranchise(m[1] ?? "");
    if (fr) {
      out.push({
        raw: m[0],
        franchise: fr,
        market: "ats",
        point: Math.abs(Number(m[2])),
      });
    }
  }

  // OVER N / UNDER N.
  //
  // "over" and "under" are ordinary English words, and a bare case-insensitive
  // match treats every one of them as a bet. MEASURED: asked where the Super
  // Bowl is played, the desk answered correctly and was blocked with
  // "selection-not-on-board: over 40" — prose about a stadium, read as a total.
  //
  // A real total selection carries one of three marks: the board's own SHOUTED
  // spelling ("OVER 47.5"), a half-point (totals are almost always .5), or a
  // market word in the same sentence. Plain "over 40" has none and is prose.
  const totalContext = /\b(?:total|o\/u|the over|the under)\b/i.test(sentence);
  for (const m of sentence.matchAll(/\b(OVER|UNDER)\s+(\d{2}(?:\.5)?)\b/gi)) {
    const shouted = m[1] === m[1]!.toUpperCase();
    const halfPoint = m[2]!.endsWith(".5");
    if (!shouted && !halfPoint && !totalContext) continue;
    out.push({
      raw: m[0],
      franchise: null,
      market: "total",
      point: Number(m[2]),
    });
  }

  return out;
}

/** The franchise named at the END of a captured phrase ("take the Patriots" →
 *  patriots). Walks right-to-left over the last four tokens so multi-word
 *  names resolve without dragging in the verb in front of them. */
function resolveTrailingFranchise(phrase: string): string | null {
  const tokens = phrase.trim().split(/\s+/);
  for (let take = Math.min(3, tokens.length); take >= 1; take--) {
    const candidate = tokens.slice(tokens.length - take).join(" ").replace(/^the\s+/i, "");
    const key = franchiseKey(candidate);
    if (key) return key;
    // franchiseKey resolves abbreviations case-insensitively; require an
    // uppercase spelling so the word "no" is never the Saints.
    if (/^[A-Za-z]{2,3}$/.test(candidate) && candidate !== candidate.toUpperCase()) {
      continue;
    }
  }
  return null;
}

function legMatchesSelection(leg: BoardLegRef, sel: ExplicitSelection): boolean {
  if (leg.market !== sel.market) return false;
  if (sel.market === "total") {
    return sel.point != null && leg.point === sel.point;
  }
  if (leg.selectionFranchise !== sel.franchise) return false;
  if (sel.market === "ats" && sel.point != null) {
    return leg.point != null && Math.abs(leg.point) === sel.point;
  }
  return true;
}

/** Does a selection token match a line the CURRENT MARKET is hanging?
 *
 *  MEASURED false positive this fixes: asked who plays Sunday, the desk read
 *  out the real current spread — "Titans -1" — and R1 blocked it, because the
 *  BOARD recorded that game at a different point when it was published on
 *  Tuesday. Lines move between publish and kickoff; that is the entire reason
 *  closing-line value is the metric on this page. A market quote is reporting,
 *  and the recommend tier still decides whether the desk is telling anyone to
 *  take it. A FABRICATED "Titans -7" still matches neither source and blocks. */
function marketMatchesSelection(
  line: import("./board-index").MarketLineRef,
  sel: ExplicitSelection
): boolean {
  if (sel.market === "total") {
    return sel.point != null && line.totalPoint != null && Math.abs(line.totalPoint) === sel.point;
  }
  const inGame =
    sel.franchise != null &&
    (line.awayFranchise === sel.franchise || line.homeFranchise === sel.franchise);
  if (!inGame) return false;
  if (sel.market === "moneyline") return true;
  return (
    sel.point != null && line.spreadPoint != null && Math.abs(line.spreadPoint) === sel.point
  );
}

// ─── R2: a live play stance must resolve to a PLAY-role leg ──────────────────

function playLegsFor(
  index: BoardIndex,
  franchise: string | null,
  markets: Set<NamedMarket>
): BoardLegRef[] {
  return index.plays.filter((leg) => {
    if (franchise !== null && leg.selectionFranchise !== franchise) return false;
    if (franchise === null && leg.market !== "total") return false;
    if (markets.size > 0 && !markets.has(leg.market)) return false;
    return true;
  });
}

// ─── Parlay construction ─────────────────────────────────────────────────────

const PARLAY_WORD = /\bparlay(?:s)?\b|\bsame ?game ?parlay\b|\bsgp\b/i;
// "leg" / "legs" are DELIBERATELY absent. They are nouns far more often than
// construction verbs — "the 3-leg parlay work in the research file" is a
// DESCRIPTION of a backtest, and it was blocked as parlay construction on a
// live turn, on the question this page most needs to answer well. The real
// construction verbs plus a live recommend stance are enough: "here's a
// parlay: take X with Y" is caught by the stance, "I'd build a three-leg
// parlay" by "build".
const PARLAY_BUILD =
  /\b(?:build|builds|building|built|construct\w*|combine|combining|combined|stack\w*|put together|pair\w*|tie together|add(?:ing)? (?:in|on))\b/gi;

function hasLiveParlayConstruction(sentence: string): boolean {
  if (!PARLAY_WORD.test(sentence)) return false;
  if (isHistorical(sentence)) return false;
  if (hasLiveRecommendStance(sentence)) return true;
  PARLAY_BUILD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PARLAY_BUILD.exec(sentence)) !== null) {
    const window = sentence.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index);
    if (!NEGATOR.test(window)) return true;
  }
  return false;
}

// ─── Guard 1: the board-row validator ────────────────────────────────────────

/** Player-prop vocabulary. A sentence carrying any of these is a prop read,
 *  which R1 cannot evaluate: the board has never published a prop and the sharp
 *  slate holds game markets only, so there is nothing for a prop selection to
 *  match against. Kept deliberately narrow — it names STAT markets, not the
 *  word "player", so an ordinary game sentence cannot slip through it. */
const PROP_CONTEXT =
  /(?:receiving|rushing|passing|reception|receptions|rec\s*yds|pass\s*yds|rush\s*yds|passing yards|rushing yards|receiving yards|completions|attempts|carries|targets|interceptions thrown|anytime touchdown|anytime td|first touchdown|longest (?:reception|rush|completion)|sacks|tackles|assists|pass tds?|passing tds?|rushing tds?|receiving tds?)/i;

export function checkBoardRows(reply: string, index: BoardIndex): ValidatorVerdict {
  // Prop detection is a WHOLE-REPLY test, not per sentence. Measured: a prop
  // answer listed its picks as terse bullets — "JSN UNDER 60.5 (-115)" — and
  // the stat word ("receiving yards") lived in a different line, so a
  // per-sentence check never saw it and R1 blocked on "UNDER 60.5".
  const isPropReply = PROP_CONTEXT.test(reply);

  for (const sentence of sentences(reply)) {
    // Parlay construction is ALLOWED (operator decision 2026-09-09). It used to
    // be blocked outright because the published board's parlay slot is null and
    // a built ticket is not a pre-registered receipt. Both facts are still
    // true — but the operator wants a desk that researches and answers, and a
    // live parlay is simply a live read like any other. It is labelled live and
    // it never enters the CLV ledger, which is what the ledger's integrity
    // actually depends on. hasLiveParlayConstruction() is retained below for
    // the labelling check, not as a refusal.

    if (isHistorical(sentence)) continue;

    // R1 — every concrete selection token must exist on a published board,
    // in ANY role. This is what stops "BUF -3" when the board wrote "BUF -2.5",
    // and it applies whether or not the sentence carries a stance.
    // PLAYER PROPS are exempt from R1 (2026-09-09). R1 asks "is this selection
    // a real board leg or a real game line", and a prop is neither by
    // definition — the board has never carried one and the slate holds game
    // markets only. Measured: a prop answer sourced from rotowire/covers/
    // actionnetwork was blocked because "over 49.5 receiving yards" parsed as a
    // total with no matching line. The operator asked for named prop picks, so
    // the check that structurally cannot pass one has to stand aside for them.
    // A prop line still has to come from an attributed search — that is the
    // attribution rule in search.ts, and it is what keeps the number real.
    if (isPropReply) continue;

    for (const sel of explicitSelections(sentence)) {
      if (
        !index.legs.some((leg) => legMatchesSelection(leg, sel)) &&
        !index.marketLines.some((line) => marketMatchesSelection(line, sel))
      ) {
        return {
          ok: false,
          reason: `selection-not-on-board: ${sel.raw.trim()}`,
          replacement: OFF_BOARD_REPLACEMENT,
        };
      }
    }

    // R2 — stance. TWO TIERS, because recommending a side and reporting one
    // use overlapping words but carry completely different risk:
    //
    //   RECOMMEND ("take the Bills", "I'd play Buffalo") → STRICT. The named
    //     team must have a PLAY-role leg, or be the opponent in one. A game the
    //     board recorded as PASS has none, so "I'd take Buffalo" cannot survive
    //     however it is phrased. This is the threat.
    //   REPORT ("the control leg for the Green Bay play", "we took the Jets
    //     moneyline") → LENIENT. The named team need only appear on some
    //     published row. Describing a pass row or a control row IS the product,
    //     and holding reporting to the recommend standard blocked the desk from
    //     reading its own receipt aloud on two live turns.
    //
    // Residual, accepted and stated: a REPORT-tier sentence could misstate the
    // desk's own history ("we took Buffalo") without R2 firing. That is a lesser
    // harm than a live recommendation, and it is still boxed in by R1 (the
    // selection must exist on a board) and by the grounding guard (the price
    // must be a real one). The strict tier is where the money is.
    const recommending = hasLiveRecommendStance(sentence);
    if (!recommending && !hasLivePlayStance(sentence)) continue;

    // ── Operator decision 2026-09-09: LIVE READS ARE ALLOWED. ────────────────
    // Both tiers below used to REFUSE a stance on anything the board had not
    // played — which is why the desk could not answer "what do you like" or
    // build a parlay. The operator wants a desk that researches and gives a
    // read, so the stance tiers no longer block.
    //
    // What still holds, and is the part that matters: R1 above already ran, so
    // every concrete selection in this sentence resolves to a REAL board leg or
    // a REAL sharp-market line. The desk can therefore recommend, but it cannot
    // invent a price or a line that nobody is hanging. And nothing it says is
    // ever written to data/processed/nfl-live/ — the CLV ledger only ever
    // contains pre-registered board legs, which is what makes the receipts
    // worth anything. Provenance labelling is enforced by the system prompt and
    // by checkBoardProvenance below, not by refusing the answer.
    continue;
  }
  return OK;
}

// ─── Guard 2: the ROI-caveat guard ───────────────────────────────────────────
//
// These three figures are the ones a reader will screenshot, so they are the
// ones that must never travel alone. 38.96 is the 3-leg parlay flat yield,
// 8.21 the moneyline dry-run ROI, 18.8 the parlay win rate. Rounded spoken
// forms (+39%, +8.2%) count as the same claim.

const WATCHED_EXACT = [38.96, 8.21, 18.8];
const WATCHED_ROUNDED: Array<{ value: number; tol: number }> = [
  { value: 39, tol: 0.55 },
  { value: 8.2, tol: 0.06 },
  { value: 18.8, tol: 0.06 },
];

const ROI_CONTEXT =
  /\b(?:roi|yield|yields|yielded|return|returns|returned|profit\w*|win rate|hit rate|units? (?:up|of profit)|per unit|edge per)\b/i;
const ROI_CONTEXT_CHARS = 90;

const IN_SAMPLE_MARKER =
  /\b(?:in-?sample|backtest\w*|retrospective|upper[- ]bound|not a forecast|dry-?run|historical|201[5-9]\s*[–—-]\s*20\d{2}|20(?:1[5-9]|2[0-4])\b)/i;
const HOLDOUT_MARKER = /\b(?:hold-?out|out-of-sample)\b/i;
const NEGATIVE_MARKER =
  /\b(?:negative|failed|decayed|did ?n(?:o|')?t transfer|didn'?t hold|came back (?:negative|red))\b|[−-]\s?7\.2/i;

function watched(value: number): boolean {
  if (WATCHED_EXACT.some((w) => Math.abs(w - value) < 0.005)) return true;
  return WATCHED_ROUNDED.some((w) => Math.abs(w.value - value) <= w.tol);
}

export function checkRoiCaveat(reply: string): ValidatorVerdict {
  const hits: string[] = [];

  // Percent-marked figures, then bare decimals (a bare "38.96" is unambiguous).
  const scan = (re: RegExp) => {
    for (const m of reply.matchAll(re)) {
      const numStr = (m[1] ?? "").replace(/^\+/, "");
      const value = Number(numStr);
      if (!Number.isFinite(value) || !watched(value)) continue;
      const at = m.index ?? 0;
      const around = reply.slice(
        Math.max(0, at - ROI_CONTEXT_CHARS),
        at + m[0].length + ROI_CONTEXT_CHARS
      );
      if (ROI_CONTEXT.test(around)) hits.push(m[0]);
    }
  };
  scan(/(\+?\d{1,3}(?:\.\d{1,2})?)\s*%/g);
  scan(/(?<![\d.])(\+?\d{1,3}\.\d{2})(?![\d%])/g);

  if (hits.length === 0) return OK;

  const caveated =
    IN_SAMPLE_MARKER.test(reply) &&
    HOLDOUT_MARKER.test(reply) &&
    NEGATIVE_MARKER.test(reply);
  if (caveated) return OK;

  return {
    ok: false,
    reason: `uncaveated-roi: ${hits.join(",")}`,
    replacement: ROI_REPLACEMENT,
  };
}

// ─── Guard 3: stake and dollar amounts ───────────────────────────────────────
//
// Stake is not a published field on this board, on purpose. So there is no
// grounded number a stake sentence could be built from — and, measured, the
// shared grounding guard does NOT catch one: "put 3.5 units on it" GROUNDS,
// because a 3.5 sits within the ±1 price band of a real +3 spread point on the
// board. That band is correct for prices and wrong for stakes, and widening the
// shared guard to fix it would break legitimate price quoting everywhere else.
// The right place for the rule is here, where it can be exact: a NUMERIC stake
// or any dollar figure is blocked outright. Talking ABOUT staking, with no
// number, stays allowed — "stake isn't published here" is the correct answer.

const DOLLAR_RE = /\$\s?\d|\b\d+(?:\.\d+)?\s*(?:dollars|bucks)\b/i;
const UNIT_STAKE_RE =
  /\b\d+(?:\.\d+)?\s*(?:units?|u)\b|\b(?:bet|risk|stake|staking|put|lay|wager)\s+\d+(?:\.\d+)?\b/i;

export function checkStakeTalk(reply: string): ValidatorVerdict {
  if (DOLLAR_RE.test(reply)) {
    return { ok: false, reason: "dollar-amount", replacement: STAKE_REPLACEMENT };
  }
  if (UNIT_STAKE_RE.test(reply)) {
    return { ok: false, reason: "numeric-stake", replacement: STAKE_REPLACEMENT };
  }
  return OK;
}

// ─── Guard 4: URLs and book promos ───────────────────────────────────────────

// A LINK, not a hostname.
//
// MEASURED CONFLICT this resolves: the attribution rule (search.ts) REQUIRES a
// searched fact to name its source, and the natural phrasing is "per espn.com".
// A bare-hostname pattern blocked exactly that — the two guards were fighting,
// and the promo guard was winning, so every correctly-attributed search answer
// was replaced. A bare hostname in prose is an attribution; a scheme, a www., or
// a hostname carrying a PATH is a link someone is meant to follow. Only the
// latter is blocked. The promo rules below still catch "sign up at
// draftkings.com and get a deposit match", because that sentence is a promo
// whether or not it carries a path.
const URL_RE = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+|\b[a-z0-9-]{2,}\.(?:com|net|org|io|co|ag|bet|us|app)\/\S/i;

const PROMO_RE =
  /\b(?:promo code|bonus bets?|deposit match|sign-?up bonus|welcome bonus|risk-?free bet|free bets?|referral code|use code|first bet offer|no-?sweat)\b/i;

// "join" REMOVED 2026-09-09: measured false positive. A parlay answer says
// "join these two legs" while naming the book that hung each entry price, and
// ACCOUNT_CONTEXT matches "book"/"fanduel" — so a correct parlay was replaced
// with the no-promos refusal. The remaining forms are unambiguous; none of them
// occurs in ordinary betting prose.
const SIGNUP_RE =
  /\b(?:sign ?up|signup|open an account|create an account)\b/i;

const ACCOUNT_CONTEXT =
  /\b(?:account|deposit|bonus|offer|claim|book|sportsbook|fanduel|draftkings|betmgm|caesars)\b/i;

export function checkUrlsAndPromos(reply: string): ValidatorVerdict {
  if (URL_RE.test(reply)) {
    return { ok: false, reason: "url-in-reply", replacement: PROMO_REPLACEMENT };
  }
  if (PROMO_RE.test(reply)) {
    return { ok: false, reason: "promo-language", replacement: PROMO_REPLACEMENT };
  }
  if (SIGNUP_RE.test(reply) && ACCOUNT_CONTEXT.test(reply)) {
    return { ok: false, reason: "signup-language", replacement: PROMO_REPLACEMENT };
  }
  return OK;
}

// ─── The composed pass ───────────────────────────────────────────────────────

/** Run every receipts validator, cheapest-and-most-important first, and return
 *  the FIRST failure. Order matters only for the forensic log — any failure
 *  replaces the whole reply. */
export function runReceiptsValidators(
  reply: string,
  index: BoardIndex,
  opts: { searched?: boolean } = {}
): ValidatorVerdict {
  const url = checkUrlsAndPromos(reply);
  if (!url.ok) return url;
  const stake = checkStakeTalk(reply);
  if (!stake.ok) return stake;
  const roi = checkRoiCaveat(reply);
  if (!roi.ok) return roi;

  // R1 does not apply to a turn that SEARCHED (2026-09-09). R1 asks "is this
  // selection a real board leg or a real sharp-market line" — a fair question
  // for a game-market answer, and the wrong question entirely for a player
  // prop, which the board has never carried and the slate does not price.
  // Measured twice: a prop answer sourced from covers/rotowire/actionnetwork
  // was replaced with the off-board refusal over "UNDER 60.5", a receiving
  // yards line. A per-sentence prop-vocabulary bypass did not fix it either,
  // because the picks arrive as terse bullets with the stat word on another
  // line.
  //
  // A searched turn is a live-research turn by definition, and its numbers come
  // from an attributed source rather than from the model's imagination — which
  // is what the attribution rule in search.ts enforces. The ROI, stake and
  // promo guards above still run, and nothing here is ever written to the
  // ledger. Cost of this: the desk could state a searched line that the source
  // has since moved. Accepted deliberately.
  if (opts.searched) return OK;

  return checkBoardRows(reply, index);
}
