import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "data", "processed");

type StandingsOutput = {
  team: string;
  abbreviation: string;
  wins: number;
  losses: number;
  winPct: number;
  homeRecord: string;
  awayRecord: string;
  pointDiff: number;
  streak: string;
  conference: string;
};

type InjuryOutput = {
  player: string;
  team: string;
  position: string;
  status: string;
  injuryType: string;
  returnDate: string;
};

const LEAGUE_ENDPOINTS: Record<string, string> = {
  nba: "basketball/nba",
  nfl: "football/nfl",
  mlb: "baseball/mlb",
  ncaab: "basketball/mens-college-basketball",
};

const INJURY_LEAGUES = ["nba", "nfl"];

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": "sports-betting-trends/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

function safeStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function safeNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

type EspnStandingsGroup = {
  name?: string;
  standings?: { entries?: unknown[] };
  entries?: unknown[];
  children?: EspnStandingsGroup[];
};

function parseStandingsEntries(
  entries: unknown[],
  conferenceName: string,
): StandingsOutput[] {
  const results: StandingsOutput[] = [];
  for (const entry of entries) {
    const e = entry as {
      team?: { displayName?: string; abbreviation?: string };
      stats?: Array<{ name?: string; value?: unknown; displayValue?: string }>;
    };
    const teamName = safeStr(e.team?.displayName);
    const abbr = safeStr(e.team?.abbreviation);
    if (!teamName && !abbr) continue;
    const stats = e.stats ?? [];

    const stat = (name: string) => {
      const s = stats.find((st) => st.name === name);
      return { value: safeNum(s?.value), display: safeStr(s?.displayValue) };
    };

    const wins = stat("wins").value;
    const losses = stat("losses").value;
    const total = wins + losses;
    // Prefer ESPN-provided winPercent if present and valid (0–1 range)
    const wpRaw = stat("winPercent").value;
    const winPct =
      wpRaw > 0 && wpRaw <= 1
        ? Math.round(wpRaw * 1000) / 1000
        : total > 0
          ? Math.round((wins / total) * 1000) / 1000
          : 0;

    results.push({
      team: teamName,
      abbreviation: abbr,
      wins,
      losses,
      winPct,
      homeRecord: stat("Home").display || stat("homeRecord").display || "",
      awayRecord: stat("Road").display || stat("awayRecord").display || "",
      pointDiff: stat("pointDifferential").value || stat("differential").value,
      streak: stat("streak").display || "",
      conference: conferenceName,
    });
  }
  return results;
}

// Walk conference > division > team nesting (NFL, MLB have 2 levels; NBA/NCAAB have 1)
function walkGroups(groups: EspnStandingsGroup[], parentName = "Unknown"): StandingsOutput[] {
  const results: StandingsOutput[] = [];
  for (const group of groups) {
    const name = safeStr(group.name) || parentName;
    if (group.standings?.entries?.length) {
      results.push(...parseStandingsEntries(group.standings.entries, name));
    }
    if (group.entries?.length) {
      results.push(...parseStandingsEntries(group.entries, name));
    }
    if (group.children?.length) {
      results.push(...walkGroups(group.children, name));
    }
  }
  return results;
}

async function fetchStandings(league: string): Promise<StandingsOutput[]> {
  const sport = LEAGUE_ENDPOINTS[league];
  if (!sport) return [];

  const url = `https://site.api.espn.com/apis/v2/sports/${sport}/standings`;
  try {
    const data = (await fetchJson(url)) as Record<string, unknown>;
    const raw: StandingsOutput[] = [];

    if (Array.isArray(data.entries)) {
      raw.push(...parseStandingsEntries(data.entries, "Unknown"));
    }
    if (Array.isArray(data.children)) {
      raw.push(...walkGroups(data.children as EspnStandingsGroup[]));
    }

    // Deduplicate — same team may appear in both an overall view and a divisional view
    const seen = new Set<string>();
    const deduped = raw.filter((e) => {
      const k = `${e.team.toLowerCase()}|${e.abbreviation.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (!deduped.length) {
      console.warn(`  [WARN] 0 teams parsed for ${league} — ESPN response shape may have changed`);
    }
    return deduped;
  } catch (err) {
    console.warn(`Standings fetch failed for ${league}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

async function fetchInjuries(league: string): Promise<InjuryOutput[]> {
  const sport = LEAGUE_ENDPOINTS[league];
  if (!sport) return [];

  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/injuries`;
  try {
    const data = (await fetchJson(url)) as Record<string, unknown>;
    // ESPN injuries: { injuries: [ { displayName: "Team Name", injuries: [...] } ] }
    // Team name is group.displayName (not group.team.displayName)
    // Injury type is inj.details.type ("Knee"), not inj.type.name ("INJURY_STATUS_OUT")
    // Player's team is also available at inj.athlete.team.displayName as fallback
    const items = (data as { injuries?: unknown[] }).injuries ?? [];
    const results: InjuryOutput[] = [];

    for (const item of items) {
      const i = item as {
        displayName?: string;
        injuries?: Array<{
          athlete?: {
            displayName?: string;
            position?: { abbreviation?: string };
            team?: { displayName?: string; abbreviation?: string };
          };
          status?: string;
          type?: { name?: string; description?: string };
          details?: {
            type?: string;
            returnDate?: string;
            detail?: string;
            fantasyStatus?: { description?: string };
          };
        }>;
      };
      const groupTeamName = safeStr(i.displayName);

      for (const inj of i.injuries ?? []) {
        // Prefer group displayName; fall back to athlete.team if group name missing
        const teamName = groupTeamName || safeStr(inj.athlete?.team?.displayName) || safeStr(inj.athlete?.team?.abbreviation);
        results.push({
          player: safeStr(inj.athlete?.displayName),
          team: teamName,
          position: safeStr(inj.athlete?.position?.abbreviation),
          status: safeStr(inj.status) || "Unknown",
          // details.type has the actual body part ("Knee", "Ankle"); type.description has "out"/"questionable"
          injuryType: safeStr(inj.details?.type) || safeStr(inj.type?.description) || "",
          returnDate: safeStr(inj.details?.returnDate) || "",
        });
      }
    }

    return results;
  } catch (err) {
    console.warn(`Injuries fetch failed for ${league}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  // Fetch standings for all leagues in parallel
  const leagueKeys = Object.keys(LEAGUE_ENDPOINTS);
  const standingsResults = await Promise.all(leagueKeys.map((l) => fetchStandings(l)));

  for (let i = 0; i < leagueKeys.length; i++) {
    const league = leagueKeys[i];
    const standings = standingsResults[i];
    const outPath = path.join(outDir, `standings-${league}.json`);
    fs.writeFileSync(outPath, JSON.stringify(standings, null, 2));
    console.log(`Standings ${league}: ${standings.length} teams → ${outPath}`);
  }

  // Fetch injuries for NBA + NFL in parallel
  const injuryResults = await Promise.all(INJURY_LEAGUES.map((l) => fetchInjuries(l)));

  for (let i = 0; i < INJURY_LEAGUES.length; i++) {
    const league = INJURY_LEAGUES[i];
    const injuries = injuryResults[i];
    const outPath = path.join(outDir, `injuries-${league}.json`);
    fs.writeFileSync(outPath, JSON.stringify(injuries, null, 2));
    console.log(`Injuries ${league}: ${injuries.length} entries → ${outPath}`);
  }

  console.log("Context ingestion complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
