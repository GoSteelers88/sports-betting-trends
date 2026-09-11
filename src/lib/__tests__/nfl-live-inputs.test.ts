// nfl-live-inputs — the live-week input layer. Every function is pure, so the
// leak boundary (nothing at/after the cursor week), the dome rule, the neutral
// flag and the ESPN status mapping are all pinned here without a network.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyForecasts,
  computeEpaFeatures,
  espnInjuriesToRows,
  espnStatusToReport,
  gateFairProb,
  isDomeRoof,
  kickoffUtcFromEastern,
  mergeInjuryRows,
  nflverseAbbr,
  parseTeamWeekEpa,
  stadiumCityFor,
  STADIUM_CITIES,
  applyReferees,
  parseOfficials,
  refereesForWeek,
  type TeamGameEpa,
  type WeatherForecast,
} from "../nfl-live-inputs";
import { buildBlindWeek, parseCsv, parseGames, type Cursor, type GameRow, type InjuryRow } from "../nfl-loop";
import { devigTwoWay } from "../nfl-devig";
import { EloLedger } from "../quant-desk/adapters/nfl";
import { FRANCHISES } from "../nfl-receipts/teams";

const CURSOR: Cursor = { season: 2026, phase: "REG", week: 2 };

function gameRow(over: Partial<GameRow>): GameRow {
  return {
    gameId: "2026_02_AAA_BBB",
    season: 2026,
    gameType: "REG",
    week: 2,
    gameday: "2026-09-20",
    gametime: "13:00",
    awayTeam: "AAA",
    homeTeam: "BBB",
    spreadLine: -3,
    totalLine: 44,
    awayMoneyline: 140,
    homeMoneyline: -160,
    overOdds: -110,
    underOdds: -110,
    awayRest: 7,
    homeRest: 7,
    divGame: false,
    roof: "outdoors",
    surface: "grass",
    temp: null,
    wind: null,
    awayQb: "QB1",
    homeQb: "QB2",
    awayCoach: "C1",
    homeCoach: "C2",
    referee: "",
    stadium: "S",
    awayScore: null,
    homeScore: null,
    result: null,
    total: null,
    ...over,
  };
}

describe("ESPN injuries → InjuryRow", () => {
  it("maps ESPN statuses onto the report-only statuses the loop models", () => {
    expect(espnStatusToReport("Out")).toBe("Out");
    expect(espnStatusToReport("Injured Reserve")).toBe("Out");
    expect(espnStatusToReport("Physically Unable to Perform")).toBe("Out");
    expect(espnStatusToReport("Doubtful")).toBe("Doubtful");
    expect(espnStatusToReport("Questionable")).toBe("Questionable");
    expect(espnStatusToReport("Day-To-Day")).toBe("Questionable");
    expect(espnStatusToReport("Probable")).toBe("None");
  });

  it("keys every row to the cursor week with the nflverse team code and keeps the source wording", () => {
    const { rows, unresolvedTeams } = espnInjuriesToRows(
      {
        fetchedAt: "2026-09-09T00:35:08Z",
        players: [
          { player: "Michael Penix Jr.", team: "Atlanta Falcons", position: "QB", status: "Out", injuryType: "Knee", returnDate: "2026-10-11" },
          { player: "Anez Cooper", team: "New York Jets", position: "G", status: "Injured Reserve", injuryType: "Shoulder" },
          { player: "Nobody", team: "Gotham Knights", position: "WR", status: "Out" },
        ],
      },
      CURSOR,
    );
    expect(rows).toHaveLength(2);
    const penix = rows.find((r) => r.player.startsWith("Michael"))!;
    expect(penix).toMatchObject({ season: 2026, gameType: "REG", week: 2, team: "ATL", position: "QB", status: "Out" });
    expect(penix.injury).toBe("Knee — Out (est. return 2026-10-11)");
    const cooper = rows.find((r) => r.player === "Anez Cooper")!;
    expect(cooper.team).toBe("NYJ");
    expect(cooper.status).toBe("Out");
    expect(cooper.injury).toBe("Shoulder — Injured Reserve");
    // An unknown team is reported, never guessed onto a franchise.
    expect(unresolvedTeams).toEqual(["Gotham Knights"]);
  });

  it("nflverse rows for the week win; ESPN fills the rest; no duplicates on re-run", () => {
    const nflverse: InjuryRow[] = [
      { season: 2026, gameType: "REG", week: 2, team: "ATL", player: "Michael Penix Jr.", position: "QB", status: "Questionable", injury: "Knee" },
      { season: 2026, gameType: "REG", week: 1, team: "ATL", player: "Someone Else", position: "T", status: "Out", injury: "Ankle" },
    ];
    const espn: InjuryRow[] = [
      { season: 2026, gameType: "REG", week: 2, team: "ATL", player: "Michael Penix Jr.", position: "QB", status: "Out", injury: "Knee — Out" },
      { season: 2026, gameType: "REG", week: 2, team: "NYJ", player: "Anez Cooper", position: "G", status: "Out", injury: "Shoulder — IR" },
    ];
    const merged = mergeInjuryRows(nflverse, espn, CURSOR);
    expect(merged).toHaveLength(3);
    // nflverse's own report for the week beats ESPN's standing status.
    expect(merged.find((r) => r.player === "Michael Penix Jr." && r.week === 2)!.status).toBe("Questionable");
    expect(mergeInjuryRows(merged, espn, CURSOR)).toHaveLength(3);
  });

  it("the blind week attaches ESPN-derived rows exactly like nflverse rows", () => {
    const games = [gameRow({ awayTeam: "NYJ", homeTeam: "TEN", gameId: "2026_02_NYJ_TEN" })];
    const { rows } = espnInjuriesToRows(
      { players: [{ player: "Anez Cooper", team: "New York Jets", position: "G", status: "Injured Reserve", injuryType: "Shoulder" }] },
      CURSOR,
    );
    const blind = buildBlindWeek(games, CURSOR, "", rows);
    expect(blind.games[0].injuries.away).toEqual([
      { player: "Anez Cooper", position: "G", status: "Out", injury: "Shoulder — Injured Reserve" },
    ]);
    expect(blind.games[0].injuries.home).toEqual([]);
  });
});

describe("team codes", () => {
  it("resolves display names to nflverse codes", () => {
    expect(nflverseAbbr("Green Bay Packers")).toBe("GB");
    expect(nflverseAbbr("Los Angeles Rams")).toBe("LA");
    expect(nflverseAbbr("Washington Commanders")).toBe("WAS");
    expect(nflverseAbbr("Nowhere FC")).toBeNull();
  });
});

describe("neutral sites", () => {
  const CSV = `game_id,season,game_type,week,gameday,gametime,away_team,home_team,location,away_moneyline,home_moneyline,spread_line,total_line,roof,surface,stadium_id,stadium
2026_01_SF_LA,2026,REG,1,2026-09-10,20:35,SF,LA,Neutral,166,-187,3,47.5,dome,grass,MEL00,Melbourne Cricket Ground
2026_01_NYJ_TEN,2026,REG,1,2026-09-13,13:00,NYJ,TEN,Home,106,-125,1.5,41,outdoors,grass,NAS00,Nissan Stadium
`;
  it("parseGames reads nflverse `location` into neutralSite", () => {
    const games = parseGames(CSV);
    expect(games.find((g) => g.gameId === "2026_01_SF_LA")!.neutralSite).toBe(true);
    expect(games.find((g) => g.gameId === "2026_01_NYJ_TEN")!.neutralSite).toBe(false);
  });
  it("the blind context carries the flag (absent column → false, never undefined)", () => {
    const games = parseGames(CSV);
    const blind = buildBlindWeek(games, { season: 2026, phase: "REG", week: 1 }, "");
    const mel = blind.games.find((g) => g.gameId === "2026_01_SF_LA")!;
    expect(mel.context.neutralSite).toBe(true);
    expect(blind.games.find((g) => g.gameId === "2026_01_NYJ_TEN")!.context.neutralSite).toBe(false);
    const fixture = buildBlindWeek([gameRow({})], CURSOR, "");
    expect(fixture.games[0].context.neutralSite).toBe(false);
  });
  it("the Elo dry-run drops home-field on a neutral site", () => {
    const elo = new EloLedger();
    expect(elo.homeWinProb("AAA", "BBB", 2026, true)).toBeCloseTo(0.5, 6);
    expect(elo.homeWinProb("AAA", "BBB", 2026, false)).toBeGreaterThan(0.5);
  });
});

describe("stadium → city", () => {
  it("a stadium NAME override beats the home team's stadium id (Jaguars in London)", () => {
    expect(stadiumCityFor("JAX00", "Tottenham Hotspur Stadium")).toEqual(STADIUM_CITIES.LON02);
    expect(stadiumCityFor("JAX00", "EverBank Stadium")).toEqual(STADIUM_CITIES.JAX00);
    expect(stadiumCityFor("ZZZ99", "Unknown Bowl")).toBeNull();
  });
  it("dome detection: dome/closed/indoors only — a blank (retractable) roof is NOT a dome", () => {
    expect(isDomeRoof("dome")).toBe(true);
    expect(isDomeRoof("closed")).toBe(true);
    expect(isDomeRoof("outdoors")).toBe(false);
    expect(isDomeRoof("")).toBe(false);
    expect(isDomeRoof("open")).toBe(false);
  });
});

describe("kickoff time (nflverse gametime is Eastern)", () => {
  it("converts EDT and EST correctly and defaults an empty time to 13:00 ET", () => {
    expect(kickoffUtcFromEastern("2026-09-13", "13:00")).toBe("2026-09-13T17:00:00.000Z"); // EDT −4
    expect(kickoffUtcFromEastern("2026-12-13", "13:00")).toBe("2026-12-13T18:00:00.000Z"); // EST −5
    expect(kickoffUtcFromEastern("2026-09-10", "20:20")).toBe("2026-09-11T00:20:00.000Z");
    expect(kickoffUtcFromEastern("2026-09-13", "")).toBe("2026-09-13T17:00:00.000Z");
    expect(kickoffUtcFromEastern("bad", "13:00")).toBeNull();
  });
});

describe("weather overlay", () => {
  const fc = (gameId: string, over: Partial<WeatherForecast> = {}): WeatherForecast => ({
    gameId,
    stadiumId: "NAS00",
    city: "Nashville, Tennessee",
    kickoffUtc: "2026-09-20T17:00:00.000Z",
    forecastHourUtc: "2026-09-20T17:00:00Z",
    tempF: 81.4,
    windMph: 12.6,
    gustMph: 20,
    precipPct: 30,
    hoursAhead: 96.5,
    fetchedAt: "2026-09-16T16:00:00Z",
    source: "open-meteo",
    ...over,
  });
  it("fills outdoor games, skips domes, keeps nflverse actuals, reports outdoor games with no forecast", () => {
    const games = [
      gameRow({ gameId: "g-outdoor" }),
      gameRow({ gameId: "g-dome", roof: "dome" }),
      gameRow({ gameId: "g-played", temp: 55, wind: 9 }),
      gameRow({ gameId: "g-missing" }),
      gameRow({ gameId: "g-retractable", roof: "" }),
    ];
    const res = applyForecasts(games, [fc("g-outdoor"), fc("g-dome"), fc("g-played", { tempF: 99 }), fc("g-retractable")]);
    const byId = new Map(res.games.map((g) => [g.gameId, g]));
    expect(byId.get("g-outdoor")).toMatchObject({ temp: 81, wind: 13, weatherForecastHoursAhead: 96.5 });
    expect(byId.get("g-dome")!.temp).toBeNull(); // dome: weather-neutral
    expect(byId.get("g-played")).toMatchObject({ temp: 55, wind: 9 }); // actuals never overwritten
    expect(byId.get("g-retractable")!.temp).toBe(81); // blank roof = fetched
    expect(res.applied).toBe(3);
    expect(res.skippedDome).toBe(1);
    expect(res.missing).toEqual(["g-missing"]);
  });
  it("the blind context exposes the forecast horizon", () => {
    const { games } = applyForecasts([gameRow({})], [fc("2026_02_AAA_BBB")]);
    const blind = buildBlindWeek(games, CURSOR, "");
    expect(blind.games[0].context.weatherForecastHoursAhead).toBe(96.5);
    expect(blind.games[0].context.temp).toBe(81);
  });
});

describe("EPA features (research rec 4)", () => {
  const row = (season: number, week: number, gameId: string, team: string, opponent: string, passEpa: number, dropbacks: number, rushEpa: number, carries: number): TeamGameEpa => ({
    season, week, seasonType: "REG", gameId, team, opponent, passEpa, dropbacks, rushEpa, carries,
  });
  it("parses the nflverse team-week CSV and derives dropbacks = attempts + sacks", () => {
    const csv = `season,week,team,season_type,game_id,opponent_team,attempts,sacks_suffered,passing_epa,carries,rushing_epa
2025,1,ARI,REG,2025_01_ARI_NO,NO,29,5,1.52,27,1.16
2025,1,NO,REG,2025_01_ARI_NO,ARI,30,2,-4.0,20,-2.0
2025,1,BAD,REG,2025_01_X_Y,Y,,,,,
`;
    const rows = parseTeamWeekEpa(parseCsv(csv));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ team: "ARI", opponent: "NO", dropbacks: 34, passEpa: 1.52, carries: 27 });
  });

  it("uses ONLY games strictly before the cursor week and takes defense from the opponent's offense", () => {
    const rows = [
      // 2026 wk1: A hosts B. A offense great, B offense bad.
      row(2026, 1, "2026_01_B_A", "A", "B", 12, 40, 3, 30),
      row(2026, 1, "2026_01_B_A", "B", "A", -8, 40, -3, 30),
      // 2026 wk2 (the cursor week) — must be ignored.
      row(2026, 2, "2026_02_A_C", "A", "C", -100, 40, -100, 30),
      row(2026, 2, "2026_02_A_C", "C", "A", 100, 40, 100, 30),
    ];
    const f = computeEpaFeatures(rows, CURSOR);
    expect(f.get("A")!.offPassEpaPerDropback).toBeCloseTo(12 / 40, 3);
    expect(f.get("A")!.defPassEpaPerDropbackAllowed).toBeCloseTo(-8 / 40, 3); // B's offense vs A
    expect(f.get("B")!.defPassEpaPerDropbackAllowed).toBeCloseTo(12 / 40, 3);
    expect(f.get("A")!.gamesInWindow).toBe(1);
    expect(f.has("C")).toBe(false); // C has no game before the cursor
  });

  it("weights by plays × decay and down-weights the prior season", () => {
    const rows = [
      row(2025, 18, "2025_18_A_B", "A", "B", 10, 50, 0, 20),
      row(2025, 18, "2025_18_A_B", "B", "A", 0, 50, 0, 20),
      row(2026, 1, "2026_01_A_C", "A", "C", 0, 50, 0, 20),
      row(2026, 1, "2026_01_A_C", "C", "A", 0, 50, 0, 20),
    ];
    // Most recent game (2026 wk1): EPA 0. Prior-season game: 10 EPA / 50
    // dropbacks, weighted decay × 0.67. Expected = (0.9·0.67·10) / (50 + 0.9·0.67·50).
    const w = 0.9 * 0.67;
    const expected = (w * 10) / (50 + w * 50);
    expect(computeEpaFeatures(rows, CURSOR).get("A")!.offPassEpaPerDropback).toBeCloseTo(expected, 3);
    expect(computeEpaFeatures(rows, CURSOR, { priorSeasonWeight: 1, decay: 1 }).get("A")!.offPassEpaPerDropback).toBeCloseTo(10 / 100, 3);
  });

  it("the blind context carries per-side features, or null when no feature map is supplied", () => {
    const rows = [
      row(2026, 1, "2026_01_BBB_AAA", "AAA", "BBB", 5, 40, 1, 25),
      row(2026, 1, "2026_01_BBB_AAA", "BBB", "AAA", -5, 40, -1, 25),
    ];
    const epa = computeEpaFeatures(rows, CURSOR);
    const withEpa = buildBlindWeek([gameRow({})], CURSOR, "", [], [], { epa });
    expect(withEpa.games[0].context.epa!.away!.offPassEpaPerDropback).toBeCloseTo(0.125, 3);
    expect(withEpa.games[0].context.epa!.home!.defPassEpaPerDropbackAllowed).toBeCloseTo(0.125, 3);
    const without = buildBlindWeek([gameRow({})], CURSOR, "");
    expect(without.games[0].context.epa).toBeNull();
  });
});

describe("gate devig (doctrine tightening T4)", () => {
  it("the gate's fair prob is the HIGHEST across the four methods — the smallest edge", () => {
    for (const [a, b] of [[106, -125], [-500, 380], [-110, -110], [250, -310]] as const) {
      const d = devigTwoWay(a, b);
      const g = gateFairProb(a, b);
      for (const p of Object.values(d.byMethod)) expect(g).toBeGreaterThanOrEqual(p - 1e-12);
      expect(g).toBeGreaterThanOrEqual(d.worstCaseA); // never looser than the CLV envelope
    }
  });
});

describe("referees (nflverse officials release)", () => {
  const CSV = `game_id,game_key,official_name,position,jersey_number,official_id,season,season_type,week
2026091300,2026091300,Adrian Hill,Referee,29,1,2026,REG,1
2026091300,2026091300,Some Umpire,Umpire,12,2,2026,REG,1
2026091301,2026091301,Alex Kemp,Referee,55,3,2026,REG,1
2026092000,2026092000,Brad Allen,Referee,122,4,2026,REG,2
`;
  it("parses rows and keys Referee names by the NFL game key for one week", () => {
    const rows = parseOfficials(parseCsv(CSV));
    expect(rows).toHaveLength(4);
    const wk1 = refereesForWeek(rows, 2026, 1);
    expect([...wk1]).toEqual([
      ["2026091300", "Adrian Hill"],
      ["2026091301", "Alex Kemp"],
    ]);
    expect(refereesForWeek(rows, 2026, 2).get("2026092000")).toBe("Brad Allen");
  });
  it("fills a blank referee by old_game_id, keeps an existing one, reports the rest", () => {
    const games = [
      gameRow({ gameId: "a", oldGameId: "2026091300", referee: "" }),
      gameRow({ gameId: "b", oldGameId: "2026091301", referee: "Already Known" }),
      gameRow({ gameId: "c", oldGameId: "2026091399", referee: "" }), // Melbourne-style key mismatch
      gameRow({ gameId: "d", referee: "" }), // no key at all
    ];
    const res = applyReferees(games, refereesForWeek(parseOfficials(parseCsv(CSV)), 2026, 1));
    expect(res.games.map((g) => g.referee)).toEqual(["Adrian Hill", "Already Known", "", ""]);
    expect(res.applied).toBe(1);
    expect(res.missing).toEqual(["c", "d"]);
    // The referee reaches the blind context through the ordinary path.
    const blind = buildBlindWeek(res.games.slice(0, 1), CURSOR, "");
    expect(blind.games[0].context.referee).toBe("Adrian Hill");
  });
});

describe("frozen anchors against the private nflverse spine", () => {
  const p = path.join(process.cwd(), "data", "private", "nfl-loop", "games.csv");
  const exists = fs.existsSync(p);
  it.skipIf(!exists)("every 2026 stadium_id resolves to a city and every 2026 team code resolves from a franchise name", () => {
    const matrix = parseCsv(fs.readFileSync(p, "utf8"));
    const h = matrix[0];
    const ix = (n: string) => h.indexOf(n);
    const rows = matrix.slice(1).filter((r) => r[ix("season")] === "2026");
    expect(rows.length).toBeGreaterThan(0);
    const unresolved = new Set<string>();
    const codes = new Set<string>();
    for (const r of rows) {
      if (!stadiumCityFor(r[ix("stadium_id")], r[ix("stadium")])) unresolved.add(`${r[ix("stadium_id")]} ${r[ix("stadium")]}`);
      codes.add(r[ix("home_team")]);
      codes.add(r[ix("away_team")]);
    }
    expect([...unresolved]).toEqual([]);
    // FRANCHISES' first abbreviation must be the code games.csv uses.
    const firstAbbrs = new Set(FRANCHISES.map((f) => f.abbrs[0]));
    const missing = [...codes].filter((c) => !firstAbbrs.has(c));
    expect(missing).toEqual([]);
  });
});
