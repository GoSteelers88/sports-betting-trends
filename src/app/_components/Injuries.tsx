"use client";

import { useState } from "react";
import type { Injury } from "../_data/dashboard";

export function Injuries({ injuries }: { injuries: Injury[] }) {
  const [open, setOpen] = useState(false);
  if (injuries.length === 0) return null;
  const byLeague: Record<string, Injury[]> = {};
  for (const i of injuries) (byLeague[i.league] ??= []).push(i);

  return (
    <section className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="bare w-full flex items-center justify-between py-3"
        style={{ borderTop: "1px solid var(--rust-deep)", borderBottom: "1px solid var(--rust-deep)" }}
      >
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em]" style={{ color: "var(--rust)" }}>
          // INJURY_FEED
        </span>
        <span className="flex items-center gap-3 var-mono text-[0.7rem] uppercase tracking-wider" style={{ color: "var(--concrete-light)" }}>
          {Object.entries(byLeague).map(([lg, list]) => `${list.length} ${lg}`).join(" // ")}
          <span style={{ color: "var(--rust)" }}>{open ? "−" : "+"}</span>
        </span>
      </button>

      {open && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 py-3">
          {Object.entries(byLeague).map(([league, list]) => (
            <div key={league}>
              <p className="var-mono text-[0.65rem] uppercase tracking-[0.3em] mb-2" style={{ color: "var(--rust)" }}>
                ▸ {league} [{list.length}]
              </p>
              <ul className="space-y-0.5">
                {list.map((inj, idx) => (
                  <li
                    key={`${inj.player}-${idx}`}
                    className="flex items-center justify-between gap-2 py-0.5 var-mono text-[0.7rem] uppercase tracking-wider"
                    style={{ color: "var(--concrete-light)" }}
                  >
                    <span className="truncate" style={{ color: "var(--foreground)" }}>{inj.player}</span>
                    <span style={{ color: "var(--rust)" }}>{inj.status}</span>
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
