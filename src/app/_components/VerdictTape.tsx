"use client";

// The verdict tape — a recessed band under the desk strip. Settled picks
// run WITH their results (result + units always travel together; an edge
// figure never appears alone once a pick has settled), pending picks carry
// their edge honestly marked pending, and the next scheduled run closes the
// loop. Pure CSS animation (keyframes in globals.css), loop tripled for
// seamlessness.

import type { DashboardData } from "../_data/dashboard";

type TapeItem = {
  kind: "settled" | "pending" | "meta";
  league: string;
  text: string;
  detail: string;
  tone: string;
  glyph: string;
};

function fmtUnits(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}u`;
}

function fmtNextRun(iso: string): string {
  const d = new Date(iso);
  const mins = Math.max(0, Math.round((d.getTime() - Date.now()) / 60000));
  const rel = mins < 60 ? `in ${mins}m` : `in ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;
  const at = d
    .toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    })
    .toUpperCase();
  return `${at} ET · ${rel}`;
}

function buildItems(data: DashboardData): TapeItem[] {
  const picks = [
    ...data.lastNight.games.picks,
    ...data.lastNight.props.picks,
    ...data.picks.games,
    ...data.picks.props,
  ].slice(0, 20);

  const seen = new Set<number>();
  const items: TapeItem[] = [];
  for (const p of picks) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const name =
      p.market === "prop" && p.player
        ? `${p.player} ${p.side?.toUpperCase()} ${p.line}`
        : `${p.matchup} · ${p.selection}`;
    const result = p.outcome?.result ?? null;
    if (result === "win" || result === "loss" || result === "push" || result === "void") {
      // Settled — the verdict travels with the pick, never the edge alone.
      const units = p.outcome?.unitsPnl ?? 0;
      items.push({
        kind: "settled",
        league: p.league,
        text: name,
        detail: `${result.toUpperCase()} ${fmtUnits(units)}`,
        tone: result === "win" ? "var(--win)" : result === "loss" ? "var(--loss)" : "var(--ink-3)",
        glyph: result === "win" ? "+" : result === "loss" ? "−" : "=",
      });
    } else {
      items.push({
        kind: "pending",
        league: p.league,
        text: name,
        detail: `PENDING · ${p.edge > 0 ? "+" : ""}${(p.edge * 100).toFixed(1)}% EDGE`,
        tone: "var(--hold)",
        glyph: "○",
      });
    }
  }
  items.push({
    kind: "meta",
    league: "DESK",
    text: "Next analyst run",
    detail: fmtNextRun(data.status.nextScheduledRunUtc),
    tone: "var(--blue)",
    glyph: "▸",
  });
  return items;
}

export function VerdictTape({ data }: { data: DashboardData }) {
  const items = buildItems(data);
  const tripled = [...items, ...items, ...items];

  return (
    <div className="relative bg-paper-3 border-b border-rule overflow-hidden">
      <div className="tape-track flex gap-10 py-2 px-5 whitespace-nowrap">
        {tripled.map((item, i) => (
          <span key={i} className="inline-flex items-baseline gap-2 num text-xs">
            <span className="eyebrow text-ink-3">{item.league}</span>
            <span
              className="text-sm leading-none font-semibold"
              style={{ color: item.tone }}
              aria-hidden
            >
              {item.glyph}
            </span>
            <span className="text-ink font-sans">{item.text}</span>
            <span className="num font-semibold" style={{ color: item.tone }} suppressHydrationWarning>
              {item.detail}
            </span>
            <span className="text-ink-3 px-1.5" aria-hidden>§</span>
          </span>
        ))}
      </div>
    </div>
  );
}
