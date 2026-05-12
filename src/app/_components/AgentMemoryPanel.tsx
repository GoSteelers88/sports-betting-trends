"use client";

import { useState } from "react";
import type { AgentMemorySummary } from "../_data/dashboard";

function scopeBadge(scope: string): string {
  if (scope === "ALL") return "ALL";
  if (scope === "NBA") return "NBA";
  if (scope === "MLB") return "MLB";
  if (scope.startsWith("book:")) return scope.slice(5).toUpperCase();
  return scope.toUpperCase();
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "NOW";
  if (hours < 24) return `${hours}H`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}D`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}W`;
  return new Date(iso).toLocaleDateString();
}

export function AgentMemoryPanel({ data }: { data: AgentMemorySummary }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [scopeFilter, setScopeFilter] = useState<string>("ALL_SCOPES");

  if (data.totalActive === 0 && data.lastDreamAt === null) return null;

  const filtered =
    scopeFilter === "ALL_SCOPES"
      ? data.rules
      : data.rules.filter(r => r.scope === scopeFilter);
  const scopes = ["ALL_SCOPES", ...Object.keys(data.byScope).sort()];

  return (
    <section>
      <div className="flex items-end justify-between mb-4 pb-3 border-b-[3px] border-white">
        <h2 className="display-tight text-4xl sm:text-5xl text-white">AGENT MEMORY</h2>
        <span className="display-eyebrow text-[var(--hazard)] text-right">
          {data.totalActive} ACTIVE RULE{data.totalActive === 1 ? "" : "S"}
          {data.lastDreamAt && (
            <> {" // "} DREAM {relativeTime(data.lastDreamAt)}</>
          )}
          {data.lastDreamAddedRetired && (
            <> {" // "} +{data.lastDreamAddedRetired.added}/−{data.lastDreamAddedRetired.retired}</>
          )}
        </span>
      </div>

      <div className="brutal-card p-5 sm:p-6">
        {data.lastDreamNotes && (
          <div className="mb-5 brutal-fill-hazard p-4">
            <p className="display-eyebrow text-black mb-2">
              WHAT DREAM LEARNED
              {data.lastDreamPicksReviewed !== null && (
                <> {" // "} REVIEWED {data.lastDreamPicksReviewed} PICK{data.lastDreamPicksReviewed === 1 ? "" : "S"}</>
              )}
            </p>
            <p className="mono text-sm text-black leading-relaxed">{data.lastDreamNotes}</p>
          </div>
        )}

        {scopes.length > 1 && (
          <div className="flex flex-wrap gap-0 mb-4 border-[3px] border-white">
            {scopes.map((s, i) => {
              const isActive = scopeFilter === s;
              const label = s === "ALL_SCOPES" ? `ALL (${data.rules.length})` : `${scopeBadge(s)} (${data.byScope[s]})`;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScopeFilter(s)}
                  className={`display-eyebrow text-[0.65rem] px-3 py-2 border-r-[3px] border-white last:border-r-0 ${
                    isActive ? "bg-[var(--hazard)] text-black" : "bg-black text-white hover:bg-white hover:text-black"
                  } ${i === scopes.length - 1 ? "border-r-0" : ""}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {filtered.length === 0 ? (
          <p className="display text-center text-white/60 py-6">
            NO RULES IN THIS SCOPE. DREAM RUNS MONDAYS 06:00 UTC.
          </p>
        ) : (
          <ul className="space-y-0 border-[3px] border-white">
            {filtered.map((r, idx) => {
              const isOpen = expanded === r.id;
              const weightPct = Math.round(Math.max(0, Math.min(1, r.weight)) * 100);
              return (
                <li key={r.id} className={idx > 0 ? "border-t-[3px] border-white" : ""}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    aria-expanded={isOpen}
                    className="w-full text-left p-4 hover:bg-white/5"
                  >
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <span className="display-eyebrow bg-white text-black px-2 py-0.5 text-[0.6rem]">
                        {r.type.toUpperCase()}
                      </span>
                      <span className="display-eyebrow text-white text-[0.6rem]">{scopeBadge(r.scope)}</span>
                      {r.isFresh && (
                        <span className="display-eyebrow bg-[var(--hazard)] text-black px-1.5 py-0.5 text-[0.55rem]">
                          NEW
                        </span>
                      )}
                      <span className="ml-auto mono text-[0.6rem] text-white/50">{relativeTime(r.updatedAt)}</span>
                    </div>

                    <p className="display text-white text-base leading-snug mb-3">{r.rule}</p>

                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-2 bg-black border-[2px] border-white">
                        <div
                          className="h-full bg-[var(--hazard)]"
                          style={{ width: `${weightPct}%` }}
                        />
                      </div>
                      <span className="mono text-[0.6rem] text-white shrink-0">
                        W {r.weight.toFixed(2)}
                      </span>
                    </div>

                    {isOpen && (
                      <div className="mt-4 pt-4 border-t-[3px] border-white">
                        <p className="display-eyebrow text-[var(--hazard)] mb-2">WHY DREAM CONCLUDED THIS</p>
                        <p className="mono text-xs text-white leading-relaxed">{r.reasoning}</p>
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
