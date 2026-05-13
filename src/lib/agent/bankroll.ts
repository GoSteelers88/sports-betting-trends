// Pure-code correlation + exposure guard. Runs after the critic to drop or
// flag picks that violate bankroll discipline. No LLM cost.

import type { GradedPick } from "./grader";

const MAX_DAILY_UNITS = 5.0;
const MAX_ML_PICKS_PER_GAME = 1;
const MAX_PROP_PICKS_PER_GAME = 2; // allow at most 2 props on the same matchup
const MAX_PROPS_PER_PLAYER = 1;    // never stack two legs on the same player
const ROAD_DOG_CLUSTER_LIMIT = 3;  // flag if 3+ road dogs same day
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
// the separator to determine which side of the split is the away team, then
// token-aware matching to avoid substring false-positives (e.g., "St. John's"
// vs "St. John's Red Storm").
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function selectionMentionsTeam(selection: string, team: string): boolean {
  const sel = normalizeForMatch(selection);
  const t = normalizeForMatch(team);
  if (!sel || !t) return false;
  if (sel === t) return true;
  // Token-aware: every token of the team name (length >= 4) must appear in selection
  const teamTokens = t.split(/\s+/).filter(x => x.length >= 4);
  if (teamTokens.length === 0) return sel.includes(t);
  const selTokens = new Set(sel.split(/\s+/));
  return teamTokens.every(x => selTokens.has(x));
}

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

  return selectionMentionsTeam(p.selection, awayTeam);
}

function gameKey(p: GradedPick): string {
  // Normalize separator + diacritics + punctuation so "Lakers vs Celtics",
  // "Celtics @ Lakers", and "lakers vs celtics" all collapse. Also strips
  // accents/apostrophes so "St. John's" matches "St Johns".
  const norm = normalizeForMatch(
    p.matchup
      .replace(/\s+vs\.?\s+/i, " | ")
      .replace(/\s+@\s+/i, " | ")
  );
  const parts = norm.split(" | ");
  if (parts.length === 2) return parts.sort().join(" | ");
  return norm;
}

export function applyBankrollGuard(picks: GradedPick[]): BankrollGuardResult {
  const dropped: Array<{ pick: GradedPick; reason: string }> = [];
  const flags: string[] = [];
  const sortedByEdge = [...picks].sort((a, b) => b.edge - a.edge);

  // Pass 1: per-game and per-player caps. ML picks: at most 1 per game.
  // Prop picks: at most 2 per game and at most 1 per player. Run as a
  // single pass against highest-edge-first so the survivor on a contested
  // game is always the strongest pick.
  const mlByGame = new Map<string, number>();
  const propsByGame = new Map<string, number>();
  const propsByPlayer = new Map<string, number>();
  const sameGamePass: GradedPick[] = [];
  for (const p of sortedByEdge) {
    const key = gameKey(p);
    if (p.market === "moneyline") {
      const count = mlByGame.get(key) ?? 0;
      if (count >= MAX_ML_PICKS_PER_GAME) {
        dropped.push({ pick: p, reason: `same-game ML duplicate (already have ${count} on "${p.matchup}")` });
        continue;
      }
      mlByGame.set(key, count + 1);
      sameGamePass.push(p);
      continue;
    }
    if (p.market === "prop") {
      const gameCount = propsByGame.get(key) ?? 0;
      if (gameCount >= MAX_PROP_PICKS_PER_GAME) {
        dropped.push({ pick: p, reason: `prop game-cap (already have ${gameCount} prop legs on "${p.matchup}")` });
        continue;
      }
      const playerKey = normalizeForMatch(p.player ?? "");
      const playerCount = playerKey ? propsByPlayer.get(playerKey) ?? 0 : 0;
      if (playerKey && playerCount >= MAX_PROPS_PER_PLAYER) {
        dropped.push({ pick: p, reason: `prop player-cap (already have a leg on "${p.player}")` });
        continue;
      }
      propsByGame.set(key, gameCount + 1);
      if (playerKey) propsByPlayer.set(playerKey, playerCount + 1);
      sameGamePass.push(p);
      continue;
    }
    // Spread/total — fall through to the conservative ML cap.
    const count = mlByGame.get(key) ?? 0;
    if (count >= MAX_ML_PICKS_PER_GAME) {
      dropped.push({ pick: p, reason: `same-game duplicate (already have ${count} on "${p.matchup}")` });
      continue;
    }
    mlByGame.set(key, count + 1);
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
