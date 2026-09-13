// THE HONEST FALLBACK — what the desk says when it cannot ground an answer.
//
// The old behaviour was one constant string for every Lane B failure:
//
//   "I don't have a clean live read on that game right now — the numbers I'd
//    need aren't in front of me…  Ask me about a different NBA, MLB, or WNBA
//    game, or come back once tonight's lines have firmed up."
//
// Two things are wrong with that, and both were measured on 2026-09-12:
//
//  1. It is MATCHUP-SHAPED. Asked "what games are on today?" — a calendar
//     question about the whole board — the desk answered "that game", which
//     reads as a non-sequitur and tells the user nothing.
//  2. It names NOTHING. The desk knew exactly what was missing (the MLB model
//     snapshot had not refreshed since September 9; the +EV prop board was
//     empty; the board-edges join returned zero rows) and said none of it. On a
//     desk whose entire brand is "every number is real", the honest version of
//     "I don't have it" is "I don't have it, and here is what I went looking
//     for" — the honesty IS the product.
//
// So: the fallback is BUILT, per turn, from the tool payloads the turn actually
// collected. Pure functions over strings — no model, no I/O, no clock except the
// one you pass in — so the exact sentence a user sees is unit-testable.

export type Gap = {
  /** Plain-English name of the feed that was missing or stale. */
  what: string;
  /** "since September 9" / "" — a refresh date when the payload carried one. */
  since: string;
};

const MAX_GAPS = 3;

// Map a snapshot filename (as it appears in a dataWarning) to how the desk says
// it out loud. Anything unmatched degrades to a de-hyphenated filename, which is
// still more useful than silence.
function friendlyFile(file: string): string {
  const f = file.replace(/\.json$/i, "");
  let m = /^latest-odds-api-(?:baseball_mlb|basketball_nba|basketball_wnba|americanfootball_nfl|icehockey_nhl|basketball_ncaab)$/.exec(f);
  if (m) {
    const lg = leagueFromSlug(f);
    return lg ? `the ${lg} odds snapshot` : "the odds snapshot";
  }
  m = /^(mlb|nba|wnba|nfl|nhl)-model(?:-output)?$/.exec(f);
  if (m) return `the ${m[1]!.toUpperCase()} model`;
  m = /^latest-player-props(?:-(mlb|wnba|nba))?$/.exec(f);
  if (m) return `the ${(m[1] ?? "nba").toUpperCase()} player-prop feed`;
  m = /^latest-(sharp|soft)-props-(mlb|wnba|nba)$/.exec(f);
  if (m) return `the ${m[2]!.toUpperCase()} ${m[1]} prop feed`;
  m = /^injuries-(mlb|nba|wnba|nfl)$/.exec(f);
  if (m) return `the ${m[1]!.toUpperCase()} injury report`;
  m = /^quant-desk-(mlb|nba|wnba)-book$/.exec(f);
  if (m) return `the quant desk's ${m[1]!.toUpperCase()} book`;
  return `the ${f.replace(/[-_]/g, " ")} snapshot`;
}

function leagueFromSlug(slug: string): string | null {
  if (slug.includes("baseball_mlb")) return "MLB";
  if (slug.includes("basketball_wnba")) return "WNBA";
  if (slug.includes("basketball_nba")) return "NBA";
  if (slug.includes("americanfootball_nfl")) return "NFL";
  if (slug.includes("icehockey_nhl")) return "NHL";
  if (slug.includes("basketball_ncaab")) return "NCAAB";
  return null;
}

const SINCE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "long",
  day: "numeric",
});

function sincePhrase(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return ` since ${SINCE_FMT.format(new Date(t))}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Walk the turn's tool payloads and collect what the desk went looking for and
 * did not find. Two signals, both written by the tools themselves:
 *
 *   • `dataWarning` — the loader's staleness banner. It names the file, and the
 *     sibling `generatedAt`/`fetchedAt` dates it. → "the MLB model hasn't
 *     refreshed since September 9".
 *   • `available: false` with a `note` — a tool saying, in its own words, that
 *     it has nothing. → "no fresh MLB prop board right now".
 *
 * De-duplicated and capped, because a fallback that lists nine gaps is a wall,
 * not an answer.
 */
export function collectGaps(toolResultTexts: string[]): Gap[] {
  const gaps: Gap[] = [];
  const seen = new Set<string>();

  const push = (what: string, since: string): void => {
    const key = what.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    gaps.push({ what, since });
  };

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isPlainObject(node)) return;

    const warn = node.dataWarning;
    if (typeof warn === "string") {
      const m = /([A-Za-z0-9._-]+\.json)/.exec(warn);
      if (m) push(friendlyFile(m[1]!), sincePhrase(node.generatedAt ?? node.fetchedAt));
    }
    if (node.available === false && typeof node.note === "string" && node.note.trim()) {
      push(node.note.trim().replace(/\.$/, ""), sincePhrase(node.generatedAt ?? node.fetchedAt));
    }

    for (const val of Object.values(node)) {
      if (isPlainObject(val) || Array.isArray(val)) visit(val);
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
  return gaps.slice(0, MAX_GAPS);
}

/** "the MLB model hasn't refreshed since September 9, and the +EV prop board is empty" */
export function describeGaps(gaps: Gap[]): string {
  if (gaps.length === 0) return "";
  const parts = gaps.map((g) => `${g.what}${g.since}`);
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join("; ")}; and ${parts[parts.length - 1]!}`;
}

export type FallbackInput = {
  /** Which shape of question this was. */
  scope: "matchup" | "slate" | "schedule";
  /** "bets" or "stats". */
  mode: "bets" | "stats";
  /** The league the turn ran against ("MLB", "NHL", …). */
  league: string;
  /** Gaps collected from this turn's tool payloads. */
  gaps: Gap[];
};

/**
 * The fallback the user actually reads. Shaped to the QUESTION (a calendar
 * question never gets a "that game" answer again) and it always names what was
 * missing when the payloads told us.
 *
 * Guard-clean by construction: contains none of the LEAK_MARKERS in
 * grounding.ts — no "tool results", no "still loading", no "my tools" — so it
 * can never re-trip the leak guard on its way out.
 */
export function buildLaneBFallback(input: FallbackInput): string {
  const { scope, mode, league, gaps } = input;
  const missing = describeGaps(gaps);
  const because = missing ? ` What's missing: ${missing}.` : "";

  if (scope === "schedule") {
    return (
      "I can't give you a clean read on today's board right now — I'd rather say that than " +
      `hand you a schedule I can't stand behind.${because} ` +
      "Try me again once the feeds refresh, or name a specific matchup and I'll tell you what I have on it."
    );
  }

  if (mode === "stats") {
    return (
      `I don't have clean ${league} numbers in front of me right now, and I won't guess — ` +
      `I put my name on real numbers or nothing.${because} ` +
      "Ask me again in a bit, or point me at tonight's NBA, MLB, or WNBA board, which I bet."
    );
  }

  if (scope === "slate") {
    return (
      `No clean read on tonight's ${league} board, so there's no play from me — ` +
      "and on this discipline, no read means no bet. Passing is a position." +
      `${because} ` +
      "Name a specific matchup and I'll tell you exactly what I have on it, or come back once tonight's lines have firmed up."
    );
  }

  return (
    "I don't have a clean read on that one right now — and on this discipline, no read means no bet. " +
    `If the desk had an edge on it tonight, it'd show as a pick on the board.${because} ` +
    "Ask me about another NBA, MLB, or WNBA game, or come back once tonight's lines have firmed up."
  );
}
