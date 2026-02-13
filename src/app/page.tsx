"use client";

import { useEffect, useMemo, useState } from "react";

type LeagueSummary = {
  league: string;
  games: number;
  avgPoints: number | null;
  avgRebounds: number | null;
  avgAssists: number | null;
  avgYards: number | null;
  recentAvgPoints: number | null;
  recentAvgYards: number | null;
  trendScore: number;
  trendSignal: "up" | "down" | "flat";
  confidence: number;
};

type Latest = {
  league: string;
  gameDate: string;
  team: string;
  opponent: string;
  points: number;
  rebounds: number | null;
  assists: number | null;
  yards: number | null;
  source: string;
};

type ApiResponse = {
  generatedAt: string;
  ready: boolean;
  recordsIngested: number;
  leagues: LeagueSummary[];
  latestByLeague: Latest[];
};

function fmt(n: number | null | undefined, digits = 1) {
  if (n == null) return "—";
  return n.toFixed(digits);
}

export default function Home() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/free-stats/summary", { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load summary (${res.status})`);
        const json = (await res.json()) as ApiResponse;
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    }
    load();
  }, []);

  const generatedAt = useMemo(() => {
    if (!data?.generatedAt) return "";
    return new Date(data.generatedAt).toLocaleString();
  }, [data?.generatedAt]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-6 rounded-xl border border-slate-800 bg-slate-900/80 p-5">
          <h1 className="text-2xl font-semibold tracking-tight">BJ Free-Data Betting Trends</h1>
          <p className="mt-2 text-sm text-slate-300">
            Public-data readiness view for NBA/NFL samples. Trend score is directional only and not betting advice.
          </p>
          {generatedAt && <p className="mt-1 text-xs text-slate-400">Last generated: {generatedAt}</p>}
        </header>

        {error && <div className="rounded-lg border border-red-500/40 bg-red-950/40 p-4 text-sm text-red-200">{error}</div>}

        {!data && !error && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">Loading summary…</div>
        )}

        {data && (
          <>
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
                <p className="text-xs uppercase tracking-wide text-slate-400">Leagues</p>
                <p className="mt-1 text-lg font-semibold">{data.leagues.length}</p>
              </div>
            </section>

            <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
              {data.leagues.map((league) => (
                <article key={league.league} className="rounded-xl border border-slate-800 bg-slate-900 p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-xl font-semibold">{league.league}</h2>
                    <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-200">
                      {league.games} games
                    </span>
                  </div>

                  <p className="mb-3 text-sm text-slate-300">
                    Trend score: <span className="font-semibold text-white">{league.trendScore}</span> / 99 ({league.trendSignal})
                  </p>

                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-md bg-slate-800/70 p-2">Avg points: {fmt(league.avgPoints)}</div>
                    <div className="rounded-md bg-slate-800/70 p-2">Recent points: {fmt(league.recentAvgPoints)}</div>
                    <div className="rounded-md bg-slate-800/70 p-2">Avg rebounds: {fmt(league.avgRebounds)}</div>
                    <div className="rounded-md bg-slate-800/70 p-2">Avg assists: {fmt(league.avgAssists)}</div>
                    <div className="rounded-md bg-slate-800/70 p-2">Avg yards: {fmt(league.avgYards)}</div>
                    <div className="rounded-md bg-slate-800/70 p-2">Recent yards: {fmt(league.recentAvgYards)}</div>
                  </div>

                  <p className="mt-3 text-xs text-slate-400">Confidence: {(league.confidence * 100).toFixed(0)}%</p>
                </article>
              ))}
            </section>

            <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="mb-3 text-lg font-semibold">Latest game per league</h3>
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
                    <p className="text-xs text-slate-400">Source: {item.source}</p>
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
