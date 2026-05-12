"use client";

import { useState } from "react";
import type { Injury } from "../_data/dashboard";

export function Injuries({ injuries }: { injuries: Injury[] }) {
  const [open, setOpen] = useState(false);

  if (injuries.length === 0) return null;

  const byLeague: Record<string, Injury[]> = {};
  for (const i of injuries) (byLeague[i.league] ??= []).push(i);

  return (
    <section>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full brutal-card p-4 flex items-center justify-between text-left hover:bg-white hover:text-black transition-colors"
      >
        <span className="display-tight text-2xl sm:text-3xl">⚠ KEY INJURIES</span>
        <span className="flex items-center gap-3">
          <span className="mono text-xs">
            {Object.entries(byLeague)
              .map(([lg, list]) => `${list.length} ${lg}`)
              .join(" // ")}
          </span>
          <span className={`display text-xl transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
        </span>
      </button>

      {open && (
        <div className="mt-3 brutal-card p-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {Object.entries(byLeague).map(([league, list]) => (
              <div key={league}>
                <p className="display-eyebrow text-[var(--hazard)] mb-3 pb-2 border-b-[3px] border-white">
                  {league} // {list.length}
                </p>
                <ul className="space-y-0 border-[3px] border-white">
                  {list.map((inj, idx) => (
                    <li
                      key={`${inj.player}-${idx}`}
                      className={`flex items-center justify-between gap-3 px-3 py-2 ${idx > 0 ? "border-t-[3px] border-white" : ""}`}
                    >
                      <span className="display text-sm text-white truncate">{inj.player.toUpperCase()}</span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="mono text-[0.65rem] text-white/50 truncate max-w-[100px]">
                          {inj.team}
                        </span>
                        <span className="display-eyebrow text-[var(--color-loss)] text-[0.6rem]">
                          {inj.status.toUpperCase()}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
