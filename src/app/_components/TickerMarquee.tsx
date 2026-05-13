"use client";

import type { DashboardData } from "../_data/dashboard";

// Horizontal scrolling ticker — purely CSS-animated, no JS. Renders the
// recent pick stream as a typographic band across the top of the page,
// like a newspaper masthead. Duplicates content so the loop is seamless.

type TickerItem = {
  result: string | null;
  league: string;
  matchup: string;
  market: string;
  edge: number;
};

function buildItems(data: DashboardData): TickerItem[] {
  const recent = [
    ...data.lastNight.games.picks,
    ...data.lastNight.props.picks,
    ...data.picks.games,
    ...data.picks.props,
  ]
    .slice(0, 20)
    .map(p => ({
      result: p.outcome?.result ?? null,
      league: p.league,
      matchup:
        p.market === "prop" && p.player
          ? `${p.player} ${p.side?.toUpperCase()} ${p.line}`
          : `${p.matchup} · ${p.selection}`,
      market: p.market,
      edge: p.edge,
    }));
  return recent;
}

function dotColor(result: string | null): string {
  if (result === "win") return "var(--edge)";
  if (result === "loss") return "var(--kill)";
  if (result === "push" || result === "void") return "var(--muted)";
  return "var(--warn)";
}

function resultGlyph(result: string | null): string {
  if (result === "win") return "+";
  if (result === "loss") return "−";
  if (result === "push" || result === "void") return "=";
  return "○";
}

export function TickerMarquee({ data }: { data: DashboardData }) {
  const items = buildItems(data);
  if (items.length === 0) {
    return (
      <div className="border-b border-[var(--border)] py-2 px-5 text-center">
        <span className="eyebrow text-[var(--faint)]">No picks shipped yet · Tape silent</span>
      </div>
    );
  }
  // Triple the array for a seamless loop at scroll-x animation
  const tripled = [...items, ...items, ...items];

  return (
    <div className="relative border-b border-[var(--border)] overflow-hidden bg-[var(--bg)]">
      <div className="ticker-track flex gap-12 py-3 px-5 whitespace-nowrap">
        {tripled.map((item, i) => (
          <span key={i} className="inline-flex items-baseline gap-2.5 font-mono text-xs tracking-tight">
            <span className="eyebrow text-[var(--faint)]">{item.league}</span>
            <span
              className="text-base leading-none"
              style={{ color: dotColor(item.result) }}
            >
              {resultGlyph(item.result)}
            </span>
            <span className="text-[var(--text)]">{item.matchup}</span>
            <span className="text-[var(--edge)] numeric">
              {item.edge > 0 ? "+" : ""}{(item.edge * 100).toFixed(1)}%
            </span>
            <span className="text-[var(--faint)] px-2">/</span>
          </span>
        ))}
      </div>
      <style jsx>{`
        @keyframes ticker-scroll {
          from { transform: translateX(0); }
          to   { transform: translateX(-33.333%); }
        }
        .ticker-track {
          animation: ticker-scroll 90s linear infinite;
          will-change: transform;
        }
        .ticker-track:hover {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  );
}
