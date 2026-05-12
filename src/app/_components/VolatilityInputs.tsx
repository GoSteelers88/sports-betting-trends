"use client";

import { useState } from "react";
import type { Injury } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

export function VolatilityInputs({ injuries }: { injuries: Injury[] }) {
  const [open, setOpen] = useState(false);
  if (injuries.length === 0) return null;

  const byLeague: Record<string, Injury[]> = {};
  for (const i of injuries) (byLeague[i.league] ??= []).push(i);

  return (
    <section className="space-y-4">
      <SectionHeader
        id="volatility-inputs"
        index="09"
        label="VOLATILITY INPUTS"
        title={`${injuries.length} ACTIVE RISKS`}
        subtitle="Injury and lineup signals fed into the agent's get_injuries tool. These are the variance vectors the model accounts for before issuing a pick."
        status={open ? "EXPANDED" : "COLLAPSED"}
        statusColor="warn"
      />

      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full surface p-4 flex items-center justify-between text-left hover:border-[var(--border-strong)]"
      >
        <span className="font-mono text-sm">
          {Object.entries(byLeague)
            .map(([lg, list]) => `${list.length} ${lg}`)
            .join("  ·  ")}
        </span>
        <span className="eyebrow text-[var(--warn)]">{open ? "− COLLAPSE" : "+ EXPAND"}</span>
      </button>

      {open && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Object.entries(byLeague).map(([league, list]) => (
            <div key={league} className="surface">
              <header className="px-4 py-2.5 border-b border-[var(--border)] flex items-baseline justify-between">
                <span className="eyebrow text-[var(--warn)]">{league}</span>
                <span className="numeric text-sm text-[var(--text)]">{list.length}</span>
              </header>
              <ul className="divide-y divide-[var(--border)]">
                {list.map((inj, idx) => (
                  <li
                    key={`${inj.player}-${idx}`}
                    className="px-4 py-2 grid grid-cols-[1fr_auto] gap-3 items-center text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-display font-semibold truncate text-[var(--text)]">
                        {inj.player}
                      </p>
                      <p className="font-mono text-[0.65rem] text-[var(--muted)] truncate">
                        {inj.team}{inj.position ? ` · ${inj.position}` : ""}
                      </p>
                    </div>
                    <span
                      className="pill"
                      style={{ color: "var(--kill)", borderColor: "var(--kill)" }}
                    >
                      {inj.status.toUpperCase()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
