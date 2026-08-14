"use client";

// The verdict tape — a recessed band under the desk strip. Settled picks
// run WITH their results (result + units always travel together; an edge
// figure never appears alone once a pick has settled), pending picks carry
// their edge honestly marked pending, and the next scheduled run closes the
// loop. Pure CSS animation (keyframes in globals.css), loop tripled for
// seamlessness.
//
// Items are built SERVER-side (verdict-tape-items.ts) so this client component
// receives ~21 small objects instead of the entire DashboardData. Copies 2 and
// 3 of the loop are aria-hidden — screen readers hear each pick once, not
// three times — and reduced-motion viewers get a scrollable band instead of a
// frozen clip (globals.css .tape-wrap guard).

import type { TapeItem } from "./verdict-tape-items";

function TapeRun({ items, hidden }: { items: TapeItem[]; hidden?: boolean }) {
  return (
    <span aria-hidden={hidden || undefined} className="inline-flex gap-10">
      {items.map((item, i) => (
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
    </span>
  );
}

export function VerdictTape({ items }: { items: TapeItem[] }) {
  return (
    <div className="tape-wrap relative bg-paper-3 border-b border-rule overflow-hidden">
      <div className="tape-track flex gap-10 py-2 px-5 whitespace-nowrap">
        <TapeRun items={items} />
        <TapeRun items={items} hidden />
        <TapeRun items={items} hidden />
      </div>
    </div>
  );
}
