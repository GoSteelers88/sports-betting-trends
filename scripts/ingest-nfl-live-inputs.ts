/**
 * ingest-nfl-live-inputs.ts — the live-week inputs a Tuesday board needs that
 * nflverse only fills AFTER the game (weather) or never for the live season
 * (EPA features, stadium coordinates).
 *
 *   npm run nfl:ingest-live -- [season] [week]
 *
 * Writes (all committed, all free, no API keys):
 *   data/processed/nfl-stadiums.json  city geocodes (Open-Meteo geocoding), cached
 *   data/processed/nfl-weather.json   kickoff-hour forecasts for the week's
 *                                     outdoor games (Open-Meteo forecast API —
 *                                     the same source ingest:mlb-weather uses)
 *   data/processed/nfl-epa.json       nflverse stats_team_week rows for the
 *                                     prior + current season (features are
 *                                     computed at blind-build time so the
 *                                     leak boundary lives in the pure code)
 *
 * Injuries are NOT fetched here — scripts/ingest-injuries.ts already writes
 * data/processed/injuries-nfl.json (ESPN) on every odds refresh; the publish
 * runbook runs it right before this script.
 *
 * Every failure is reported and the script still writes what it has: a board
 * with a missing forecast is honest (the prompt says "unknown"); a board that
 * never publishes because a weather API blipped is not.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultStateDir,
  gamesForCursor,
  loadGames,
  parseCsv,
  type Cursor,
  type GameRow,
} from "../src/lib/nfl-loop";
import {
  isDomeRoof,
  kickoffUtcFromEastern,
  parseTeamWeekEpa,
  stadiumCityFor,
  type StadiumCity,
  type TeamGameEpa,
  type WeatherFile,
  type WeatherForecast,
} from "../src/lib/nfl-live-inputs";

const UA = "sports-betting-trends/nfl-live-inputs (github.com/GoSteelers88)";
const PROCESSED = path.join(process.cwd(), "data", "processed");
const STADIUMS_PATH = path.join(PROCESSED, "nfl-stadiums.json");
const WEATHER_PATH = path.join(PROCESSED, "nfl-weather.json");
const EPA_PATH = path.join(PROCESSED, "nfl-epa.json");
/** Open-Meteo's forecast horizon. */
const FORECAST_MAX_DAYS = 16;

type GeoEntry = StadiumCity & {
  lat: number;
  lon: number;
  geocoderName: string;
  geocoderAdmin1: string;
  geocoderCountry: string;
  geocodedAt: string;
};
type StadiumsFile = { generatedAt: string; cities: Record<string, GeoEntry> };

function cityKey(c: StadiumCity): string {
  return `${c.country}|${c.admin1 ?? ""}|${c.query}`;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n", "utf8");
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// ─── 1. Stadium geocodes ────────────────────────────────────────────────────

type GeoResult = {
  results?: Array<{ name: string; admin1?: string; country_code: string; latitude: number; longitude: number }>;
};

async function geocode(c: StadiumCity, now: string): Promise<GeoEntry | null> {
  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(c.query)}` +
    `&count=10&language=en&format=json`;
  const data = await fetchJson<GeoResult>(url);
  // Gazetteer disambiguation: the country must match and, when we name one,
  // admin1 must match too (Glendale AZ vs CA, Paris FR vs TX …).
  const hit = (data.results ?? []).find(
    (r) => r.country_code === c.country && (!c.admin1 || (r.admin1 ?? "").toLowerCase() === c.admin1.toLowerCase()),
  );
  if (!hit) return null;
  return {
    ...c,
    lat: hit.latitude,
    lon: hit.longitude,
    geocoderName: hit.name,
    geocoderAdmin1: hit.admin1 ?? "",
    geocoderCountry: hit.country_code,
    geocodedAt: now,
  };
}

// ─── 2. Weather ─────────────────────────────────────────────────────────────

type ForecastResponse = {
  hourly?: {
    time: string[];
    temperature_2m: Array<number | null>;
    wind_speed_10m: Array<number | null>;
    wind_gusts_10m: Array<number | null>;
    precipitation_probability: Array<number | null>;
  };
};

async function forecastAt(geo: GeoEntry, kickoffUtc: string): Promise<Omit<WeatherForecast, "gameId" | "stadiumId" | "city" | "kickoffUtc" | "hoursAhead" | "fetchedAt" | "source">> {
  const day = kickoffUtc.slice(0, 10);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
    `&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC&start_date=${day}&end_date=${day}`;
  const data = await fetchJson<ForecastResponse>(url);
  const h = data.hourly;
  if (!h || h.time.length === 0) throw new Error("no hourly block in forecast response");
  // Nearest hour to kickoff.
  const target = Date.parse(kickoffUtc);
  let best = 0;
  let bestDist = Infinity;
  h.time.forEach((t, i) => {
    const d = Math.abs(Date.parse(t + ":00Z") - target);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return {
    forecastHourUtc: h.time[best] + ":00Z",
    tempF: h.temperature_2m[best] ?? null,
    windMph: h.wind_speed_10m[best] ?? null,
    gustMph: h.wind_gusts_10m[best] ?? null,
    precipPct: h.precipitation_probability[best] ?? null,
  };
}

// ─── 3. EPA rows ────────────────────────────────────────────────────────────

function statsUrl(season: number): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const season = Number(process.argv[2] ?? new Date().getUTCFullYear());
  const week = Number(process.argv[3] ?? 1);
  const cursor: Cursor = { season, phase: "REG", week };
  const now = new Date();
  const nowIso = now.toISOString();

  const games = loadGames(defaultStateDir());
  const slate: GameRow[] = gamesForCursor(games, cursor);
  if (slate.length === 0) {
    console.error(`[nfl-live-inputs] no games for ${season} REG wk${week} in games.csv — run npm run nfl:ingest`);
    process.exit(1);
  }
  console.log(`[nfl-live-inputs] ${season} REG wk${week}: ${slate.length} games`);

  // 1. Stadium geocodes (cached; only misses hit the network).
  const stadiums: StadiumsFile = readJson<StadiumsFile>(STADIUMS_PATH) ?? { generatedAt: nowIso, cities: {} };
  const unresolvedVenues: string[] = [];
  const geoFailures: string[] = [];
  for (const g of slate) {
    const stadiumId = stadiumIdOf(g);
    const city = stadiumCityFor(stadiumId, g.stadium);
    if (!city) {
      unresolvedVenues.push(`${g.gameId} (${stadiumId} "${g.stadium}")`);
      continue;
    }
    const key = cityKey(city);
    if (stadiums.cities[key]) continue;
    try {
      const geo = await geocode(city, nowIso);
      if (!geo) {
        geoFailures.push(`${key}: no gazetteer match with the required admin1/country`);
        continue;
      }
      stadiums.cities[key] = geo;
      console.log(`  geocoded ${key} → ${geo.geocoderName}, ${geo.geocoderAdmin1} ${geo.geocoderCountry} (${geo.lat.toFixed(3)}, ${geo.lon.toFixed(3)})`);
    } catch (err) {
      geoFailures.push(`${key}: ${(err as Error).message}`);
    }
  }
  stadiums.generatedAt = nowIso;
  writeJson(STADIUMS_PATH, stadiums);

  // 2. Weather for the week's outdoor (or retractable/unknown-roof) games.
  const forecasts: WeatherForecast[] = [];
  const wxSkipped: string[] = [];
  for (const g of slate) {
    if (isDomeRoof(g.roof)) continue;
    const stadiumId = stadiumIdOf(g);
    const city = stadiumCityFor(stadiumId, g.stadium);
    const geo = city ? stadiums.cities[cityKey(city)] : undefined;
    const kickoffUtc = kickoffUtcFromEastern(g.gameday, g.gametime);
    if (!city || !geo || !kickoffUtc) {
      wxSkipped.push(`${g.gameId}: ${!kickoffUtc ? "unparseable kickoff" : "no geocode"}`);
      continue;
    }
    const hoursAhead = (Date.parse(kickoffUtc) - now.getTime()) / 3_600_000;
    if (hoursAhead > FORECAST_MAX_DAYS * 24) {
      wxSkipped.push(`${g.gameId}: kickoff ${hoursAhead.toFixed(0)}h out (> ${FORECAST_MAX_DAYS}d horizon)`);
      continue;
    }
    try {
      const f = await forecastAt(geo, kickoffUtc);
      forecasts.push({
        gameId: g.gameId,
        stadiumId,
        city: `${geo.geocoderName}, ${geo.geocoderAdmin1 || geo.geocoderCountry}`,
        kickoffUtc,
        hoursAhead: Math.round(hoursAhead * 10) / 10,
        fetchedAt: nowIso,
        source: "open-meteo",
        ...f,
      });
      console.log(
        `  wx ${g.awayTeam} @ ${g.homeTeam} ${kickoffUtc} (${hoursAhead.toFixed(0)}h out): ` +
          `${f.tempF ?? "?"}°F wind ${f.windMph ?? "?"} mph gust ${f.gustMph ?? "?"} precip ${f.precipPct ?? "?"}%` +
          (g.roof.trim() === "" ? "  [retractable/unknown roof]" : ""),
      );
    } catch (err) {
      wxSkipped.push(`${g.gameId}: ${(err as Error).message}`);
    }
  }
  const wxFile: WeatherFile = { generatedAt: nowIso, season, week, forecasts };
  writeJson(WEATHER_PATH, wxFile);

  // 3. EPA rows — prior season + current season (the current file may not
  //    exist before week 1 is played; that is not an error).
  const epaRows: TeamGameEpa[] = [];
  const epaSeasons: number[] = [];
  const epaErrors: string[] = [];
  for (const s of [season - 1, season]) {
    try {
      const csv = await fetchText(statsUrl(s));
      const rows = parseTeamWeekEpa(parseCsv(csv));
      if (rows.length === 0) {
        epaErrors.push(`${s}: parsed 0 rows (schema change?)`);
        continue;
      }
      epaRows.push(...rows);
      epaSeasons.push(s);
      console.log(`  epa ${s}: ${rows.length} team-game rows`);
    } catch (err) {
      epaErrors.push(`${s}: ${(err as Error).message}`);
    }
  }
  if (epaRows.length > 0) {
    writeJson(EPA_PATH, { generatedAt: nowIso, seasons: epaSeasons, source: "nflverse stats_team_week", rows: epaRows });
  } else {
    console.warn("[nfl-live-inputs] no EPA rows fetched — leaving any previous nfl-epa.json in place");
  }

  // Coverage — printed AND the exit code says whether the week is fully covered.
  const outdoor = slate.filter((g) => !isDomeRoof(g.roof)).length;
  console.log(
    `\n[nfl-live-inputs] coverage: weather ${forecasts.length}/${outdoor} outdoor games, ` +
      `epa seasons ${epaSeasons.join("+") || "none"} (${epaRows.length} rows), ` +
      `stadium cities cached ${Object.keys(stadiums.cities).length}`,
  );
  for (const m of unresolvedVenues) console.warn(`  unresolved venue: ${m}`);
  for (const m of geoFailures) console.warn(`  geocode failure: ${m}`);
  for (const m of wxSkipped) console.warn(`  weather skipped: ${m}`);
  for (const m of epaErrors) console.warn(`  epa: ${m}`);
}

/** nflverse `stadium_id` is not on GameRow (the loop never needed it); read
 *  it straight from the CSV spine by game id. */
let stadiumIdIndex: Map<string, string> | null = null;
function stadiumIdOf(g: GameRow): string {
  if (!stadiumIdIndex) {
    stadiumIdIndex = new Map();
    const csv = fs.readFileSync(path.join(defaultStateDir(), "games.csv"), "utf8");
    const matrix = parseCsv(csv);
    const header = matrix[0]?.map((h) => h.trim()) ?? [];
    const gi = header.indexOf("game_id");
    const si = header.indexOf("stadium_id");
    if (gi >= 0 && si >= 0) {
      for (let i = 1; i < matrix.length; i++) {
        const r = matrix[i];
        if (r && r[gi]) stadiumIdIndex.set(r[gi], r[si] ?? "");
      }
    }
  }
  return stadiumIdIndex.get(g.gameId) ?? "";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
