import type { PlayerProp } from "../_data/dashboard";

function fmtAmerican(n: number | null): string {
  if (n === null) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

export function PlayerProps({ props }: { props: PlayerProp[] }) {
  if (props.length === 0) return null;

  return (
    <section>
      <div className="flex items-end justify-between mb-4 pb-3 border-b-[3px] border-white">
        <h2 className="display-tight text-4xl sm:text-5xl text-white">PLAYER PROPS</h2>
        <span className="display-eyebrow text-[var(--hazard)]">{props.length} RANKED // NBA</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0 border-[3px] border-white">
        {props.map((p, idx) => {
          const price = p.pickSide === "over" ? p.overPrice : p.underPrice;
          const isOver = p.pickSide === "over";
          return (
            <article
              key={`${p.player}-${p.market}-${idx}`}
              className="p-4 border-r-[3px] border-b-[3px] border-white last:border-r-0 md:[&:nth-child(2n)]:border-r-0 lg:[&:nth-child(2n)]:border-r-[3px] lg:[&:nth-child(3n)]:border-r-0"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="display-eyebrow bg-white text-black px-1.5 py-0.5 text-[0.55rem]">
                  {(p.marketLabel ?? p.market).toUpperCase()}
                </span>
                <span className="mono text-[0.65rem] text-white/50">#{idx + 1}</span>
              </div>

              <p className="display text-white text-lg leading-tight">{p.player.toUpperCase()}</p>
              <p className="mono text-[0.65rem] text-white/50 mb-3">
                {(p.team ?? "—").toUpperCase()} {p.opponent ? `VS ${p.opponent.toUpperCase()}` : ""}
              </p>

              <div className="flex items-end justify-between gap-3 mb-3 pb-3 border-b-[3px] border-white/20">
                <span className="display flex items-center gap-2 text-base">
                  <span className={`px-1.5 py-0.5 text-xs ${isOver ? "bg-[var(--color-win)] text-black" : "bg-[var(--color-loss)] text-white"}`}>
                    {p.pickSide.toUpperCase()}
                  </span>
                  <span className="text-white">{p.line}</span>
                </span>
                <span className="odds-display text-3xl text-[var(--hazard)]">{fmtAmerican(price)}</span>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 border-[2px] border-white">
                  <div
                    className="h-full bg-[var(--hazard)]"
                    style={{ width: `${Math.min(100, p.confidence)}%` }}
                  />
                </div>
                <span className="mono text-[0.65rem] text-white shrink-0">CONF {p.confidence}</span>
              </div>

              {p.rationaleSignals?.[0] && (
                <p className="mono text-[0.7rem] text-white/50 mt-2 line-clamp-2">{p.rationaleSignals[0]}</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
