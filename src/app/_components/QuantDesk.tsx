// FOL. 10 — THE QUANT DESK (MLB live paper).
//
// Doctrine (Benter / Benham / Bloom): a proprietary model makes fair
// probabilities; bet ONLY model-vs-market mispricings; size 1/4-Kelly with a
// drawdown rail; judge by CLOSING-LINE VALUE, not wins. Mirrors DevigPaperBook's
// styling. Reads getQuantDeskView() directly; hides gracefully when empty.

import { getQuantDeskView } from "@/lib/quant-desk/store";
import { DevigEquityCurve } from "./DevigEquityCurve";

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtUsd2 = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const fmtOdds = (n: number) =>
  Number.isFinite(n) && Math.abs(n) >= 100 ? (n > 0 ? `+${n}` : `${n}`) : "—";

function gameTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function QuantDesk() {
  let view;
  try {
    view = getQuantDeskView("MLB");
  } catch {
    return null;
  }
  const { stats, config, open, settled, equityCurve } = view;

  // Hide entirely when the desk has never traded AND has no opportunities riding
  // — an empty book with no history is nothing to show.
  if (stats.settledCount === 0 && open.length === 0 && equityCurve.length === 0) {
    return null;
  }

  const pnlTone =
    stats.realizedPnlUsd > 0 ? "var(--win)" : stats.realizedPnlUsd < 0 ? "var(--loss)" : "var(--ink-3)";
  const hasSettles = settled.length > 0;
  const railActive = stats.equityUsd < stats.startingBankrollUsd * (1 - config.maxDrawdown);
  const clvTone =
    stats.avgClvProbPoints == null
      ? "var(--ink-3)"
      : stats.avgClvProbPoints >= 0
        ? "var(--win)"
        : "var(--loss)";

  return (
    <article id="quant-desk" className="panel">
      <header className="px-4 sm:px-5 py-3" style={{ borderBottom: "3px double var(--rule-strong)" }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display font-semibold text-lg text-ink leading-tight">
            The Quant Desk — model-edge MLB, $10k paper
          </h3>
          <span className="tag" style={{ color: railActive ? "var(--loss)" : "var(--blue)" }}>
            {railActive ? "Paper · Rail active" : "Paper · Live"}
          </span>
        </div>
        <p className="num text-[0.7rem] text-ink-2 leading-relaxed mt-1 max-w-3xl">
          A proprietary model makes fair probabilities; the desk bets ONLY where the market is
          mispriced vs the model — edge = model − de-vigged market ≥ {(config.edgeFloor * 100).toFixed(0)}%,
          on the sharp-favored side. {config.kellyMultiplier}× Kelly, ≤{(config.maxStakePctEquity * 100).toFixed(0)}%/bet,
          {" "}with a {(config.maxDrawdown * 100).toFixed(0)}% drawdown rail. Judged by CLV, not wins.
        </p>
      </header>

      {/* Stat strip — equity, CLV (headline), open, record */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-rule border-b border-rule bg-paper-2">
        <Tile label="Equity" value={fmtUsd2(stats.equityUsd)} sub={`of ${fmtUsd(stats.startingBankrollUsd)} start`} />
        <Tile
          label="CLV · beat-rate"
          value={stats.clvBeatRatePct == null ? "—" : `${stats.clvBeatRatePct}%`}
          tone={clvTone}
          sub={
            stats.avgClvProbPoints == null
              ? `awaiting settles`
              : `avg ${stats.avgClvProbPoints >= 0 ? "+" : ""}${stats.avgClvProbPoints}pp · n=${stats.clvSettledCount}`
          }
        />
        <Tile
          label="Open plays"
          value={String(stats.openCount)}
          sub={`${fmtUsd2(stats.exposureUsd)} exposure`}
        />
        <Tile
          label="Record"
          value={`${stats.wins}–${stats.losses}${stats.pushes ? `–${stats.pushes}` : ""}`}
          sub={
            hasSettles
              ? `${stats.realizedPnlUsd >= 0 ? "+" : ""}${fmtUsd2(stats.realizedPnlUsd)} · ${stats.yieldPct == null ? "—" : (stats.yieldPct >= 0 ? "+" : "") + stats.yieldPct + "% yield"}`
              : "awaiting first settle"
          }
          tone={hasSettles ? pnlTone : undefined}
        />
      </div>

      {railActive && (
        <p className="px-4 sm:px-5 py-2.5 border-b border-rule tag" style={{ color: "var(--loss)" }}>
          Drawdown rail engaged · equity {(stats.drawdownPct * 100).toFixed(1)}% below peak —
          no new plays opened until the book recovers above the floor
        </p>
      )}

      {hasSettles ? (
        <>
          {equityCurve.length >= 2 && (
            <figure className="p-4 border-b border-rule">
              <figcaption className="eyebrow mb-3">Equity curve</figcaption>
              <DevigEquityCurve data={equityCurve} baseline={stats.startingBankrollUsd} />
            </figure>
          )}
          <div className="overflow-x-auto border-b border-rule">
            <table className="ledger-table">
              <caption className="sr-only">Recently settled quant-desk plays</caption>
              <thead>
                <tr>
                  <th scope="col">Settled play</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Edge</th>
                  <th scope="col" className="text-right hidden sm:table-cell">CLV</th>
                  <th scope="col" className="text-right">Result</th>
                  <th scope="col" className="text-right">P&L</th>
                </tr>
              </thead>
              <tbody>
                {settled.slice(0, 15).map(b => {
                  const won = b.status === "won";
                  const lost = b.status === "lost";
                  const tone = won ? "var(--win)" : lost ? "var(--loss)" : "var(--ink-3)";
                  return (
                    <tr key={b.id}>
                      <td className="max-w-[300px] text-sm text-ink">
                        <span className="block leading-snug break-words line-clamp-2" title={b.finalScore ?? b.matchup}>
                          {b.selection}
                        </span>
                        <span className="num text-[0.65rem] text-ink-3 sm:hidden">
                          edge +{(b.edge * 100).toFixed(1)}% · {fmtOdds(b.priceAmerican)}
                        </span>
                      </td>
                      <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                        +{(b.edge * 100).toFixed(1)}%
                      </td>
                      <td
                        className="num text-xs text-right hidden sm:table-cell"
                        style={{ color: (b.clvProbPoints ?? 0) >= 0 ? "var(--win)" : "var(--loss)" }}
                      >
                        {b.clvProbPoints == null ? "—" : `${b.clvProbPoints >= 0 ? "+" : ""}${b.clvProbPoints.toFixed(2)}pp`}
                      </td>
                      <td className="text-right">
                        <span className="tag" style={{ color: tone }}>{b.status}</span>
                      </td>
                      <td
                        className="num text-sm text-right font-semibold"
                        style={{ color: (b.pnlUsd ?? 0) >= 0 ? "var(--win)" : "var(--loss)" }}
                      >
                        {(b.pnlUsd ?? 0) >= 0 ? "+" : ""}{fmtUsd2(b.pnlUsd ?? 0)}
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
          Awaiting first settle
          {open.length === 0
            ? ` · no open plays — a model edge ≥ ${(config.edgeFloor * 100).toFixed(0)}% vs the de-vigged market is rare; an empty board is the honest result of an efficient market`
            : ` · ${open.length} play${open.length === 1 ? "" : "s"} riding`}
        </p>
      )}

      {/* Open plays — top model-vs-market mispricings */}
      {open.length > 0 && (
        <details className="group" open={!hasSettles}>
          <summary className="px-4 sm:px-5 py-2.5 cursor-pointer list-none flex items-baseline justify-between hover:bg-paper-3/60 transition-colors">
            <span className="eyebrow">Open plays · {open.length} · best edge first</span>
            <span className="eyebrow text-ink-3 group-open:hidden">+ Unfold</span>
            <span className="eyebrow text-ink-3 hidden group-open:inline">− Fold</span>
          </summary>
          <div className="overflow-x-auto border-t border-rule">
            <table className="ledger-table">
              <caption className="sr-only">Open quant-desk plays</caption>
              <thead>
                <tr>
                  <th scope="col">Play</th>
                  <th scope="col" className="text-right">Edge</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Model</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Price</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Stake</th>
                </tr>
              </thead>
              <tbody>
                {open.slice(0, 20).map(b => (
                  <tr key={b.id}>
                    <td className="max-w-[300px] text-sm text-ink">
                      <span className="block leading-snug break-words line-clamp-2" title={b.matchup}>
                        {b.selection} <span className="eyebrow text-ink-3">@ {b.book}</span>
                        {b.estimate && <span className="eyebrow text-ink-3"> · est</span>}
                      </span>
                      <span className="num text-[0.65rem] text-ink-3 sm:hidden">
                        {fmtOdds(b.priceAmerican)} · {fmtUsd2(b.stakeUsd)} · {gameTime(b.commenceTime)}
                      </span>
                    </td>
                    <td className="num text-sm text-right font-medium" style={{ color: "var(--win)" }}>
                      +{(b.edge * 100).toFixed(1)}%
                    </td>
                    <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                      {(b.modelFairProb * 100).toFixed(0)}%
                    </td>
                    <td className="num text-sm text-right text-ink hidden sm:table-cell">
                      {fmtOdds(b.priceAmerican)}
                    </td>
                    <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                      {fmtUsd2(b.stakeUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {open.length > 20 && (
              <p className="eyebrow text-ink-3 px-4 py-2 border-t border-rule">+ {open.length - 20} more</p>
            )}
          </div>
        </details>
      )}

      <p className="eyebrow text-ink-3 leading-relaxed px-4 sm:px-5 py-2.5 border-t border-rule">
        Simulated · not financial advice. Model fair values are estimates, not gospel. Edge basis:
        OUR model probability vs the de-vigged sharp line, taking the best soft price on the
        sharp-favored side. Sized at quarter-Kelly with a drawdown rail; judged by closing-line value,
        not wins. The desk places nothing real.
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
      <p className="num-display text-xl mt-1" style={{ color: tone ?? "var(--ink)" }}>{value}</p>
      {sub && <p className="eyebrow text-ink-3 mt-0.5">{sub}</p>}
    </div>
  );
}
