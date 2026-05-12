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
      hour12: false,
    })
    .toUpperCase();
}

export function Slate({ games }: { games: SlateGame[] }) {
  if (games.length === 0) return null;

  // Flatten into a long ticker line, duplicated twice for seamless marquee.
  const cells = games.map(g => {
    const homeOdds = g.consensus.home?.american;
    const awayOdds = g.consensus.away?.american;
    return {
      key: g.eventId,
      league: g.league,
      time: fmtTime(g.commenceTime),
      label: `${g.awayTeam.toUpperCase()} ${awayOdds !== undefined && awayOdds !== null ? fmtAmerican(awayOdds) : "—"} @ ${g.homeTeam.toUpperCase()} ${homeOdds !== undefined && homeOdds !== null ? fmtAmerican(homeOdds) : "—"}`,
      hasPick: g.hasPick,
    };
  });
  const doubled = [...cells, ...cells];

  return (
    <section className="relative">
      <div className="flex items-baseline justify-between mb-2">
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--rust)]">
          // SLATE_FEED
        </span>
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--foreground)]">
          {games.length} GAMES
        </span>
      </div>

      <div className="relative overflow-hidden border-y" style={{ borderColor: "var(--rust-deep)" }}>
        <div className="ticker-x flex whitespace-nowrap py-3">
          {doubled.map((c, i) => (
            <span
              key={`${c.key}-${i}`}
              className="var-mono text-sm sm:text-base uppercase tracking-wider px-6 inline-flex items-center gap-3"
              style={{
                color: c.hasPick ? "var(--rust-flash)" : "var(--concrete-light)",
                fontWeight: c.hasPick ? 700 : 400,
              }}
            >
              <span style={{ color: "var(--rust)" }}>[{c.league}]</span>
              <span>{c.time}</span>
              <span>{c.label}</span>
              {c.hasPick && <span style={{ color: "var(--rust-flash)" }}>★ PICK</span>}
              <span style={{ color: "var(--concrete-dark)" }}>///</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
