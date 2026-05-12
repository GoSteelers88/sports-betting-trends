"use client";

import { useEffect, useRef } from "react";
import type { SlatePick } from "../_data/dashboard";
import { BetBackground } from "./BetBackground";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

// Map edge → variable-font weight. Hot = ultra-bold, cold = thin.
// Edge realistically ranges 0..0.25. Clamp to wght 200..900.
function edgeToWeight(edge: number): number {
  const raw = 200 + edge * 3500;
  return Math.max(200, Math.min(900, raw));
}

function temperature(edge: number): "HOT" | "WARM" | "COLD" {
  if (edge >= 0.10) return "HOT";
  if (edge >= 0.05) return "WARM";
  return "COLD";
}

export function BetBlock({
  pick,
  index,
  total,
  onOpen,
}: {
  pick: SlatePick;
  index: number;
  total: number;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const matchupRef = useRef<HTMLHeadingElement>(null);
  const oddsRef = useRef<HTMLSpanElement>(null);

  // Scroll-driven distortion: as the block moves through the viewport,
  // bias its rotation/skew based on its center vs the viewport center.
  useEffect(() => {
    if (!ref.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    let rafId = 0;
    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const viewportH = window.innerHeight;
        // Center of block relative to center of viewport, normalized -1..1
        const center = (rect.top + rect.height / 2 - viewportH / 2) / (viewportH / 2);
        const clamped = Math.max(-1, Math.min(1, center));
        // Rotate ±3deg, skew ±2deg, slight scale dip away from center
        const rot = clamped * 2.5;
        const skew = clamped * 1.5;
        const scale = 1 - Math.abs(clamped) * 0.04;
        el.style.transform = `rotate(${rot}deg) skewY(${skew}deg) scale(${scale})`;
        // Headline weight tilts toward 900 as block approaches center
        const proximity = 1 - Math.abs(clamped); // 0 far, 1 center
        const baseWeight = edgeToWeight(pick.edge);
        const dynamicWeight = baseWeight + proximity * 200;
        if (matchupRef.current) {
          matchupRef.current.style.setProperty(
            "--wght",
            String(Math.min(900, Math.round(dynamicWeight)))
          );
        }
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [pick.edge]);

  const temp = temperature(pick.edge);
  const isHot = temp === "HOT";
  const isCold = temp === "COLD";
  const baseWeight = edgeToWeight(pick.edge);
  const tempColor =
    temp === "HOT" ? "var(--rust-flash)" : temp === "WARM" ? "var(--rust)" : "var(--cold)";

  const indexStr = String(index + 1).padStart(2, "0");
  const totalStr = String(total).padStart(2, "0");

  return (
    <section
      ref={ref}
      aria-label={`Bet ${index + 1}: ${pick.matchup}`}
      className="relative min-h-[100svh] flex items-center justify-center overflow-hidden transition-transform duration-300 ease-out"
    >
      <BetBackground league={pick.league} />

      {/* Top + bottom transmission frame */}
      <div className="absolute top-0 left-0 right-0 px-6 sm:px-12 py-5 flex items-center justify-between var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--concrete-light)] z-10">
        <span>// TX_{indexStr}/{totalStr}</span>
        <span className="scramble">{pick.league} ▸ MONEYLINE</span>
        <span style={{ color: tempColor }}>{temp}</span>
      </div>
      <div className="absolute bottom-0 left-0 right-0 px-6 sm:px-12 py-5 flex items-center justify-between var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--concrete)] z-10">
        <span>EDGE_{(pick.edge * 100).toFixed(2)}%</span>
        <span>WGT_{baseWeight.toFixed(0)}</span>
        <span>STAKE_{pick.kellyStakeUnits.toFixed(2)}U</span>
      </div>

      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open receipt for ${pick.matchup}`}
        className="bare relative w-full h-full min-h-[100svh] px-4 sm:px-10 flex flex-col items-stretch justify-center text-left"
      >
        {/* MATCHUP — the kinetic typographic block */}
        <h2
          ref={matchupRef}
          className={`var-display text-[var(--foreground)] text-[clamp(3.5rem,16vw,16rem)] ${
            isHot ? "hot-vibrate" : ""
          } ${isCold ? "cold-fade" : ""}`}
          style={{
            ["--wght" as string]: String(baseWeight),
            ["--lsp" as string]: "-0.05em",
            color: isCold ? "var(--concrete)" : "var(--foreground)",
          }}
        >
          {pick.matchup.split(/\s+(?:VS\.?|vs\.?|@)\s+/i).map((part, i) => (
            <span key={i} className="block">
              {i > 0 && (
                <span
                  className="inline-block mr-3 var-mono"
                  style={{ color: "var(--rust)", fontSize: "0.45em", verticalAlign: "0.4em" }}
                >
                  ▸
                </span>
              )}
              {part}
            </span>
          ))}
        </h2>

        {/* SELECTION + ODDS — secondary line, oversized but in rust */}
        <div className="mt-6 sm:mt-10 flex flex-wrap items-baseline gap-x-6 gap-y-3">
          <span
            className="var-display text-[clamp(2rem,7vw,7rem)]"
            style={{
              color: "var(--rust-flash)",
              ["--wght" as string]: "800",
            }}
          >
            {pick.selection.toUpperCase()}
          </span>
          <span
            ref={oddsRef}
            className={`var-display text-[clamp(2.5rem,9vw,9rem)] ${isHot ? "hot-vibrate" : ""}`}
            style={{
              color: tempColor,
              ["--wght" as string]: isHot ? "900" : isCold ? "200" : "700",
            }}
          >
            {fmtAmerican(pick.oddsAmerican)}
          </span>
        </div>

        {/* Bottom-anchored thesis + invalidation as monospace transmission */}
        <div className="mt-8 max-w-3xl grid gap-2">
          <p className="var-mono text-[0.75rem] sm:text-sm uppercase tracking-wider text-[var(--concrete-light)] leading-relaxed">
            <span style={{ color: "var(--rust)" }}>▸ THESIS </span>
            {pick.thesis}
          </p>
          {pick.invalidation && (
            <p className="var-mono text-[0.7rem] sm:text-xs uppercase tracking-wider text-[var(--concrete)] leading-relaxed">
              <span style={{ color: "var(--rust)" }}>▸ KILL </span>
              {pick.invalidation}
            </p>
          )}
        </div>

        {/* "Press to receipt" hint */}
        <div className="mt-8 var-mono text-[0.7rem] uppercase tracking-[0.4em] text-[var(--concrete)] flex items-center gap-3">
          <span className="inline-block w-3 h-3" style={{ background: "var(--rust)" }} />
          PRESS — PRINT RECEIPT
        </div>
      </button>
    </section>
  );
}
