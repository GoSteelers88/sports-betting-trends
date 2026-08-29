// teams.ts — the one bridge across the three id vocabularies the receipts
// pipeline must join (threat T12):
//   nflverse:  "2026_01_KC_PHI" (abbreviations)
//   Odds API:  "Kansas City Chiefs" (full names, 32-hex event ids)
//   Pinnacle:  "Kansas City Chiefs" (full names, numeric matchup ids)
//
// Canonical franchise key = the nickname, lowercased ("chiefs"). All 32 are
// unique. Event identity is NEVER matched on a source's own id — always on
// (kickoffUtc, homeFranchise, awayFranchise); Odds API event-id stability is
// undocumented and Pinnacle ids are meaningless outside Pinnacle.

export interface Franchise {
  key: string; // canonical, lowercase nickname
  fullName: string; // as printed by Odds API and Pinnacle
  abbrs: string[]; // every nflverse/legacy abbreviation that maps here
}

export const FRANCHISES: Franchise[] = [
  { key: "cardinals", fullName: "Arizona Cardinals", abbrs: ["ARI", "ARZ"] },
  { key: "falcons", fullName: "Atlanta Falcons", abbrs: ["ATL"] },
  { key: "ravens", fullName: "Baltimore Ravens", abbrs: ["BAL", "BLT"] },
  { key: "bills", fullName: "Buffalo Bills", abbrs: ["BUF"] },
  { key: "panthers", fullName: "Carolina Panthers", abbrs: ["CAR"] },
  { key: "bears", fullName: "Chicago Bears", abbrs: ["CHI"] },
  { key: "bengals", fullName: "Cincinnati Bengals", abbrs: ["CIN"] },
  { key: "browns", fullName: "Cleveland Browns", abbrs: ["CLE", "CLV"] },
  { key: "cowboys", fullName: "Dallas Cowboys", abbrs: ["DAL"] },
  { key: "broncos", fullName: "Denver Broncos", abbrs: ["DEN"] },
  { key: "lions", fullName: "Detroit Lions", abbrs: ["DET"] },
  { key: "packers", fullName: "Green Bay Packers", abbrs: ["GB", "GNB"] },
  { key: "texans", fullName: "Houston Texans", abbrs: ["HOU", "HST"] },
  { key: "colts", fullName: "Indianapolis Colts", abbrs: ["IND"] },
  { key: "jaguars", fullName: "Jacksonville Jaguars", abbrs: ["JAX", "JAC"] },
  { key: "chiefs", fullName: "Kansas City Chiefs", abbrs: ["KC", "KAN"] },
  { key: "chargers", fullName: "Los Angeles Chargers", abbrs: ["LAC", "SD", "SDG"] },
  { key: "rams", fullName: "Los Angeles Rams", abbrs: ["LA", "LAR", "STL"] },
  { key: "raiders", fullName: "Las Vegas Raiders", abbrs: ["LV", "OAK", "LVR"] },
  { key: "dolphins", fullName: "Miami Dolphins", abbrs: ["MIA"] },
  { key: "vikings", fullName: "Minnesota Vikings", abbrs: ["MIN"] },
  { key: "patriots", fullName: "New England Patriots", abbrs: ["NE", "NWE"] },
  { key: "saints", fullName: "New Orleans Saints", abbrs: ["NO", "NOR"] },
  { key: "giants", fullName: "New York Giants", abbrs: ["NYG"] },
  { key: "jets", fullName: "New York Jets", abbrs: ["NYJ"] },
  { key: "eagles", fullName: "Philadelphia Eagles", abbrs: ["PHI"] },
  { key: "steelers", fullName: "Pittsburgh Steelers", abbrs: ["PIT"] },
  { key: "49ers", fullName: "San Francisco 49ers", abbrs: ["SF", "SFO"] },
  { key: "seahawks", fullName: "Seattle Seahawks", abbrs: ["SEA"] },
  { key: "buccaneers", fullName: "Tampa Bay Buccaneers", abbrs: ["TB", "TAM", "TBB"] },
  { key: "titans", fullName: "Tennessee Titans", abbrs: ["TEN", "OTI"] },
  { key: "commanders", fullName: "Washington Commanders", abbrs: ["WAS", "WSH"] },
];

const BY_ABBR = new Map<string, string>();
const BY_FULL = new Map<string, string>();
const BY_NICK = new Map<string, string>();
for (const f of FRANCHISES) {
  for (const a of f.abbrs) BY_ABBR.set(a, f.key);
  BY_FULL.set(f.fullName.toLowerCase(), f.key);
  BY_NICK.set(f.key, f.key);
}

/** Canonical franchise key for any spelling any of the three sources emits,
 *  or null — an unrecognized name must surface as a join failure, never be
 *  fuzzy-matched into the wrong game. */
export function franchiseKey(name: string): string | null {
  const raw = name.trim();
  if (!raw) return null;
  const abbr = BY_ABBR.get(raw.toUpperCase());
  if (abbr) return abbr;
  const full = BY_FULL.get(raw.toLowerCase());
  if (full) return full;
  // Nickname = FINAL token only: handles "LA Chargers"-style shorthand while
  // "New York Giants" can never hit "jets". Bare city names ("Washington")
  // deliberately do NOT resolve — no source in this pipeline emits them.
  const lastToken = raw.toLowerCase().split(/\s+/).pop() ?? "";
  return BY_NICK.get(lastToken) ?? null;
}

/** Same-game test across sources: kickoff within `toleranceMin` minutes AND
 *  both franchise keys equal. Kickoffs drift a few minutes between feeds;
 *  they never drift enough to collide with another game of the same teams. */
export function sameGame(
  a: { kickoffUtc: string; home: string; away: string },
  b: { kickoffUtc: string; home: string; away: string },
  toleranceMin = 90,
): boolean {
  const ha = franchiseKey(a.home);
  const aa = franchiseKey(a.away);
  const hb = franchiseKey(b.home);
  const ab = franchiseKey(b.away);
  if (!ha || !aa || !hb || !ab) return false;
  if (ha !== hb || aa !== ab) return false;
  const ta = Date.parse(a.kickoffUtc);
  const tb = Date.parse(b.kickoffUtc);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) <= toleranceMin * 60_000;
}
