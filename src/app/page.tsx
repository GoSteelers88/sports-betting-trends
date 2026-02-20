"use client";

import { useEffect, useMemo, useState } from "react";

type NcaabMetrics = {
  last10Momentum: number | null;
  atsForm: number | null;
  upsetAlertScore: number;
  bubbleWatchTeams: string[];
  autoBidWatchTeams: string[];
};

type BasketballAdvanced = {
  games: number;
  pace: number | null;
  oRtg: number | null;
  dRtg: number | null;
  netRating: number | null;
  tsPct: number | null;
  efgPct: number | null;
  toRate: number | null;
  ftRate: number | null;
  sos: number | null;
};

type FootballAdvanced = {
  games: number;
  ppg: number | null;
  oppPpg: number | null;
  ypg: number | null;
  oppYpg: number | null;
  turnoverMargin: number | null;
  thirdDownPct: number | null;
  redZonePct: number | null;
  avgTop: number | null;
  sos: number | null;
};

type BaseballAdvanced = {
  games: number;
  rpg: number | null;
  oppRpg: number | null;
  hitsPerGame: number | null;
  errorsPerGame: number | null;
  sos: number | null;
};

type AdvancedMetrics = BasketballAdvanced | FootballAdvanced | BaseballAdvanced;

type LeagueSummary = {
  league: string;
  games: number;
  conferences: string[];
  avgPoints: number | null;
  avgRebounds: number | null;
  avgAssists: number | null;
  avgYards: number | null;
  recentAvgPoints: number | null;
  recentAvgYards: number | null;
  trendScore: number;
  trendSignal: "up" | "down" | "flat";
  confidence: number;
  ncaab: NcaabMetrics | null;
  advanced: AdvancedMetrics | null;
  teamAdvanced: Record<string, AdvancedMetrics> | null;
};

type Latest = {
  league: string;
  conference: string | null;
  gameDate: string;
  team: string;
  opponent: string;
  points: number;
  rebounds: number | null;
  assists: number | null;
  yards: number | null;
  source: string;
};

type BestBetGame = {
  league: string;
  conference: string | null;
  gameDate: string;
  matchup: string;
  pickTeam: string;
  opponent: string;
  spread: number | null;
  modelSpread: number | null;
  line: string | null;
  score: number;
  confidence: number;
  rationaleSignals: string[];
  momentumEdge: number;
  atsEdge: number | null;
};

type InjuryEntry = {
  player: string;
  team: string;
  position: string;
  status: string;
  injuryType: string;
  returnDate: string;
};

type PlayerPropSummary = {
  player: string;
  team: string | null;
  opponent: string | null;
  market: string;
  marketLabel: string;
  category: "core" | "defense" | "combo";
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  pickSide: "over" | "under";
  confidence: number;
  rationaleSignals: string[];
  dataQuality: "high" | "medium" | "low";
};

type ApiResponse = {
  generatedAt: string;
  ready: boolean;
  recordsIngested: number;
  leagues: LeagueSummary[];
  latestByLeague: Latest[];
  conferences: string[];
  bestBets: BestBetGame[];
  topBestBetsTarget?: number;
  topBestBetsDateEt?: string;
  topBestBetsFallbackUsed?: boolean;
  bestBetsNote?: string | null;
  playerProps?: PlayerPropSummary[];
  playerPropsNote?: string | null;
  playerPropsGeneratedAt?: string | null;
  injuries?: Record<string, InjuryEntry[]>;
};

function fmtOdds(n: number | null | undefined): string {
  if (n == null) return "\u2014";
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtGameTime(d: string | null | undefined): string {
  if (!d) return "";
  const t = new Date(d);
  if (isNaN(t.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(t) + " ET";
}

function fmt(n: number | null | undefined, digits = 1) {
  if (n == null) return "\u2014";
  return n.toFixed(digits);
}

function pct(n: number | null | undefined) {
  if (n == null) return "\u2014";
  return (n * 100).toFixed(1) + "%";
}

function isBasketball(league: string) {
  return league === "NBA" || league === "NCAAB";
}

function isFootball(league: string) {
  return league === "NFL";
}

export default function Home() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leagueFilter, setLeagueFilter] = useState("ALL");
  const [conferenceFilter, setConferenceFilter] = useState("ALL");
  const [propCategoryFilter, setPropCategoryFilter] = useState<"all" | "core" | "defense" | "combo">("all");

  useEffect(() => {
    async function load() {
      try {
        const params = new URLSearchParams({ league: leagueFilter, conference: conferenceFilter, _t: String(Date.now()) });
        const res = await fetch(`/api/free-stats/summary?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load summary (${res.status})`);
        const json = (await res.json()) as ApiResponse;
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    }
    load();
  }, [leagueFilter, conferenceFilter]);



  const generatedAt = useMemo(() => {
    if (!data?.generatedAt) return "";
    return new Date(data.generatedAt).toLocaleString();
  }, [data?.generatedAt]);

  const leagueOptions = ["ALL", "NBA", "NFL", "NCAAB", "MLB"];

  const top5BestBets = useMemo(() => {
    const target = data?.topBestBetsTarget ?? 5;
    return (data?.bestBets ?? []).slice(0, target);
  }, [data?.bestBets, data?.topBestBetsTarget]);

  const keyInjuries = useMemo(() => {
    if (!data?.injuries) return {};
    const filtered: Record<string, InjuryEntry[]> = {};
    for (const [league, entries] of Object.entries(data.injuries)) {
      const severe = entries.filter(
        (e) => e.status.toLowerCase().includes("out") || e.status.toLowerCase().includes("doubtful"),
      );
      if (severe.length) filtered[league] = severe.slice(0, 15);
    }
    return filtered;
  }, [data?.injuries]);


  const topPlayerProps = useMemo(() => {
    const props = data?.playerProps ?? [];
    const filtered = propCategoryFilter === "all" ? props : props.filter((p) => p.category === propCategoryFilter);
    return filtered.slice(0, 5);
  }, [data?.playerProps, propCategoryFilter]);  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-6 rounded-xl border border-slate-800 bg-slate-900/80 p-5">
          <h1 className="text-2xl font-semibold tracking-tight">BJ Free-Data Betting Trends</h1>
          <p className="mt-2 text-sm text-slate-300">
            Free-data snapshot across NBA, NFL, NCAAB, and MLB. Signals are directional support only, not betting advice.
          </p>
          {generatedAt && <p className="mt-1 text-xs text-slate-400">Last generated: {generatedAt}</p>}
        </header>

        <section className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4 md:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-400">League</span>
            <select
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2"
              value={leagueFilter}
              onChange={(e) => setLeagueFilter(e.target.value)}
            >
              {leagueOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-400">Conference / Division</span>
            <select
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2"
              value={conferenceFilter}
              onChange={(e) => setConferenceFilter(e.target.value)}
            >
              <option value="ALL">ALL</option>
              {(data?.conferences ?? []).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
          <div className="rounded-md bg-slate-800/60 p-3 text-sm text-slate-300">
            <p>Conference/division filter applies to leagues that provide grouping data (NCAAB + MLB).</p>
          </div>
        </section>

        {error && <div className="rounded-lg border border-red-500/40 bg-red-950/40 p-4 text-sm text-red-200">{error}</div>}

        {!data && !error && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">Loading summary...</div>
        )}

        {data && (
          <>
            <section className="mb-6 rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-4 sm:p-5">
              <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <h2 className="text-lg font-semibold text-emerald-200">Top 5 Game Picks of the Day</h2>
                <p className="text-xs text-emerald-100/80">
                  Date: {data.topBestBetsDateEt ?? "Today"} (America/New_York) | Last updated: {generatedAt || "\u2014"}
                </p>
              </div>
              <div className="space-y-2">
                {data.bestBetsNote && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-950/20 p-3 text-sm text-amber-100">
                    {data.bestBetsNote}
                  </div>
                )}
                {top5BestBets.length === 0 && (
                  <div className="rounded-md border border-emerald-500/20 bg-slate-900/80 p-3 text-sm text-slate-300">
                    No eligible game-level picks found for this date.
                  </div>
                )}
                {top5BestBets.map((item, idx) => (
                  <div key={`${item.league}-${item.matchup}-${idx}`} className="rounded-md border border-emerald-500/20 bg-slate-900/80 p-3">
                    <p className="text-sm font-semibold text-white">
                      #{idx + 1} {item.matchup} ({item.league}{item.conference ? ` / ${item.conference}` : ""}){fmtGameTime(item.gameDate) ? ` · ${fmtGameTime(item.gameDate)}` : ""}
                    </p>
                    <p className="text-xs text-slate-300 sm:text-sm">
                      Pick {item.pickTeam}
                      {item.line ? ` (${item.line})` : ""}
                      {item.modelSpread != null && item.spread != null && Math.abs(item.spread - item.modelSpread) >= 3
                        ? ` → model: ${item.modelSpread > 0 ? "+" : ""}${item.modelSpread}`
                        : ""}{" "}
                      | Score {item.score} | Confidence {item.confidence}%
                    </p>
                    <p className="text-xs text-slate-400">{item.rationaleSignals?.[0] ?? "Signal details unavailable"}</p>
                  </div>
                ))}
              </div>
            </section>

            {(leagueFilter === "NBA" || leagueFilter === "ALL") && (
              <section className="mb-6 rounded-xl border border-violet-500/30 bg-violet-950/10 p-4 sm:p-5">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <h2 className="text-lg font-semibold text-violet-200">Top 5 Player Props (NBA)</h2>
                  <p className="text-xs text-violet-300/80">Updated: {data.playerPropsGeneratedAt ? new Date(data.playerPropsGeneratedAt).toLocaleString() : "—"}</p>
                </div>
                <div className="mb-3 flex flex-wrap gap-2 text-xs">
                  {([
                    ["all", "All"],
                    ["core", "Core"],
                    ["defense", "Defense"],
                    ["combo", "Combo"],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setPropCategoryFilter(key)}
                      className={`rounded-md border px-2.5 py-1 ${propCategoryFilter === key ? "border-violet-400 bg-violet-500/20 text-violet-100" : "border-slate-700 bg-slate-900/60 text-slate-300"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {data.playerPropsNote && <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-950/20 p-3 text-sm text-amber-100">{data.playerPropsNote}</div>}
                {topPlayerProps.length === 0 ? (
                  <div className="rounded-md border border-violet-500/20 bg-slate-900/80 p-3 text-sm text-slate-300">No eligible NBA player props for this filter.</div>
                ) : (
                  <div className="space-y-2">{topPlayerProps.map((prop, idx) => (
                    <div key={`${prop.player}-${prop.market}-${idx}`} className="rounded-md border border-violet-500/20 bg-slate-900/80 p-3">
                      <p className="text-sm font-semibold text-white">#${idx + 1} ${prop.player} (${prop.marketLabel})</p>
                      <p className="text-xs text-slate-300">${prop.team ?? "—"} vs ${prop.opponent ?? "—"} · Line ${prop.line} · Over ${fmtOdds(prop.overPrice)} / Under ${fmtOdds(prop.underPrice)}</p>
                      <p className="text-xs text-slate-300">Pick ${prop.pickSide.toUpperCase()} · Confidence ${prop.confidence}% · Data quality ${prop.dataQuality}</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-400">{(prop.rationaleSignals ?? []).slice(0, 3).map((signal) => (<li key={signal}>{signal}</li>))}</ul>
                    </div>
                  ))}</div>
                )}
              </section>
            )}

            <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-400">Ingest readiness</p>
                <p className="mt-1 text-lg font-semibold">{data.ready ? "Ready" : "Not ready"}</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-400">Rows ingested</p>
                <p className="mt-1 text-lg font-semibold">{data.recordsIngested}</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-400">Leagues in view</p>
                <p className="mt-1 text-lg font-semibold">{data.leagues.length}</p>
              </div>
            </section>

            <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
              {data.leagues.map((league) => (
                <article key={league.league} className="rounded-xl border border-slate-800 bg-slate-900 p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-xl font-semibold">{league.league}</h2>
                    <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-200">{league.games} games</span>
                  </div>

                  <p className="mb-3 text-sm text-slate-300">
                    League trend score: <span className="font-semibold text-white">{league.trendScore}</span> / 99 ({league.trendSignal})
                  </p>

                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-md bg-slate-800/70 p-2">Avg points: {fmt(league.avgPoints)}</div>
                    <div className="rounded-md bg-slate-800/70 p-2">Recent points: {fmt(league.recentAvgPoints)}</div>
                    <div className="rounded-md bg-slate-800/70 p-2">Avg rebounds: {fmt(league.avgRebounds)}</div>
                    <div className="rounded-md bg-slate-800/70 p-2">Avg assists: {fmt(league.avgAssists)}</div>
                    <div className="rounded-md bg-slate-800/70 p-2">Avg yards: {fmt(league.avgYards)}</div>
                    <div className="rounded-md bg-slate-800/70 p-2">Recent yards: {fmt(league.recentAvgYards)}</div>
                  </div>

                  {/* Basketball Advanced Metrics */}
                  {isBasketball(league.league) && league.advanced && "pace" in league.advanced && (
                    <div className="mt-3">
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Advanced Metrics</p>
                      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                        <div className="rounded-md bg-indigo-950/40 p-2">
                          <span className="text-xs text-slate-400">Pace</span>
                          <p className="font-semibold">{fmt((league.advanced as BasketballAdvanced).pace)}</p>
                        </div>
                        <div className="rounded-md bg-indigo-950/40 p-2">
                          <span className="text-xs text-slate-400">Net Rtg</span>
                          <p className="font-semibold">{fmt((league.advanced as BasketballAdvanced).netRating)}</p>
                        </div>
                        <div className="rounded-md bg-indigo-950/40 p-2">
                          <span className="text-xs text-slate-400">ORtg</span>
                          <p className="font-semibold">{fmt((league.advanced as BasketballAdvanced).oRtg)}</p>
                        </div>
                        <div className="rounded-md bg-indigo-950/40 p-2">
                          <span className="text-xs text-slate-400">DRtg</span>
                          <p className="font-semibold">{fmt((league.advanced as BasketballAdvanced).dRtg)}</p>
                        </div>
                        <div className="rounded-md bg-indigo-950/40 p-2">
                          <span className="text-xs text-slate-400">TS%</span>
                          <p className="font-semibold">{pct((league.advanced as BasketballAdvanced).tsPct)}</p>
                        </div>
                        <div className="rounded-md bg-indigo-950/40 p-2">
                          <span className="text-xs text-slate-400">eFG%</span>
                          <p className="font-semibold">{pct((league.advanced as BasketballAdvanced).efgPct)}</p>
                        </div>
                        <div className="rounded-md bg-indigo-950/40 p-2">
                          <span className="text-xs text-slate-400">TO Rate</span>
                          <p className="font-semibold">{pct((league.advanced as BasketballAdvanced).toRate)}</p>
                        </div>
                        <div className="rounded-md bg-indigo-950/40 p-2">
                          <span className="text-xs text-slate-400">SOS</span>
                          <p className="font-semibold">{fmt((league.advanced as BasketballAdvanced).sos, 3)}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* NFL Advanced Metrics */}
                  {isFootball(league.league) && league.advanced && "ppg" in league.advanced && (
                    <div className="mt-3">
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Advanced Metrics</p>
                      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                        <div className="rounded-md bg-orange-950/40 p-2">
                          <span className="text-xs text-slate-400">PPG</span>
                          <p className="font-semibold">{fmt((league.advanced as FootballAdvanced).ppg)}</p>
                        </div>
                        <div className="rounded-md bg-orange-950/40 p-2">
                          <span className="text-xs text-slate-400">Opp PPG</span>
                          <p className="font-semibold">{fmt((league.advanced as FootballAdvanced).oppPpg)}</p>
                        </div>
                        <div className="rounded-md bg-orange-950/40 p-2">
                          <span className="text-xs text-slate-400">YPG</span>
                          <p className="font-semibold">{fmt((league.advanced as FootballAdvanced).ypg)}</p>
                        </div>
                        <div className="rounded-md bg-orange-950/40 p-2">
                          <span className="text-xs text-slate-400">TO Margin</span>
                          <p className="font-semibold">{fmt((league.advanced as FootballAdvanced).turnoverMargin, 2)}</p>
                        </div>
                        <div className="rounded-md bg-orange-950/40 p-2">
                          <span className="text-xs text-slate-400">3rd Down %</span>
                          <p className="font-semibold">{pct((league.advanced as FootballAdvanced).thirdDownPct)}</p>
                        </div>
                        <div className="rounded-md bg-orange-950/40 p-2">
                          <span className="text-xs text-slate-400">Red Zone %</span>
                          <p className="font-semibold">{pct((league.advanced as FootballAdvanced).redZonePct)}</p>
                        </div>
                        <div className="rounded-md bg-orange-950/40 p-2">
                          <span className="text-xs text-slate-400">SOS</span>
                          <p className="font-semibold">{fmt((league.advanced as FootballAdvanced).sos, 3)}</p>
                        </div>
                        <div className="rounded-md bg-orange-950/40 p-2">
                          <span className="text-xs text-slate-400">Avg TOP</span>
                          <p className="font-semibold">{fmt((league.advanced as FootballAdvanced).avgTop)} min</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* MLB Advanced Metrics */}
                  {league.league === "MLB" && league.advanced && "rpg" in league.advanced && (
                    <div className="mt-3">
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Advanced Metrics</p>
                      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                        <div className="rounded-md bg-green-950/40 p-2">
                          <span className="text-xs text-slate-400">RPG</span>
                          <p className="font-semibold">{fmt((league.advanced as BaseballAdvanced).rpg)}</p>
                        </div>
                        <div className="rounded-md bg-green-950/40 p-2">
                          <span className="text-xs text-slate-400">Opp RPG</span>
                          <p className="font-semibold">{fmt((league.advanced as BaseballAdvanced).oppRpg)}</p>
                        </div>
                        <div className="rounded-md bg-green-950/40 p-2">
                          <span className="text-xs text-slate-400">Hits/G</span>
                          <p className="font-semibold">{fmt((league.advanced as BaseballAdvanced).hitsPerGame)}</p>
                        </div>
                        <div className="rounded-md bg-green-950/40 p-2">
                          <span className="text-xs text-slate-400">Errors/G</span>
                          <p className="font-semibold">{fmt((league.advanced as BaseballAdvanced).errorsPerGame)}</p>
                        </div>
                        <div className="rounded-md bg-green-950/40 p-2">
                          <span className="text-xs text-slate-400">SOS</span>
                          <p className="font-semibold">{fmt((league.advanced as BaseballAdvanced).sos, 3)}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {league.league === "NCAAB" && league.ncaab && (
                    <div className="mt-3 space-y-1 text-sm text-slate-200">
                      <p>NCAAB last-10 momentum: {fmt(league.ncaab.last10Momentum, 2)}</p>
                      <p>NCAAB ATS form: {fmt(league.ncaab.atsForm, 2)}</p>
                      <p>NCAAB upset-alert score: {league.ncaab.upsetAlertScore}</p>
                      <p className="text-xs text-slate-400">
                        Bubble hooks: {league.ncaab.bubbleWatchTeams.join(", ") || "\u2014"} | Auto-bid hooks: {league.ncaab.autoBidWatchTeams.join(", ") || "\u2014"}
                      </p>
                    </div>
                  )}

                  <p className="mt-3 text-xs text-slate-400">Confidence: {(league.confidence * 100).toFixed(0)}%</p>
                </article>
              ))}
            </section>

            {/* Injuries Section */}
            {Object.keys(keyInjuries).length > 0 && (
              <section className="mb-6 rounded-xl border border-red-500/30 bg-red-950/10 p-5">
                <h3 className="mb-3 text-lg font-semibold text-red-200">Key Injuries (Out / Doubtful)</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {Object.entries(keyInjuries).map(([league, entries]) => (
                    <div key={league}>
                      <p className="mb-2 text-sm font-semibold uppercase text-red-300">{league.toUpperCase()}</p>
                      <div className="space-y-1">
                        {entries.map((inj, idx) => (
                          <div key={`${inj.player}-${idx}`} className="rounded-md bg-slate-900/80 px-3 py-1.5 text-sm">
                            <span className="font-medium text-white">{inj.player}</span>
                            <span className="text-slate-400"> ({inj.team}, {inj.position})</span>
                            <span className="ml-2 text-xs text-red-300">{inj.status}</span>
                            {inj.injuryType && <span className="ml-1 text-xs text-slate-500">- {inj.injuryType}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="mb-6 rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="mb-3 text-lg font-semibold">Full Game-Pick Ranking (NBA / NFL / NCAAB / MLB)</h3>
              <div className="space-y-2 text-sm text-slate-200">
                {data.bestBets.map((item, idx) => (
                  <div key={`${item.league}-${item.matchup}-${idx}`} className="rounded-md bg-slate-800/70 p-3">
                    <p className="font-medium">
                      {item.matchup} ({item.league}{item.conference ? ` / ${item.conference}` : ""}){fmtGameTime(item.gameDate) ? ` · ${fmtGameTime(item.gameDate)}` : ""} \u2014 Pick {item.pickTeam}
                      {item.line ? ` (${item.line})` : ""}
                      {item.modelSpread != null && item.spread != null && Math.abs(item.spread - item.modelSpread) >= 3
                        ? ` → model: ${item.modelSpread > 0 ? "+" : ""}${item.modelSpread}`
                        : ""}{" "}
                      \u2014 Score {item.score}
                    </p>
                    <p className="text-slate-300">
                      Confidence {item.confidence}% | Momentum edge {fmt(item.momentumEdge, 2)} | ATS edge {fmt(item.atsEdge, 2)}
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-400">
                      {(item.rationaleSignals ?? ["Signal details unavailable"]).map((signal) => (
                        <li key={signal}>{signal}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="mb-3 text-lg font-semibold">Latest completed game per league</h3>
              <div className="space-y-2 text-sm text-slate-200">
                {data.latestByLeague.map((item) => (
                  <div key={`${item.league}-${item.gameDate}`} className="rounded-md bg-slate-800/70 p-3">
                    <p className="font-medium">
                      {item.league}: {item.team} vs {item.opponent} ({new Date(item.gameDate).toLocaleDateString()})
                    </p>
                    <p className="text-slate-300">
                      Points {item.points}
                      {item.rebounds != null ? ` | Reb ${item.rebounds}` : ""}
                      {item.assists != null ? ` | Ast ${item.assists}` : ""}
                      {item.yards != null ? ` | Yds ${item.yards}` : ""}
                    </p>
                    <p className="text-xs text-slate-400">
                      {item.conference ? `${item.conference} | ` : ""}Source: {item.source}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}










