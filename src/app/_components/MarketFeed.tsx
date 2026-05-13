"use client";

import { useMemo, useState } from "react";
import type { SlateGame } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

function fmtAmerican(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtTime(iso: string): string {
  return new Date(iso)
    .toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    })
    .toUpperCase();
}

type LeagueFilter = "ALL" | "NBA" | "MLB" | "WNBA" | "NHL";
type EdgeFilter = "ALL" | "ANY" | "5" | "10";
type SortKey = "time" | "edge" | "disagree";

export function MarketFeed({ games }: { games: SlateGame[] }) {
  const [league, setLeague] = useState<LeagueFilter>("ALL");
  const [edge, setEdge] = useState<EdgeFilter>("ALL");
  const [picksOnly, setPicksOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("time");

  const filtered = useMemo(() => {
    let list = [...games];
    if (league !== "ALL") list = list.filter(g => g.league === league);
    if (picksOnly) list = list.filter(g => g.hasPick);
    if (edge !== "ALL") {
      const threshold = edge === "ANY" ? 0.001 : edge === "5" ? 0.05 : 0.10;
      list = list.filter(g => g.pick && g.pick.edge >= threshold);
    }
    list.sort((a, b) => {
      if (sortBy === "edge") {
        return (b.pick?.edge ?? -1) - (a.pick?.edge ?? -1);
      }
      if (sortBy === "disagree") {
        const da = a.modelHomeProb !== null && a.consensus.home?.impliedProb !== undefined
          ? Math.abs(a.modelHomeProb - (a.consensus.home?.impliedProb ?? 0))
          : -1;
        const db = b.modelHomeProb !== null && b.consensus.home?.impliedProb !== undefined
          ? Math.abs(b.modelHomeProb - (b.consensus.home?.impliedProb ?? 0))
          : -1;
        return db - da;
      }
      return new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime();
    });
    return list;
  }, [games, league, edge, picksOnly, sortBy]);

  const availableLeagues = Array.from(new Set(games.map(g => g.league)));

  if (games.length === 0) {
    return (
      <section className="space-y-4">
        <SectionHeader id="market-feed" index="07" label="MARKET FEED" title="FEED OFFLINE" />
        <div className="surface p-8 text-center">
          <p className="eyebrow text-[var(--muted)]">NO GAMES SCHEDULED</p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <SectionHeader
        id="market-feed"
        index="07"
        label="MARKET FEED"
        title="LIVE ODDS BOARD"
        subtitle="Full slate at consensus median. Highlight rows where model and market disagree most — those are the agent's hunting grounds."
        status={`${filtered.length} / ${games.length} GAMES`}
        statusColor="signal"
      />

      {/* Filter rail */}
      <div className="surface p-3 flex flex-wrap items-center gap-2 text-xs">
        <FilterGroup label="LEAGUE">
          <FilterPill active={league === "ALL"} onClick={() => setLeague("ALL")}>ALL</FilterPill>
          {(["NBA", "MLB", "WNBA", "NHL"] as LeagueFilter[]).filter(l => l === "ALL" || availableLeagues.includes(l)).map(l => (
            <FilterPill key={l} active={league === l} onClick={() => setLeague(l)}>
              {l}
            </FilterPill>
          ))}
        </FilterGroup>
        <Divider />
        <FilterGroup label="EDGE">
          <FilterPill active={edge === "ALL"} onClick={() => setEdge("ALL")}>ALL</FilterPill>
          <FilterPill active={edge === "ANY"} onClick={() => setEdge("ANY")}>ANY</FilterPill>
          <FilterPill active={edge === "5"} onClick={() => setEdge("5")}>≥5%</FilterPill>
          <FilterPill active={edge === "10"} onClick={() => setEdge("10")}>≥10%</FilterPill>
        </FilterGroup>
        <Divider />
        <FilterGroup label="SORT">
          <FilterPill active={sortBy === "time"} onClick={() => setSortBy("time")}>TIME</FilterPill>
          <FilterPill active={sortBy === "edge"} onClick={() => setSortBy("edge")}>EDGE</FilterPill>
          <FilterPill active={sortBy === "disagree"} onClick={() => setSortBy("disagree")}>DISAGREE</FilterPill>
        </FilterGroup>
        <button
          type="button"
          onClick={() => setPicksOnly(p => !p)}
          className={`ml-auto eyebrow px-2 py-1 border transition-colors ${
            picksOnly
              ? "border-[var(--edge)] text-[var(--edge)] bg-[var(--edge)]/10"
              : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--border-strong)]"
          }`}
        >
          PICKS ONLY
        </button>
      </div>

      {/* Header row */}
      <div className="surface">
        <div className="hidden md:grid grid-cols-[60px_56px_1fr_72px_72px_92px_72px_72px_60px] gap-2 px-3 py-2 border-b border-[var(--border)] eyebrow text-[var(--muted)]">
          <span>TIME</span>
          <span>LG</span>
          <span>MATCHUP</span>
          <span className="text-right">ML(A)</span>
          <span className="text-right">ML(H)</span>
          <span className="text-right">SPRD</span>
          <span className="text-right">MODEL</span>
          <span className="text-right">MKT</span>
          <span className="text-right">EDGE</span>
        </div>

        <ul className="divide-y divide-[var(--border)]">
          {filtered.map(g => (
            <FeedRow key={g.eventId} game={g} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function FeedRow({ game }: { game: SlateGame }) {
  const c = game.consensus;
  const modelHome = game.modelHomeProb;
  const marketHome = c.home?.impliedProb ?? null;
  const disagreement =
    modelHome !== null && marketHome !== null ? modelHome - marketHome : null;
  const edge = game.pick?.edge ?? null;

  return (
    <li
      className={`grid grid-cols-[1fr_auto] md:grid-cols-[60px_56px_1fr_72px_72px_92px_72px_72px_60px] gap-2 px-3 py-2 items-center hover:bg-[rgba(255,255,255,0.02)] ${
        game.hasPick ? "border-l-2 border-l-[var(--edge)]" : "border-l-2 border-l-transparent"
      }`}
    >
      <span className="numeric text-xs text-[var(--muted)] md:order-none order-1 col-start-1">
        {fmtTime(game.commenceTime)}
      </span>
      <span className="pill md:order-none order-2 col-start-2 row-start-1 justify-self-end md:justify-self-start" style={{ color: "var(--signal)", borderColor: "var(--signal)" }}>
        {game.league}
      </span>
      <div className="md:order-none order-3 col-span-2 md:col-span-1 min-w-0">
        <p className="font-sans text-sm truncate">
          <span className="text-[var(--text)]">{game.awayTeam}</span>{" "}
          <span className="text-[var(--muted)]">@</span>{" "}
          <span className="text-[var(--text)]">{game.homeTeam}</span>
        </p>
        {game.pick && (
          <p className="font-mono text-[0.65rem] text-[var(--edge)] truncate">
            ▸ {game.pick.selection} @ {fmtAmerican(game.pick.oddsAmerican)} · {(game.pick.edge * 100).toFixed(1)}%
          </p>
        )}
      </div>
      <span className="numeric text-xs text-right hidden md:block">
        {fmtAmerican(c.away?.american)}
      </span>
      <span className="numeric text-xs text-right hidden md:block">
        {fmtAmerican(c.home?.american)}
      </span>
      <span className="numeric text-xs text-right text-[var(--muted)] hidden md:block">
        {c.spread ? `${c.spread.line > 0 ? "+" : ""}${c.spread.line}` : "—"}
      </span>
      <span className="numeric text-xs text-right hidden md:block" style={{ color: "var(--signal)" }}>
        {modelHome !== null ? `${Math.round(modelHome * 100)}%` : "—"}
      </span>
      <span className="numeric text-xs text-right hidden md:block text-[var(--muted)]">
        {marketHome !== null ? `${Math.round(marketHome * 100)}%` : "—"}
      </span>
      <span
        className="numeric text-xs text-right hidden md:block"
        style={{
          color:
            edge !== null && edge >= 0.05
              ? "var(--edge)"
              : disagreement !== null && Math.abs(disagreement) >= 0.05
              ? "var(--warn)"
              : "var(--muted)",
        }}
      >
        {edge !== null
          ? `+${(edge * 100).toFixed(1)}%`
          : disagreement !== null
          ? `Δ${Math.abs(disagreement * 100).toFixed(0)}`
          : "—"}
      </span>
    </li>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <span className="eyebrow text-[var(--muted)] mr-1">{label}</span>
      {children}
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`eyebrow px-2 py-1 border transition-colors ${
        active
          ? "border-[var(--text)] text-[var(--text)] bg-white/5"
          : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="hidden sm:inline-block h-3 w-px bg-[var(--border)] mx-1" />;
}
