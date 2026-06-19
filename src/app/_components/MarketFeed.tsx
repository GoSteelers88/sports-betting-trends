"use client";

// Folio 07 — the board, set in agate. Defaults to the desk's actual remit:
// picked rows plus real NBA/MLB games. FULL BOARD unfolds everything the
// feed carries — honestly labeled: baseball that isn't MLB (NCAA, NPB,
// minor-league) reads OTHER, never MLB. Columns that are empty for ≥95% of
// rows don't print.

import { useMemo, useState } from "react";
import type { SlateGame } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";
import { fmtAmerican, honestLeague, isInScopeGame, type HonestLeague } from "./format";

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

type LeagueFilter = "ALL" | HonestLeague;
type SortKey = "time" | "edge" | "disagree";

export function MarketFeed({ games }: { games: SlateGame[] }) {
  const [fullBoard, setFullBoard] = useState(false);
  const [league, setLeague] = useState<LeagueFilter>("ALL");
  const [picksOnly, setPicksOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("time");

  // Honest league per row, computed once.
  const tagged = useMemo(
    () => games.map(g => ({ ...g, displayLeague: honestLeague(g) })),
    [games]
  );

  // Scope: DESK = in-scope (real NBA/MLB) + any picked row; FULL = everything.
  const scoped = useMemo(
    () => (fullBoard ? tagged : tagged.filter(g => isInScopeGame(g) || g.hasPick)),
    [tagged, fullBoard]
  );

  // Column honesty — a column that is ≥95% em-dash doesn't print.
  const modelCoverage =
    scoped.length > 0 ? scoped.filter(g => g.modelHomeProb !== null).length / scoped.length : 0;
  const edgeCoverage =
    scoped.length > 0
      ? scoped.filter(
          g =>
            g.pick !== null ||
            (g.modelHomeProb !== null && g.consensus.home?.impliedProb !== undefined)
        ).length / scoped.length
      : 0;
  const showModel = modelCoverage >= 0.05;
  const showEdge = edgeCoverage >= 0.05;

  const filtered = useMemo(() => {
    let list = [...scoped];
    if (league !== "ALL") list = list.filter(g => g.displayLeague === league);
    if (picksOnly) list = list.filter(g => g.hasPick);
    list.sort((a, b) => {
      // Picked rows pin to the top of the board regardless of active sort —
      // the desk's own plays never sink below the agate.
      if (a.hasPick !== b.hasPick) return a.hasPick ? -1 : 1;
      if (sortBy === "edge") {
        return (b.pick?.edge ?? -1) - (a.pick?.edge ?? -1);
      }
      if (sortBy === "disagree") {
        const da =
          a.modelHomeProb !== null && a.consensus.home?.impliedProb !== undefined
            ? Math.abs(a.modelHomeProb - (a.consensus.home?.impliedProb ?? 0))
            : -1;
        const db =
          b.modelHomeProb !== null && b.consensus.home?.impliedProb !== undefined
            ? Math.abs(b.modelHomeProb - (b.consensus.home?.impliedProb ?? 0))
            : -1;
        return db - da;
      }
      return new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime();
    });
    return list;
  }, [scoped, league, picksOnly, sortBy]);

  const availableLeagues = Array.from(new Set(scoped.map(g => g.displayLeague)));
  const leagueOrder: HonestLeague[] = ["NBA", "MLB", "WNBA", "NHL", "OTHER"];

  if (games.length === 0) {
    return (
      <section>
        <SectionHeader id="market-feed" index="07" dense label="THE BOARD" title="Board dark" status="Off-slate" statusTone="mute" />
        <p className="tag text-ink-3 mt-3">No games scheduled — the board reopens with the next slate</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <SectionHeader
        id="market-feed"
        index="07"
        dense
        label="THE BOARD · CONSENSUS MEDIAN"
        title={fullBoard ? "The full board" : "Tonight's desk slate"}
        subtitle={
          fullBoard
            ? "Everything the odds feed carries tonight — including out-of-scope and non-league baseball, labeled honestly."
            : "Picked rows plus real NBA/MLB games — the desk's actual remit. Unfold the full board for everything else."
        }
        status={`${filtered.length} / ${fullBoard ? tagged.length : scoped.length} games`}
        statusTone="blue"
      />

      {/* Filter rail */}
      <div className="panel-dim p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <FilterGroup label="Scope">
          <FilterChip active={!fullBoard} onClick={() => { setFullBoard(false); setLeague("ALL"); }}>
            DESK
          </FilterChip>
          <FilterChip active={fullBoard} onClick={() => { setFullBoard(true); setLeague("ALL"); }}>
            FULL BOARD
          </FilterChip>
        </FilterGroup>
        <FilterGroup label="League">
          <FilterChip active={league === "ALL"} onClick={() => setLeague("ALL")}>ALL</FilterChip>
          {leagueOrder
            .filter(l => availableLeagues.includes(l))
            .map(l => (
              <FilterChip key={l} active={league === l} onClick={() => setLeague(l)}>
                {l}
              </FilterChip>
            ))}
        </FilterGroup>
        <FilterGroup label="Sort">
          <FilterChip active={sortBy === "time"} onClick={() => setSortBy("time")}>TIME</FilterChip>
          <FilterChip active={sortBy === "edge"} onClick={() => setSortBy("edge")}>EDGE</FilterChip>
          {showModel && (
            <FilterChip active={sortBy === "disagree"} onClick={() => setSortBy("disagree")}>
              DISAGREE
            </FilterChip>
          )}
        </FilterGroup>
        <button
          type="button"
          onClick={() => setPicksOnly(p => !p)}
          aria-pressed={picksOnly}
          className={`ml-auto eyebrow px-2.5 py-1 border transition-colors ${
            picksOnly
              ? "border-loss text-loss"
              : "border-rule text-ink-3 hover:text-ink hover:border-rule-strong"
          }`}
          style={picksOnly ? { background: "var(--loss-wash)" } : undefined}
        >
          Picks only
        </button>
      </div>

      {/* The board */}
      <div className="panel overflow-x-auto">
        <table className="ledger-table agate">
          <caption className="sr-only">Tonight&rsquo;s odds board</caption>
          <thead>
            <tr>
              <th scope="col" className="hidden sm:table-cell">Time</th>
              <th scope="col">Lg</th>
              <th scope="col">Matchup</th>
              <th scope="col" className="text-right hidden md:table-cell">ML (A)</th>
              <th scope="col" className="text-right hidden md:table-cell">ML (H)</th>
              <th scope="col" className="text-right hidden md:table-cell">Sprd</th>
              {showModel && <th scope="col" className="text-right hidden sm:table-cell">Model</th>}
              {showModel && <th scope="col" className="text-right hidden sm:table-cell">Mkt</th>}
              {showEdge && (
                <th scope="col" className="text-right" title="Model vs. market on the home side — bar bleeds toward the side the model leans">
                  Edge · Δ
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map(g => (
              <BoardRow key={g.eventId} game={g} showModel={showModel} showEdge={showEdge} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BoardRow({
  game,
  showModel,
  showEdge,
}: {
  game: SlateGame & { displayLeague: HonestLeague };
  showModel: boolean;
  showEdge: boolean;
}) {
  const c = game.consensus;
  const modelHome = game.modelHomeProb;
  const marketHome = c.home?.impliedProb ?? null;
  const disagreement =
    modelHome !== null && marketHome !== null ? modelHome - marketHome : null;
  const edge = game.pick?.edge ?? null;

  return (
    <tr
      style={{
        boxShadow: game.hasPick ? "inset 3px 0 0 var(--loss)" : undefined,
        background: game.hasPick ? "var(--win-wash)" : undefined,
      }}
    >
      <td className="num text-xs text-ink-2 hidden sm:table-cell">{fmtTime(game.commenceTime)}</td>
      <td>
        <span className="tag" style={game.displayLeague === "OTHER" ? { color: "var(--ink-3)" } : undefined}>
          {game.displayLeague}
        </span>
      </td>
      <td className="min-w-0 max-w-[340px]">
        {/* Two-line row — mobile folds time + prices in, nothing clips mid-word */}
        <p className="text-sm leading-snug break-words">
          <span className="text-ink font-medium">{game.awayTeam}</span>{" "}
          <span className="text-ink-3">@</span>{" "}
          <span className="text-ink font-medium">{game.homeTeam}</span>
        </p>
        <p className="num text-[0.68rem] text-ink-2 leading-snug break-words md:hidden">
          <span className="sm:hidden">{fmtTime(game.commenceTime)} · </span>
          ML {fmtAmerican(c.away?.american)}/{fmtAmerican(c.home?.american)}
          {c.spread ? ` · SPRD ${c.spread.line > 0 ? "+" : ""}${c.spread.line}` : ""}
        </p>
        {game.pick && (
          <p className="num text-[0.68rem] leading-snug break-words" style={{ color: "var(--win)" }}>
            ▸ {game.pick.selection} @ {fmtAmerican(game.pick.oddsAmerican)} ·{" "}
            {(game.pick.edge * 100).toFixed(1)}%
          </p>
        )}
      </td>
      <td className="num text-xs text-right text-ink hidden md:table-cell">{fmtAmerican(c.away?.american)}</td>
      <td className="num text-xs text-right text-ink hidden md:table-cell">{fmtAmerican(c.home?.american)}</td>
      <td className="num text-xs text-right text-ink-2 hidden md:table-cell">
        {c.spread ? `${c.spread.line > 0 ? "+" : ""}${c.spread.line}` : "—"}
      </td>
      {showModel && (
        <td className="num text-xs text-right hidden sm:table-cell" style={{ color: "var(--blue)" }}>
          {modelHome !== null ? `${Math.round(modelHome * 100)}%` : "—"}
        </td>
      )}
      {showModel && (
        <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
          {marketHome !== null ? `${Math.round(marketHome * 100)}%` : "—"}
        </td>
      )}
      {showEdge && (
        <td className="text-right">
          <EdgeMeter edge={edge} disagreement={disagreement} />
        </td>
      )}
    </tr>
  );
}

/** The board's signature glyph: a divergence meter (model vs. market on the
 *  home side) with the numeric edge beside it. A picked row reads as a solid
 *  blue conviction bar sized to the pick's edge; an unpicked row reads as the
 *  raw model−market disagreement, bleeding toward the side the model leans. */
function EdgeMeter({
  edge,
  disagreement,
}: {
  edge: number | null;
  disagreement: number | null;
}) {
  // Picked row → the desk's own edge, always a positive (blue) conviction mark.
  // Unpicked row → signed model−market divergence on the home side.
  const signed = edge !== null ? edge : disagreement;
  if (signed === null || !Number.isFinite(signed)) {
    return <span className="num text-xs text-ink-3">—</span>;
  }
  // ~15pp of disagreement saturates the bar; below 1pp prints no bar (noise).
  const mag = Math.min(1, Math.abs(signed) / 0.15);
  const dir = signed >= 0 ? "pos" : "neg";
  const labelColor =
    edge !== null && edge >= 0.05
      ? "var(--blue)"
      : Math.abs(signed) >= 0.05
      ? "var(--hold)"
      : "var(--ink-3)";
  const label =
    edge !== null
      ? `+${(edge * 100).toFixed(1)}`
      : `${signed >= 0 ? "+" : "−"}${Math.abs(signed * 100).toFixed(0)}`;

  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="num text-xs font-medium tabular-nums" style={{ color: labelColor }}>
        {label}
      </span>
      <span
        className="diverge shrink-0"
        role="img"
        aria-label={
          edge !== null
            ? `picked, ${label} percent edge`
            : `model ${dir === "pos" ? "favors home" : "fades home"} by ${Math.abs(signed * 100).toFixed(0)} points`
        }
      >
        {mag > 0.02 && (
          <span
            className="diverge-bar"
            data-dir={dir}
            style={{ ["--m" as string]: mag.toFixed(3) }}
          />
        )}
      </span>
    </span>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="eyebrow text-ink-3 mr-0.5">{label}</span>
      {children}
    </div>
  );
}

function FilterChip({
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
      aria-pressed={active}
      className={`eyebrow px-2 py-1 border transition-colors ${
        active
          ? "border-rule-strong text-ink bg-paper-2"
          : "border-rule text-ink-3 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
