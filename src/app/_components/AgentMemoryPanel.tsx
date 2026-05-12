"use client";

import { useState } from "react";
import type { AgentMemorySummary } from "../_data/dashboard";

function typeColor(type: string): { fg: string; bg: string; border: string } {
  switch (type) {
    case "correction":
      return { fg: "#ff8c42", bg: "rgba(255,140,66,0.12)", border: "rgba(255,140,66,0.35)" };
    case "bias":
      return { fg: "#ff007a", bg: "rgba(255,0,122,0.12)", border: "rgba(255,0,122,0.35)" };
    case "pattern":
      return { fg: "#00d9ff", bg: "rgba(0,217,255,0.12)", border: "rgba(0,217,255,0.35)" };
    case "rule":
    default:
      return { fg: "#a855f7", bg: "rgba(168,85,247,0.12)", border: "rgba(168,85,247,0.35)" };
  }
}

function scopeBadge(scope: string): string {
  if (scope === "ALL") return "🌐 ALL";
  if (scope === "NBA") return "🏀 NBA";
  if (scope === "MLB") return "⚾ MLB";
  if (scope.startsWith("book:")) return `📚 ${scope.slice(5)}`;
  return scope;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
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

  const lastDreamLabel = data.lastDreamAt
    ? `Dream ${relativeTime(data.lastDreamAt)}`
    : "no dream yet";

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <h2 className="display-eyebrow text-violet-300">🧠 Agent Memory</h2>
        <span className="text-xs text-slate-500 mono">
          {data.totalActive} active rule{data.totalActive === 1 ? "" : "s"} · {lastDreamLabel}
          {data.lastDreamAddedRetired && (
            <span className="text-slate-600">
              {" "}· +{data.lastDreamAddedRetired.added}/−{data.lastDreamAddedRetired.retired}
            </span>
          )}
        </span>
      </div>

      <div className="glass rounded-2xl p-4 sm:p-5">
        {scopes.length > 1 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {scopes.map(s => {
              const isActive = scopeFilter === s;
              const label = s === "ALL_SCOPES" ? `all (${data.rules.length})` : `${scopeBadge(s)} (${data.byScope[s]})`;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScopeFilter(s)}
                  className={`mono text-[0.65rem] px-2 py-1 rounded-full border transition-colors ${
                    isActive
                      ? "bg-violet-400/15 border-violet-400/50 text-violet-200"
                      : "bg-white/[0.02] border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {filtered.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-6">
            No rules in this scope yet. Dream consolidates picks weekly on Mondays.
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map(r => {
              const c = typeColor(r.type);
              const isOpen = expanded === r.id;
              const weightPct = Math.round(Math.max(0, Math.min(1, r.weight)) * 100);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    aria-expanded={isOpen}
                    className="w-full text-left rounded-lg bg-white/[0.02] border border-white/5 hover:border-white/15 transition-colors p-3"
                  >
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      <span
                        className="mono text-[0.6rem] px-1.5 py-0.5 rounded uppercase tracking-wider"
                        style={{ color: c.fg, background: c.bg, border: `1px solid ${c.border}` }}
                      >
                        {r.type}
                      </span>
                      <span className="mono text-[0.6rem] text-slate-400">
                        {scopeBadge(r.scope)}
                      </span>
                      {r.isFresh && (
                        <span className="mono text-[0.6rem] text-[#22ff88] uppercase tracking-wider">
                          • new
                        </span>
                      )}
                      <span className="ml-auto mono text-[0.6rem] text-slate-500">
                        {relativeTime(r.updatedAt)}
                      </span>
                    </div>

                    <p className="text-sm text-slate-100 leading-snug mb-2">{r.rule}</p>

                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${weightPct}%`,
                            background: `linear-gradient(90deg, ${c.fg}, ${c.fg}88)`,
                          }}
                        />
                      </div>
                      <span className="mono text-[0.6rem] text-slate-500 shrink-0">
                        weight {r.weight.toFixed(2)}
                      </span>
                    </div>

                    {isOpen && (
                      <div className="mt-3 pt-3 border-t border-white/5">
                        <p className="display-eyebrow text-slate-500 text-[0.6rem] mb-1">
                          Why dream concluded this
                        </p>
                        <p className="text-xs text-slate-300 leading-relaxed">{r.reasoning}</p>
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
