"use client";

import { useState } from "react";
import type { AgentMemorySummary } from "../_data/dashboard";

function scopeBadge(scope: string): string {
  if (scope === "ALL") return "ALL";
  if (scope.startsWith("book:")) return scope.slice(5).toUpperCase();
  return scope.toUpperCase();
}

function rel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "NOW";
  if (h < 24) return `${h}H`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}D`;
  return `${Math.floor(d / 7)}W`;
}

export function AgentMemoryPanel({ data }: { data: AgentMemorySummary }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [scope, setScope] = useState<string>("ALL_SCOPES");
  if (data.totalActive === 0 && data.lastDreamAt === null) return null;
  const filtered = scope === "ALL_SCOPES" ? data.rules : data.rules.filter(r => r.scope === scope);
  const scopes = ["ALL_SCOPES", ...Object.keys(data.byScope).sort()];

  return (
    <section className="relative">
      <div className="flex items-baseline justify-between mb-3">
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--rust)]">
          // AGENT_MEMORY
        </span>
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--foreground)]">
          {data.totalActive} RULES
          {data.lastDreamAt && <> ▸ DREAM_{rel(data.lastDreamAt)}</>}
        </span>
      </div>

      <div className="p-5 sm:p-6" style={{ border: "1px solid var(--rust-deep)" }}>
        {data.lastDreamNotes && (
          <div
            className="mb-5 p-4"
            style={{
              background: "var(--rust-deep)",
              borderLeft: "4px solid var(--rust-flash)",
              color: "var(--foreground)",
            }}
          >
            <p className="var-mono text-[0.65rem] uppercase tracking-[0.3em] mb-2" style={{ color: "var(--rust-flash)" }}>
              ▸ DREAM_TRANSCRIPT // REVIEWED {data.lastDreamPicksReviewed ?? 0} PICKS
              {data.lastDreamAddedRetired && (
                <> ▸ +{data.lastDreamAddedRetired.added} / −{data.lastDreamAddedRetired.retired}</>
              )}
            </p>
            <p className="var-mono text-xs leading-relaxed">{data.lastDreamNotes}</p>
          </div>
        )}

        {scopes.length > 1 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {scopes.map(s => {
              const active = scope === s;
              const label = s === "ALL_SCOPES" ? `ALL [${data.rules.length}]` : `${scopeBadge(s)} [${data.byScope[s]}]`;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className="bare var-mono text-[0.65rem] uppercase tracking-[0.2em] px-2 py-1"
                  style={{
                    color: active ? "var(--background)" : "var(--concrete-light)",
                    background: active ? "var(--rust)" : "transparent",
                    border: `1px solid ${active ? "var(--rust)" : "var(--concrete-dark)"}`,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {filtered.length === 0 ? (
          <p className="var-mono text-xs uppercase tracking-wider text-[var(--concrete)] text-center py-6">
            ▸ NO RULES IN SCOPE // DREAM RUNS MON 06:00 UTC
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map(r => {
              const isOpen = expanded === r.id;
              const weightPct = Math.round(Math.max(0, Math.min(1, r.weight)) * 100);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    aria-expanded={isOpen}
                    className="bare w-full text-left p-3"
                    style={{
                      borderLeft: `3px solid ${r.isFresh ? "var(--rust-flash)" : "var(--concrete-dark)"}`,
                      background: isOpen ? "var(--concrete-dark)" : "transparent",
                    }}
                  >
                    <div className="flex items-center gap-2 flex-wrap mb-2 var-mono text-[0.6rem] uppercase tracking-[0.2em]">
                      <span style={{ color: "var(--rust)" }}>[{r.type}]</span>
                      <span style={{ color: "var(--concrete-light)" }}>{scopeBadge(r.scope)}</span>
                      {r.isFresh && <span style={{ color: "var(--rust-flash)" }}>NEW</span>}
                      <span className="ml-auto" style={{ color: "var(--concrete)" }}>
                        {rel(r.updatedAt)}
                      </span>
                    </div>
                    <p
                      className="var-display text-base leading-snug mb-2"
                      style={{ color: "var(--foreground)", ["--wght" as string]: "500", textTransform: "none" }}
                    >
                      {r.rule}
                    </p>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-1 bg-[var(--concrete-dark)]">
                        <div className="h-full" style={{ width: `${weightPct}%`, background: "var(--rust)" }} />
                      </div>
                      <span className="var-mono text-[0.6rem] uppercase tracking-wider text-[var(--concrete-light)]">
                        W={r.weight.toFixed(2)}
                      </span>
                    </div>
                    {isOpen && (
                      <p className="mt-3 var-mono text-[0.7rem] leading-relaxed text-[var(--concrete-light)]">
                        ▸ {r.reasoning}
                      </p>
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
