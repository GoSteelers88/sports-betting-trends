"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import type { PipelineStatus as PipelineStatusData } from "../_data/dashboard";

type Stage = { key: string; label: string; count: number; hint: string };

export function PipelineStatus({ data }: { data: PipelineStatusData }) {
  const rootRef = useRef<HTMLDivElement>(null);

  if (data.totalRunsLast14d === 0) return null;

  const raw = data.rawAnalystPicks14d ?? 0;
  const graderKept = data.graderKept14d ?? 0;
  const criticSurvived = Math.max(0, graderKept - (data.criticKilled14d ?? 0));
  const shipped = data.finalShipped14d ?? 0;

  const stages: Stage[] = [
    { key: "raw", label: "ANALYST RAW", count: raw, hint: "LLM PROPOSED" },
    { key: "grader", label: "GRADER KEPT", count: graderKept, hint: "≥6% EDGE" },
    { key: "critic", label: "CRITIC SURVIVED", count: criticSurvived, hint: "DEVIL'S ADVOCATE" },
    { key: "shipped", label: "SHIPPED", count: shipped, hint: "TO DB + DISCORD" },
  ];
  const maxCount = Math.max(...stages.map(s => s.count), 1);

  useEffect(() => {
    if (!rootRef.current) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = gsap.context(() => {
      const bars = rootRef.current!.querySelectorAll<HTMLElement>("[data-stage-bar]");
      const counts = rootRef.current!.querySelectorAll<HTMLElement>("[data-stage-count]");
      if (reduceMotion) {
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

  const killRatePct = data.killRatePct;
  const avgClv = data.avgClvCents;

  return (
    <section ref={rootRef} className="brutal-card p-5 sm:p-6">
      <div className="flex items-center justify-between mb-5 pb-4 border-b-[3px] border-white">
        <span className="display text-2xl sm:text-3xl text-white">AGENT PIPELINE</span>
        <span className="mono text-xs text-white/60">LAST 14D · {data.totalRunsLast14d} RUNS</span>
      </div>

      <div className="space-y-3">
        {stages.map((s, i) => {
          const widthPct = (s.count / maxCount) * 100;
          const prev = i === 0 ? null : stages[i - 1].count;
          const survivalPct = prev === null || prev === 0 ? null : Math.round((s.count / prev) * 100);
          return (
            <div key={s.key} className="flex items-stretch gap-3">
              <div className="w-32 sm:w-40 shrink-0 flex flex-col justify-center">
                <p className="display text-[0.7rem] text-white leading-tight">{s.label}</p>
                <p className="mono text-[0.6rem] text-white/40 mt-0.5">{s.hint}</p>
              </div>

              <div className="flex-1 relative h-14 border-[3px] border-white bg-black">
                <div
                  data-stage-bar
                  className="absolute inset-y-0 left-0 bg-[var(--hazard)]"
                  style={{ width: `${Math.max(widthPct, 1)}%` }}
                />
                <div className="absolute inset-0 flex items-center justify-between px-4">
                  <span
                    data-stage-count
                    data-stage-count={s.count}
                    className="odds-display text-2xl sm:text-3xl text-black mix-blend-difference"
                  >
                    {s.count}
                  </span>
                  {survivalPct !== null && (
                    <span className="display-eyebrow text-black bg-white px-1.5 py-0.5 text-[0.6rem] mix-blend-difference">
                      {survivalPct}% KEPT
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border-[3px] border-white mt-6">
        <Cell
          label="KILL RATE"
          value={killRatePct !== null ? `${killRatePct}%` : "—"}
          hint="CRITIC / RAW"
          pos={killRatePct !== null && killRatePct >= 25}
        />
        <Cell label="BANKROLL CUT" value={`${data.bankrollDropped14d}`} hint="CAP / DUP" />
        <Cell
          label="AVG CLV"
          value={avgClv !== null ? `${avgClv > 0 ? "+" : ""}${avgClv}¢` : "—"}
          hint={`N=${data.clvSampleSize}`}
          pos={avgClv !== null && avgClv > 0}
          neg={avgClv !== null && avgClv < 0}
        />
        <Cell
          label={data.parseFailedRuns14d > 0 ? "PARSE FAILS" : "PARSE OK"}
          value={data.parseFailedRuns14d > 0 ? `${data.parseFailedRuns14d}` : "✓"}
          hint={data.parseFailedRuns14d > 0 ? "JSON BROKE" : "ALL RUNS"}
          neg={data.parseFailedRuns14d > 0}
        />
      </div>
    </section>
  );
}

function Cell({
  label,
  value,
  hint,
  pos,
  neg,
}: {
  label: string;
  value: string;
  hint?: string;
  pos?: boolean;
  neg?: boolean;
}) {
  const color = pos ? "text-[var(--color-win)]" : neg ? "text-[var(--color-loss)]" : "text-white";
  return (
    <div className="px-3 py-3 border-r-[3px] border-b-[3px] border-white last:border-r-0 sm:[&:nth-child(4)]:border-r-0 sm:[&:nth-child(n+3)]:border-b-0 [&:nth-child(n+3)]:border-b-0">
      <p className="display-eyebrow text-white/60 text-[0.6rem]">{label}</p>
      <p className={`odds-display mt-1 text-2xl ${color}`}>{value}</p>
      {hint && <p className="mono text-[0.6rem] text-white/40 mt-0.5">{hint}</p>}
    </div>
  );
}
