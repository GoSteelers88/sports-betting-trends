// Server-side item builder for the verdict tape.
//
// This deliberately lives OUTSIDE the "use client" component: when buildItems
// lived in VerdictTape.tsx, the whole DashboardData object was serialized into
// the Flight payload as the client prop — every pick thesis, memory rule, and
// injury note riding along in the HTML so the tape could use ~20 small fields.
// The server builds the ~21 tiny TapeItems; the client gets only those.

import type { DashboardData } from "../_data/dashboard";

export type TapeItem = {
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

export function buildTapeItems(data: DashboardData): TapeItem[] {
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
