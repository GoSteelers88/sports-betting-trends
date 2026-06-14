// mlb-prop-plays.ts — assembles the "MLB prop plays · by stat" board: for each
// MLB-slate player, every stat's milestone ladder (1+, 2+, 3+, 4+ …) with OUR
// MODEL's P(stat ≥ k) per rung, and — WHERE a market line exists — the de-vigged
// market-implied prob, the model−market EDGE, the best soft price/book, and a
// playable flag (reusing the props-board EV floor).
//
// Two truths kept distinct:
//   • The MODEL probability prints for EVERY rung the model can honestly produce
//     (this is a "based on our model" board, not a +EV-only board).
//   • The MARKET edge overlays ONLY where a sharp line maps to that exact rung.
//     A rung with no market line is still shown — model number only.
//
// Pure read of static JSON + the distribution model. Any missing/corrupt file
// degrades to an empty board so the dashboard section hides cleanly.

import { expectedValue } from "./devig";
import {
  MLB_STAT_SPECS,
  distributionFor,
  type MlbGameLogFile,
  type PlayerGameLog,
  type StatDistribution,
  type MlbStat,
  type StatKind,
} from "./mlb-prop-distributions";

// Reuse the board's pre-registered playable floor so the two prop surfaces
// agree on what "playable" means.
export const PLAYS_PLAYABLE_FLOOR = 0.03;

// ── market shapes (subset of the sharp/soft prop files) ─────────────────────

interface SharpPropRow {
  player: string;
  units: string; // Pinnacle units: TotalBases, HomeRuns, Strikeouts, EarnedRuns, …
  line: number;
  overAmerican: number;
  underAmerican: number;
  fairOverProb: number;
}
interface SharpPropsFile {
  fetchedAt?: string;
  props?: SharpPropRow[];
}

interface SoftQuoteRow {
  player: string;
  market: string; // Odds API key: pitcher_strikeouts, …
  line: number;
  side: "Over" | "Under";
  american: number;
  book: string;
  commence?: string;
}
interface SoftPropsFile {
  fetchedAt?: string;
  quotes?: SoftQuoteRow[];
}

// Pinnacle `units` → our MlbStat (for overlaying the sharp fair prob on a rung).
const UNITS_TO_STAT: Record<string, MlbStat> = {
  HomeRuns: "batter_home_runs",
  TotalBases: "batter_total_bases",
  Strikeouts: "pitcher_strikeouts",
  EarnedRuns: "pitcher_earned_runs",
  // (Hits/RBI/Runs sharp props are not in the Pinnacle units feed today —
  //  those ladders are model-only until a line appears.)
};

// Odds API soft market key → our MlbStat (for best soft price/book per rung).
const SOFT_MARKET_TO_STAT: Record<string, MlbStat> = {
  pitcher_strikeouts: "pitcher_strikeouts",
  batter_home_runs: "batter_home_runs",
  batter_total_bases: "batter_total_bases",
  pitcher_earned_runs: "pitcher_earned_runs",
  batter_hits: "batter_hits",
  batter_rbis: "batter_rbis",
  batter_runs_scored: "batter_runs_scored",
};

// ── name matching (mirrors props-board.samePlayer) ──────────────────────────

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exact normalized match, or last name + first initial. */
export function samePlayer(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = na.split(" ");
  const tb = nb.split(" ");
  return (
    ta.length > 1 &&
    tb.length > 1 &&
    ta[ta.length - 1] === tb[tb.length - 1] &&
    ta[0][0] === tb[0][0]
  );
}

/** A milestone line `k − 0.5` maps to the ladder rung "≥ k". Returns the
 *  integer threshold k for a `.5` line, else null (whole-number lines like
 *  "exactly 2" aren't milestone rungs). */
export function lineToThreshold(line: number): number | null {
  const k = line + 0.5;
  if (Math.abs(k - Math.round(k)) > 1e-9) return null;
  const ki = Math.round(k);
  return ki >= 1 ? ki : null;
}

// ── output shapes ───────────────────────────────────────────────────────────

export interface PlayRung {
  threshold: number;       // k in "P(stat ≥ k)"
  label: string;           // "1+", "2+", …
  modelProb: number;       // OUR model probability for this rung
  // Market overlay — present only when a sharp line maps to this exact rung.
  marketProb: number | null;   // de-vigged sharp fair P(≥k)
  edge: number | null;         // modelProb − marketProb
  bestPrice: number | null;    // best soft American price for the OVER of this rung
  bestBook: string | null;
  evPct: number | null;        // EV of the best soft price vs OUR model prob
  playable: boolean;           // EV ≥ floor and a real edge exists
}

export interface PlayerStatLadder {
  player: string;
  team: string | null;
  stat: MlbStat;
  statLabel: string;
  kind: StatKind;
  mean: number;
  method: StatDistribution["method"];
  nGames: number;
  derived: boolean;
  lowConfidence: boolean;
  rungs: PlayRung[];
  /** Best edge across this player's rungs for this stat (for ranking); null
   *  when no market line touched any rung. */
  topEdge: number | null;
  hasPlayable: boolean;
}

export interface StatGroup {
  stat: MlbStat;
  label: string;
  kind: StatKind;
  ladders: PlayerStatLadder[];
}

export interface MlbPropPlaysBoard {
  generatedAt: string | null;
  windowAgeHours: number | null;
  groups: StatGroup[];
  /** Distinct stats that are MODEL-backed (real or synthesized fit). */
  modeledStats: string[];
  totalPlayers: number;
}

function thresholdLabel(k: number): string {
  return `${k}+`;
}

// ── the build ───────────────────────────────────────────────────────────────

/**
 * Build the by-stat board from already-loaded inputs (pure — no fs). The caller
 * supplies the gamelog file, the set of slate team names, the sharp + soft prop
 * rows, and a `nowMs` for window-age math.
 *
 * `isSlateTeam(team)` decides whether a player's team is on tonight's slate —
 * injected so the team-matching helper lives with the rest of the dashboard's
 * token-aware matching and this module stays dependency-light.
 */
export function buildMlbPropPlays(input: {
  gamelog: MlbGameLogFile | null;
  isSlateTeam: (team: string | null) => boolean;
  sharp: SharpPropRow[];
  soft: SoftQuoteRow[];
  nowMs?: number;
  /** Max players to show per stat group (board stays dense, not endless). */
  perStatLimit?: number;
}): MlbPropPlaysBoard {
  const empty: MlbPropPlaysBoard = {
    generatedAt: null,
    windowAgeHours: null,
    groups: [],
    modeledStats: [],
    totalPlayers: 0,
  };
  const { gamelog } = input;
  if (!gamelog || !gamelog.players) return empty;

  const nowMs = input.nowMs ?? Date.now();
  const perStatLimit = input.perStatLimit ?? 12;
  const leagueAverages = gamelog.leagueAverages ?? {};

  // Players whose team is on tonight's slate. (When the gamelog window predates
  // the slate this naturally yields nobody → the section hides.)
  const slatePlayers = Object.values(gamelog.players).filter(p =>
    input.isSlateTeam(p.team),
  );

  // Index market rows for O(1)-ish lookup per (stat, threshold).
  // Sharp: best (lowest overround already baked into fairOverProb) per
  // (player, stat, threshold) — there is usually one line; keep the first.
  const sharpByKey = new Map<string, SharpPropRow>();
  for (const s of input.sharp) {
    const stat = UNITS_TO_STAT[s.units];
    if (!stat) continue;
    const k = lineToThreshold(s.line);
    if (k === null) continue;
    if (!Number.isFinite(s.fairOverProb)) continue;
    const key = `${stat}|${k}|${normalize(s.player)}`;
    if (!sharpByKey.has(key)) sharpByKey.set(key, s);
  }

  // Soft: best OVER price per (player, stat, threshold). "Best" = highest
  // payout = the most positive American for the bettor.
  const softBest = new Map<string, { american: number; book: string }>();
  for (const q of input.soft) {
    if (q.side !== "Over") continue;
    const stat = SOFT_MARKET_TO_STAT[q.market];
    if (!stat) continue;
    const k = lineToThreshold(q.line);
    if (k === null) continue;
    if (!Number.isFinite(q.american)) continue;
    const key = `${stat}|${k}|${normalize(q.player)}`;
    const prev = softBest.get(key);
    if (!prev || betterForBettor(q.american, prev.american)) {
      softBest.set(key, { american: q.american, book: q.book });
    }
  }

  const groups: StatGroup[] = [];
  const modeledStats = new Set<string>();
  const playerSet = new Set<string>();

  for (const spec of MLB_STAT_SPECS) {
    const ladders: PlayerStatLadder[] = [];

    for (const player of slatePlayers) {
      const dist = distributionFor(player, spec, leagueAverages);
      if (!dist) continue;
      modeledStats.add(spec.label);

      const rungs: PlayRung[] = dist.ladder.map(r => {
        const lookupKey = `${spec.stat}|${r.threshold}|${normalize(player.displayName)}`;
        const sharp = sharpByKey.get(lookupKey);
        const soft = softBest.get(lookupKey);

        const marketProb = sharp ? clampProb(sharp.fairOverProb) : null;
        const edge = marketProb !== null ? +(r.prob - marketProb).toFixed(4) : null;

        // EV uses OUR model prob vs the best soft OVER price (what we'd actually
        // take). Only when a soft price exists for this rung.
        let evPct: number | null = null;
        let playable = false;
        if (soft) {
          const ev = expectedValue(r.prob, soft.american);
          if (ev != null && Number.isFinite(ev)) {
            evPct = +(ev * 100).toFixed(2);
            // Playable: positive model EV at/above the floor AND, when we have a
            // sharp line, model agrees we beat it (edge > 0). The sharp gate
            // guards against a soft mispricing that the sharp market has already
            // corrected.
            playable =
              ev >= PLAYS_PLAYABLE_FLOOR && (edge === null || edge > 0);
          }
        }

        return {
          threshold: r.threshold,
          label: thresholdLabel(r.threshold),
          modelProb: r.prob,
          marketProb,
          edge,
          bestPrice: soft?.american ?? null,
          bestBook: soft?.book ?? null,
          evPct,
          playable,
        };
      });

      const edges = rungs.map(r => r.edge).filter((e): e is number => e !== null);
      const topEdge = edges.length ? Math.max(...edges) : null;
      const hasPlayable = rungs.some(r => r.playable);

      ladders.push({
        player: player.displayName,
        team: player.team,
        stat: spec.stat,
        statLabel: spec.label,
        kind: spec.kind,
        mean: dist.mean,
        method: dist.method,
        nGames: dist.nGames,
        derived: dist.derived,
        lowConfidence: dist.lowConfidence,
        rungs,
        topEdge,
        hasPlayable,
      });
      playerSet.add(normalize(player.displayName));
    }

    if (ladders.length === 0) continue;

    // Rank within a stat: playable first, then by the strongest rung
    // probability (the most likely milestone), so the densest signal is on top.
    ladders.sort((a, b) => {
      if (a.hasPlayable !== b.hasPlayable) return a.hasPlayable ? -1 : 1;
      const aTop = a.topEdge ?? -Infinity;
      const bTop = b.topEdge ?? -Infinity;
      if (aTop !== bTop) return bTop - aTop;
      // Fall back to the first-rung model prob (P(≥1) / P(≥4) for K) descending.
      return (b.rungs[0]?.modelProb ?? 0) - (a.rungs[0]?.modelProb ?? 0);
    });

    groups.push({
      stat: spec.stat,
      label: spec.label,
      kind: spec.kind,
      ladders: ladders.slice(0, perStatLimit),
    });
  }

  const generatedAt = gamelog.generatedAt ?? null;
  const windowAgeHours =
    generatedAt && Number.isFinite(new Date(generatedAt).getTime())
      ? +Math.max(0, (nowMs - new Date(generatedAt).getTime()) / 36e5).toFixed(1)
      : null;

  return {
    generatedAt,
    windowAgeHours,
    groups,
    modeledStats: [...modeledStats],
    totalPlayers: playerSet.size,
  };
}

// Higher payout for the bettor: more positive American is always better at the
// same notional (e.g. +120 beats +100 beats −110 beats −150).
function betterForBettor(a: number, b: number): boolean {
  return a > b;
}

function clampProb(p: number): number {
  return Math.min(0.999, Math.max(0.001, p));
}

// Convenience re-export for the loader.
export type { SharpPropsFile, SoftPropsFile, SharpPropRow, SoftQuoteRow, PlayerGameLog };
