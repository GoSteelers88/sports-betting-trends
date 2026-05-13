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

// Per-kind labels keep the games / props sections visually distinct while
// reusing the same component shell. Anchors come straight from the spec
// (CommandHeader nav uses them).
const SECTION_LABELS = {
  games: {
    anchor: "survivors",
    index: "03",
    eyebrow: "SURVIVOR BRIEF · GAMES",
    title: "GAME SURVIVOR",
    subtitle:
      "Moneyline/spread/total picks that survived the analyst, grader, critic, and bankroll guard.",
    emptyTitle: "NO GAME EDGE",
    emptyHeadline: "No game picks survived the critic today.",
    emptyBody:
      "Discipline > action. Capital remains locked on the moneyline board. Nothing cleared the 6% edge floor + critic pass.",
  },
  props: {
    anchor: "prop-survivors",
    index: "04",
    eyebrow: "SURVIVOR BRIEF · PROPS",
    title: "PROP SURVIVOR",
    subtitle:
      "Player props that cleared the projector + critic. modelProb on every pick comes from get_prop_projection, not analyst reasoning.",
    emptyTitle: "NO PROP EDGE",
    emptyHeadline: "No prop picks survived today.",
    emptyBody:
      "Prop track is independent from games — the projector returned no qualifying edges, or the critic killed every one it found.",
  },
} as const;

export function SurvivorBrief({
  picks,
  kind = "games",
}: {
  picks: SlatePick[];
  kind?: "games" | "props";
}) {
  const [openId, setOpenId] = useState<number | null>(null);

  const labels = SECTION_LABELS[kind];

  // The brief: the single highest-edge survivor — that's the headline.
  // Other survivors get listed below as a stack.
  const sorted = [...picks].sort((a, b) => b.edge - a.edge);
  const headline = sorted[0] ?? null;
  const others = sorted.slice(1);

  if (!headline) {
    return (
      <section className="space-y-4">
        <SectionHeader
          id={labels.anchor}
          index={labels.index}
          label={labels.eyebrow}
          title={labels.emptyTitle}
          status="CAPITAL LOCKED"
          statusColor="muted"
        />
        <div className="surface p-8 sm:p-10">
          <p className="font-display text-2xl sm:text-3xl text-[var(--text)] mb-3">
            {labels.emptyHeadline}
          </p>
          <p className="font-mono text-sm text-[var(--muted)] max-w-xl">
            ▸ {labels.emptyBody}
          </p>
        </div>
      </section>
    );
  }

  const open = openId !== null ? picks.find(p => p.id === openId) ?? null : null;

  return (
    <section id={labels.anchor} className="space-y-10">
      {/* Editorial spread banner */}
      <div className="flex items-baseline justify-between flex-wrap gap-3 pb-3 border-b border-[var(--border)]">
        <p className="eyebrow">{labels.eyebrow}</p>
        <p className="eyebrow text-[var(--faint)]">
          {picks.length} survivor{picks.length === 1 ? "" : "s"} · critic passed
        </p>
      </div>

      {/* Magazine-style two-column spread:
            left column — pull quote (the pick + thesis)
            right column — narrow data rail */}
      <article className="grid grid-cols-1 lg:grid-cols-[1.7fr_1fr] gap-10 lg:gap-16">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-6">
            <span className="pill" style={{ color: "var(--edge)", borderColor: "var(--edge)" }}>
              ★ Top survivor
            </span>
            <span className="pill" style={{ color: "var(--signal)", borderColor: "var(--signal)" }}>
              {headline.league}
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
          </div>

          {headline.market === "prop" && headline.player ? (
            <>
              <h3
                className="font-display leading-[0.95] text-[var(--text)]"
                style={{
                  fontStyle: "italic",
                  fontSize: "clamp(3rem, 7.5vw, 6.5rem)",
                  letterSpacing: "-0.025em",
                }}
              >
                {headline.player}
              </h3>
              <p className="mt-2 font-mono text-xs text-[var(--muted)]">{headline.matchup}</p>
              <p
                className="mt-4 font-display text-2xl sm:text-3xl text-[var(--edge)]"
                style={{ fontStyle: "italic" }}
              >
                {headline.side?.toUpperCase()} {headline.line} {formatPropType(headline.propType)}
                <span className="text-[var(--text)] numeric" style={{ fontStyle: "normal" }}> @ {fmtAmerican(headline.oddsAmerican)}</span>
              </p>
            </>
          ) : (
            <>
              <h3
                className="font-display leading-[0.95] text-[var(--text)]"
                style={{
                  fontStyle: "italic",
                  fontSize: "clamp(3rem, 7.5vw, 6.5rem)",
                  letterSpacing: "-0.025em",
                }}
              >
                {headline.matchup}
              </h3>
              <p
                className="mt-4 font-display text-2xl sm:text-3xl text-[var(--edge)]"
                style={{ fontStyle: "italic" }}
              >
                {headline.selection}{" "}
                <span className="text-[var(--text)] numeric" style={{ fontStyle: "normal" }}>@ {fmtAmerican(headline.oddsAmerican)}</span>
              </p>
            </>
          )}

          {/* Thesis as pull-quote */}
          <blockquote
            className="mt-10 pl-6 border-l-2 border-[var(--edge)] font-display text-xl sm:text-2xl text-[var(--text)] leading-snug max-w-2xl"
            style={{ fontStyle: "italic" }}
          >
            {headline.thesis}
          </blockquote>

          <p className="mt-6 max-w-2xl text-sm text-[var(--muted)] leading-relaxed">
            <span className="eyebrow text-[var(--warn)] mr-2">What kills it</span>
            {headline.invalidation || "—"}
          </p>

          <button
            type="button"
            onClick={() => setOpenId(headline.id)}
            className="mt-10 eyebrow inline-flex items-center gap-3 text-[var(--text)] hover:text-[var(--edge)] transition-colors group"
          >
            <span className="w-10 h-px bg-current group-hover:w-16 transition-all duration-300" />
            Open autopsy
          </button>
        </div>

        {/* Right rail — narrow stat column */}
        <dl className="space-y-8 lg:border-l lg:border-[var(--border)] lg:pl-12">
          <RailStat label="Edge" value={fmtPct(headline.edge, 2)} color="edge" big />
          <RailStat label="Stake" value={`${headline.kellyStakeUnits.toFixed(2)}u`} />
          <RailStat label="Model probability" value={fmtPct(headline.modelProb)} color="signal" />
          <RailStat label="Market probability" value={fmtPct(headline.marketProb)} color="muted" />
          <RailStat label="Confidence" value={`${headline.confidence}`} />
          <RailStat
            label="CLV"
            value={
              headline.market === "prop"
                ? "n/a"
                : headline.clvCents !== null
                ? `${headline.clvCents > 0 ? "+" : ""}${headline.clvCents}¢`
                : "pending"
            }
            color={
              headline.market === "prop"
                ? "muted"
                : headline.clvCents !== null && headline.clvCents > 0
                ? "edge"
                : headline.clvCents !== null && headline.clvCents < 0
                ? "kill"
                : "muted"
            }
          />
        </dl>
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
                      <p className="font-sans text-sm truncate text-[var(--text)]">{p.player}</p>
                      <p className="font-mono text-xs text-[var(--muted)] truncate">
                        {p.side?.toUpperCase()} {p.line} {formatPropType(p.propType)} · {p.matchup}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-sans text-sm truncate text-[var(--text)]">{p.matchup}</p>
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

function RailStat({
  label,
  value,
  color = "text",
  big = false,
}: {
  label: string;
  value: string;
  color?: "edge" | "warn" | "kill" | "signal" | "muted" | "text";
  big?: boolean;
}) {
  const colorVar = color === "muted" ? "var(--muted)" : `var(--${color})`;
  return (
    <div>
      <p className="eyebrow mb-2">{label}</p>
      <p
        className="font-display leading-none"
        style={{
          fontStyle: "italic",
          fontSize: big ? "clamp(2.5rem, 5vw, 4rem)" : "clamp(1.5rem, 2.5vw, 2.25rem)",
          color: colorVar,
          letterSpacing: "-0.02em",
        }}
      >
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
