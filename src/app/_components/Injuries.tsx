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
        className="w-full glass rounded-2xl p-4 hover:bg-white/[0.06] transition-colors flex items-center justify-between"
      >
        <span className="display-eyebrow text-rose-300">⚕ Key Injuries</span>
        <span className="flex items-center gap-3">
          <span className="text-xs text-slate-400 mono">
            {Object.entries(byLeague)
              .map(([lg, list]) => `${list.length} ${lg}`)
              .join(" · ")}
          </span>
          <span className={`text-rose-200 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
        </span>
      </button>

      {open && (
        <div className="mt-2 glass rounded-2xl p-4 border border-rose-400/10">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {Object.entries(byLeague).map(([league, list]) => (
              <div key={league}>
                <p className="display-eyebrow text-rose-300 mb-2">{league} · {list.length}</p>
                <div className="space-y-1">
                  {list.map((inj, idx) => (
                    <div
                      key={`${inj.player}-${idx}`}
                      className="flex items-center justify-between rounded-md bg-white/[0.02] px-3 py-1.5 text-xs"
                    >
                      <span className="font-medium text-white truncate">{inj.player}</span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="text-slate-500 truncate max-w-[120px]">{inj.team}</span>
                        <span className="text-rose-300">{inj.status}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
