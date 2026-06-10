"use client";

// Back of the book — house rules. Constraints the weekly Dream agent writes
// into the desk's rulebook, set in agate: dense, small type, no stamps.
// Each rule is a numbered clause; click to read the Dream's reasoning.

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

function ruleImpact(type: string, weight: number): { label: string; tone: string } {
  const w = Math.round(weight * 100);
  if (type === "correction") return { label: "BLOCKS BLIND FOLLOW", tone: "var(--hold)" };
  if (type === "bias") return { label: "ACTIVE CONSTRAINT", tone: "var(--loss)" };
  if (type === "pattern") return { label: `WEIGHT ${w}`, tone: "var(--blue)" };
  return { label: `WEIGHT ${w}`, tone: "var(--win)" };
}

export function SystemMemory({ data }: { data: AgentMemorySummary }) {
  const [scope, setScope] = useState("ALL_SCOPES");
  const [openId, setOpenId] = useState<number | null>(null);

  if (data.totalActive === 0 && data.lastDreamAt === null) return null;

  const filtered =
    scope === "ALL_SCOPES" ? data.rules : data.rules.filter(r => r.scope === scope);
  const scopes = ["ALL_SCOPES", ...Object.keys(data.byScope).sort()];

  return (
    <section className="space-y-5">
      <SectionHeader
        id="system-memory"
        index="—"
        dense
        label="BACK OF BOOK · HOUSE RULES"
        title={`${data.totalActive} standing rules`}
        subtitle="Living constraints written by the weekly Dream agent. When picks fail in predictable ways, a new clause blocks the analyst from repeating the mistake."
        status={data.lastDreamAt ? `Dream ${rel(data.lastDreamAt)}` : "No dream yet"}
        statusTone="blue"
      />

      {data.lastDreamNotes && (
        <figure className="panel p-4" style={{ borderLeft: "3px solid var(--blue)" }}>
          <figcaption className="eyebrow mb-2" style={{ color: "var(--blue)" }}>
            Dream transcript
            {data.lastDreamPicksReviewed !== null && (
              <> · reviewed {data.lastDreamPicksReviewed} picks</>
            )}
            {data.lastDreamAddedRetired && (
              <>
                {" "}· +{data.lastDreamAddedRetired.added}/−{data.lastDreamAddedRetired.retired} rules
              </>
            )}
          </figcaption>
          <blockquote className="deck text-sm sm:text-base text-ink leading-relaxed">
            {data.lastDreamNotes}
          </blockquote>
        </figure>
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
                aria-pressed={active}
                className={`eyebrow px-2 py-1 border transition-colors ${
                  active
                    ? "border-rule-strong text-ink bg-paper-2"
                    : "border-rule text-ink-3 hover:text-ink"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="tag text-ink-3">No rules in this scope</p>
      ) : (
        <ol className="panel">
          {filtered.map((r, i) => {
            const isOpen = openId === r.id;
            const impact = ruleImpact(r.type, r.weight);
            return (
              <li key={r.id} className={i > 0 ? "border-t border-rule" : ""}>
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : r.id)}
                  aria-expanded={isOpen}
                  className="w-full text-left p-3.5 hover:bg-paper-3/60 transition-colors"
                >
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="num text-xs text-ink-3">
                      §{String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="tag" style={{ color: impact.tone }}>
                      {r.type}
                    </span>
                    <span className="eyebrow text-ink-3">{r.scope}</span>
                    {r.isFresh && (
                      <span className="tag" style={{ color: "var(--win)" }}>
                        New
                      </span>
                    )}
                    <span className="ml-auto eyebrow text-ink-3">
                      {impact.label} · updated {rel(r.updatedAt)}
                    </span>
                  </div>
                  <p className="font-display font-semibold text-base leading-snug text-ink">
                    {r.rule}
                  </p>
                  <div className="mt-2.5 flex items-center gap-3">
                    <div className="flex-1 meter" style={{ height: 3 }}>
                      <div
                        className="meter-fill"
                        style={{ width: `${Math.round(r.weight * 100)}%`, background: impact.tone }}
                      />
                    </div>
                    <span className="num text-xs text-ink-2">w={r.weight.toFixed(2)}</span>
                  </div>
                  {isOpen && (
                    <p className="mt-3 pt-3 border-t border-rule text-sm text-ink-2 leading-relaxed">
                      <span className="eyebrow mr-2" style={{ color: "var(--blue)" }}>
                        Dream reasoning ▸
                      </span>
                      {r.reasoning}
                    </p>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
