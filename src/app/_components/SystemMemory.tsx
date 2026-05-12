"use client";

import { useState } from "react";
import type { AgentMemorySummary } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

function rel(iso: string): string {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (h < 1) return "NOW";
  if (h < 24) return `${h}H`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}D`;
  return `${Math.floor(d / 7)}W`;
}

function ruleImpact(type: string, weight: number): { label: string; color: string } {
  const w = Math.round(weight * 100);
  if (type === "correction") return { label: "BLOCKS BLIND FOLLOW", color: "var(--warn)" };
  if (type === "bias") return { label: "ACTIVE CONSTRAINT", color: "var(--kill)" };
  if (type === "pattern") return { label: `WEIGHT ${w}`, color: "var(--signal)" };
  return { label: `WEIGHT ${w}`, color: "var(--edge)" };
}

export function SystemMemory({ data }: { data: AgentMemorySummary }) {
  const [scope, setScope] = useState("ALL_SCOPES");
  const [openId, setOpenId] = useState<number | null>(null);

  if (data.totalActive === 0 && data.lastDreamAt === null) return null;

  const filtered =
    scope === "ALL_SCOPES" ? data.rules : data.rules.filter(r => r.scope === scope);
  const scopes = ["ALL_SCOPES", ...Object.keys(data.byScope).sort()];

  return (
    <section className="space-y-4">
      <SectionHeader
        id="system-memory"
        index="08"
        label="SYSTEM MEMORY"
        title={`${data.totalActive} ACTIVE RULES`}
        subtitle="Living constraints written by the weekly Dream agent. The system is self-correcting — when picks fail in predictable ways, new rules block the analyst from repeating them."
        status={data.lastDreamAt ? `DREAM ${rel(data.lastDreamAt)}` : "NO DREAM YET"}
        statusColor="signal"
      />

      {data.lastDreamNotes && (
        <div className="surface-signal p-4">
          <p className="eyebrow text-[var(--signal)] mb-1.5">
            DREAM TRANSCRIPT
            {data.lastDreamPicksReviewed !== null && (
              <> · REVIEWED {data.lastDreamPicksReviewed} PICKS</>
            )}
            {data.lastDreamAddedRetired && (
              <> · +{data.lastDreamAddedRetired.added}/−{data.lastDreamAddedRetired.retired}</>
            )}
          </p>
          <p className="text-sm text-[var(--text)] leading-relaxed">{data.lastDreamNotes}</p>
        </div>
      )}

      {scopes.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {scopes.map(s => {
            const active = scope === s;
            const label =
              s === "ALL_SCOPES" ? `ALL (${data.rules.length})` : `${s} (${data.byScope[s]})`;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`eyebrow px-2 py-1 border transition-colors ${
                  active
                    ? "border-[var(--text)] text-[var(--text)] bg-white/5"
                    : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="surface p-6 text-center">
          <p className="eyebrow text-[var(--muted)]">NO RULES IN SCOPE</p>
        </div>
      ) : (
        <ul className="surface divide-y divide-[var(--border)]">
          {filtered.map(r => {
            const isOpen = openId === r.id;
            const impact = ruleImpact(r.type, r.weight);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : r.id)}
                  aria-expanded={isOpen}
                  className="w-full text-left p-4 hover:bg-white/[0.02]"
                >
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span
                      className="pill"
                      style={{ color: impact.color, borderColor: impact.color }}
                    >
                      {r.type.toUpperCase()}
                    </span>
                    <span className="pill" style={{ color: "var(--muted)", borderColor: "var(--border-strong)" }}>
                      {r.scope}
                    </span>
                    {r.isFresh && (
                      <span className="pill" style={{ color: "var(--edge)", borderColor: "var(--edge)" }}>
                        NEW
                      </span>
                    )}
                    <span className="ml-auto eyebrow text-[var(--muted)]">
                      {impact.label} · UPDATED {rel(r.updatedAt)}
                    </span>
                  </div>
                  <p className="font-display text-base font-semibold leading-snug text-[var(--text)]">
                    {r.rule}
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="flex-1 meter">
                      <div
                        className="meter-fill"
                        style={{ width: `${Math.round(r.weight * 100)}%`, background: impact.color }}
                      />
                    </div>
                    <span className="numeric text-xs text-[var(--muted)]">
                      W={r.weight.toFixed(2)}
                    </span>
                  </div>
                  {isOpen && (
                    <p className="mt-3 pt-3 border-t border-[var(--border)] text-sm text-[var(--muted)] leading-relaxed">
                      <span className="eyebrow text-[var(--signal)]">DREAM REASONING ▸ </span>
                      {r.reasoning}
                    </p>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
