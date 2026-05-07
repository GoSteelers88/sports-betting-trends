import type { SlateGame } from "../_data/dashboard";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function leagueIcon(league: string): string {
  if (league === "MLB") return "⚾";
  if (league === "NBA") return "🏀";
  return "🎯";
}

function leagueAccent(league: string): string {
  if (league === "MLB") return "text-amber-300";
  if (league === "NBA") return "text-violet-300";
  return "text-slate-300";
}

export function Slate({ games }: { games: SlateGame[] }) {
  if (games.length === 0) {
    return (
      <section>
        <h2 className="display-eyebrow text-cyan-300 mb-3">Tonight&apos;s Slate</h2>
        <div className="glass rounded-2xl p-8 text-center">
          <p className="display text-2xl text-slate-300 mb-2">No games today</p>
          <p className="text-sm text-slate-500">Off-day for both leagues. Refresh tomorrow.</p>
        </div>
      </section>
    );
  }

  // Group by league for headers
  const byLeague: Record<string, SlateGame[]> = {};
  for (const g of games) (byLeague[g.league] ??= []).push(g);

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="display-eyebrow text-cyan-300">Tonight&apos;s Slate</h2>
        <span className="text-xs text-slate-500 mono">{games.length} games</span>
      </div>

      <div className="space-y-6">
        {Object.entries(byLeague).map(([league, leagueGames]) => (
          <div key={league}>
            <p className={`display-eyebrow mb-2 ${leagueAccent(league)}`}>
              {leagueIcon(league)} {league} · {leagueGames.length}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {leagueGames.map(g => (
                <GameCard key={g.eventId} game={g} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function GameCard({ game }: { game: SlateGame }) {
  const { consensus, modelHomeProb, hasPick } = game;
  const pickGlow = hasPick ? "glow-lime" : "";
  const borderClass = hasPick ? "border-emerald-400/30" : "border-white/8";

  // Compute model probability bar position
  const modelProb = modelHomeProb;
  const marketProb = consensus.home?.impliedProb ?? null;

  return (
    <article className={`relative rounded-2xl glass p-4 ${pickGlow}`} style={{ borderColor: undefined }}>
      <div className="flex items-baseline justify-between mb-3">
        <span className="mono text-xs text-slate-400">{fmtTime(game.commenceTime)} ET</span>
        {hasPick && (
          <span className="display-eyebrow text-emerald-300">★ Agent Pick</span>
        )}
      </div>

      <div className="space-y-1.5 mb-3">
        <TeamRow
          name={game.awayTeam}
          subscript="(away)"
          american={consensus.away?.american ?? null}
          spread={consensus.spread ? -consensus.spread.line : null}
          spreadPrice={consensus.spread?.awayPrice ?? null}
        />
        <TeamRow
          name={game.homeTeam}
          subscript="(home)"
          american={consensus.home?.american ?? null}
          spread={consensus.spread?.line ?? null}
          spreadPrice={consensus.spread?.homePrice ?? null}
        />
      </div>

      {consensus.total && (
        <p className="mono text-xs text-slate-400 mb-3">
          O/U <span className="text-slate-200">{consensus.total.line}</span>{" "}
          <span className="text-slate-500">·</span>{" "}
          O {fmtAmerican(consensus.total.overPrice)} / U {fmtAmerican(consensus.total.underPrice)}
        </p>
      )}

      {modelProb !== null && marketProb !== null && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-[0.65rem] mb-1">
            <span className="display-eyebrow text-slate-500">Model {(modelProb * 100).toFixed(0)}%</span>
            <span className="display-eyebrow text-slate-500">Market {(marketProb * 100).toFixed(0)}%</span>
          </div>
          <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="absolute top-0 left-0 h-full rounded-full bg-cyan-400/60"
              style={{ width: `${marketProb * 100}%` }}
            />
            <div
              className="absolute top-0 left-0 h-full rounded-full"
              style={{
                width: `${modelProb * 100}%`,
                background:
                  modelProb > marketProb
                    ? "linear-gradient(90deg, #22ff88aa, #22ff88)"
                    : "linear-gradient(90deg, #ff007aaa, #ff007a)",
              }}
            />
          </div>
        </div>
      )}

      {game.pick && (
        <div className="rounded-md border border-emerald-400/20 bg-emerald-500/5 p-2.5 mt-2">
          <p className="text-xs mono">
            <span className="text-emerald-300">{game.pick.selection}</span>{" "}
            <span className="text-slate-400">@</span>{" "}
            <span className="text-white">{fmtAmerican(game.pick.oddsAmerican)}</span>
            <span className="text-slate-500"> · </span>
            <span className="text-emerald-200">edge {(game.pick.edge * 100).toFixed(1)}%</span>
            <span className="text-slate-500"> · </span>
            <span className="text-slate-300">{game.pick.kellyStakeUnits.toFixed(2)}u</span>
          </p>
          <p className="text-xs text-slate-400 mt-1.5 line-clamp-2">{game.pick.thesis}</p>
        </div>
      )}
    </article>
  );
}

function TeamRow({
  name,
  subscript,
  american,
  spread,
  spreadPrice,
}: {
  name: string;
  subscript: string;
  american: number | null;
  spread: number | null;
  spreadPrice: number | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-white truncate">{name}</p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {spread !== null && (
          <span className="text-xs mono text-slate-400">
            {spread > 0 ? "+" : ""}
            {spread}
            {spreadPrice !== null && (
              <span className="text-slate-600"> ({fmtAmerican(spreadPrice)})</span>
            )}
          </span>
        )}
        <span
          className={`mono text-sm font-semibold ${
            american !== null && american < 0 ? "text-cyan-200" : "text-emerald-200"
          }`}
        >
          {american !== null ? fmtAmerican(american) : "—"}
        </span>
      </div>
    </div>
  );
}
