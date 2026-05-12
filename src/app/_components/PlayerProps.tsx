import type { PlayerProp } from "../_data/dashboard";

function fmtAmerican(n: number | null): string {
  if (n === null) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

export function PlayerProps({ props }: { props: PlayerProp[] }) {
  if (props.length === 0) return null;
  return (
    <section className="relative">
      <div className="flex items-baseline justify-between mb-3">
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--rust)]">
          // PROP_FEED // NBA
        </span>
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--foreground)]">
          {props.length} RANKED
        </span>
      </div>

      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-0" style={{ border: "1px solid var(--rust-deep)" }}>
        {props.map((p, idx) => {
          const price = p.pickSide === "over" ? p.overPrice : p.underPrice;
          const isOver = p.pickSide === "over";
          return (
            <li
              key={`${p.player}-${p.market}-${idx}`}
              className="p-3 var-mono"
              style={{ borderBottom: "1px dashed var(--rust-deep)", borderRight: "1px dashed var(--rust-deep)" }}
            >
              <p className="text-[0.6rem] uppercase tracking-[0.3em]" style={{ color: "var(--concrete)" }}>
                #{String(idx + 1).padStart(2, "0")} ▸ {(p.marketLabel ?? p.market).toUpperCase()}
              </p>
              <p
                className="var-display text-lg sm:text-xl mt-1"
                style={{ color: "var(--foreground)", ["--wght" as string]: "700" }}
              >
                {p.player.toUpperCase()}
              </p>
              <p className="text-[0.65rem] uppercase tracking-wider" style={{ color: "var(--concrete-light)" }}>
                {p.team ?? "—"}{p.opponent ? ` VS ${p.opponent}` : ""}
              </p>
              <p className="mt-2 text-sm uppercase tracking-wider flex items-baseline justify-between">
                <span style={{ color: isOver ? "var(--rust-flash)" : "var(--cold)" }}>
                  {p.pickSide.toUpperCase()} {p.line}
                </span>
                <span
                  className="var-display text-2xl"
                  style={{ color: "var(--rust)", ["--wght" as string]: "800" }}
                >
                  {fmtAmerican(price)}
                </span>
              </p>
              <p className="text-[0.6rem] uppercase tracking-wider mt-1" style={{ color: "var(--concrete)" }}>
                CONF {p.confidence}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
