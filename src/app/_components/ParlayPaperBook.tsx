// Experiment No. 4 — the parlay paper book ($10k). Thesis: three INDEPENDENT
// +EV prop legs across DISTINCT games multiply into a +EV parlay so long as
// the compounded edge survives a −4pt/leg fair-prob haircut. The book opens a
// parlay only when ≥3 such legs land across different games, sizes the combined
// price at quarter-Kelly, and settles on real box scores. Compressed to a
// ledger card until the first settle — a visual sibling of DevigPaperBook.

import { getParlayLedgerView } from "@/lib/parlay-paper";
import { KalshiEquityCurve } from "./KalshiEquityCurve";

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtUsd2 = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
// Parlay decimal odds → American, for the card line. Invalid (≤1, NaN) → em-dash.
const fmtParlayOdds = (decimal: number) => {
  if (!Number.isFinite(decimal) || decimal <= 1) return "—";
  const american = decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
  const rounded = Math.round(american);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
};

function gameTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function ParlayPaperBook() {
  let view;
  try {
    view = getParlayLedgerView();
  } catch {
    return null; // book unavailable — hide the card
  }
  const { stats, config, open, settled, equityCurve } = view;

  const pnlTone =
    stats.realizedPnlUsd > 0 ? "var(--win)" : stats.realizedPnlUsd < 0 ? "var(--loss)" : "var(--ink-3)";
  const hasSettles = settled.length > 0;
  const haircutPts = Math.round(config.haircutPerLegProb * 100);

  return (
    <article id="parlay-paper-book" className="panel">
      <header className="px-4 sm:px-5 py-3" style={{ borderBottom: "3px double var(--rule-strong)" }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display font-semibold text-lg text-ink leading-tight">
            Exp. No. 4 — Parlay paper, $10k
          </h3>
          <span className="tag" style={{ color: "var(--blue)" }}>Paper · Live</span>
        </div>
        <p className="num text-[0.7rem] text-ink-2 leading-relaxed mt-1 max-w-3xl">
          Combines {config.legsPerParlay} INDEPENDENT +EV prop legs from different games
          (correlation blocked) — opened only when the compounded EV stays positive after a
          −{haircutPts}pt/leg fair-prob haircut, sized at {config.kellyMultiplier}× Kelly on the
          combined price. Settled on real box scores.
        </p>
      </header>

      {/* Stat strip — mirrors DevigPaperBook */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-rule border-b border-rule bg-paper-2">
        <Tile label="Equity" value={fmtUsd2(stats.equityUsd)} sub={`of ${fmtUsd(stats.startingBankrollUsd)} start`} />
        <Tile
          label="Realized P&L"
          value={`${stats.realizedPnlUsd >= 0 ? "+" : ""}${fmtUsd2(stats.realizedPnlUsd)}`}
          tone={pnlTone}
          sub={hasSettles ? `${stats.roiPct >= 0 ? "+" : ""}${stats.roiPct.toFixed(2)}% ROI` : "—"}
        />
        <Tile
          label="Open exposure"
          value={fmtUsd2(stats.exposureUsd)}
          sub={`${stats.openCount} parlay${stats.openCount === 1 ? "" : "s"}`}
        />
        <Tile
          label="Record"
          value={`${stats.wins}–${stats.losses}${stats.voids ? `–${stats.voids}` : ""}`}
          sub={
            stats.yieldPct != null
              ? `${stats.yieldPct >= 0 ? "+" : ""}${stats.yieldPct}% yield`
              : "awaiting first settle"
          }
        />
      </div>

      {hasSettles ? (
        <>
          {equityCurve.length >= 2 && (
            <figure className="p-4 border-b border-rule">
              <figcaption className="eyebrow mb-3">Equity curve</figcaption>
              <KalshiEquityCurve data={equityCurve} baseline={stats.startingBankrollUsd} />
            </figure>
          )}
          <div className="overflow-x-auto border-b border-rule">
            <table className="ledger-table">
              <caption className="sr-only">Recently settled parlays</caption>
              <thead>
                <tr>
                  <th scope="col">Settled parlay</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Price</th>
                  <th scope="col" className="text-right">Result</th>
                  <th scope="col" className="text-right">P&L</th>
                </tr>
              </thead>
              <tbody>
                {settled.slice(0, 15).map(p => {
                  const won = p.status === "won";
                  const lost = p.status === "lost";
                  const tone = won ? "var(--win)" : lost ? "var(--loss)" : "var(--ink-3)";
                  const legLine = p.legs
                    .map(l => `${l.player} ${l.side} ${l.line} ${l.propType}`)
                    .join(" · ");
                  return (
                    <tr key={p.id}>
                      <td className="max-w-[340px] text-sm text-ink">
                        <span className="block leading-snug break-words line-clamp-2" title={legLine}>
                          {p.legs.map(l => l.player).join(" + ")}
                        </span>
                        <span className="num text-[0.65rem] text-ink-3">
                          {p.legs.length} legs · {fmtParlayOdds(p.parlayDecimalOdds)}
                        </span>
                      </td>
                      <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                        {fmtParlayOdds(p.parlayDecimalOdds)}
                      </td>
                      <td className="text-right">
                        <span className="tag" style={{ color: tone }}>
                          {p.status}
                        </span>
                      </td>
                      <td
                        className="num text-sm text-right font-semibold"
                        style={{ color: (p.pnlUsd ?? 0) >= 0 ? "var(--win)" : "var(--loss)" }}
                      >
                        {(p.pnlUsd ?? 0) >= 0 ? "+" : ""}
                        {fmtUsd2(p.pnlUsd ?? 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="px-4 sm:px-5 py-3 border-b border-rule tag" style={{ color: "var(--hold)" }}>
          No independent +EV triples yet
          {open.length === 0
            ? ` · the book opens a parlay only when ≥${config.legsPerParlay} playable legs land across different games — an empty book is the honest result`
            : ` · ${open.length} parlay${open.length === 1 ? "" : "s"} riding`}
        </p>
      )}

      {/* Open book — printed disclosure */}
      {open.length > 0 && (
        <details className="group">
          <summary className="px-4 sm:px-5 py-2.5 cursor-pointer list-none flex items-baseline justify-between hover:bg-paper-3/60 transition-colors">
            <span className="eyebrow">Open parlays · {open.length}</span>
            <span className="eyebrow text-ink-3 group-open:hidden">+ Unfold</span>
            <span className="eyebrow text-ink-3 hidden group-open:inline">− Fold</span>
          </summary>
          <div className="overflow-x-auto border-t border-rule">
            <table className="ledger-table">
              <caption className="sr-only">Open parlays</caption>
              <thead>
                <tr>
                  <th scope="col">Parlay</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Price</th>
                  <th scope="col" className="text-right">EV</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Stake</th>
                  <th scope="col" className="text-right hidden sm:table-cell">First leg</th>
                </tr>
              </thead>
              <tbody>
                {open.slice(0, 20).map(p => {
                  const firstCommence = p.legs
                    .map(l => l.commence)
                    .sort((a, b) => a.localeCompare(b))[0];
                  const legLine = p.legs
                    .map(l => `${l.player} ${l.side} ${l.line} ${l.propType}`)
                    .join(" · ");
                  return (
                    <tr key={p.id}>
                      <td className="max-w-[320px] text-sm text-ink">
                        <span className="block leading-snug break-words line-clamp-2" title={legLine}>
                          {p.legs.map(l => l.player).join(" + ")}
                        </span>
                        <span className="num text-[0.65rem] text-ink-3 sm:hidden">
                          {fmtParlayOdds(p.parlayDecimalOdds)} · {fmtUsd2(p.stakeUsd)} ·{" "}
                          {gameTime(firstCommence)}
                        </span>
                      </td>
                      <td className="num text-sm text-right text-ink hidden sm:table-cell">
                        {fmtParlayOdds(p.parlayDecimalOdds)}
                      </td>
                      <td className="num text-sm text-right font-medium" style={{ color: "var(--win)" }}>
                        +{(p.parlayEV * 100).toFixed(1)}%
                      </td>
                      <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                        {fmtUsd2(p.stakeUsd)}
                      </td>
                      <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                        {gameTime(firstCommence)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {open.length > 20 && (
              <p className="eyebrow text-ink-3 px-4 py-2 border-t border-rule">
                + {open.length - 20} more
              </p>
            )}
          </div>
        </details>
      )}

      <p className="eyebrow text-ink-3 leading-relaxed px-4 sm:px-5 py-2.5 border-t border-rule">
        Simulated · not financial advice. Legs are the props board&rsquo;s already-validated
        +EV quotes (≥{(config.evFloor * 100).toFixed(0)}% vs the de-vigged sharp prop line),
        combined only across {config.legsPerParlay} distinct games so the joint probability is
        the product. The book books nothing unless the compounded EV survives a per-leg haircut —
        the parlay&rsquo;s honest test of whether independent edges really multiply.
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
