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
//
// URL: the active tab is the location fragment (`/#props`). Three rules make
// that safe here:
//
//  1. The FIRST render is always DEFAULT_TAB, on the server and on the client.
//     Reading location.hash during render would make the client's first paint
//     disagree with the server's HTML — a hydration mismatch. The hash is read
//     in an effect, after mount, which costs one extra render on a deep link
//     and nothing at all on a normal load.
//  2. Clicking a tab writes the fragment with history.replaceState, NOT
//     `location.hash = …`. Assigning to location.hash makes the browser scroll
//     to any element sharing that id (the experiments panel has one), which
//     would yank the page mid-click; replaceState changes the URL and nothing
//     else. It also fires no hashchange, so the listener below cannot loop.
//  3. An unrecognised fragment (`/#nfl-week`, a section deep link) leaves the
//     tab alone — parseTabHash returns null for it and the browser's own
//     anchor scrolling still works inside whatever tab is open.

import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_TAB, TABS, parseTabHash, type Tab } from "@/lib/site-tabs";

export type { Tab };

export function TabShell({ panels }: { panels: Record<Tab, ReactNode> }) {
  const [activeTab, setActiveTab] = useState<Tab>(DEFAULT_TAB);

  useEffect(() => {
    const sync = () => {
      const fromHash = parseTabHash(window.location.hash);
      if (fromHash) setActiveTab(fromHash);
    };
    sync(); // deep link on first load: /#props, a bookmark, a refresh
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const select = (id: Tab) => {
    setActiveTab(id);
    // Keep the URL shareable without moving the viewport. Wrapped because a
    // sandboxed/opaque-origin embed throws on replaceState, and a nav rail
    // that cannot rewrite the URL must still switch tabs.
    try {
      window.history.replaceState(null, "", `#${id}`);
    } catch {
      /* URL stays put; the tab still switches. */
    }
  };

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
                onClick={() => select(tab.id)}
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
