"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import type { PipelineStatus as PipelineStatusData } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

type Stage = {
  key: string;
  short: string;
  label: string;
  hint: string;
  count: number;
  color: string;
};

export function EdgeReactor({ data }: { data: PipelineStatusData }) {
  const rootRef = useRef<HTMLDivElement>(null);

  const raw = data.rawAnalystPicks14d ?? 0;
  const graderKept = data.graderKept14d ?? 0;
  const criticSurvived = Math.max(0, graderKept - (data.criticKilled14d ?? 0));
  const shipped = data.finalShipped14d ?? 0;
  const killRate = data.killRatePct ?? 0;
  const totalKilled = (raw - shipped); // grader + critic + bankroll combined

  const stages: Stage[] = [
    { key: "raw", short: "RAW", label: "Analyst proposed", hint: "LLM raw ideas", count: raw, color: "var(--muted)" },
    { key: "grader", short: "GRADED", label: "Grader kept", hint: "≥6% edge + ≤2u + thesis", count: graderKept, color: "var(--signal)" },
    { key: "critic", short: "SURVIVED", label: "Critic survived", hint: "Devil's advocate pass", count: criticSurvived, color: "var(--warn)" },
    { key: "shipped", short: "SHIPPED", label: "Final shipped", hint: "Persisted + Discord", count: shipped, color: "var(--edge)" },
  ];
  const maxCount = Math.max(...stages.map(s => s.count), 1);

  useEffect(() => {
    if (!rootRef.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = gsap.context(() => {
      const bars = rootRef.current!.querySelectorAll<HTMLElement>("[data-bar]");
      const counts = rootRef.current!.querySelectorAll<HTMLElement>("[data-count]");
      if (reduce) {
        bars.forEach(b => gsap.set(b, { scaleX: 1 }));
        return;
      }
      gsap.set(bars, { scaleX: 0, transformOrigin: "left center" });
      gsap.to(bars, { scaleX: 1, duration: 0.7, ease: "power3.out", stagger: 0.1 });
      counts.forEach((el, i) => {
        const final = Number(el.dataset.count);
        if (!Number.isFinite(final)) return;
        const obj = { v: 0 };
        gsap.to(obj, {
          v: final,
          duration: 0.8,
          delay: 0.1 * i,
          ease: "power3.out",
          onUpdate: () => { el.textContent = Math.round(obj.v).toString(); },
        });
      });
    }, rootRef);
    return () => ctx.revert();
  }, []);

  if (data.totalRunsLast14d === 0) {
    return (
      <section className="space-y-4">
        <SectionHeader id="reactor" index="02" label="EDGE REACTOR" title="REACTOR DARK" />
        <div className="surface p-8 text-center">
          <p className="eyebrow text-[var(--muted)] mb-2">NO RUNS LAST 14D</p>
          <p className="font-mono text-sm text-[var(--text)]">
            Capital remains locked. Awaiting first agent transmission.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <SectionHeader
        id="reactor"
        index="02"
        label="EDGE REACTOR"
        title="THE CRITIC PROSECUTES"
        subtitle={`Last 14 days · ${data.totalRunsLast14d} runs · ${raw} raw ideas tested against six tool calls and a devil's-advocate critic. Only survivors reach the board.`}
        status="OPERATIONAL"
        statusColor="signal"
      />

      {/* The kill-rate centerpiece — dominant visually */}
      <div className="surface p-5 sm:p-7 scanlines relative">
        <div className="relative z-10 grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-6 lg:gap-10 items-center">
          <div>
            <p className="eyebrow text-[var(--muted)] mb-2">CRITIC KILL RATE — 14D</p>
            <p
              className="font-display font-bold leading-none"
              style={{
                fontSize: "clamp(4.5rem, 12vw, 9rem)",
                color: killRate >= 25 ? "var(--edge)" : "var(--warn)",
                letterSpacing: "-0.05em",
              }}
            >
              {killRate.toFixed(1)}<span className="text-[var(--muted)]">%</span>
            </p>
            <p className="mt-2 font-mono text-sm text-[var(--text)] max-w-md">
              <span className="reactor-active" style={{ color: "var(--kill)" }}>●</span>{" "}
              The critic killed <span className="numeric text-[var(--kill)]">{totalKilled}</span> of {raw} ideas. Only survivors reach the board.
            </p>
          </div>

          {/* Pipeline flow */}
          <div ref={rootRef} className="grid gap-2.5">
            {stages.map((s, i) => {
              const widthPct = (s.count / maxCount) * 100;
              const prev = i === 0 ? null : stages[i - 1].count;
              const survivalPct = prev === null || prev === 0 ? null : Math.round((s.count / prev) * 100);
              return (
                <div
                  key={s.key}
                  className="grid grid-cols-[80px_1fr_auto] sm:grid-cols-[120px_1fr_auto] items-center gap-3"
                >
                  <div>
                    <p className="eyebrow" style={{ color: s.color }}>{s.short}</p>
                    <p className="font-mono text-[0.65rem] text-[var(--muted)] truncate">{s.hint}</p>
                  </div>
                  <div
                    className="relative h-9"
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)" }}
                  >
                    <div
                      data-bar
                      className="absolute inset-y-0 left-0"
                      style={{
                        width: `${Math.max(widthPct, 1)}%`,
                        background: s.color,
                        opacity: 0.18,
                      }}
                    />
                    <div className="absolute inset-y-0 left-0 flex items-center px-2 sm:px-3">
                      <span
                        data-count={s.count}
                        className="numeric text-lg sm:text-xl font-semibold"
                        style={{ color: s.color }}
                      >
                        {s.count}
                      </span>
                      <span className="ml-2 font-mono text-[0.65rem] text-[var(--muted)] hidden sm:inline">
                        {s.label}
                      </span>
                    </div>
                  </div>
                  <span
                    className="numeric text-xs text-right w-16 sm:w-20 shrink-0"
                    style={{ color: survivalPct !== null && survivalPct >= 50 ? "var(--edge)" : "var(--muted)" }}
                  >
                    {survivalPct !== null ? `${survivalPct}% KEPT` : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Operational telemetry strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Cell
          label="AVG CLV"
          value={data.avgClvCents !== null ? `${data.avgClvCents > 0 ? "+" : ""}${data.avgClvCents}¢` : "—"}
          sub={`N=${data.clvSampleSize}`}
          color={data.avgClvCents !== null && data.avgClvCents > 0 ? "edge" : data.avgClvCents !== null ? "kill" : "muted"}
        />
        <Cell label="BANKROLL CUT" value={`${data.bankrollDropped14d}`} sub="CAP / DUP" color="warn" />
        <Cell label="GRADER REJECTS" value={`${Math.max(0, raw - graderKept)}`} sub="PRE-CRITIC" color="signal" />
        <Cell
          label={data.parseFailedRuns14d > 0 ? "PARSE FAILS" : "PARSE HEALTH"}
          value={data.parseFailedRuns14d > 0 ? `${data.parseFailedRuns14d}` : "OK"}
          sub={data.parseFailedRuns14d > 0 ? "CRITIC JSON" : "ALL CLEAR"}
          color={data.parseFailedRuns14d > 0 ? "kill" : "edge"}
        />
      </div>
    </section>
  );
}

function Cell({
  label,
  value,
  sub,
  color = "muted",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: "edge" | "warn" | "kill" | "signal" | "muted";
}) {
  return (
    <div className="surface px-4 py-3">
      <p className="eyebrow text-[var(--muted)]">{label}</p>
      <p className="numeric text-2xl mt-1" style={{ color: `var(--${color === "muted" ? "text" : color})` }}>
        {value}
      </p>
      {sub && <p className="eyebrow text-[var(--muted)] mt-0.5">{sub}</p>}
    </div>
  );
}
