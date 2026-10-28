// daily-plays-post.ts — the front page's "today" list, as a Discord post.
//
// The rows come from buildTodayRows (today-list.ts), the same function "/"
// renders, so #betting can never say something the site does not. This file
// only words them. Pure: no fs, no fetch, the clock is injected.
//
// Same wording rules as the cards in TodayList.tsx:
//   agent (game/prop) — ENTRY price · stake · EDGE (the grader's edge).
//   nfl               — ENTRY price @ book · DISAGREEMENT in pp. NEVER a stake,
//                       a unit, a return or CLV (pre-registration Amendment 1).

import {
  etDayLabel,
  etTimeLabel,
  fmtAmerican,
  fmtGap,
  fmtPct1,
  round1,
} from "./nfl-receipts/receipts-view";
import { etDateKey, type AgentPickLike, type TodayRow } from "./today-list";
import { propLabel } from "@/app/_components/format";

/** The slice of a SlatePick the post reads. */
export interface PostPick extends AgentPickLike {
  league: string;
  matchup: string;
  selection: string;
  oddsAmerican: number;
  modelProb: number;
  marketProb: number;
  kellyStakeUnits: number;
  player: string | null;
  propType: string | null;
  line: number | null;
  side: "over" | "under" | null;
}

/** Discord rejects content over 2000 characters; leave room for safety. */
export const DISCORD_MAX_CHARS = 1900;

function when(iso: string | null): string {
  return iso ? `${etDayLabel(iso)} · ${etTimeLabel(iso)} ET` : "TIME TBD";
}

function splitMatchup(matchup: string): { away: string; home: string } {
  const [away = "", home = ""] = matchup.split("@").map((s) => s.trim());
  return { away, home };
}

/** One play, two lines: what to bet, then the numbers behind it. */
export function formatRow(row: TodayRow<PostPick>): string {
  if (row.kind === "nfl") {
    const leg = row.leg;
    const conn = leg.selectedIsAway ? "at" : "vs";
    const book = leg.book ? ` @ ${leg.book.toUpperCase()}` : "";
    const read =
      leg.modelPct == null || leg.marketPct == null
        ? ""
        : ` · disagreement ${fmtGap(leg.gapPp)} pp (model ${fmtPct1(leg.modelPct)} / market ${fmtPct1(leg.marketPct)})`;
    return (
      `🏈 **NFL** · ${when(leg.kickoffUtc)}\n` +
      `**${leg.selectedAbbr} ML** ${conn} ${leg.opponentAbbr} · entry ${fmtAmerican(leg.entryPriceAmerican)}${book}${read}`
    );
  }

  const p = row.pick;
  const isProp = row.kind === "prop" && !!p.player;
  const edge = `${p.edge > 0 ? "+" : ""}${(p.edge * 100).toFixed(1)}%`;
  const numbers =
    `entry ${fmtAmerican(p.oddsAmerican)} · ${p.kellyStakeUnits.toFixed(2)}u · edge ${edge}` +
    ` (model ${fmtPct1(round1(p.modelProb * 100))} / market ${fmtPct1(round1(p.marketProb * 100))})`;
  const icon = p.league === "MLB" ? "⚾" : "🏀";
  let bet: string;
  if (isProp) {
    const side = (p.side ?? "").toUpperCase();
    const label = `${p.player} ${side} ${p.line ?? "—"} ${propLabel(p.propType)}`.trim();
    bet = `**${label}** · ${p.matchup}`;
  } else {
    const { away, home } = splitMatchup(p.matchup);
    const selectedIsAway = away.length > 0 && away === p.selection;
    const opp = selectedIsAway ? home : away || home;
    bet = `**${p.selection} ML** ${selectedIsAway ? "at" : "vs"} ${opp}`;
  }
  return `${icon} **${p.league}** · ${when(row.startIso)}\n${bet} · ${numbers}`;
}

/** A stable fingerprint of the list, so a second run with the same plays
 *  does not post them again the same day. */
export function playsSignature(rows: TodayRow<PostPick>[], nowMs: number): string {
  const ids = rows.map((r) => (r.kind === "nfl" ? `nfl:${r.leg.legId}` : `${r.kind}:${r.pick.id}`));
  return `${etDateKey(nowMs)}|${[...ids].sort().join(",")}`;
}

/** The post, split into Discord-sized messages on row boundaries. An empty
 *  list returns no messages: the caller decides whether silence is right. */
export function formatDailyPlays(
  rows: TodayRow<PostPick>[],
  nowMs: number,
  siteUrl: string,
): string[] {
  if (rows.length === 0) return [];
  const stamp = new Date(nowMs).toISOString();
  const header =
    `🎯 **Today's plays** — ${etDayLabel(stamp)} · as of ${etTimeLabel(stamp)} ET\n` +
    `${rows.length} play${rows.length === 1 ? "" : "s"} · full cards and receipts: <${siteUrl}>`;
  const messages: string[] = [];
  let current = header;
  for (const row of rows) {
    const block = formatRow(row);
    if (current.length + 2 + block.length > DISCORD_MAX_CHARS) {
      messages.push(current);
      current = block;
    } else {
      current += `\n\n${block}`;
    }
  }
  messages.push(current);
  return messages;
}
