"use client";

// Back of the book — house rules. Constraints the weekly Dream agent writes
// into the desk's rulebook, set in agate: dense, small type, no stamps.
// Each rule is a numbered clause; click to read the Dream's reasoning.

import { useState } from "react";
import type { AgentMemoryRule, AgentMemorySummary } from "../_data/dashboard";
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
  const fresh = filtered.filter(r => r.isFresh);
  const rest = filtered.filter(r => !r.isFresh);
  const scopes = ["ALL_SCOPES", ...Object.keys(data.byScope).sort()];

  return (
    <section className="receipts-section space-y-5">
      <SectionHeader
        id="system-memory"
        label={`${data.totalActive} ACTIVE · WRITTEN BY THE WEEKLY DREAM`}
        title="STANDING RULES"
        subtitle="Living constraints written by the weekly Dream agent. When picks fail in predictable ways, a new clause blocks the analyst from repeating the mistake."
        status={data.lastDreamAt ? `Dream ${rel(data.lastDreamAt)}` : "No dream yet"}
        statusTone="blue"
      />

      {/* The operator's weekly memo — folded; the summary carries the news. */}
      {data.lastDreamNotes && (
        <details className="group panel" style={{ borderLeft: "3px solid var(--blue)" }}>
          <summary className="px-4 py-2.5 cursor-pointer list-none flex items-baseline justify-between gap-3 hover:bg-paper-3/60 transition-colors">
            <span className="eyebrow" style={{ color: "var(--blue)" }}>
              Dream transcript
              {data.lastDreamPicksReviewed !== null && (
                <> · reviewed {data.lastDreamPicksReviewed} picks</>
              )}
              {data.lastDreamAddedRetired && (
                <>
                  {" "}· +{data.lastDreamAddedRetired.added}/−{data.lastDreamAddedRetired.retired} rules
                </>
              )}
            </span>
            <span className="eyebrow text-ink-3 group-open:hidden">+ Unfold</span>
            <span className="eyebrow text-ink-3 hidden group-open:inline">− Fold</span>
          </summary>
          <blockquote className="prose px-4 pb-4 pt-1">{data.lastDreamNotes}</blockquote>
        </details>
      )}

      {scopes.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {scopes.map(s => {
            const active = scope === s;
            // "ALL" is a real scope (rules for every league); the first chip
            // is the unfiltered view and must not share its name.
            const label =
              s === "ALL_SCOPES" ? `EVERY SCOPE (${data.rules.length})` : `${s} (${data.byScope[s]})`;
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
        <>
          {/* Two folds, both counted in their summaries: this week's new
              rules, then the standing body. A four-character weight says
              what the bar said. */}
          {fresh.length > 0 && (
            <details className="group panel">
              <summary className="px-4 py-2.5 cursor-pointer list-none flex items-baseline justify-between gap-3 hover:bg-paper-3/60 transition-colors">
                <span className="eyebrow">
                  <span style={{ color: "var(--win)" }}>{fresh.length} new</span>{" "}
                  {fresh.length === 1 ? "rule" : "rules"} this fortnight
                </span>
                <span className="eyebrow text-ink-3 group-open:hidden">+ Unfold</span>
                <span className="eyebrow text-ink-3 hidden group-open:inline">− Fold</span>
              </summary>
              <ol className="border-t border-rule">
                {fresh.map((r, i) => (
                  <RuleRow key={r.id} r={r} n={i + 1} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} />
                ))}
              </ol>
            </details>
          )}
          {rest.length > 0 && (
            <details className="group panel">
              <summary className="px-4 py-2.5 cursor-pointer list-none flex items-baseline justify-between gap-3 hover:bg-paper-3/60 transition-colors">
                <span className="eyebrow">
                  {rest.length} standing {rest.length === 1 ? "rule" : "rules"}
                  {fresh.length > 0 ? ` beyond the ${fresh.length} new` : ""}
                </span>
                <span className="eyebrow text-ink-3 group-open:hidden">+ Unfold</span>
                <span className="eyebrow text-ink-3 hidden group-open:inline">− Fold</span>
              </summary>
              <ol className="border-t border-rule">
                {rest.map((r, i) => (
                  <RuleRow key={r.id} r={r} n={fresh.length + i + 1} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} />
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function RuleRow({
  r,
  n,
  open,
  onToggle,
}: {
  r: AgentMemoryRule;
  n: number;
  open: boolean;
  onToggle: () => void;
}) {
  const impact = ruleImpact(r.type, r.weight);
  return (
    <li className={n > 1 ? "border-t border-rule" : ""}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full text-left px-4 py-2.5 hover:bg-paper-3/60 transition-colors"
      >
        <p className="eyebrow text-ink-3 flex flex-wrap gap-x-2 gap-y-0.5">
          <span className="num">§{String(n).padStart(2, "0")}</span>
          <span style={{ color: impact.tone }}>{r.type}</span>
          <span>{r.scope}</span>
          {r.isFresh && <span style={{ color: "var(--win)" }}>New</span>}
          <span className="num">w {r.weight.toFixed(2)}</span>
          <span>updated {rel(r.updatedAt)}</span>
        </p>
        <p className="prose mt-1" style={{ fontSize: "0.875rem" }}>
          {r.rule}
        </p>
        {open && (
          <p className="prose mt-2 pt-2 border-t border-rule" style={{ fontSize: "0.875rem" }}>
            <span className="eyebrow mr-2" style={{ color: "var(--blue)" }}>
              Dream reasoning ▸
            </span>
            {r.reasoning}
          </p>
        )}
      </button>
    </li>
  );
}
