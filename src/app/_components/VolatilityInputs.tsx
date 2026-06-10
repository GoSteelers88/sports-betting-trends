// Back of the book — the injury wire, set in agate. Collapsed by default
// behind a native disclosure (no JS); the agent's get_injuries tool reads
// the same feed before any pick ships. No stamps — plain tags only.

import type { Injury } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

export function VolatilityInputs({ injuries }: { injuries: Injury[] }) {
  if (injuries.length === 0) return null;

  const byLeague: Record<string, Injury[]> = {};
  for (const i of injuries) (byLeague[i.league] ??= []).push(i);

  return (
    <section className="space-y-4">
      <SectionHeader
        id="volatility-inputs"
        index="—"
        dense
        label="BACK OF BOOK · INJURY WIRE"
        title={`${injuries.length} active risks`}
        subtitle="Injury and lineup signals fed into the agent's get_injuries tool — the variance vectors weighed before any pick ships."
        status="OUT / DOUBTFUL only"
        statusTone="hold"
      />

      <details className="group panel-dim">
        <summary className="p-3.5 cursor-pointer list-none flex items-center justify-between hover:border-rule-strong transition-colors">
          <span className="num text-sm text-ink">
            {Object.entries(byLeague)
              .map(([lg, list]) => `${list.length} ${lg}`)
              .join("  ·  ")}
          </span>
          <span className="eyebrow" style={{ color: "var(--hold)" }}>
            <span className="group-open:hidden">+ Expand</span>
            <span className="hidden group-open:inline">− Collapse</span>
          </span>
        </summary>

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
      </details>
    </section>
  );
}
