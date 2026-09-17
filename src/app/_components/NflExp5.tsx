// NFL — the receipts, as a pointer card on /experiments.
//
// Condensed 2026-09-12: this card used to be a third copy of /nfl's Part Two
// (the same nfl-exp5.json rendered in full by ResearchAppendix), with sixteen
// sample rows, a stat strip and a second thing called "Experiment 5". Now it
// is two prose lines and two links — every figure in them is the same field
// ResearchAppendix prints under its caveats, and the example rows live there
// and only there.
//
// Hides when the summary file is absent (nflExp5 === null).

import type { NflExp5 } from "../_data/dashboard";

const fmtPp = (n: number | null): string =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}pp`;
const fmtPct = (n: number | null): string =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const fmtRatePct = (n: number | null): string =>
  n == null ? "—" : `${n.toFixed(1)}%`;
const rec = (r: { wins: number; losses: number; pushes: number }): string =>
  `${r.wins}–${r.losses}${r.pushes ? `–${r.pushes}` : ""}`;

export function NflExp5({ data }: { data: NflExp5 | null }) {
  if (!data) return null; // summary unavailable — hide the card

  const { record, settled, clvBeatRatePct, avgClvProbPoints, roiPct, props, parlays } = data;
  const roiTone = roiPct > 0 ? "var(--win)" : roiPct < 0 ? "var(--loss)" : "var(--ink)";

  return (
    <article id="nfl-exp5" className="panel">
      <header className="px-4 sm:px-5 py-3" style={{ borderBottom: "3px double var(--rule-strong)" }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display font-semibold text-lg text-ink leading-tight">
            NFL — the receipts <span className="eyebrow text-ink-3 ml-1">Exp. No. 5</span>
          </h3>
          <span className="tag" style={{ color: "var(--blue)" }}>Live on /nfl</span>
        </div>
      </header>

      <div className="px-4 sm:px-5 py-3 space-y-2">
        <p className="prose" style={{ fontSize: "0.875rem" }}>
          <strong>Live season</strong> — pre-registered on the receipts page; the verdict metric
          is closing-line value against a sharp close, and no return is claimed.
        </p>
        <p className="prose" style={{ fontSize: "0.875rem" }}>
          <strong>Backtest</strong>, research dry-run, judged by CLV: a leak-free Elo fair value
          walked across <span className="num">{settled}</span> settled NFL bets (2015–2024),{" "}
          <span className="num">{rec(record)}</span> ML, CLV beat rate{" "}
          <span className="num">{fmtRatePct(clvBeatRatePct)}</span> (avg{" "}
          <span className="num">{fmtPp(avgClvProbPoints)}</span> vs close), flat-stake ROI{" "}
          <span className="num" style={{ color: roiTone }}>{fmtPct(roiPct)}</span>
          {props ? (
            <>
              ; <span className="num">{rec(props.record)}</span> props ({props.settled} settled)
            </>
          ) : null}
          {parlays && parlays.settled > 0 ? (
            <>
              ; <span className="num">{rec(parlays.record)}</span> three-leg parlays
            </>
          ) : null}
          . In-sample; the pre-registered 2025 holdout was negative.
        </p>
        <p className="prose" style={{ fontSize: "0.875rem" }}>
          <a href="/nfl">The live receipts →</a>
          {" · "}
          <a href="/nfl#research">Full backtest, with its caveats →</a>
        </p>
      </div>
    </article>
  );
}
