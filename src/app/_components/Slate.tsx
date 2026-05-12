import type { SlateGame } from "../_data/dashboard";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtTime(iso: string): string {
  return new Date(iso)
    .toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .toUpperCase();
}

export function Slate({ games }: { games: SlateGame[] }) {
  if (games.length === 0) {
    return (
      <section>
        <div className="flex items-end justify-between mb-4 pb-3 border-b-[3px] border-white">
          <h2 className="display-tight text-4xl sm:text-5xl text-white">TONIGHT&apos;S SLATE</h2>
        </div>
        <div className="brutal-card p-10 text-center">
          <p className="display text-3xl text-white mb-2">NO GAMES TODAY.</p>
          <p className="display-eyebrow text-white/60">OFF-DAY ALL LEAGUES</p>
        </div>
      </section>
    );
  }

  const byLeague: Record<string, SlateGame[]> = {};
  for (const g of games) (byLeague[g.league] ??= []).push(g);

  return (
    <section>
      <div className="flex items-end justify-between mb-4 pb-3 border-b-[3px] border-white">
        <h2 className="display-tight text-4xl sm:text-5xl text-white">TONIGHT&apos;S SLATE</h2>
        <span className="display-eyebrow text-[var(--hazard)]">{games.length} GAMES</span>
      </div>

      <div className="space-y-6">
        {Object.entries(byLeague).map(([league, leagueGames]) => (
          <div key={league}>
            <p className="display-eyebrow text-[var(--hazard)] mb-2">
              {league} // {leagueGames.length}
            </p>
            <div className="border-[3px] border-white">
              {leagueGames.map((g, idx) => (
                <GameRow key={g.eventId} game={g} isFirst={idx === 0} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function GameRow({ game, isFirst }: { game: SlateGame; isFirst: boolean }) {
  const { consensus, hasPick, modelHomeProb } = game;
  return (
    <div
      className={`p-4 ${!isFirst ? "border-t-[3px] border-white" : ""} ${
        hasPick ? "bg-[var(--hazard)] text-black" : ""
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className={`mono text-xs ${hasPick ? "text-black" : "text-white/50"}`}>
          {fmtTime(game.commenceTime)} ET
        </span>
        {hasPick && (
          <span className="display-eyebrow bg-black text-[var(--hazard)] px-2 py-0.5">
            ★ AGENT PICK
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-2">
        <TeamRow
          name={game.awayTeam}
          american={consensus.away?.american ?? null}
          spread={consensus.spread ? -consensus.spread.line : null}
          dark={hasPick}
        />
        <TeamRow
          name={game.homeTeam}
          american={consensus.home?.american ?? null}
          spread={consensus.spread?.line ?? null}
          dark={hasPick}
        />
      </div>

      {consensus.total && (
        <p className={`mono text-xs ${hasPick ? "text-black/70" : "text-white/40"}`}>
          O/U <span className={hasPick ? "text-black" : "text-white"}>{consensus.total.line}</span>{" "}
          · O {fmtAmerican(consensus.total.overPrice)} / U {fmtAmerican(consensus.total.underPrice)}
        </p>
      )}

      {modelHomeProb !== null && consensus.home?.impliedProb !== null && consensus.home?.impliedProb !== undefined && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[0.6rem] mb-1">
            <span className={`display-eyebrow ${hasPick ? "text-black/60" : "text-white/50"}`}>
              MODEL {Math.round(modelHomeProb * 100)}%
            </span>
            <span className={`display-eyebrow ${hasPick ? "text-black/60" : "text-white/50"}`}>
              MARKET {Math.round(consensus.home.impliedProb * 100)}%
            </span>
          </div>
          <div className={`relative h-1.5 ${hasPick ? "bg-black/30" : "bg-white/10"}`}>
            <div
              className={`absolute top-0 left-0 h-full ${hasPick ? "bg-black" : "bg-white/60"}`}
              style={{ width: `${consensus.home.impliedProb * 100}%` }}
            />
            <div
              className={`absolute top-0 left-0 h-full ${hasPick ? "bg-black" : "bg-[var(--hazard)]"}`}
              style={{ width: `${modelHomeProb * 100}%`, mixBlendMode: hasPick ? "normal" : "screen" }}
            />
          </div>
        </div>
      )}

      {game.pick && (
        <div className="mt-3 pt-3 border-t-[3px] border-black/20">
          <p className="mono text-xs">
            <span className="display">{game.pick.selection.toUpperCase()}</span>{" "}
            @ <span className="display">{fmtAmerican(game.pick.oddsAmerican)}</span>
            <span className="opacity-60"> · EDGE {(game.pick.edge * 100).toFixed(1)}% · {game.pick.kellyStakeUnits.toFixed(2)}U</span>
          </p>
          <p className="mono text-[0.7rem] mt-1 line-clamp-2 opacity-80">{game.pick.thesis}</p>
        </div>
      )}
    </div>
  );
}

function TeamRow({
  name,
  american,
  spread,
  dark,
}: {
  name: string;
  american: number | null;
  spread: number | null;
  dark: boolean;
}) {
  return (
    <div>
      <p className={`display text-sm leading-tight ${dark ? "text-black" : "text-white"}`}>
        {name.toUpperCase()}
      </p>
      <div className={`flex items-baseline gap-2 mt-1 ${dark ? "text-black" : "text-white"}`}>
        <span className="odds-display text-2xl">
          {american !== null ? fmtAmerican(american) : "—"}
        </span>
        {spread !== null && (
          <span className={`mono text-xs ${dark ? "text-black/60" : "text-white/50"}`}>
            {spread > 0 ? "+" : ""}{spread}
          </span>
        )}
      </div>
    </div>
  );
}
