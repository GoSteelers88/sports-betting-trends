// Back of the book — the injury wire, set in agate. Collapsed by default
// behind a native disclosure (no JS); the agent's get_injuries tool reads
// the same slate-scoped feed before any pick ships. No stamps — plain tags.
//
// Two bands:
//   · SLATE   — injuries for teams playing today (the variance the agent weighs)
//   · WATCH   — leaguewide context for a covered league with no slate today
//               (e.g. NFL out of season). Clearly labeled as context, not a slate.

import type { Injury, InjuryWire } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

function InjuryGrid({ byLeague }: { byLeague: Record<string, Injury[]> }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-3.5 pt-0">
      {Object.entries(byLeague).map(([league, list]) => (
        <div key={league} className="panel">
          <header
            className="px-3.5 py-2 flex items-baseline justify-between"
            style={{ borderBottom: "3px double var(--rule-strong)" }}
          >
            <span className="eyebrow" style={{ color: "var(--hold)" }}>
              {league}
            </span>
            <span className="num text-sm text-ink">{list.length}</span>
          </header>
          <ul>
            {list.map((inj, idx) => (
              <li
                key={`${inj.player}-${idx}`}
                className={`px-3.5 py-2 grid grid-cols-[1fr_auto] gap-3 items-center text-sm ${
                  idx > 0 ? "border-t border-rule" : ""
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-ink font-medium">{inj.player}</p>
                  <p className="num text-[0.65rem] text-ink-2 truncate">
                    {inj.team}
                    {inj.position ? ` · ${inj.position}` : ""}
                    {inj.injuryType ? ` · ${inj.injuryType}` : ""}
                  </p>
                </div>
                <span className="tag" style={{ color: "var(--loss)" }}>
                  {inj.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function groupByLeague(injuries: Injury[]): Record<string, Injury[]> {
  const byLeague: Record<string, Injury[]> = {};
  for (const i of injuries) (byLeague[i.league] ??= []).push(i);
  return byLeague;
}

export function VolatilityInputs({ wire }: { wire: InjuryWire }) {
  const slate = wire.injuries;
  const watch = wire.watch ?? [];
  // Nothing to show in either band → render nothing.
  if (slate.length === 0 && watch.length === 0) return null;

  const slateByLeague = groupByLeague(slate);
  const watchByLeague = groupByLeague(watch);

  const slateLabel =
    wire.slateTeamCount > 0
      ? `${wire.slateTeamCount} teams on today's slate`
      : "today's slate";

  const summaryCounts = [
    ...Object.entries(slateByLeague).map(([lg, list]) => `${list.length} ${lg}`),
    ...Object.entries(watchByLeague).map(([lg, list]) => `${list.length} ${lg} watch`),
  ].join("  ·  ");

  const totalRisks = slate.length + watch.length;

  return (
    <section className="space-y-4">
      <SectionHeader
        id="volatility-inputs"
        index="—"
        dense
        label="BACK OF BOOK · INJURY WIRE"
        title={`${totalRisks} active risks`}
        subtitle={`Injuries for teams playing today — ${slateLabel} across ${
          wire.leaguesOnSlate.join(" · ") || "no leagues live"
        }. The same slate-scoped feed the agent's get_injuries tool weighs before any pick ships.`}
        status="OUT / DOUBTFUL / IL"
        statusTone="hold"
      />

      {/* Plain-English "what we're doing" line, in the agate eyebrow voice. */}
      {wire.explainer ? (
        <p className="eyebrow text-ink-2" style={{ lineHeight: 1.5 }}>
          {wire.explainer}
        </p>
      ) : null}

      <details className="group panel-dim" open={slate.length === 0}>
        <summary className="p-3.5 cursor-pointer list-none flex items-center justify-between hover:border-rule-strong transition-colors">
          <span className="num text-sm text-ink">{summaryCounts}</span>
          <span className="eyebrow" style={{ color: "var(--hold)" }}>
            <span className="group-open:hidden">+ Expand</span>
            <span className="hidden group-open:inline">− Collapse</span>
          </span>
        </summary>

        {slate.length > 0 ? (
          <>
            <p className="eyebrow px-3.5 pt-3 pb-1" style={{ color: "var(--hold)" }}>
              On today&apos;s slate
            </p>
            <InjuryGrid byLeague={slateByLeague} />
          </>
        ) : null}

        {watch.length > 0 ? (
          <>
            <p
              className="eyebrow px-3.5 pt-3 pb-1 flex items-baseline gap-2"
              style={{ color: "var(--hold)" }}
            >
              <span>League watch</span>
              <span className="text-ink-2 normal-case tracking-normal" style={{ fontWeight: 400 }}>
                — {wire.watchLeagues.join(", ")}, no slate today · leaguewide context, not scoped
              </span>
            </p>
            <InjuryGrid byLeague={watchByLeague} />
          </>
        ) : null}
      </details>
    </section>
  );
}
