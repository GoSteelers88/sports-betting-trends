import type { MarketPick } from "../_data/dashboard";

function leagueTag(league: string): string {
  return league.toUpperCase();
}

function fmtGameTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso)
    .toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .toUpperCase();
}

export function MarketPicks({ picks }: { picks: MarketPick[] }) {
  if (picks.length === 0) {
    return (
      <section>
        <SectionHeader title="MARKET PICKS" subtitle="0 RANKED" />
        <div className="brutal-card p-6 text-center">
          <p className="display-eyebrow text-white/60">
            HEURISTIC MODEL NEEDS MORE GAMES TO SCORE
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionHeader title="MARKET PICKS" subtitle={`${picks.length} RANKED // TREND + ATS + INJURY`} />

      <ul className="border-[3px] border-white">
        {picks.map((p, idx) => (
          <li
            key={`${p.league}-${p.matchup}-${idx}`}
            className={`flex items-center gap-4 p-4 ${idx > 0 ? "border-t-[3px] border-white" : ""}`}
          >
            <span className="odds-display text-3xl sm:text-4xl text-[var(--hazard)] w-12 shrink-0">
              #{idx + 1}
            </span>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="display-eyebrow bg-white text-black px-1.5 py-0.5 text-[0.55rem]">
                  {leagueTag(p.league)}
                </span>
                {fmtGameTime(p.gameDate) && (
                  <span className="mono text-[0.65rem] text-white/50">{fmtGameTime(p.gameDate)}</span>
                )}
              </div>
              <p className="display text-white text-base leading-tight">{p.matchup.toUpperCase()}</p>
              <p className="mono text-xs text-white/70 mt-1">
                PICK <span className="text-[var(--hazard)]">{p.pickTeam.toUpperCase()}</span>
                {p.line && <span className="text-white/50"> ({p.line})</span>}
              </p>
              {p.rationaleSignals?.[0] && (
                <p className="mono text-[0.7rem] text-white/50 mt-1 line-clamp-1">
                  {p.rationaleSignals[0]}
                </p>
              )}
            </div>

            <div className="text-right shrink-0">
              <p className="display-eyebrow text-white/60 text-[0.55rem]">SCORE</p>
              <p className={`odds-display text-3xl ${p.score >= 75 ? "text-[var(--color-win)]" : p.score >= 60 ? "text-[var(--hazard)]" : "text-white"}`}>
                {p.score}
              </p>
              <p className="mono text-[0.6rem] text-white/40">CONF {p.confidence}%</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-end justify-between mb-4 pb-3 border-b-[3px] border-white">
      <h2 className="display-tight text-4xl sm:text-5xl text-white">{title}</h2>
      <span className="display-eyebrow text-[var(--hazard)]">{subtitle}</span>
    </div>
  );
}
