// Formats agent picks into a copy-ready X (Twitter) post.
//
// Constraint: X caps posts at 280 chars. We never emit a URL (URL posts cost
// $0.20 each on the X API; even though we're posting manually, we keep the
// format API-ready for if/when we automate it).
//
// Strategy: build incrementally, drop picks that don't fit. Final guard: hard
// slice at 280.

import type { GradedPick } from "./grader";
import type { AgentLeague } from "./tools";

const X_MAX = 280;

const LEAGUE_EMOJI: Record<string, string> = {
  NBA: "🏀",
  MLB: "⚾",
  NFL: "🏈",
  NHL: "🏒",
};

function emojiFor(league: string): string {
  return LEAGUE_EMOJI[league] ?? "🎯";
}

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtEdge(edge: number): string {
  // Always show as positive percent — the grader enforces edge ≥ +6%.
  return `+${(edge * 100).toFixed(1)}%`;
}

function pickLine(p: GradedPick, league: string): string {
  return `${emojiFor(league)} ${p.selection} ML ${fmtAmerican(p.oddsAmerican)} · ${fmtEdge(p.edge)} edge`;
}

export type XFormatInput = {
  league: AgentLeague | "BOTH";
  picks: GradedPick[];
  paperTrialDay?: number;
  paperTrialTotal?: number;
  // Per-pick league override; required when `league` is "BOTH".
  pickLeagues?: string[];
};

export type XFormatOutput = {
  text: string;
  charCount: number;
  truncated: boolean;
  picksIncluded: number;
};

export function formatPicksForX(input: XFormatInput): XFormatOutput {
  const { picks, paperTrialDay, paperTrialTotal = 30, pickLeagues } = input;
  const leagueLabel = input.league === "BOTH" ? "" : input.league;

  if (picks.length === 0) {
    const noPicks =
      paperTrialDay !== undefined
        ? `🤖 No plays today — slate didn't clear the rubric.\n\nDay ${paperTrialDay}/${paperTrialTotal} · paper trial`
        : `🤖 No plays today — slate didn't clear the rubric.`;
    return {
      text: noPicks.slice(0, X_MAX),
      charCount: Math.min(noPicks.length, X_MAX),
      truncated: noPicks.length > X_MAX,
      picksIncluded: 0,
    };
  }

  const totalUnits = picks.reduce((s, p) => s + p.kellyStakeUnits, 0);

  const headerParts: string[] = ["🤖 NIGHTLY LOCKS"];
  if (leagueLabel) headerParts.push(`· ${leagueLabel}`);
  if (paperTrialDay !== undefined) headerParts.push(`· DAY ${paperTrialDay}/${paperTrialTotal}`);
  const header = headerParts.join(" ");

  const footer = `${picks.length} play${picks.length === 1 ? "" : "s"} · ${totalUnits.toFixed(1)}u`;

  const separator = "\n";
  const blockSep = "\n\n";
  const baseLen = header.length + blockSep.length + blockSep.length + footer.length;

  let used = baseLen;
  const lines: string[] = [];
  let truncated = false;

  for (let i = 0; i < picks.length; i++) {
    const line = pickLine(picks[i], pickLeagues?.[i] ?? leagueLabel);
    const cost = (lines.length === 0 ? 0 : separator.length) + line.length;
    if (used + cost > X_MAX) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += cost;
  }

  if (lines.length === 0) {
    // Even one pick + header + footer exceeds budget — drop the footer.
    const fallback = `${header}\n\n${pickLine(picks[0], pickLeagues?.[0] ?? leagueLabel)}`;
    return {
      text: fallback.slice(0, X_MAX),
      charCount: Math.min(fallback.length, X_MAX),
      truncated: true,
      picksIncluded: 1,
    };
  }

  const text = `${header}\n\n${lines.join(separator)}\n\n${footer}`;
  return {
    text,
    charCount: text.length,
    truncated,
    picksIncluded: lines.length,
  };
}
