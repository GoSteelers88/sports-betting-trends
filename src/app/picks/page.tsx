import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

type Pick = {
  rank: number;
  pickTeam: string;
  homeTeam: string;
  awayTeam: string;
  side: "home" | "away";
  modelProb: number;
  marketImpliedProb: number | null;
  marketML: number | null;
  edge: number | null;
  matchup: string;
  homePitcher?: string;
  awayPitcher?: string;
  expectedMargin?: number;
  calibrated?: boolean;
};

type Health = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
  staleSources: string[];
  criticalErrors: string[];
};

const PROCESSED_DIR = path.join(process.cwd(), "data", "processed");

function readJson<T>(file: string): T | null {
  const p = path.join(PROCESSED_DIR, file);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function fmtML(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n > 0 ? `+${n}` : String(n);
}

function fmtPct(p: number | null | undefined, dec = 1): string {
  if (p === null || p === undefined) return "—";
  return (p * 100).toFixed(dec) + "%";
}

function fmtEdge(e: number | null | undefined): string {
  if (e === null || e === undefined) return "—";
  const sign = e >= 0 ? "+" : "";
  return `${sign}${(e * 100).toFixed(1)}%`;
}

function statusColor(s: string | undefined): string {
  if (s === "ok") return "text-emerald-400";
  if (s === "degraded") return "text-amber-400";
  if (s === "error") return "text-rose-400";
  return "text-slate-400";
}

export default function PicksPage() {
  const mlbEnv = readJson<{ data?: { picks?: Pick[]; dateEt?: string } }>("picks-today.json");
  const nbaEnv = readJson<{ data?: { picks?: Pick[]; dateEt?: string } }>("picks-nba-today.json");
  const healthEnv = readJson<{ data?: Health }>("sports-ingest-health.json");

  const mlbPicks = mlbEnv?.data?.picks ?? [];
  const nbaPicks = nbaEnv?.data?.picks ?? [];
  const health = healthEnv?.data;
  const dateEt = mlbEnv?.data?.dateEt ?? new Date().toISOString().slice(0, 10);

  return (
    <main className="min-h-screen p-6 md:p-10 max-w-5xl mx-auto">
      <header className="mb-8 flex items-baseline justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">🎯 Today&apos;s Picks</h1>
          <p className="text-sm text-slate-400 mt-1">
            {dateEt} · ranked by edge over devigged market
          </p>
        </div>
        {health && (
          <div className={`text-xs uppercase tracking-wide ${statusColor(health.status)}`}>
            ingest: {health.status}
            {health.staleSources?.length > 0 && ` · stale: ${health.staleSources.join(", ")}`}
            {health.criticalErrors?.length > 0 && ` · critical: ${health.criticalErrors.join(", ")}`}
          </div>
        )}
      </header>

      {/* MLB */}
      <section className="mb-10">
        <h2 className="text-2xl font-semibold mb-1 flex items-baseline gap-3">
          <span>⚾ MLB</span>
          <span className="text-xs text-slate-500 font-normal">calibrated · isotonic CV · LightGBM</span>
        </h2>
        {mlbPicks.length === 0 ? (
          <p className="text-slate-500 italic mt-3">No MLB picks today — model edge below threshold for all games.</p>
        ) : (
          <ol className="space-y-3 mt-4">
            {mlbPicks.map((p) => (
              <li key={p.rank} className="bg-slate-900/50 border border-slate-800 rounded-lg p-4">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <div className="font-semibold text-lg">
                    <span className="text-slate-500 mr-2">#{p.rank}</span>
                    {p.pickTeam} <span className="text-slate-400">{fmtML(p.marketML)}</span>
                  </div>
                  <div className="text-emerald-400 font-mono font-semibold">edge {fmtEdge(p.edge)}</div>
                </div>
                <div className="text-sm text-slate-400 mt-1">
                  model {fmtPct(p.modelProb)} vs market {fmtPct(p.marketImpliedProb)} · {p.awayTeam} @ {p.homeTeam}
                  {p.homePitcher && p.awayPitcher && (
                    <span className="block text-xs mt-1 text-slate-500">
                      {p.awayPitcher} vs {p.homePitcher}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* NBA */}
      <section className="mb-10">
        <h2 className="text-2xl font-semibold mb-1 flex items-baseline gap-3">
          <span>🏀 NBA</span>
          <span className="text-xs text-amber-400 font-normal">heuristic · uncalibrated · net-rating</span>
        </h2>
        {nbaPicks.length === 0 ? (
          <p className="text-slate-500 italic mt-3">No NBA picks today — model edge below threshold for all games.</p>
        ) : (
          <ol className="space-y-3 mt-4">
            {nbaPicks.map((p) => (
              <li key={p.rank} className="bg-slate-900/50 border border-slate-800 rounded-lg p-4">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <div className="font-semibold text-lg">
                    <span className="text-slate-500 mr-2">#{p.rank}</span>
                    {p.pickTeam} <span className="text-slate-400">{fmtML(p.marketML)}</span>
                  </div>
                  <div className="text-emerald-400 font-mono font-semibold">edge {fmtEdge(p.edge)}</div>
                </div>
                <div className="text-sm text-slate-400 mt-1">
                  model {fmtPct(p.modelProb)} vs market {fmtPct(p.marketImpliedProb)} · {p.awayTeam} @ {p.homeTeam}
                  {p.expectedMargin !== undefined && (
                    <span className="ml-2 text-slate-500">· margin {p.expectedMargin > 0 ? "+" : ""}{p.expectedMargin.toFixed(1)}</span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="text-xs text-slate-500 mt-12 pt-4 border-t border-slate-800">
        <p>
          MLB calibrated via isotonic regression with cross-validation; NBA is a net-rating + home-court heuristic
          (training pipeline in progress). Picks shown only when model edge clears threshold (MLB +2%, NBA +5%).
          Bankroll discipline applies.
        </p>
      </footer>
    </main>
  );
}
