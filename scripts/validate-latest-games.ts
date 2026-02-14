import fs from "node:fs";
import path from "node:path";

type LatestRow = {
  league: string;
  gameDate: string;
  team: string;
  opponent: string;
  source?: string;
  sourceEventId?: string | null;
  gameStatus?: string | null;
  completionEvidence?: string | null;
};

type Summary = {
  generatedAt: string;
  latestByLeague: LatestRow[];
};

const root = process.cwd();

function toYyyyMmDd(dateIso: string | Date) {
  const d = new Date(dateIso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function normalizeName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function fetchEspnScoreboard(league: string, yyyymmdd: string) {
  const map: Record<string, string> = {
    NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
    NFL: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
    NCAAB: "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=50&limit=500",
    MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
  };

  const base = map[league];
  if (!base) return null;
  const join = base.includes("?") ? "&" : "?";
  const url = `${base}${join}dates=${yyyymmdd}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "sports-betting-trends/1.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Scoreboard fetch failed ${league}: ${res.status}`);
  return (await res.json()) as { events?: Array<{ id?: string; competitions?: Array<{ status?: { type?: { completed?: boolean } }; competitors?: Array<{ team?: { shortDisplayName?: string; displayName?: string } }> }> }> };
}

async function main() {
  const summaryPath = path.join(root, "data", "processed", "latest-summary.json");
  if (!fs.existsSync(summaryPath)) throw new Error("Missing data/processed/latest-summary.json. Run ingest first.");

  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as Summary;
  const now = Date.now();
  const failures: string[] = [];
  const checks: Array<Record<string, unknown>> = [];

  for (const row of summary.latestByLeague) {
    const league = row.league;
    const gameMs = new Date(row.gameDate).getTime();

    if (gameMs > now) {
      failures.push(`${league}: latest game is in the future (${row.gameDate})`);
    }

    const hasEvidence = Boolean(row.completionEvidence || row.gameStatus || row.source?.toLowerCase().includes("manual"));
    if (!hasEvidence) {
      failures.push(`${league}: latest game has no completion evidence`);
    }

    checks.push({
      league,
      gameDate: row.gameDate,
      team: row.team,
      opponent: row.opponent,
      gameStatus: row.gameStatus ?? null,
      completionEvidence: row.completionEvidence ?? null,
      source: row.source ?? null,
      basicPass: gameMs <= now && hasEvidence,
    });
  }

  // Optional source cross-check (at least one feed): NCAAB
  const ncaab = summary.latestByLeague.find((r) => r.league === "NCAAB");
  if (ncaab) {
    const d = new Date(ncaab.gameDate);
    const prev = new Date(d);
    prev.setUTCDate(prev.getUTCDate() - 1);

    const boards = await Promise.all([
      fetchEspnScoreboard("NCAAB", toYyyyMmDd(d)),
      fetchEspnScoreboard("NCAAB", toYyyyMmDd(prev)),
    ]);

    const t = normalizeName(ncaab.team);
    const o = normalizeName(ncaab.opponent);
    let foundCompleted = false;

    for (const board of boards) {
      for (const e of board?.events ?? []) {
        const comp = e.competitions?.[0];
        const eventIdMatch = Boolean(ncaab.sourceEventId && e.id === ncaab.sourceEventId);
        const teams = (comp?.competitors ?? []).map((c) => normalizeName(c.team?.shortDisplayName ?? c.team?.displayName ?? ""));
        const teamMatch = teams.includes(t) && teams.includes(o);

        if ((eventIdMatch || teamMatch) && comp?.status?.type?.completed) {
          foundCompleted = true;
          break;
        }
      }
      if (foundCompleted) break;
    }

    checks.push({ league: "NCAAB", sourceCrossCheck: "espn-scoreboard", matchCompleted: foundCompleted });
    if (!foundCompleted) failures.push("NCAAB: latest game not found as completed in ESPN scoreboard cross-check");
  }

  const auditPath = path.join(root, "data", "processed", "latest-games-audit.json");
  fs.writeFileSync(
    auditPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summaryGeneratedAt: summary.generatedAt,
        pass: failures.length === 0,
        failures,
        checks,
      },
      null,
      2,
    ),
  );

  if (failures.length) {
    console.error("Latest game validation failed:\n- " + failures.join("\n- "));
    process.exit(1);
  }

  console.log(`Latest game validation passed (${checks.length} checks).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
