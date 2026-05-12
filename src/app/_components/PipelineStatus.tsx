"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import type { PipelineStatus as PipelineStatusData } from "../_data/dashboard";

type Stage = { key: string; label: string; count: number };

export function PipelineStatus({ data }: { data: PipelineStatusData }) {
  const rootRef = useRef<HTMLDivElement>(null);

  if (data.totalRunsLast14d === 0) return null;

  const raw = data.rawAnalystPicks14d ?? 0;
  const graderKept = data.graderKept14d ?? 0;
  const criticSurvived = Math.max(0, graderKept - (data.criticKilled14d ?? 0));
  const shipped = data.finalShipped14d ?? 0;

  const stages: Stage[] = [
    { key: "raw", label: "ANALYST_RAW", count: raw },
    { key: "grader", label: "GRADER_KEPT", count: graderKept },
    { key: "critic", label: "CRITIC_SURVIVED", count: criticSurvived },
    { key: "shipped", label: "SHIPPED", count: shipped },
  ];
  const maxCount = Math.max(...stages.map(s => s.count), 1);

  useEffect(() => {
    if (!rootRef.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = gsap.context(() => {
      const bars = rootRef.current!.querySelectorAll<HTMLElement>("[data-stage-bar]");
      const counts = rootRef.current!.querySelectorAll<HTMLElement>("[data-stage-count]");
      if (reduce) {
        bars.forEach(b => gsap.set(b, { scaleX: 1 }));
        return;
      }
      gsap.set(bars, { scaleX: 0, transformOrigin: "left center" });
      gsap.to(bars, { scaleX: 1, duration: 0.7, ease: "power3.out", stagger: 0.12 });
      counts.forEach((el, i) => {
        const parsed = Number(el.dataset.stageCount);
        const final = Number.isFinite(parsed) ? parsed : 0;
        const obj = { v: 0 };
        gsap.to(obj, {
          v: final,
          duration: 0.7,
          delay: 0.12 * i,
          ease: "power3.out",
          onUpdate: () => { el.textContent = Math.round(obj.v).toString(); },
        });
      });
    }, rootRef);
    return () => ctx.revert();
  }, []);

  return (
    <section className="relative">
      <div className="flex items-baseline justify-between mb-3">
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--rust)]">
          // AGENT_PIPELINE — LAST_14D
        </span>
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--foreground)]">
          {data.totalRunsLast14d} RUNS
        </span>
      </div>

      <div ref={rootRef} className="p-5 sm:p-6" style={{ border: "1px solid var(--rust-deep)" }}>
        {/* Radar sweep decoration */}
        <div className="relative h-0 mb-2">
          <svg viewBox="0 0 200 8" className="w-full h-2" aria-hidden="true">
            <line x1="0" y1="4" x2="200" y2="4" stroke="var(--rust-deep)" strokeDasharray="3 5" />
          </svg>
        </div>

        <div className="space-y-2">
          {stages.map((s, i) => {
            const widthPct = (s.count / maxCount) * 100;
            const prev = i === 0 ? null : stages[i - 1].count;
            const survival = prev === null || prev === 0 ? null : Math.round((s.count / prev) * 100);
            return (
              <div key={s.key} className="grid grid-cols-[140px_1fr_auto] sm:grid-cols-[180px_1fr_auto] items-center gap-3">
                <span className="var-mono text-[0.65rem] uppercase tracking-[0.2em] text-[var(--concrete-light)]">
                  {s.label}
                </span>
                <div className="relative h-7 bg-[var(--concrete-dark)]/60">
                  <div
                    data-stage-bar
                    className="absolute inset-y-0 left-0"
                    style={{ width: `${Math.max(widthPct, 1)}%`, background: "var(--rust)" }}
                  />
                  <span
                    data-stage-count
                    data-stage-count={s.count}
                    className="var-display absolute inset-y-0 left-2 flex items-center text-base sm:text-lg"
                    style={{ color: "var(--foreground)", ["--wght" as string]: "800" }}
                  >
                    {s.count}
                  </span>
                </div>
                <span className="var-mono text-[0.65rem] uppercase tracking-wider text-[var(--rust)] w-16 text-right">
                  {survival !== null ? `${survival}%` : "—"}
                </span>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4 mt-6 pt-5" style={{ borderTop: "1px dashed var(--rust-deep)" }}>
          <Cell label="KILL_RATE" value={data.killRatePct !== null ? `${data.killRatePct}%` : "—"} hot={data.killRatePct !== null && data.killRatePct >= 25} />
          <Cell label="BANKROLL_CUT" value={`${data.bankrollDropped14d}`} />
          <Cell
            label="AVG_CLV"
            value={data.avgClvCents !== null ? `${data.avgClvCents > 0 ? "+" : ""}${data.avgClvCents}¢` : "—"}
            hot={data.avgClvCents !== null && data.avgClvCents > 0}
            cold={data.avgClvCents !== null && data.avgClvCents < 0}
          />
          <Cell
            label={data.parseFailedRuns14d > 0 ? "PARSE_FAIL" : "PARSE_OK"}
            value={data.parseFailedRuns14d > 0 ? String(data.parseFailedRuns14d) : "✓"}
            cold={data.parseFailedRuns14d > 0}
          />
        </div>
      </div>
    </section>
  );
}

function Cell({
  label,
  value,
  hot,
  cold,
}: {
  label: string;
  value: string;
  hot?: boolean;
  cold?: boolean;
}) {
  const color = hot ? "var(--rust-flash)" : cold ? "var(--cold)" : "var(--foreground)";
  const weight = hot ? 800 : cold ? 300 : 500;
  return (
    <div>
      <p className="var-mono text-[0.6rem] uppercase tracking-[0.3em] text-[var(--concrete)]">
        {label}
      </p>
      <p
        className="var-display text-2xl sm:text-3xl mt-1"
        style={{ color, ["--wght" as string]: String(weight) }}
      >
        {value}
      </p>
    </div>
  );
}
