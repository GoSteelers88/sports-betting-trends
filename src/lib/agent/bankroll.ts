// Pure-code correlation + exposure guard. Runs after the critic to drop or
// flag picks that violate bankroll discipline. No LLM cost.

import type { GradedPick } from "./grader";

const MAX_DAILY_UNITS = 5.0;
const MAX_PICKS_PER_GAME = 1;
const ROAD_DOG_CLUSTER_LIMIT = 3; // flag if 3+ road dogs same day
const FLOAT_EPSILON = 1e-9;

export type BankrollGuardResult = {
  kept: GradedPick[];
  dropped: Array<{ pick: GradedPick; reason: string }>;
  flags: string[];
  totalUnits: number;
};

// Detect if a pick is a road dog (away team taking plus-money). Robust to
// either "Away @ Home" or "Home vs Away" matchup strings: `@` reliably means
// "away @ home", but `vs` does NOT — convention is "home vs away". We use
// the separator to determine which side of the split is the away team.
function pickIsRoadDog(p: GradedPick): boolean {
  if (p.market !== "moneyline") return false;
  if (p.oddsAmerican <= 0) return false;

  const atSplit = p.matchup.split(/\s+@\s+/);
  const vsSplit = p.matchup.split(/\s+vs\.?\s+/i);

  let awayTeam: string | null = null;
  if (atSplit.length === 2) {
    awayTeam = atSplit[0]; // "Away @ Home" — first is away
  } else if (vsSplit.length === 2) {
    awayTeam = vsSplit[1]; // "Home vs Away" — second is away (sport convention)
  } else {
    return false;
  }

  const sel = p.selection.toLowerCase();
  return sel.includes(awayTeam.toLowerCase().trim());
}

function gameKey(p: GradedPick): string {
  // Normalize separator: treat "vs" and "@" as the same key by sorting tokens
  // alphabetically so "Lakers vs Celtics" and "Celtics @ Lakers" collapse.
  const norm = p.matchup
    .toLowerCase()
    .replace(/\s+vs\.?\s+/i, " | ")
    .replace(/\s+@\s+/i, " | ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = norm.split(" | ");
  if (parts.length === 2) return parts.sort().join(" | ");
  return norm;
}

export function applyBankrollGuard(picks: GradedPick[]): BankrollGuardResult {
  const dropped: Array<{ pick: GradedPick; reason: string }> = [];
  const flags: string[] = [];
  const seenGames = new Map<string, number>(); // game → pick count
  const sortedByEdge = [...picks].sort((a, b) => b.edge - a.edge);

  // Pass 1: drop multiple picks on same game, keep highest-edge
  const sameGamePass: GradedPick[] = [];
  for (const p of sortedByEdge) {
    const key = gameKey(p);
    const count = seenGames.get(key) ?? 0;
    if (count >= MAX_PICKS_PER_GAME) {
      dropped.push({ pick: p, reason: `same-game duplicate (already have ${count} on "${p.matchup}")` });
      continue;
    }
    seenGames.set(key, count + 1);
    sameGamePass.push(p);
  }

  // Pass 2: enforce daily unit cap. Algorithm: drop the pick with the WORST
  // edge-per-stake-unit ratio first (i.e., paying the most stake for the
  // least edge). This frees the most cap headroom per drop. Iterate until
  // total <= cap (with float-epsilon tolerance to avoid spurious trims when
  // the slate sums to exactly 5.0u).
  let total = sameGamePass.reduce((s, p) => s + p.kellyStakeUnits, 0);
  const kept: GradedPick[] = [...sameGamePass];
  if (total > MAX_DAILY_UNITS + FLOAT_EPSILON) {
    flags.push(`total stake ${total.toFixed(2)}u exceeded ${MAX_DAILY_UNITS}u cap — trimming weakest by edge/stake`);
    while (total > MAX_DAILY_UNITS + FLOAT_EPSILON && kept.length > 0) {
      // Pick the worst edge-per-unit-of-stake (i.e., spending stake for low edge).
      let worstIdx = 0;
      let worstScore = Infinity;
      for (let i = 0; i < kept.length; i++) {
        const score = kept[i].edge / Math.max(kept[i].kellyStakeUnits, 1e-6);
        if (score < worstScore) {
          worstScore = score;
          worstIdx = i;
        }
      }
      const [trimmed] = kept.splice(worstIdx, 1);
      total -= trimmed.kellyStakeUnits;
      dropped.push({ pick: trimmed, reason: "trimmed to fit daily unit cap (worst edge/stake ratio)" });
    }
  }

  // Pass 3: flag (don't drop) road-dog clusters
  const roadDogs = kept.filter(pickIsRoadDog);
  if (roadDogs.length >= ROAD_DOG_CLUSTER_LIMIT) {
    flags.push(
      `${roadDogs.length} road-dog moneylines on the slate — high correlation if a "favorites day" plays out`
    );
  }

  return {
    kept,
    dropped,
    flags,
    totalUnits: kept.reduce((s, p) => s + p.kellyStakeUnits, 0),
  };
}
