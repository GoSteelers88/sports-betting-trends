import type { PlayerProp } from "../_data/dashboard";

function fmtAmerican(n: number | null): string {
  if (n === null) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

function categoryColor(cat?: string): string {
  if (cat === "core") return "text-cyan-300";
  if (cat === "defense") return "text-rose-300";
  if (cat === "combo") return "text-violet-300";
  return "text-slate-400";
}

export function PlayerProps({ props }: { props: PlayerProp[] }) {
  if (props.length === 0) return null; // hide entirely when no props available

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="display-eyebrow text-violet-300">🏀 Player Props (NBA)</h2>
        <span className="text-xs text-slate-500 mono">{props.length} ranked</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {props.map((p, idx) => {
          const price = p.pickSide === "over" ? p.overPrice : p.underPrice;
          return (
            <article key={`${p.player}-${p.market}-${idx}`} className="glass rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className={`display-eyebrow ${categoryColor(p.category)}`}>
                  {p.marketLabel ?? p.market}
                </span>
                <span className="mono text-xs text-slate-500">#{idx + 1}</span>
              </div>

              <p className="display text-base font-semibold leading-snug text-white">
                {p.player}
              </p>
              <p className="text-xs text-slate-500 mb-2">
                {p.team ?? "—"} {p.opponent ? `vs ${p.opponent}` : ""}
              </p>

              <div className="flex items-center justify-between mb-2">
                <span className="mono text-sm text-white">
                  <span className={p.pickSide === "over" ? "text-emerald-300" : "text-rose-300"}>
                    {p.pickSide.toUpperCase()}
                  </span>{" "}
                  {p.line}
                </span>
                <span className="mono text-sm text-slate-300">{fmtAmerican(price)}</span>
              </div>

              <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden mb-2">
                <div
                  className="absolute left-0 top-0 h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-400"
                  style={{ width: `${Math.min(100, p.confidence)}%` }}
                />
              </div>
              <p className="mono text-[0.65rem] text-slate-500">conf {p.confidence}</p>

              {p.rationaleSignals?.[0] && (
                <p className="text-xs text-slate-400 mt-2 line-clamp-2">{p.rationaleSignals[0]}</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
