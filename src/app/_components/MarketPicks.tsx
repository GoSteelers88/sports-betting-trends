import type { MarketPick } from "../_data/dashboard";

export function MarketPicks({ picks }: { picks: MarketPick[] }) {
  if (picks.length === 0) return null;

  return (
    <section className="relative">
      <div className="flex items-baseline justify-between mb-3">
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--rust)]">
          // MARKET_HEURISTIC_FEED
        </span>
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--foreground)]">
          {picks.length} RANKED
        </span>
      </div>

      <ul className="divide-y" style={{ borderColor: "var(--rust-deep)" }}>
        {picks.map((p, idx) => (
          <li
            key={`${p.league}-${p.matchup}-${idx}`}
            className="flex items-center gap-4 py-2"
            style={{ borderColor: "var(--rust-deep)" }}
          >
            <span
              className="var-display text-2xl sm:text-3xl w-10 shrink-0"
              style={{
                color: p.score >= 75 ? "var(--rust-flash)" : "var(--concrete)",
                ["--wght" as string]: "800",
              }}
            >
              {String(idx + 1).padStart(2, "0")}
            </span>
            <div className="flex-1 min-w-0">
              <p className="var-mono text-xs sm:text-sm uppercase tracking-wider truncate" style={{ color: "var(--foreground)" }}>
                <span style={{ color: "var(--rust)" }}>[{p.league}]</span> {p.matchup.toUpperCase()}
              </p>
              <p className="var-mono text-[0.7rem] uppercase tracking-wider truncate" style={{ color: "var(--concrete-light)" }}>
                ▸ {p.pickTeam.toUpperCase()}
                {p.line && <> ({p.line})</>}
                {p.rationaleSignals?.[0] && <> ▸ {p.rationaleSignals[0]}</>}
              </p>
            </div>
            <span
              className="var-display text-2xl sm:text-3xl shrink-0"
              style={{
                color: p.score >= 75 ? "var(--rust-flash)" : p.score >= 60 ? "var(--rust)" : "var(--concrete)",
                ["--wght" as string]: "700",
              }}
            >
              {p.score}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
