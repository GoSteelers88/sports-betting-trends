import type { PlayerProp } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

function fmtAmerican(n: number | null): string {
  if (n === null) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

function confidenceColor(conf: number): string {
  if (conf >= 80) return "var(--edge)";
  if (conf >= 60) return "var(--signal)";
  if (conf >= 40) return "var(--warn)";
  return "var(--muted)";
}

function confidenceLabel(conf: number): string {
  if (conf >= 80) return "EDGE VERIFIED";
  if (conf >= 60) return "BOOK CONSENSUS";
  if (conf >= 40) return "VOLATILITY WARN";
  return "LOW SIGNAL";
}

export function PropSignals({ props }: { props: PlayerProp[] }) {
  if (props.length === 0) return null;

  return (
    <section className="space-y-4">
      <SectionHeader
        id="prop-signals"
        index="05"
        label="PROP SIGNALS"
        title="HIGH-CONFIDENCE SIGNALS"
        subtitle="Player-prop signals ranked by model confidence. The agent uses these as supporting evidence for game picks; high-conf entries are eligible for future direct-prop deployment."
        status={`${props.length} RANKED`}
        statusColor="signal"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {props.map((p, idx) => {
          const price = p.pickSide === "over" ? p.overPrice : p.underPrice;
          const isOver = p.pickSide === "over";
          const cColor = confidenceColor(p.confidence);
          const cLabel = confidenceLabel(p.confidence);
          return (
            <article key={`${p.player}-${p.market}-${idx}`} className="surface p-4 flex flex-col">
              <header className="flex items-center justify-between mb-3">
                <span className="eyebrow text-[var(--muted)]">
                  #{String(idx + 1).padStart(2, "0")} / {(p.marketLabel ?? p.market).toUpperCase()}
                </span>
                <span className="pill" style={{ color: cColor, borderColor: cColor }}>
                  {cLabel}
                </span>
              </header>

              <h3 className="font-display text-2xl leading-tight text-[var(--text)]">{p.player}</h3>
              <p className="font-mono text-xs text-[var(--muted)] mb-3">
                {p.team ?? "—"}{p.opponent ? ` vs ${p.opponent}` : ""}
              </p>

              <div className="grid grid-cols-[1fr_auto] gap-2 items-baseline border-y border-[var(--border)] py-3 mb-3">
                <span className="font-display text-base">
                  <span style={{ color: isOver ? "var(--edge)" : "var(--kill)" }}>
                    {p.pickSide.toUpperCase()}
                  </span>{" "}
                  <span className="numeric text-[var(--text)]">{p.line}</span>
                </span>
                <span className="numeric text-2xl text-[var(--text)]">
                  {fmtAmerican(price)}
                </span>
              </div>

              {/* Huge confidence numeric per spec */}
              <div className="flex items-baseline justify-between mb-2">
                <span className="eyebrow text-[var(--muted)]">CONFIDENCE</span>
                <span className="numeric text-3xl font-bold" style={{ color: cColor }}>
                  {p.confidence}
                </span>
              </div>
              <div className="meter mb-3">
                <div
                  className="meter-fill"
                  style={{ width: `${Math.min(100, p.confidence)}%`, background: cColor }}
                />
              </div>

              {p.rationaleSignals?.[0] && (
                <p className="font-mono text-xs text-[var(--muted)] leading-relaxed line-clamp-2 mt-auto">
                  ▸ {p.rationaleSignals[0]}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
