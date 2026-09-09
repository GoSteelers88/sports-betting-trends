// exp5-view.ts — the pure read-model behind /nfl's RESEARCH half.
//
// The research half of /nfl publishes exactly two blocks out of the committed
// aggregate summary `data/processed/nfl-exp5.json`: player props and 3-leg
// parlays. The moneyline block (+8.21% ROI) is deliberately NOT surfaced here;
// it stays on the homepage card.
//
// Four rules this module exists to enforce, because prose alone forgets them:
//
//  1. NOTHING is claimed that the file does not carry. The props block has no
//     ROI and no CLV — it was graded against nflverse box scores, never
//     against a market price — so this module exposes no such field and the
//     page cannot invent one. `propsHitRatePct` is offered as a HIT RATE
//     against a threshold and is named that way in the type.
//  2. Every figure is IN-SAMPLE over a measured span. RESEARCH_SPAN below is
//     not a guess: it is the season range of the two private logs the summary
//     writer reads (see the constant's comment for the counts).
//  3. The parlay yield is an OPTIMISTIC UPPER BOUND — the backtest grades
//     against nflverse approximate closing lines, so it banks no closing-line
//     value. `parlayUpperBound` is a required boolean on the type so a caller
//     that renders the yield cannot skip the caveat by forgetting a prop.
//  4. Malformed input degrades to null, never to zeros. A block rendered as
//     "0 settled" would be a claim; a hidden block is an absence.

/** The one devigged-CLV research doc every backtest figure on the page links.
 *  The repo is public; these are the committed write-ups themselves, not a
 *  summary of them. */
export const REPO_DOC_BASE =
  "https://github.com/GoSteelers88/sports-betting-trends/blob/master/docs/research/";
export const HOLDOUT_DOC = "2026-08-18-holdout-validation-2025.md";
export const PREREG_DOC = "2026-08-29-nfl-receipts-preregistration.md";
export const HOLDOUT_DOC_URL = REPO_DOC_BASE + HOLDOUT_DOC;
export const PREREG_DOC_URL = REPO_DOC_BASE + PREREG_DOC;

/** Seasons the two blocks on this page were walked over. MEASURED 2026-09-09
 *  against the private logs the summary writer reads, not transcribed from
 *  copy elsewhere on the site:
 *
 *    data/private/nfl-loop/prop-picks-log.jsonl  1,181 rows, seasons 2019–2024
 *    data/private/nfl-loop/picks-log.jsonl       4,794 rows, seasons 2019–2024
 *
 *  The parlay engine (`runNflParlayBacktest`) consumes exactly those two logs,
 *  so both published blocks share the span.
 *
 *  NOTE — this is NOT the span of the moneyline book
 *  (data/private/nfl-loop/quant/quant-desk-nfl-book.json: 310 bets, seasons
 *  2015–2024). That block is not published on this page. The public JSON
 *  carries no season field, so this constant is the only place the span
 *  lives; if the summary writer ever emits one, read it instead of this. */
export const RESEARCH_SPAN = "2019–2024";

/** The 2025 out-of-sample result, stated the same way everywhere it appears.
 *  Source: docs/research/2026-08-18-holdout-validation-2025.md. */
export const HOLDOUT_HEADLINE =
  "The one out-of-sample test this model has taken came back negative: ATS −7.2% ROI, and the underdog doctrine decayed from +9.6% in-walk to −3.6% out-of-sample. Calibration transferred. Edge did not.";

export interface PropExample {
  player: string;
  team: string;
  stat: string;
  threshold: number;
  side: "over" | "under";
  result: "win" | "loss" | "push";
  rationale: string;
  season: number | null;
  week: number | null;
}

export interface PropsBlock {
  wins: number;
  losses: number;
  pushes: number;
  /** wins + losses + pushes as the file reports it. */
  settled: number;
  /** Picks whose stat line never posted a threshold — counted, never dropped. */
  noData: number;
  /** wins + losses. Pushes decide nothing and are not in the denominator. */
  decided: number;
  /** wins / decided, as a percentage, 1dp. A HIT RATE AGAINST A THRESHOLD —
   *  there is no price behind it, so it is not a win rate and not a return. */
  hitRatePct: number | null;
  examples: PropExample[];
}

export interface ParlaysBlock {
  wins: number;
  losses: number;
  pushes: number;
  settled: number;
  decided: number;
  /** Profit per 1u risked at a FLAT stake, percent. Not a compounding return. */
  flatYieldPct: number;
  winRatePct: number;
  /** The win rate the parlay odds themselves require. */
  breakEvenPct: number;
  /** Mean model-minus-market edge across legs, percentage points. */
  avgLegEdgePct: number | null;
  /** True whenever the yield is graded against approximate closing lines and
   *  therefore banks no CLV. Required, not optional: a renderer must decide. */
  upperBound: true;
}

export interface ResearchView {
  generatedAt: string | null;
  props: PropsBlock | null;
  parlays: ParlaysBlock | null;
}

const isNum = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);

function rec(x: unknown): { wins: number; losses: number; pushes: number } | null {
  if (typeof x !== "object" || x === null) return null;
  const r = x as Record<string, unknown>;
  if (!isNum(r.wins) || !isNum(r.losses) || !isNum(r.pushes)) return null;
  if (r.wins < 0 || r.losses < 0 || r.pushes < 0) return null;
  return { wins: r.wins, losses: r.losses, pushes: r.pushes };
}

const SIDES = new Set(["over", "under"]);
const RESULTS = new Set(["win", "loss", "push"]);

function propExample(x: unknown): PropExample | null {
  if (typeof x !== "object" || x === null) return null;
  const e = x as Record<string, unknown>;
  if (typeof e.player !== "string" || !e.player.trim()) return null;
  if (typeof e.stat !== "string" || !e.stat.trim()) return null;
  if (!isNum(e.threshold)) return null;
  if (typeof e.side !== "string" || !SIDES.has(e.side)) return null;
  if (typeof e.result !== "string" || !RESULTS.has(e.result)) return null;
  return {
    player: e.player,
    team: typeof e.team === "string" ? e.team : "",
    stat: e.stat,
    threshold: e.threshold,
    side: e.side as "over" | "under",
    result: e.result as "win" | "loss" | "push",
    rationale: typeof e.rationale === "string" ? e.rationale : "",
    season: isNum(e.season) ? e.season : null,
    week: isNum(e.week) ? e.week : null,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Parse the committed summary into the two blocks /nfl publishes.
 *
 *  A wrong `source` stamp is fatal for the whole view — the same guard the
 *  dashboard applies — so a stray JSON can never masquerade as the dry-run.
 *  Each block then validates independently: a malformed parlay block hides
 *  the parlays and leaves the props standing. */
export function parseExp5Research(raw: unknown): ResearchView {
  const empty: ResearchView = { generatedAt: null, props: null, parlays: null };
  if (typeof raw !== "object" || raw === null) return empty;
  const j = raw as Record<string, unknown>;
  if (j.source !== "nfl-quant-dryrun") return empty;

  const generatedAt = typeof j.generatedAt === "string" ? j.generatedAt : null;

  let props: PropsBlock | null = null;
  const p = j.props;
  if (typeof p === "object" && p !== null) {
    const pr = p as Record<string, unknown>;
    const r = rec(pr.record);
    if (r && isNum(pr.settled) && pr.settled > 0) {
      const decided = r.wins + r.losses;
      const rawExamples = Array.isArray(pr.examples) ? pr.examples : [];
      props = {
        ...r,
        settled: pr.settled,
        noData: isNum(pr.noData) && pr.noData >= 0 ? pr.noData : 0,
        decided,
        hitRatePct: decided > 0 ? round1((r.wins / decided) * 100) : null,
        examples: rawExamples
          .map(propExample)
          .filter((e): e is PropExample => e !== null),
      };
    }
  }

  let parlays: ParlaysBlock | null = null;
  const q = j.parlays;
  if (typeof q === "object" && q !== null) {
    const qr = q as Record<string, unknown>;
    const r = rec(qr.record);
    if (
      r &&
      isNum(qr.settled) &&
      qr.settled > 0 &&
      isNum(qr.roiPct) &&
      isNum(qr.winRatePct) &&
      isNum(qr.breakEvenPct)
    ) {
      parlays = {
        ...r,
        settled: qr.settled,
        decided: r.wins + r.losses,
        flatYieldPct: qr.roiPct,
        winRatePct: qr.winRatePct,
        breakEvenPct: qr.breakEvenPct,
        // The file carries avgLegsEdge as a FRACTION (0.112); the page prints
        // percentage points. Converting here means the page never multiplies.
        avgLegEdgePct: isNum(qr.avgLegsEdge) ? round1(qr.avgLegsEdge * 100) : null,
        upperBound: true,
      };
    }
  }

  return { generatedAt, props, parlays };
}

// ─── Display furniture (pure) ───────────────────────────────────────────────

const STAT_LABELS: Record<string, string> = {
  passYds: "pass yds",
  passTDs: "pass TDs",
  rushYds: "rush yds",
  recYds: "rec yds",
  recTDs: "rec TDs",
};

/** nflverse stat key → the noun a reader uses. Unknown keys pass through
 *  unchanged rather than being guessed at. */
export function statLabel(stat: string): string {
  return STAT_LABELS[stat] ?? stat;
}

/** "OVER 50 REC YDS" — the pick itself, with no result attached. */
export function propPickLabel(e: PropExample): string {
  return `${e.side.toUpperCase()} ${e.threshold} ${statLabel(e.stat)}`;
}

/** "Wk 22 · 2024", or "" when the file carried no provenance. Provenance is
 *  what separates a settled historical row from an implied future pick. */
export function propProvenance(e: PropExample): string {
  const parts: string[] = [];
  if (e.week != null) parts.push(`Wk ${e.week}`);
  if (e.season != null) parts.push(String(e.season));
  return parts.join(" · ");
}

/** "1,079" — thousands separated, so a four-digit denominator does not read
 *  as a year. */
export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** "+38.96%" / "-3.60%" — signed, two decimals, ASCII sign. Two decimals
 *  because the file carries two and rounding a yield up is a claim. */
export function fmtYieldPct(x: number): string {
  return `${x > 0 ? "+" : x < 0 ? "-" : ""}${Math.abs(x).toFixed(2)}%`;
}

/** "18.8%" — unsigned rates. */
export function fmtRatePct(x: number | null): string {
  return x == null ? "—" : `${x.toFixed(1)}%`;
}
