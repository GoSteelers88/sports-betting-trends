// Experiment No. 1 — the Kalshi favorite-longshot $10k paper trail,
// compressed to a ledger card until the first settle. Data logic untouched
// (getLedgerView). The equity chart prints only once real settles exist;
// the open book lives behind a printed disclosure. Constant columns (cost,
// resolution horizon) are stated once in the table footer, not 50 times.

import { getLedgerView } from "@/lib/kalshi/paperEngine";
import { KalshiEquityCurve } from "./KalshiEquityCurve";

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtUsd2 = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function daysUntil(iso: string): number | null {
  const d = (Date.parse(iso) - Date.now()) / 86_400_000;
  return Number.isFinite(d) ? d : null;
}

export async function KalshiPaperTrail() {
  let view;
  try {
    view = await getLedgerView();
  } catch {
    return null; // tables not migrated / DB unavailable — hide the card
  }
  const { stats, config, open, closed, equityCurve } = view;

  const pnlTone =
    stats.realizedPnlUsd > 0 ? "var(--win)" : stats.realizedPnlUsd < 0 ? "var(--loss)" : "var(--ink-3)";
  const hasSettles = closed.length > 0;

  // Footer constants — computed, not asserted
  const costs = open.map(p => p.costUsd).sort((a, b) => a - b);
  const medianCost = costs.length ? costs[Math.floor(costs.length / 2)] : null;
  const horizons = open
    .map(p => daysUntil(p.closeTime))
    .filter((d): d is number => d !== null);
  const maxHorizon = horizons.length ? Math.max(...horizons) : null;
  const horizonNote =
    maxHorizon === null ? "" : maxHorizon < 1 ? "all resolve <1d" : `all resolve ≤${Math.ceil(maxHorizon)}d`;

  return (
    <article id="kalshi-paper-trail" className="panel">
      <header className="px-4 sm:px-5 py-3" style={{ borderBottom: "3px double var(--rule-strong)" }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display font-semibold text-lg text-ink leading-tight">
            Exp. No. 1 — Kalshi favorite-longshot, $10k paper
          </h3>
          <span className="tag" style={{ color: "var(--blue)" }}>Paper · Live</span>
        </div>
        <p className="num text-[0.7rem] text-ink-2 leading-relaxed mt-1 max-w-3xl">
          Buys heavily-favored contracts ({config.minAsk.toFixed(2)}–{config.maxAsk.toFixed(2)},
          ≤{config.maxHorizonDays}d, ex-{config.excludeCategories.join("/").toUpperCase()}) — the
          crowd underprices near-locks. Maker fills at the bid, held to settlement.
        </p>
      </header>

      {/* Stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-rule border-b border-rule bg-paper-2">
        <Tile label="Equity" value={fmtUsd2(stats.equityUsd)} sub={`of ${fmtUsd(stats.startingBankrollUsd)} start`} />
        <Tile
          label="Realized P&L"
          value={`${stats.realizedPnlUsd >= 0 ? "+" : ""}${fmtUsd2(stats.realizedPnlUsd)}`}
          tone={pnlTone}
          sub={hasSettles ? `${stats.roiPct >= 0 ? "+" : ""}${stats.roiPct.toFixed(2)}% ROI` : "—"}
        />
        <Tile label="Open exposure" value={fmtUsd2(stats.exposureUsd)} sub={`${stats.openCount} positions`} />
        <Tile
          label="Settled"
          value={hasSettles ? `${stats.wins}–${stats.losses}` : "0–0"}
          sub={stats.winRatePct != null ? `${stats.winRatePct.toFixed(1)}% win` : "awaiting first settle"}
        />
      </div>

      {/* Fill reality — the engine assumes every resting bid fills; this strip
          reports which assumed fills verifiably traded through on the candle
          path, vs the adverse-selection backtest's 73.6% / 85.4% / 97.7%. */}
      {stats.fillTracking.confirmed + stats.fillTracking.missed > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-rule border-b border-rule">
          <Tile
            label="Verified fill rate"
            value={
              stats.fillTracking.fillRatePct != null
                ? `${stats.fillTracking.fillRatePct.toFixed(1)}%`
                : "—"
            }
            sub={`${stats.fillTracking.confirmed} of ${stats.fillTracking.confirmed + stats.fillTracking.missed} settled · backtest 73.6%`}
          />
          <Tile
            label="Win% · filled"
            value={
              stats.fillTracking.winRateConfirmedPct != null
                ? `${stats.fillTracking.winRateConfirmedPct.toFixed(1)}%`
                : "—"
            }
            sub={`${stats.fillTracking.confirmedWins}–${stats.fillTracking.confirmedLosses} · backtest 85.4%`}
          />
          <Tile
            label="Win% · missed"
            value={
              stats.fillTracking.winRateMissedPct != null
                ? `${stats.fillTracking.winRateMissedPct.toFixed(1)}%`
                : "—"
            }
            sub={`${stats.fillTracking.missedWins}–${stats.fillTracking.missedLosses} · backtest 97.7%`}
          />
          <Tile
            label="Filled-only P&L"
            value={`${stats.fillTracking.realizedPnlConfirmedUsd >= 0 ? "+" : ""}${fmtUsd2(stats.fillTracking.realizedPnlConfirmedUsd)}`}
            tone={
              stats.fillTracking.realizedPnlConfirmedUsd > 0
                ? "var(--win)"
                : stats.fillTracking.realizedPnlConfirmedUsd < 0
                  ? "var(--loss)"
                  : "var(--ink-3)"
            }
            sub={`vs ${fmtUsd2(stats.realizedPnlUsd)} assumed${stats.fillTracking.pending > 0 ? ` · ${stats.fillTracking.pending} unchecked` : ""}`}
          />
        </div>
      )}

      {hasSettles ? (
        <>
          {/* Equity curve — only once real settles exist */}
          {equityCurve.length >= 2 && (
            <figure className="p-4 border-b border-rule">
              <figcaption className="eyebrow mb-3">Equity curve</figcaption>
              <KalshiEquityCurve data={equityCurve} baseline={stats.startingBankrollUsd} />
            </figure>
          )}
          <div className="overflow-x-auto border-b border-rule">
            <table className="ledger-table">
              <caption className="sr-only">Recently settled Kalshi paper positions</caption>
              <thead>
                <tr>
                  <th scope="col">Settled market</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Entry</th>
                  <th scope="col" className="text-right">Result</th>
                  <th scope="col" className="text-right">P&L</th>
                </tr>
              </thead>
              <tbody>
                {closed.slice(0, 15).map(p => {
                  const won = p.result === "yes";
                  const fillNote =
                    p.fill === "confirmed" ? "fill ✓" : p.fill === "missed" ? "no fill" : "fill ?";
                  return (
                    <tr key={p.ticker}>
                      <td className="max-w-[340px] text-sm text-ink">
                        <span className="block leading-snug break-words line-clamp-2">{p.title}</span>
                        <span className="num text-[0.65rem] text-ink-3 sm:hidden">
                          entry {(p.entryPrice * 100).toFixed(0)}¢ · {fillNote}
                        </span>
                      </td>
                      <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                        {(p.entryPrice * 100).toFixed(0)}¢
                        <span
                          className="block text-[0.6rem]"
                          style={{ color: p.fill === "missed" ? "var(--hold)" : "var(--ink-3)" }}
                        >
                          {fillNote}
                        </span>
                      </td>
                      <td className="text-right">
                        <span className="tag" style={{ color: won ? "var(--win)" : "var(--loss)" }}>
                          {won ? "won" : "lost"}
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
          Awaiting first settle · {stats.openCount} positions riding
        </p>
      )}

      {/* Open book — printed disclosure */}
      {open.length > 0 && (
        <details className="group">
          <summary className="px-4 sm:px-5 py-2.5 cursor-pointer list-none flex items-baseline justify-between hover:bg-paper-3/60 transition-colors">
            <span className="eyebrow">Open positions · {open.length}</span>
            <span className="eyebrow text-ink-3 group-open:hidden">+ Unfold</span>
            <span className="eyebrow text-ink-3 hidden group-open:inline">− Fold</span>
          </summary>
          <div className="overflow-x-auto border-t border-rule">
            <table className="ledger-table">
              <caption className="sr-only">Open Kalshi paper positions</caption>
              <thead>
                <tr>
                  <th scope="col">Market</th>
                  <th scope="col" className="hidden sm:table-cell">Cat</th>
                  <th scope="col" className="text-right">Entry</th>
                </tr>
              </thead>
              <tbody>
                {open.map(p => (
                  <tr key={p.ticker}>
                    <td className="max-w-[420px] text-sm text-ink">
                      {/* Two-line row — wraps at word boundaries */}
                      <span className="block leading-snug break-words line-clamp-2">{p.title}</span>
                      <span className="tag text-ink-3 sm:hidden">{p.category}</span>
                    </td>
                    <td className="hidden sm:table-cell">
                      <span className="tag text-ink-3">{p.category}</span>
                    </td>
                    <td className="num text-sm text-right text-ink">
                      {(p.entryPrice * 100).toFixed(0)}¢
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* The constants, stated once */}
          <p className="eyebrow text-ink-3 px-4 sm:px-5 py-2 border-t border-rule">
            {open.length} positions{medianCost !== null ? ` · ~${fmtUsd(medianCost)} each` : ""}
            {horizonNote ? ` · ${horizonNote}` : ""}
          </p>
        </details>
      )}

      <p className="eyebrow text-ink-3 leading-relaxed px-4 sm:px-5 py-2.5 border-t border-rule">
        Simulated · not financial advice. Fills assume a resting limit order at the bid is filled
        (maker); each assumed fill is then verified against the hourly candle path (ask-low or
        trade-low ≤ bid). Backtest on 23,382 settled markets: only 73.6% of resting bids fill, and
        filled favorites win 85.4% vs 97.7% for missed — realized maker EV ≈ 0. Edge basis:
        Bürgi–Deng–Whelan (2026) &amp; Le (2026) — favorite-longshot bias.
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
