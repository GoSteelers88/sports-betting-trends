"use client";

import { useEffect, useMemo, useState } from "react";

type NcaabMetrics = {
  last10Momentum: number | null;
  atsForm: number | null;
  upsetAlertScore: number;
  bubbleWatchTeams: string[];
  autoBidWatchTeams: string[];
};

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
  line: string | null;
  score: number;
  confidence: number;
  rationaleSignals: string[];
  momentumEdge: number;
  atsEdge: number | null;
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
  bestBetsNote?: string | null;
};

function fmt(n: number | null | undefined, digits = 1) {
  if (n == null) return "—";
  return n.toFixed(digits);
}

export default function Home() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leagueFilter, setLeagueFilter] = useState("ALL");
  const [conferenceFilter, setConferenceFilter] = useState("ALL");

  useEffect(() => {
    async function load() {
      try {
        const params = new URLSearchParams({ league: leagueFilter, conference: conferenceFilter });
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
    return (data?.bestBets ?? []).slice(0, 5);
  }, [data?.bestBets]);

  return (
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
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">Loading summary…</div>
        )}

        {data && (
          <>
            <section className="mb-6 rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-4 sm:p-5">
              <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <h2 className="text-lg font-semibold text-emerald-200">Top 5 Game Picks of the Day</h2>
                <p className="text-xs text-emerald-100/80">Last updated: {generatedAt || "—"}</p>
              </div>
              <div className="space-y-2">
                {top5BestBets.map((item, idx) => (
                  <div key={`${item.league}-${item.matchup}-${idx}`} className="rounded-md border border-emerald-500/20 bg-slate-900/80 p-3">
                    <p className="text-sm font-semibold text-white">
                      #{idx + 1} {item.matchup} ({item.league}{item.conference ? ` / ${item.conference}` : ""})
                    </p>
                    <p className="text-xs text-slate-300 sm:text-sm">
                      Pick {item.pickTeam}
                      {item.line ? ` (${item.line})` : ""} | Score {item.score} | Confidence {item.confidence}%
                    </p>
                    <p className="text-xs text-slate-400">{item.rationaleSignals?.[0] ?? "Signal details unavailable"}</p>
                  </div>
                ))}
              </div>
            </section>

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

                  {league.league === "NCAAB" && league.ncaab && (
                    <div className="mt-3 space-y-1 text-sm text-slate-200">
                      <p>NCAAB last-10 momentum: {fmt(league.ncaab.last10Momentum, 2)}</p>
                      <p>NCAAB ATS form: {fmt(league.ncaab.atsForm, 2)}</p>
                      <p>NCAAB upset-alert score: {league.ncaab.upsetAlertScore}</p>
                      <p className="text-xs text-slate-400">
                        Bubble hooks: {league.ncaab.bubbleWatchTeams.join(", ") || "—"} | Auto-bid hooks: {league.ncaab.autoBidWatchTeams.join(", ") || "—"}
                      </p>
                    </div>
                  )}

                  <p className="mt-3 text-xs text-slate-400">Confidence: {(league.confidence * 100).toFixed(0)}%</p>
                </article>
              ))}
            </section>

            <section className="mb-6 rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="mb-3 text-lg font-semibold">Full Game-Pick Ranking (NBA / NFL / NCAAB / MLB)</h3>
              <div className="space-y-2 text-sm text-slate-200">
                {data.bestBets.map((item, idx) => (
                  <div key={`${item.league}-${item.matchup}-${idx}`} className="rounded-md bg-slate-800/70 p-3">
                    <p className="font-medium">
                      {item.matchup} ({item.league}{item.conference ? ` / ${item.conference}` : ""}) — Pick {item.pickTeam}
                      {item.line ? ` (${item.line})` : ""} — Score {item.score}
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
