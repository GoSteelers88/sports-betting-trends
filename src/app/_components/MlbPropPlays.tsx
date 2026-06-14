"use client";

// Folio 09 — MLB prop plays, organized BY STAT. Each stat is a milestone
// ladder (1+, 2+, 3+, 4+ …) the way a sportsbook lists player props, with OUR
// model's P(≥k) per rung. Where a market line maps to a rung we overlay the
// model−market edge, the best soft price/book, and a 🔥 on a playable +EV rung.
// Most rungs won't have a market — the MODEL probability prints regardless,
// because this is a "based on our model" board, not a +EV-only board.
//
// Dense agate styling matched to the Props Desk: SectionHeader, eyebrow group
// labels, num/tabular figures, em-dash guards, and the existing collapse
// disclosure for long stat groups. Hides entirely with no MLB slate.

import { useState } from "react";
import type { MlbPropPlaysBoard, StatGroup, PlayerStatLadder, PlayRung } from "@/lib/mlb-prop-plays";
import { SectionHeader } from "./SectionHeader";

// How many players to show per stat before the group collapses behind a toggle.
const COLLAPSE_AFTER = 6;

export function MlbPropPlays({ board }: { board: MlbPropPlaysBoard }) {
  // Nothing modeled / no slate → render nothing (the section disappears).
  if (!board || board.groups.length === 0) return null;

  const ageNote =
    board.windowAgeHours !== null
      ? board.windowAgeHours < 48
        ? `game logs ${board.windowAgeHours.toFixed(0)}h old`
        : `game logs ${(board.windowAgeHours / 24).toFixed(0)}d old — stale`
      : null;

  const modeled = board.modeledStats.length;

  return (
    <section className="space-y-8">
      <SectionHeader
        id="mlb-prop-plays"
        index="09"
        dense
        label="MLB PROP PLAYS · BY STAT"
        title="The ladders, by our model"
        subtitle="Every MLB-slate player's milestone ladder — 1+, 2+, 3+, 4+ — priced by OUR distribution model, not the book. Counts are fit with a recent-form-weighted, sample-shrunk Negative-Binomial (over-dispersed, so the tails aren't overconfident); each rung is the survival function P(stat ≥ k), monotone by construction. Where a sharp/soft line maps to a rung we overlay the de-vigged market prob, the model−market edge, and the best price — 🔥 marks a playable +EV rung. Rungs without a market still print the model number."
        status={`${modeled} stat${modeled === 1 ? "" : "s"} modeled${ageNote ? ` · ${ageNote}` : ""}`}
        statusTone={board.windowAgeHours !== null && board.windowAgeHours >= 48 ? "loss" : "blue"}
      />

      {board.groups.map(group => (
        <StatGroupBlock key={group.stat} group={group} />
      ))}

      <p className="eyebrow text-ink-3 leading-relaxed">
        Model-backed stats: {board.modeledStats.join(" · ") || "—"}. Total Bases is
        synthesized from hits + HR (the feed carries no 2B/3B) and is flagged{" "}
        <span className="text-ink-2">est</span>. Stolen bases, batter strikeouts,
        walks, and pitcher outs are <span className="text-ink-2">omitted</span> — the
        gamelog feed measures no per-game signal for them, so we refuse to print a
        fabricated distribution. A rung with no market line shows the model
        probability only.
      </p>
    </section>
  );
}

function StatGroupBlock({ group }: { group: StatGroup }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = group.ladders.length > COLLAPSE_AFTER;
  const shown = expanded || !collapsible ? group.ladders : group.ladders.slice(0, COLLAPSE_AFTER);

  // The rung thresholds for THIS stat (every ladder shares the same rungs).
  const rungThresholds = group.ladders[0]?.rungs.map(r => r.label) ?? [];
  const anyMarket = group.ladders.some(l => l.rungs.some(r => r.marketProb !== null));

  return (
    <div>
      <p className="eyebrow mb-2 flex items-baseline justify-between gap-3">
        <span>
          {group.label}
          <span className="text-ink-3">
            {" "}· {group.kind === "pitcher" ? "pitcher" : "batter"} · P(≥ k){anyMarket ? " · edge vs market" : ""}
          </span>
        </span>
        <span className="num text-ink-3">{group.ladders.length} player{group.ladders.length === 1 ? "" : "s"}</span>
      </p>
      <div className="panel overflow-x-auto">
        <table className="ledger-table">
          <caption className="sr-only">
            {group.label} milestone ladder with model probabilities by player
          </caption>
          <thead>
            <tr>
              <th scope="col">Player</th>
              {rungThresholds.map(t => (
                <th scope="col" key={t} className="text-right whitespace-nowrap">
                  {t}
                </th>
              ))}
              {anyMarket && (
                <th scope="col" className="text-right whitespace-nowrap hidden sm:table-cell">
                  Best edge
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map((ladder, idx) => (
              <LadderRow key={`${ladder.player}-${idx}`} ladder={ladder} showEdgeCol={anyMarket} />
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={1 + rungThresholds.length + (anyMarket ? 1 : 0)} className="!border-t !border-rule">
                <p className="eyebrow text-ink-3 leading-relaxed py-1">
                  Cells are OUR model P(stat ≥ k). Green = a market line maps to that
                  rung and the model beats it; a price below the player name is the
                  best soft over.{" "}
                  <span className="text-ink-2">est</span> = synthesized series ·{" "}
                  <span className="text-ink-2">n&lt;5</span> = low-confidence fit.
                </p>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="eyebrow mt-2 px-2 py-1 border border-rule text-ink-2 hover:text-ink hover:border-ink-2 transition-colors"
        >
          {expanded ? "Show fewer" : `Show all ${group.ladders.length}`}
        </button>
      )}
    </div>
  );
}

function LadderRow({ ladder, showEdgeCol }: { ladder: PlayerStatLadder; showEdgeCol: boolean }) {
  // Best soft price across this player's rungs, for the sub-line under the name.
  const priced = ladder.rungs.find(r => r.bestPrice !== null && r.playable)
    ?? ladder.rungs.find(r => r.bestPrice !== null);

  const topEdge = ladder.topEdge;

  return (
    <tr>
      <td className="min-w-0 max-w-[240px]">
        <p className="text-sm text-ink font-medium leading-snug break-words">
          {ladder.hasPlayable && <span aria-hidden="true">🔥 </span>}
          {ladder.player}
        </p>
        <p className="num text-[0.68rem] text-ink-2 leading-snug break-words">
          {ladder.team ?? "—"}
          {" · μ "}
          {ladder.mean.toFixed(2)}
          {ladder.derived && <span className="text-ink-3"> · est</span>}
          {ladder.lowConfidence && <span style={{ color: "var(--hold)" }}> · n&lt;5</span>}
          {priced && priced.bestPrice !== null && (
            <span className="text-ink-3">
              {" · "}best {priced.label} {fmtAmerican(priced.bestPrice)}
              {priced.bestBook ? ` @ ${priced.bestBook}` : ""}
            </span>
          )}
        </p>
      </td>
      {ladder.rungs.map(rung => (
        <RungCell key={rung.threshold} rung={rung} />
      ))}
      {showEdgeCol && (
        <td className="num text-sm text-right hidden sm:table-cell whitespace-nowrap">
          {topEdge === null ? (
            <span className="text-ink-3">—</span>
          ) : (
            <span
              className="font-medium"
              style={{ color: topEdge > 0 ? "var(--win)" : topEdge < 0 ? "var(--loss)" : "var(--ink-2)" }}
            >
              {topEdge > 0 ? "+" : ""}
              {(topEdge * 100).toFixed(1)}%
            </span>
          )}
        </td>
      )}
    </tr>
  );
}

function RungCell({ rung }: { rung: PlayRung }) {
  const hasMarket = rung.marketProb !== null;
  // Color the model prob green when a market line exists AND the model beats it
  // (positive edge); otherwise plain ink for a pure model number.
  const beats = hasMarket && rung.edge !== null && rung.edge > 0;
  const pct = `${(rung.modelProb * 100).toFixed(0)}%`;

  return (
    <td className="num text-sm text-right whitespace-nowrap">
      <span
        className={rung.playable ? "font-semibold" : ""}
        style={{ color: rung.playable ? "var(--win)" : beats ? "var(--win)" : "var(--ink)" }}
        title={
          hasMarket
            ? `model ${(rung.modelProb * 100).toFixed(1)}% vs market ${(rung.marketProb! * 100).toFixed(1)}%`
            : `model ${(rung.modelProb * 100).toFixed(1)}% (no market line)`
        }
      >
        {pct}
      </span>
      {rung.playable && <span aria-hidden="true"> 🔥</span>}
    </td>
  );
}

// Local American-odds formatter (mirrors format.fmtAmerican — kept inline so
// this client component stays self-contained and the rule is identical).
function fmtAmerican(n: number | null): string {
  if (n === null || !Number.isFinite(n) || Math.abs(n) < 100) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}
