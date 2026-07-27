// Experiment No. 5 — the NFL backtest, surfaced as a RESEARCH / DRY-RUN card.
// Mirrors the DevigPaperBook ledger-card aesthetic but is deliberately NOT a live
// $10k paper book: it's a leak-free Elo fair value vs nflverse ~closing lines.
// The headline is CLV (Benter doctrine), which is ≈0 by construction for a
// dry-run. Reads ONLY the aggregate summary (data/processed/nfl-exp5.json) — the
// raw per-week picks stay private under data/private/. Hides when the file is
// absent (nflExp5 === null).
//
// Below the stat strip it surfaces a few EXAMPLE settled picks (the model's Elo
// fair-value reasoning) and, when present, an example PROPS section — both are
// dry-run illustrations, not live bets, and each hides when its data is absent.

import type { NflExp5 } from "../_data/dashboard";

const fmtPp = (n: number | null): string =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}pp`;
const fmtPct = (n: number | null): string =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const fmtRatePct = (n: number | null): string =>
  n == null ? "—" : `${n.toFixed(1)}%`;
const fmtEdge = (n: number): string =>
  Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(1)}%` : "—";

// Compact "Wk 7 · 2024"-style provenance tag for an example row.
const provenance = (season: number | null, week: number | null): string => {
  const parts: string[] = [];
  if (week != null) parts.push(`Wk ${week}`);
  if (season != null) parts.push(`${season}`);
  return parts.join(" · ");
};

// Map nflverse stat keys → human prop nouns. Unknown keys pass through.
const STAT_LABELS: Record<string, string> = {
  passYds: "pass yds",
  passTDs: "pass TDs",
  rushYds: "rush yds",
  recYds: "rec yds",
  recTDs: "rec TDs",
};
const statLabel = (stat: string): string => STAT_LABELS[stat] ?? stat;

// "J. Allen" — first-initial last-name, defensive against single-token names.
const shortName = (full: string): string => {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  const last = parts[parts.length - 1];
  return `${parts[0][0]}. ${last}`;
};

export function NflExp5({ data }: { data: NflExp5 | null }) {
  if (!data) return null; // summary unavailable — hide the card

  const {
    record,
    settled,
    clvBeatRatePct,
    avgClvProbPoints,
    roiPct,
    examplePicks,
    props,
    parlays,
  } = data;

  const roiTone = roiPct > 0 ? "var(--win)" : roiPct < 0 ? "var(--loss)" : "var(--ink-3)";
  // CLV is the headline (Benter): a research dry-run is expected near zero, so
  // it reads as neutral ink unless it genuinely clears the close.
  const clvTone =
    avgClvProbPoints != null && avgClvProbPoints > 0
      ? "var(--win)"
      : avgClvProbPoints != null && avgClvProbPoints < 0
        ? "var(--loss)"
        : "var(--ink-3)";

  // Section guards — each block hides when its data is absent.
  const games = examplePicks ?? [];
  const showGames = games.length > 0;
  const propExamples = props?.examples ?? [];
  const showProps = props != null && propExamples.length > 0;
  const showParlays = parlays != null && parlays.settled > 0;
  // The yield beats break-even => a real in-sample edge; tone it as a win, but
  // the framing copy keeps it honest (graded vs ~closing lines, CLV ≈ 0).
  const parlayYieldTone =
    parlays && parlays.roiPct > 0 ? "var(--win)" : parlays && parlays.roiPct < 0 ? "var(--loss)" : "var(--ink-3)";
  const beatsBreakEven = parlays != null && parlays.winRatePct > parlays.breakEvenPct;

  return (
    <article id="nfl-exp5" className="panel">
      <header className="px-4 sm:px-5 py-3" style={{ borderBottom: "3px double var(--rule-strong)" }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display font-semibold text-lg text-ink leading-tight">
            Exp. No. 5 — NFL backtest (research dry-run)
          </h3>
          <span className="tag" style={{ color: "var(--hold)" }}>Research · Dry-run</span>
        </div>
        <p className="num text-[0.7rem] text-ink-2 leading-relaxed mt-1 max-w-3xl">
          A leak-free Elo fair value walked across {settled} settled NFL bets
          (2023–2025), judged the desk way — by closing-line value, not wins.
          Not a live bet book; the raw per-week picks stay private.
        </p>
      </header>

      {/* Stat strip — CLV is the headline (Benter doctrine) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-rule border-b border-rule bg-paper-2">
        <Tile
          label="CLV beat rate"
          value={fmtRatePct(clvBeatRatePct)}
          sub={`avg ${fmtPp(avgClvProbPoints)} vs close`}
          tone={clvTone}
        />
        <Tile
          label="Record"
          value={`${record.wins}–${record.losses}${record.pushes ? `–${record.pushes}` : ""}`}
          sub="W–L, dry-run"
        />
        <Tile
          label="ROI"
          value={fmtPct(roiPct)}
          sub="on a flat $10k book"
          tone={roiTone}
        />
        <Tile label="Settled n" value={`${settled}`} sub="graded bets" />
      </div>

      {/* Why these picks — example settled game picks + Elo reasoning */}
      {showGames && (
        <section className="border-b border-rule">
          <div className="px-4 sm:px-5 py-2.5 flex flex-wrap items-baseline justify-between gap-2 bg-paper-2 border-b border-rule">
            <h4 className="eyebrow text-ink">Why these picks</h4>
            <span className="eyebrow text-ink-3">Elo fair value · sample of {games.length}</span>
          </div>
          <ul className="divide-y divide-rule">
            {games.map((p, i) => {
              const won = p.result === "won";
              const lost = p.result === "lost";
              const tone = won ? "var(--win)" : lost ? "var(--loss)" : "var(--ink-3)";
              const prov = provenance(p.season, p.week);
              return (
                <li key={`${p.matchup}-${p.selection}-${i}`} className="px-4 sm:px-5 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="num text-sm text-ink leading-snug min-w-0">
                      <span
                        aria-hidden
                        className="inline-block w-2 h-2 rounded-full mr-2 align-middle shrink-0"
                        style={{ background: tone }}
                      />
                      <span className="font-semibold">{p.selection}</span>
                      <span className="text-ink-3"> · {p.matchup}</span>
                      {p.market && <span className="text-ink-3"> · {p.market}</span>}
                    </p>
                    <span className="num text-xs text-right shrink-0" style={{ color: tone }}>
                      {p.result}
                      <span className="text-ink-3"> · {fmtEdge(p.edgePct)}</span>
                    </span>
                  </div>
                  <p className="text-[0.78rem] text-ink-2 leading-relaxed mt-1">
                    {p.explanation}
                  </p>
                  {prov && <p className="eyebrow text-ink-3 mt-1">{prov}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Player props — record tile + example settled prop picks + rationale.
          Entire section hides when props is null or has no examples. */}
      {showProps && (
        <section className="border-b border-rule">
          <div className="px-4 sm:px-5 py-2.5 flex flex-wrap items-baseline justify-between gap-2 bg-paper-2 border-b border-rule">
            <div className="flex items-baseline gap-3">
              <h4 className="eyebrow text-ink">Player props</h4>
              <span className="num text-xs text-ink-2">
                {props.record.wins}–{props.record.losses}
                {props.record.pushes ? `–${props.record.pushes}` : ""}
              </span>
            </div>
            <span className="eyebrow text-ink-3">
              Research · Dry-run · {props.settled} settled
              {props.noData ? ` · ${props.noData} no-line` : ""}
            </span>
          </div>
          <ul className="divide-y divide-rule">
            {propExamples.map((x, i) => {
              const won = x.result === "win";
              const lost = x.result === "loss";
              const tone = won ? "var(--win)" : lost ? "var(--loss)" : "var(--ink-3)";
              const prov = provenance(x.season, x.week);
              const line = `${shortName(x.player)} · ${x.team} — ${x.side.toUpperCase()} ${x.threshold} ${statLabel(x.stat)}`;
              return (
                <li key={`${x.player}-${x.stat}-${i}`} className="px-4 sm:px-5 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="num text-sm text-ink leading-snug min-w-0">
                      <span
                        aria-hidden
                        className="inline-block w-2 h-2 rounded-full mr-2 align-middle shrink-0"
                        style={{ background: tone }}
                      />
                      <span className="font-semibold">{line}</span>
                    </p>
                    <span className="num text-xs text-right shrink-0" style={{ color: tone }}>
                      {x.result}
                    </span>
                  </div>
                  <p className="text-[0.78rem] text-ink-2 leading-relaxed mt-1">
                    {x.rationale}
                  </p>
                  {prov && <p className="eyebrow text-ink-3 mt-1">{prov}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* 3-leg parlays — the HONEST framing: flat-stake yield (not the Kelly
          equity curve), win rate vs the break-even the odds require, and the
          CLV≈0 upper-bound caveat. Hides when no parlay was formed. */}
      {showParlays && parlays && (
        <section className="border-b border-rule">
          <div className="px-4 sm:px-5 py-2.5 flex flex-wrap items-baseline justify-between gap-2 bg-paper-2 border-b border-rule">
            <div className="flex items-baseline gap-3">
              <h4 className="eyebrow text-ink">3-leg parlays</h4>
              <span className="num text-xs text-ink-2">
                {parlays.record.wins}–{parlays.record.losses}
                {parlays.record.pushes ? `–${parlays.record.pushes}` : ""}
              </span>
            </div>
            <span className="eyebrow text-ink-3">Research · Dry-run · {parlays.settled} settled</span>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-rule">
            <Tile
              label="Flat-stake yield"
              value={fmtPct(parlays.roiPct)}
              sub="profit per 1u risked"
              tone={parlayYieldTone}
            />
            <Tile
              label="Win rate"
              value={fmtRatePct(parlays.winRatePct)}
              sub={`needs ${fmtRatePct(parlays.breakEvenPct)} to break even`}
              tone={beatsBreakEven ? "var(--win)" : "var(--loss)"}
            />
            <Tile
              label="Break-even"
              value={fmtRatePct(parlays.breakEvenPct)}
              sub="win rate the odds require"
            />
            <Tile
              label="Avg leg edge"
              value={parlays.avgLegsEdge == null ? "—" : fmtRatePct(parlays.avgLegsEdge * 100)}
              sub="model vs the line"
            />
          </div>

          <p className="text-[0.78rem] text-ink-2 leading-relaxed px-4 sm:px-5 py-2.5">
            {beatsBreakEven ? (
              <>
                The {fmtRatePct(parlays.winRatePct)} win rate clears the{" "}
                {fmtRatePct(parlays.breakEvenPct)} the odds require, so the edge is{" "}
                <span className="font-semibold" style={{ color: "var(--win)" }}>real in-sample</span>.
              </>
            ) : (
              <>The {fmtRatePct(parlays.winRatePct)} win rate is short of the {fmtRatePct(parlays.breakEvenPct)} the odds require.</>
            )}{" "}
            Reported as a <span className="font-semibold">flat 1u per parlay</span> — not a
            compounding bankroll. Graded vs nflverse ~closing lines (CLV ≈ 0), so the yield is an{" "}
            <span className="font-semibold">optimistic upper bound</span> for live betting, not a forecast.
          </p>
        </section>
      )}

      <p className="eyebrow text-ink-3 leading-relaxed px-4 sm:px-5 py-2.5 border-t border-rule">
        Quiet offseason backtest — leak-free Elo fair value vs nflverse ~closing
        lines; CLV ≈ 0 by construction for a dry-run; not live betting. Goes live
        for the 2026 season.
      </p>
    </article>
  );
}

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="px-4 py-3">
      <p className="eyebrow text-ink-3">{label}</p>
      <p className="num-display text-xl mt-1" style={{ color: tone ?? "var(--ink)" }}>
        {value}
      </p>
      {sub && <p className="eyebrow text-ink-3 mt-0.5">{sub}</p>}
    </div>
  );
}
