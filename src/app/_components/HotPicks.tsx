import type { SlatePick } from "../_data/dashboard";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function leagueEmoji(league: string): string {
  if (league === "MLB") return "⚾";
  if (league === "NBA") return "🏀";
  return "🎯";
}

function pickGlow(p: SlatePick): string {
  if (p.outcome?.result === "win") return "glow-lime";
  if (p.outcome?.result === "loss") return "";
  if (p.edge >= 0.10) return "glow-pink"; // hot
  if (p.edge >= 0.05) return "glow-cyan"; // solid
  return "";
}

function pickAccent(p: SlatePick): { tag: string; color: string } {
  if (p.outcome?.result === "win") return { tag: "WIN", color: "text-[#22ff88]" };
  if (p.outcome?.result === "loss") return { tag: "LOSS", color: "text-[#ff3b3b]" };
  if (p.edge >= 0.10) return { tag: "HOT", color: "text-[#ff007a]" };
  if (p.edge >= 0.05) return { tag: "EDGE", color: "text-[#00d9ff]" };
  return { tag: "PICK", color: "text-slate-300" };
}

export function HotPicks({ picks }: { picks: SlatePick[] }) {
  if (picks.length === 0) {
    return (
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="display-eyebrow text-pink-300">🤖 Bot Picks</h2>
        </div>
        <div className="glass rounded-2xl p-8 text-center">
          <p className="display text-2xl text-slate-300 mb-2">No edge tonight</p>
          <p className="text-sm text-slate-500">
            The agent passed on every game it analyzed. Discipline &gt; action — check back after the next run.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="display-eyebrow text-pink-300">🔥 Hot Picks</h2>
        <span className="text-xs text-slate-500 mono">{picks.length} live</span>
      </div>

      <div className="h-rail flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0">
        {picks.map(p => {
          const accent = pickAccent(p);
          const glowClass = pickGlow(p);
          return (
            <article
              key={p.id}
              className={`shrink-0 w-[280px] sm:w-[320px] glass rounded-2xl p-4 ${glowClass}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs flex items-center gap-1.5">
                  <span className="text-base">{leagueEmoji(p.league)}</span>
                  <span className="display-eyebrow text-slate-400">{p.league}</span>
                </span>
                <span className={`display-eyebrow ${accent.color}`}>{accent.tag}</span>
              </div>

              <p className="display text-base font-semibold leading-snug mb-1 text-white">
                {p.matchup}
              </p>
              <p className="text-sm text-slate-300 mb-3 mono">
                {p.selection} · <span className="text-slate-100">{fmtAmerican(p.oddsAmerican)}</span>
              </p>

              <EdgeMeter edge={p.edge} />

              <div className="flex justify-between mt-3 pt-3 border-t border-white/5">
                <Field label="Stake" value={`${p.kellyStakeUnits.toFixed(2)}u`} />
                <Field label="Conf" value={`${p.confidence}`} />
                <Field label="Edge" value={`${(p.edge * 100).toFixed(1)}%`} accent />
                {p.clvCents !== null && (
                  <Field
                    label="CLV"
                    value={`${p.clvCents > 0 ? "+" : ""}${p.clvCents}¢`}
                    customColor={p.clvCents > 0 ? "text-[#22ff88]" : p.clvCents < 0 ? "text-[#ff3b3b]" : "text-slate-300"}
                  />
                )}
              </div>

              <p className="mt-3 text-xs text-slate-400 line-clamp-3 leading-relaxed">
                {p.thesis}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  accent,
  customColor,
}: {
  label: string;
  value: string;
  accent?: boolean;
  customColor?: string;
}) {
  const color = customColor ?? (accent ? "text-[#22ff88] font-semibold" : "text-white");
  return (
    <div className="text-center">
      <p className="display-eyebrow text-slate-500 text-[0.6rem]">{label}</p>
      <p className={`mono text-sm mt-0.5 ${color}`}>{value}</p>
    </div>
  );
}

function EdgeMeter({ edge }: { edge: number }) {
  const pct = Math.min(100, Math.max(0, edge * 100 * 4)); // 25% edge = full
  const color = edge >= 0.10 ? "#ff007a" : edge >= 0.05 ? "#22ff88" : "#00d9ff";
  return (
    <div className="relative h-1.5 rounded-full bg-white/5 overflow-hidden">
      <div
        className="meter-fill absolute left-0 top-0 h-full rounded-full"
        style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${color}, ${color}aa)` }}
      />
    </div>
  );
}
