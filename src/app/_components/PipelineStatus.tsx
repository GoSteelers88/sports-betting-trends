"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import type { PipelineStatus as PipelineStatusData } from "../_data/dashboard";

type Stage = {
  key: string;
  label: string;
  count: number;
  hint: string;
  color: string;
  glow: string;
};

export function PipelineStatus({ data }: { data: PipelineStatusData }) {
  const rootRef = useRef<HTMLDivElement>(null);

  if (data.totalRunsLast14d === 0) return null;

  const raw = data.rawAnalystPicks14d;
  const graderKept = data.graderKept14d;
  const criticSurvived = Math.max(0, graderKept - data.criticKilled14d);
  const shipped = data.finalShipped14d;

  const stages: Stage[] = [
    { key: "raw", label: "Analyst raw", count: raw, hint: "LLM proposed", color: "#a855f7", glow: "rgba(168,85,247,0.35)" },
    { key: "grader", label: "Grader kept", count: graderKept, hint: "≥6% edge, ≤2u", color: "#00d9ff", glow: "rgba(0,217,255,0.35)" },
    { key: "critic", label: "Critic survived", count: criticSurvived, hint: "devil's advocate", color: "#ff8c42", glow: "rgba(255,140,66,0.35)" },
    { key: "shipped", label: "Final shipped", count: shipped, hint: "to DB + Discord", color: "#22ff88", glow: "rgba(34,255,136,0.4)" },
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
      gsap.to(bars, {
        scaleX: 1,
        duration: 0.7,
        ease: "power3.out",
        stagger: 0.12,
      });

      counts.forEach((el, i) => {
        const final = Number(el.dataset.stageCount ?? "0");
        const obj = { v: 0 };
        gsap.to(obj, {
          v: final,
          duration: 0.7,
          delay: 0.12 * i,
          ease: "power3.out",
          onUpdate: () => {
            el.textContent = Math.round(obj.v).toString();
          },
        });
      });
    }, rootRef);
    return () => ctx.revert();
  }, []);

  const killRatePct = data.killRatePct;
  const killRateColor =
    killRatePct === null
      ? "text-slate-400"
      : killRatePct >= 25
      ? "text-[#22ff88]"
      : "text-amber-300";

  const clvColor =
    data.avgClvCents === null
      ? "text-slate-400"
      : data.avgClvCents > 0
      ? "text-[#22ff88]"
      : "text-[#ff3b3b]";

  return (
    <section ref={rootRef}>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="display-eyebrow text-cyan-300">⚙ Agent Pipeline (last 14d)</h2>
        <span className="text-xs text-slate-500 mono">{data.totalRunsLast14d} runs</span>
      </div>

      <div className="glass rounded-2xl p-5 sm:p-6">
        <div className="space-y-3">
          {stages.map((s, i) => {
            const widthPct = (s.count / maxCount) * 100;
            const prev = i === 0 ? null : stages[i - 1].count;
            const survivalPct =
              prev === null || prev === 0 ? null : Math.round((s.count / prev) * 100);
            return (
              <div key={s.key} className="flex items-center gap-3">
                <div className="w-28 sm:w-32 shrink-0">
                  <p className="display-eyebrow text-slate-400 text-[0.6rem] leading-tight">{s.label}</p>
                  <p className="text-[0.6rem] text-slate-600 mono leading-tight">{s.hint}</p>
                </div>

                <div className="flex-1 relative h-9 sm:h-10">
                  <div className="absolute inset-0 rounded-md bg-white/[0.02] border border-white/5" />
                  <div
                    data-stage-bar
                    className="absolute inset-y-0 left-0 rounded-md"
                    style={{
                      width: `${Math.max(widthPct, 2)}%`,
                      background: `linear-gradient(90deg, ${s.color}cc, ${s.color}55)`,
                      boxShadow: `inset 0 0 0 1px ${s.color}66, 0 0 18px ${s.glow}`,
                    }}
                  />
                  <div className="absolute inset-0 flex items-center justify-between px-3 pointer-events-none">
                    <span
                      data-stage-count
                      data-stage-count-value={s.count}
                      className="mono text-lg sm:text-xl font-semibold text-white"
                      style={{ textShadow: "0 1px 8px rgba(0,0,0,0.55)" }}
                    >
                      {s.count}
                    </span>
                    {survivalPct !== null && (
                      <span
                        className="mono text-[0.65rem] sm:text-xs px-1.5 py-0.5 rounded-full"
                        style={{
                          color: s.color,
                          background: "rgba(0,0,0,0.35)",
                          border: `1px solid ${s.color}44`,
                        }}
                      >
                        {survivalPct}% kept
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-5 pt-4 border-t border-white/5 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat
            label="Kill rate"
            value={killRatePct !== null ? `${killRatePct}%` : "—"}
            hint="critic / raw"
            colorClass={killRateColor}
          />
          <Stat
            label="Bankroll cut"
            value={`${data.bankrollDropped14d}`}
            hint="cap / dup / cluster"
          />
          <Stat
            label="Avg CLV"
            value={
              data.avgClvCents !== null
                ? `${data.avgClvCents > 0 ? "+" : ""}${data.avgClvCents}¢`
                : "—"
            }
            hint={`n=${data.clvSampleSize}`}
            colorClass={clvColor}
          />
          <Stat
            label={data.parseFailedRuns14d > 0 ? "Parse fails" : "Parse health"}
            value={data.parseFailedRuns14d > 0 ? `${data.parseFailedRuns14d}` : "ok"}
            hint={data.parseFailedRuns14d > 0 ? "critic JSON broke" : "all runs parsed"}
            colorClass={data.parseFailedRuns14d > 0 ? "text-amber-300" : "text-slate-300"}
          />
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  colorClass,
}: {
  label: string;
  value: string;
  hint?: string;
  colorClass?: string;
}) {
  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/5 px-3 py-2">
      <p className="display-eyebrow text-slate-500 text-[0.6rem]">{label}</p>
      <p className={`mono mt-0.5 text-base font-semibold ${colorClass ?? "text-white"}`}>{value}</p>
      {hint && <p className="text-[0.6rem] text-slate-600 mt-0.5">{hint}</p>}
    </div>
  );
}
