// Pure-code correlation + exposure guard. Runs after the critic to drop or
// flag picks that violate bankroll discipline. No LLM cost.

import type { GradedPick } from "./grader";

const MAX_DAILY_UNITS = 5.0;
const MAX_PICKS_PER_GAME = 1;
const ROAD_DOG_CLUSTER_LIMIT = 3; // flag if 3+ road dogs same day

export type BankrollGuardResult = {
  kept: GradedPick[];
  dropped: Array<{ pick: GradedPick; reason: string }>;
  flags: string[];
  totalUnits: number;
};

function pickIsRoadDog(p: GradedPick): boolean {
  // `selection` typically reads "Team @ Odds" or "Team -spread". Heuristic:
  // away team in matchup AND positive moneyline odds.
  if (p.market !== "moneyline") return false;
  if (p.oddsAmerican <= 0) return false;
  const matchupParts = p.matchup.split(/\s+vs\.?\s+|\s+@\s+/i);
  if (matchupParts.length !== 2) return false;
  const [first] = matchupParts;
  // Selection must mention the away (first) team for it to be the road dog
  return p.selection.toLowerCase().includes(first.toLowerCase().trim());
}

function gameKey(p: GradedPick): string {
  return p.matchup.toLowerCase().replace(/\s+/g, " ").trim();
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

  // Pass 2: enforce daily unit cap by trimming smallest-edge picks
  let total = sameGamePass.reduce((s, p) => s + p.kellyStakeUnits, 0);
  const kept: GradedPick[] = [...sameGamePass];
  if (total > MAX_DAILY_UNITS) {
    flags.push(`total stake ${total.toFixed(2)}u exceeded ${MAX_DAILY_UNITS}u cap — trimming weakest picks`);
    kept.sort((a, b) => b.edge - a.edge);
    while (total > MAX_DAILY_UNITS && kept.length > 0) {
      const weakest = kept.pop()!;
      total -= weakest.kellyStakeUnits;
      dropped.push({ pick: weakest, reason: "trimmed to fit daily unit cap" });
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
