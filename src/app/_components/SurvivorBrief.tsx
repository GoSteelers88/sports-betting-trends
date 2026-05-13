"use client";

import { useState } from "react";
import type { SlatePick } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";
import { PickAutopsy } from "./PickAutopsy";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
function fmtPct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

// Map prop-type keys to short, readable labels. The keys come from the
// scraper (RotoWire / odds feed), so the inverse mapping is stable.
const PROP_LABELS: Record<string, string> = {
  player_points: "pts",
  player_rebounds: "reb",
  player_assists: "ast",
  player_threes: "3PM",
  player_blocks: "blk",
  player_steals: "stl",
  player_turnovers: "TO",
  player_points_rebounds_assists: "PRA",
  player_points_rebounds: "P+R",
  player_points_assists: "P+A",
  player_rebounds_assists: "R+A",
  player_blocks_steals: "B+S",
  batter_hits: "hits",
  batter_home_runs: "HR",
  batter_rbis: "RBI",
  batter_runs_scored: "runs",
  batter_total_bases: "TB",
  pitcher_strikeouts: "K",
  pitcher_earned_runs: "ER",
};

function formatPropType(propType: string | null): string {
  if (!propType) return "";
  return PROP_LABELS[propType] ?? propType.replace(/^player_|^batter_|^pitcher_/, "").replace(/_/g, " ");
}

export function SurvivorBrief({ picks }: { picks: SlatePick[] }) {
  const [openId, setOpenId] = useState<number | null>(null);

  // The brief: the single highest-edge survivor — that's the headline.
  // Other survivors get listed below as a stack.
  const sorted = [...picks].sort((a, b) => b.edge - a.edge);
  const headline = sorted[0] ?? null;
  const others = sorted.slice(1);

  if (!headline) {
    return (
      <section className="space-y-4">
        <SectionHeader
          id="survivors"
          index="03"
          label="SURVIVOR BRIEF"
          title="NO EDGE DETECTED"
          status="CAPITAL LOCKED"
          statusColor="muted"
        />
        <div className="surface p-8 sm:p-10">
          <p className="font-display text-2xl sm:text-3xl text-[var(--text)] mb-3">
            The critic found no survivable market inefficiency.
          </p>
          <p className="font-mono text-sm text-[var(--muted)] max-w-xl">
            ▸ Discipline &gt; action. Capital remains locked. The agent passed on every game it analyzed.
          </p>
        </div>
      </section>
    );
  }

  const open = openId !== null ? picks.find(p => p.id === openId) ?? null : null;

  return (
    <section className="space-y-4">
      <SectionHeader
        id="survivors"
        index="03"
        label="SURVIVOR BRIEF"
        title={`${picks.length} SURVIVOR${picks.length === 1 ? "" : "S"}`}
        subtitle="Every pick below has survived the analyst, the grader, the critic, and the bankroll guard. They're the only ones the system would put real capital on."
        status="SURVIVED CRITIC"
        statusColor="edge"
      />

      {/* Headline survivor — large intelligence brief card */}
      <article className="surface-edge p-5 sm:p-7 relative overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="pill" style={{ color: "var(--edge)", borderColor: "var(--edge)" }}>
            ★ TOP SURVIVOR
          </span>
          <span className="pill" style={{ color: "var(--signal)", borderColor: "var(--signal)" }}>
            {headline.league}
          </span>
          <span className="pill" style={{ color: "var(--muted)", borderColor: "var(--border-strong)" }}>
            {headline.market.toUpperCase()}
          </span>
          {headline.outcome?.result && (
            <span
              className="pill"
              style={{
                color: headline.outcome.result === "win" ? "var(--edge)" : "var(--kill)",
                borderColor: headline.outcome.result === "win" ? "var(--edge)" : "var(--kill)",
              }}
            >
              {headline.outcome.result.toUpperCase()}
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpenId(headline.id)}
            className="ml-auto eyebrow text-[var(--text)] hover:text-[var(--edge)] px-2 py-1 border border-[var(--border)] hover:border-[var(--edge)]"
          >
            OPEN AUTOPSY →
          </button>
        </div>

        {headline.market === "prop" && headline.player ? (
          <>
            <h3 className="font-display text-2xl sm:text-4xl font-bold leading-tight">
              {headline.player}
            </h3>
            <p className="mt-1 font-mono text-xs sm:text-sm text-[var(--muted)] truncate">
              {headline.matchup}
            </p>
            <p className="mt-2 font-display text-lg sm:text-2xl text-[var(--edge)]">
              {headline.side?.toUpperCase()} {headline.line} {formatPropType(headline.propType)}
              <span className="text-[var(--text)] numeric"> @ {fmtAmerican(headline.oddsAmerican)}</span>
            </p>
          </>
        ) : (
          <>
            <h3 className="font-display text-2xl sm:text-4xl font-bold leading-tight">
              {headline.matchup}
            </h3>
            <p className="mt-2 font-display text-lg sm:text-2xl text-[var(--edge)]">
              {headline.selection} <span className="text-[var(--text)] numeric">@ {fmtAmerican(headline.oddsAmerican)}</span>
            </p>
          </>
        )}

        {/* Model vs Market — the visual centerpiece per spec */}
        <ModelMarketBar
          modelProb={headline.modelProb}
          marketProb={headline.marketProb}
          edge={headline.edge}
        />

        {/* Numeric brief grid */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-0 mt-5 border border-[var(--border)]">
          <Datum label="EDGE" value={fmtPct(headline.edge, 2)} color="edge" />
          <Datum label="STAKE" value={`${headline.kellyStakeUnits.toFixed(2)}U`} />
          <Datum label="CONF" value={`${headline.confidence}`} />
          <Datum label="MODEL" value={fmtPct(headline.modelProb)} color="signal" />
          <Datum
            label="CLV"
            value={headline.clvCents !== null ? `${headline.clvCents > 0 ? "+" : ""}${headline.clvCents}¢` : "PEND"}
            color={headline.clvCents !== null && headline.clvCents > 0 ? "edge" : headline.clvCents !== null && headline.clvCents < 0 ? "kill" : "muted"}
          />
        </div>

        {/* Thesis + invalidation as separate dossiers */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
          <div className="surface p-4">
            <p className="eyebrow text-[var(--edge)] mb-1.5">THESIS</p>
            <p className="text-sm text-[var(--text)] leading-relaxed">{headline.thesis}</p>
          </div>
          <div className="surface p-4">
            <p className="eyebrow text-[var(--warn)] mb-1.5">WHAT WOULD KILL THIS</p>
            <p className="text-sm text-[var(--text)] leading-relaxed">
              {headline.invalidation || "—"}
            </p>
          </div>
        </div>
      </article>

      {/* Other survivors as a stack */}
      {others.length > 0 && (
        <div className="space-y-1">
          <p className="eyebrow text-[var(--muted)] px-1">OTHER SURVIVORS</p>
          <ul className="surface">
            {others.map((p, i) => (
              <li
                key={p.id}
                className={`grid grid-cols-[auto_1fr_auto_auto] sm:grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
              >
                <span className="pill" style={{ color: "var(--signal)", borderColor: "var(--signal)" }}>
                  {p.league}
                </span>
                <div className="min-w-0">
                  {p.market === "prop" && p.player ? (
                    <>
                      <p className="font-display font-semibold text-sm truncate">{p.player}</p>
                      <p className="font-mono text-xs text-[var(--muted)] truncate">
                        {p.side?.toUpperCase()} {p.line} {formatPropType(p.propType)} · {p.matchup}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-display font-semibold text-sm truncate">{p.matchup}</p>
                      <p className="font-mono text-xs text-[var(--muted)] truncate">{p.selection}</p>
                    </>
                  )}
                </div>
                <span className="numeric text-sm text-[var(--text)] hidden sm:inline">
                  {fmtAmerican(p.oddsAmerican)}
                </span>
                <span className="numeric text-sm text-[var(--edge)]">
                  EDGE {fmtPct(p.edge, 1)}
                </span>
                <span className="numeric text-xs text-[var(--muted)] hidden sm:inline">
                  {p.kellyStakeUnits.toFixed(2)}U
                </span>
                <button
                  type="button"
                  onClick={() => setOpenId(p.id)}
                  className="eyebrow text-[var(--text)] hover:text-[var(--edge)] px-2 py-1 border border-[var(--border)] hover:border-[var(--edge)]"
                >
                  AUTOPSY
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <PickAutopsy pick={open} onClose={() => setOpenId(null)} />
    </section>
  );
}

function Datum({
  label,
  value,
  color = "text",
}: {
  label: string;
  value: string;
  color?: "edge" | "warn" | "kill" | "signal" | "muted" | "text";
}) {
  return (
    <div className="px-3 py-2 border-r border-[var(--border)] last:border-r-0">
      <p className="eyebrow text-[var(--muted)]">{label}</p>
      <p className="numeric text-lg sm:text-xl mt-0.5" style={{ color: `var(--${color})` }}>
        {value}
      </p>
    </div>
  );
}

// Model vs market disagreement — the visual center of the product per spec
function ModelMarketBar({
  modelProb,
  marketProb,
  edge,
}: {
  modelProb: number;
  marketProb: number;
  edge: number;
}) {
  const m = modelProb * 100;
  const mk = marketProb * 100;
  return (
    <div className="mt-5">
      <div className="flex justify-between mb-1">
        <span className="eyebrow text-[var(--signal)]">MODEL {m.toFixed(1)}%</span>
        <span className="eyebrow text-[var(--edge)]">+{(edge * 100).toFixed(2)} EDGE</span>
        <span className="eyebrow text-[var(--muted)]">MARKET {mk.toFixed(1)}%</span>
      </div>
      <div className="relative h-2.5" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)" }}>
        {/* market track */}
        <div
          className="absolute inset-y-0 left-0"
          style={{ width: `${mk}%`, background: "rgba(125,138,153,0.35)" }}
        />
        {/* model track overlaid */}
        <div
          className="absolute inset-y-0 left-0"
          style={{ width: `${m}%`, background: "var(--signal)", opacity: 0.7 }}
        />
        {/* edge delta — vertical marker between market and model */}
        <div
          className="absolute inset-y-0"
          style={{
            left: `${Math.min(m, mk)}%`,
            width: `${Math.abs(m - mk)}%`,
            background: "repeating-linear-gradient(45deg, var(--edge) 0, var(--edge) 4px, transparent 4px, transparent 8px)",
            opacity: 0.85,
          }}
        />
      </div>
    </div>
  );
}
