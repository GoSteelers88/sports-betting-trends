"use client";

// TabShell — the tab rail + conditional content switcher.
// Holds the single source of truth for activeTab; renders the 5-button
// underline nav and gates each tab's content behind a keyed div so React
// remounts on switch → sheet-rise fires on every tab change.
//
// IMPORTANT: this is a client component, so it must NOT import the section
// panels directly — several of them (QuantDesk, the paper books, MarketFeed)
// read files via node:fs at render and are server components. Pulling those
// into the client bundle breaks the build ("does not support external
// modules: node:fs"). Instead, page.tsx (a server component) renders each
// tab's content server-side and passes it in as a ReactNode via `panels`.
// TabShell only owns the rail + which pre-rendered panel is visible.

import { useState, type ReactNode } from "react";

export type Tab =
  | "tonight"
  | "the-desk"
  | "props"
  | "experiments"
  | "operations";

const TABS: { id: Tab; num: string; label: string }[] = [
  { id: "tonight", num: "T1", label: "Tonight" },
  { id: "the-desk", num: "T2", label: "The Desk" },
  { id: "props", num: "T3", label: "Props" },
  { id: "experiments", num: "T4", label: "Experiments" },
  { id: "operations", num: "T5", label: "Operations" },
];

export function TabShell({ panels }: { panels: Record<Tab, ReactNode> }) {
  const [activeTab, setActiveTab] = useState<Tab>("tonight");

  return (
    <>
      {/* Tab rail — sticky below CommandHeader. CommandHeader is now a single
          telemetry row (~38px). The tab rail sits flush below it. */}
      <div
        className="sticky z-10 bg-paper"
        style={{ top: "38px", borderBottom: "1px solid var(--rule)" }}
      >
        <nav
          aria-label="Dashboard sections"
          className="px-5 sm:px-10 max-w-[1280px] mx-auto flex items-center overflow-x-auto"
          style={{ scrollbarWidth: "none" }}
        >
          {TABS.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className="eyebrow shrink-0 py-2.5 pr-6 flex items-baseline gap-1.5 transition-colors cursor-pointer"
                style={{
                  color: active ? "var(--ink)" : "var(--ink-3)",
                  fontWeight: active ? 600 : undefined,
                  borderBottom: active
                    ? "2px solid var(--ink)"
                    : "2px solid transparent",
                  marginBottom: "-1px", // overlap the rail's bottom border
                }}
                aria-current={active ? "page" : undefined}
              >
                <span className="num text-[0.6rem]" style={{ color: "var(--ink-3)" }}>
                  {tab.num}
                </span>
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab content — keyed so React remounts on every switch, firing sheet-rise */}
      <main className="px-5 sm:px-10 max-w-[1280px] mx-auto">
        <div
          key={activeTab}
          className="margin-rule space-y-16 sm:space-y-24 pb-20"
          style={{ animation: "sheet-rise 160ms ease-out both" }}
        >
          {panels[activeTab]}
        </div>
      </main>
    </>
  );
}
