import type { MarketPick } from "../_data/dashboard";

function leagueIcon(league: string): string {
  if (league === "MLB") return "⚾";
  if (league === "NBA") return "🏀";
  return "🎯";
}

function fmtGameTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function scoreColor(score: number): string {
  if (score >= 75) return "text-[#22ff88]";
  if (score >= 60) return "text-[#00d9ff]";
  if (score >= 45) return "text-amber-300";
  return "text-slate-400";
}

export function MarketPicks({ picks }: { picks: MarketPick[] }) {
  if (picks.length === 0) {
    return (
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="display-eyebrow text-cyan-300">📈 Market Picks</h2>
        </div>
        <div className="glass rounded-2xl p-6 text-center">
          <p className="text-sm text-slate-500">
            No market-derived picks for today (heuristic model needs more games to score).
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="display-eyebrow text-cyan-300">📈 Market Picks</h2>
        <span className="text-xs text-slate-500 mono">
          {picks.length} ranked · trend + ATS + injury model
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {picks.map((p, idx) => (
          <article key={`${p.league}-${p.matchup}-${idx}`} className="glass rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="display-eyebrow text-slate-400 flex items-center gap-1.5">
                <span className="text-base">{leagueIcon(p.league)}</span>
                {p.league} · #{idx + 1}
              </span>
              <span className={`mono text-sm font-semibold ${scoreColor(p.score)}`}>
                {p.score}
              </span>
            </div>

            <p className="display text-base font-semibold leading-snug mb-1 text-white">
              {p.matchup}
            </p>
            <p className="text-sm text-slate-300 mb-2 mono">
              Pick <span className="text-cyan-200">{p.pickTeam}</span>
              {p.line ? <span className="text-slate-400"> ({p.line})</span> : null}
              {p.modelSpread != null && p.spread != null && Math.abs(p.spread - p.modelSpread) >= 3 && (
                <span className="text-slate-500"> → model {p.modelSpread > 0 ? "+" : ""}{p.modelSpread}</span>
              )}
            </p>

            <div className="flex justify-between gap-3 text-xs mb-2">
              <span className="mono text-slate-400">conf {p.confidence}%</span>
              {fmtGameTime(p.gameDate) && (
                <span className="mono text-slate-500">{fmtGameTime(p.gameDate)}</span>
              )}
            </div>

            {p.rationaleSignals?.[0] && (
              <p className="text-xs text-slate-400 line-clamp-2">{p.rationaleSignals[0]}</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
