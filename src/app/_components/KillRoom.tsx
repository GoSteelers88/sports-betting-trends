"use client";

// Folio 05 — the kill room. The pipeline and the prosecution merged into one
// story: raw analyst ideas are ground down through grader, critic, and
// bankroll guard (the funnel), the kill rate is the headline, and the
// taxonomy + run log show what died and why. EVERY figure here is the
// 14-day operational window — trial-to-date numbers are canonical in the
// funding gate (Fol. 03) and are cross-referenced, not duplicated.

import { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import type { KillStats, PipelineStatus } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

gsap.registerPlugin(ScrollTrigger, useGSAP);

type Stage = {
  key: string;
  short: string;
  label: string;
  hint: string;
  count: number;
  color: string;
};

export function KillRoom({
  pipeline,
  kills,
  trialKillRate,
}: {
  pipeline: PipelineStatus;
  kills: KillStats;
  trialKillRate: number | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  const raw = pipeline.rawAnalystPicks14d ?? 0;
  const graderKept = pipeline.graderKept14d ?? 0;
  const criticSurvived = Math.max(0, graderKept - (pipeline.criticKilled14d ?? 0));
  const shipped = pipeline.finalShipped14d ?? 0;
  const killRate = pipeline.killRatePct ?? 0;
  const totalKilled = raw - shipped; // grader + critic + bankroll combined
  const graderRejects = Math.max(0, raw - graderKept);
  const graderRejectPct = raw > 0 ? Math.round((graderRejects / raw) * 100) : null;

  const stages: Stage[] = [
    { key: "raw", short: "RAW", label: "Analyst proposed", hint: "LLM raw ideas", count: raw, color: "var(--ink-3)" },
    { key: "grader", short: "GRADED", label: "Grader kept", hint: "≥6% edge · ≤2u · thesis", count: graderKept, color: "var(--blue)" },
    { key: "critic", short: "SURVIVED", label: "Critic survived", hint: "Devil's-advocate pass", count: criticSurvived, color: "var(--hold)" },
    { key: "shipped", short: "SHIPPED", label: "Final shipped", hint: "Persisted + Discord", count: shipped, color: "var(--win)" },
  ];
  const maxCount = Math.max(...stages.map(s => s.count), 1);

  useGSAP(
    () => {
      const root = rootRef.current;
      if (!root) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const bars = root.querySelectorAll<HTMLElement>("[data-bar]");
        gsap.from(bars, {
          scaleX: 0,
          transformOrigin: "left center",
          duration: 0.8,
          ease: "power3.out",
          stagger: 0.12,
          immediateRender: false, // bars stay visible if the trigger misses
          scrollTrigger: { trigger: root, start: "top 92%", once: true },
        });
      });
    },
    { scope: rootRef }
  );

  if (pipeline.totalRunsLast14d === 0) {
    return (
      <section>
        <SectionHeader
          id="kill-room"
          index="05"
          label="THE KILL ROOM · 14D"
          title="Reactor dark"
          status="No runs · 14d"
          statusTone="mute"
        />
        <p className="tag text-ink-3 mt-4">Capital remains locked — awaiting the first agent transmission</p>
      </section>
    );
  }

  const totalCategorized = kills.categories.reduce((s, c) => s + c.examples, 0);

  return (
    <section className="space-y-8">
      <SectionHeader
        id="kill-room"
        index="05"
        label="THE KILL ROOM · LAST 14 DAYS"
        title="The critic prosecutes"
        subtitle={`${pipeline.totalRunsLast14d} runs · ${raw} raw ideas tested against six tool calls and a devil's-advocate critic. Only survivors reach the book. All figures on this page: 14-day window. Trial-to-date numbers are canonical in the funding gate (Fol. 03).`}
        status={`${killRate.toFixed(1)}% kill rate · 14d`}
        statusTone={killRate >= 25 ? "loss" : "hold"}
      />

      {/* Kill-rate figure against the funnel — 5/7 split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
        <div className="lg:col-span-5">
          <p className="eyebrow mb-3">Critic kill rate · 14d</p>
          <p
            className="num-display"
            style={{
              fontSize: "clamp(4.5rem, 12vw, 9.5rem)",
              color: killRate >= 25 ? "var(--loss)" : "var(--hold)",
            }}
          >
            {killRate.toFixed(1)}
            <span className="text-ink-3" style={{ fontSize: "0.45em" }}>%</span>
          </p>
          <p className="mt-4 text-sm text-ink-2 max-w-md leading-relaxed">
            The desk killed{" "}
            <span className="num font-semibold" style={{ color: "var(--loss)" }}>
              {totalKilled}
            </span>{" "}
            of {raw} ideas in 14 days before they could touch the bankroll
            ({kills.totalKilledLast7d} by the critic in the last 7).
            {trialKillRate !== null && (
              <>
                {" "}Trial-to-date kill rate:{" "}
                <span className="num font-semibold text-ink">
                  {(trialKillRate * 100).toFixed(1)}%
                </span>{" "}
                — gated at ≥25% in Fol. 03.
              </>
            )}
          </p>
        </div>

        {/* The funnel — 14d */}
        <div ref={rootRef} className="lg:col-span-7 grid gap-3">
          {stages.map((s, i) => {
            const widthPct = (s.count / maxCount) * 100;
            const prev = i === 0 ? null : stages[i - 1].count;
            const survivalPct =
              prev === null || prev === 0 ? null : Math.round((s.count / prev) * 100);
            return (
              <div
                key={s.key}
                className="grid grid-cols-[84px_1fr_auto] sm:grid-cols-[130px_1fr_auto] items-center gap-3"
              >
                <div>
                  <p className="eyebrow" style={{ color: s.color === "var(--ink-3)" ? "var(--ink-2)" : s.color }}>
                    {s.short}
                  </p>
                  <p className="num text-[0.62rem] text-ink-3 truncate">{s.hint}</p>
                </div>
                <div className="relative h-10 panel">
                  <div
                    data-bar
                    className="absolute inset-y-0 left-0"
                    style={{
                      width: `${Math.max(widthPct, 1.5)}%`,
                      background: s.color,
                      opacity: 0.16,
                      borderRight: `2px solid ${s.color}`,
                    }}
                  />
                  <div className="absolute inset-y-0 left-0 flex items-center px-2.5 sm:px-3.5">
                    <span
                      className="num text-lg sm:text-xl font-semibold"
                      style={{ color: s.color === "var(--ink-3)" ? "var(--ink)" : s.color }}
                    >
                      {s.count}
                    </span>
                    <span className="ml-2.5 num text-[0.62rem] text-ink-2 hidden sm:inline uppercase tracking-widest">
                      {s.label}
                    </span>
                  </div>
                </div>
                <span
                  className="num text-xs text-right w-16 sm:w-20 shrink-0"
                  style={{
                    color: survivalPct !== null && survivalPct >= 50 ? "var(--win)" : "var(--ink-2)",
                  }}
                >
                  {survivalPct !== null ? `${survivalPct}% kept` : "—"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Telemetry strip — one figure per fact, each labeled 14d */}
      <div className="grid grid-cols-2 sm:grid-cols-4 border border-rule divide-x divide-y sm:divide-y-0 divide-rule bg-paper-2">
        <Cell
          label="Avg CLV · 14d"
          value={pipeline.avgClvCents !== null ? `${pipeline.avgClvCents > 0 ? "+" : ""}${pipeline.avgClvCents}¢` : "—"}
          sub={`n=${pipeline.clvSampleSize} · trial figure in Fol. 03`}
          tone={
            pipeline.avgClvCents !== null && pipeline.avgClvCents > 0
              ? "var(--win)"
              : pipeline.avgClvCents !== null
              ? "var(--loss)"
              : "var(--ink-3)"
          }
        />
        <Cell
          label="Grader rejects · 14d"
          value={graderRejectPct !== null ? `${graderRejects} · ${graderRejectPct}%` : `${graderRejects}`}
          sub="pre-critic, of raw"
          tone="var(--blue)"
        />
        <Cell label="Bankroll cut · 14d" value={`${pipeline.bankrollDropped14d}`} sub="cap / dup / cluster" tone="var(--hold)" />
        <Cell
          label={pipeline.parseFailedRuns14d > 0 ? "Parse fails · 14d" : "Parse health · 14d"}
          value={pipeline.parseFailedRuns14d > 0 ? `${pipeline.parseFailedRuns14d}` : "OK"}
          sub={pipeline.parseFailedRuns14d > 0 ? "critic JSON" : "all clear"}
          tone={pipeline.parseFailedRuns14d > 0 ? "var(--loss)" : "var(--win)"}
        />
      </div>

      {/* Kill taxonomy — 14d */}
      <div className="panel">
        <header
          className="px-4 py-2.5 flex items-center justify-between"
          style={{ borderBottom: "3px double var(--rule-strong)" }}
        >
          <span className="eyebrow">Kill taxonomy · 14d</span>
          <span className="eyebrow" style={{ color: "var(--loss)" }}>
            {totalCategorized} allocated
          </span>
        </header>
        <ul>
          {kills.categories.map((c, i) => {
            const pct = totalCategorized > 0 ? (c.examples / totalCategorized) * 100 : 0;
            return (
              <li
                key={c.key}
                className={`px-4 py-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 items-center ${
                  i > 0 ? "border-t border-rule" : ""
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm text-ink font-medium">{c.label}</p>
                  {/* Wraps in full at narrow widths — never truncates mid-sentence */}
                  <p className="num text-[0.7rem] text-ink-2 leading-snug break-words">{c.description}</p>
                </div>
                <span className="num-display text-xl" style={{ color: "var(--loss)" }}>
                  {c.examples}
                </span>
                <div className="col-span-2 meter" style={{ height: 3 }}>
                  <div
                    className="meter-fill"
                    style={{ width: `${pct}%`, background: "var(--loss)", opacity: 0.75 }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        <p className="px-4 py-2.5 border-t border-rule eyebrow text-ink-3 leading-relaxed">
          Note — individual critic decisions not yet persisted per pick · distribution
          estimated from the critic system prompt · schema extension in progress
        </p>
      </div>

      {/* Prosecution log */}
      {kills.recentRuns.length > 0 && (
        <div className="panel overflow-x-auto">
          <header
            className="px-4 py-2.5 flex items-center justify-between"
            style={{ borderBottom: "3px double var(--rule-strong)" }}
          >
            <span className="eyebrow">Prosecution log · recent runs</span>
            <span className="eyebrow text-ink-3">14d window</span>
          </header>
          <table className="ledger-table">
            <caption className="sr-only">Recent agent runs and kill counts</caption>
            {/* No run-id column — a truncated hash is dead ink, and it
                pushed RATE off-canvas at 360. The run's age rides with the
                league tag; RAW/KILLED/RATE all print at every width. */}
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col" className="text-right">Raw</th>
                <th scope="col" className="text-right">Killed</th>
                <th scope="col" className="text-right">Rate</th>
              </tr>
            </thead>
            <tbody>
              {kills.recentRuns.map(r => (
                <tr key={r.runId}>
                  <td className="whitespace-nowrap">
                    <span className="tag">{r.league}</span>{" "}
                    <span className="num text-[0.62rem] text-ink-3">{relTime(r.createdAt)}</span>
                  </td>
                  <td className="num text-xs text-ink text-right">{r.rawAnalystPicks}</td>
                  <td className="num text-xs text-right font-semibold" style={{ color: "var(--loss)" }}>
                    {r.criticKilled}
                  </td>
                  <td
                    className="num text-xs text-right"
                    style={{
                      color:
                        r.killRate !== null && r.killRate >= 0.5
                          ? "var(--loss)"
                          : "var(--ink-2)",
                    }}
                  >
                    {r.killRate !== null ? `${Math.round(r.killRate * 100)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function relTime(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "NOW";
  if (m < 60) return `${m}M`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}H`;
  return `${Math.floor(h / 24)}D`;
}

function Cell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: string;
}) {
  return (
    <div className="px-4 py-3.5">
      <p className="eyebrow text-ink-3">{label}</p>
      <p className="num-display text-2xl mt-1.5" style={{ color: tone }}>
        {value}
      </p>
      {sub && <p className="eyebrow text-ink-3 mt-1">{sub}</p>}
    </div>
  );
}
