// Experiment No. 3 — the PEAD stock paper book ($10k, long extreme EPS
// surprises, 28d hold, vs SPY), compressed to a ledger card until the first
// settle. The verdict metric is excess-vs-SPY with a pre-registered kill
// rule (PEAD_PAPER_SPEC.md) — the raw P&L tile is deliberately secondary.

import { getStockLedgerView } from "@/lib/stocks/peadEngine";
import { KalshiEquityCurve } from "./KalshiEquityCurve";

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtUsd2 = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function daysUntil(iso: string): number | null {
  const d = (Date.parse(iso) - Date.now()) / 86_400_000;
  return Number.isFinite(d) ? d : null;
}

const VERDICT_COPY: Record<string, { label: string; tone: string }> = {
  accumulating: { label: "accumulating", tone: "var(--hold)" },
  extend: { label: "extend to n=80", tone: "var(--hold)" },
  validated: { label: "drift validated", tone: "var(--win)" },
  kill: { label: "killed", tone: "var(--loss)" },
};

export async function StockPaperBook() {
  let view;
  try {
    view = await getStockLedgerView();
  } catch {
    return null; // tables not migrated / DB unavailable — hide the card
  }
  const { stats, config, open, closed, equityCurve } = view;

  const pnlTone =
    stats.realizedPnlUsd > 0 ? "var(--win)" : stats.realizedPnlUsd < 0 ? "var(--loss)" : "var(--ink-3)";
  const hasSettles = closed.length > 0;
  const hasPositions = open.length > 0 || hasSettles;
  const verdict = VERDICT_COPY[stats.verdict] ?? VERDICT_COPY.accumulating;
  const excessTone =
    stats.avgExcessRetPct == null
      ? "var(--ink-3)"
      : stats.avgExcessRetPct > 0
        ? "var(--win)"
        : "var(--loss)";

  return (
    <article id="pead-paper-book" className="panel">
      <header className="px-4 sm:px-5 py-3" style={{ borderBottom: "3px double var(--rule-strong)" }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display font-semibold text-lg text-ink leading-tight">
            Exp. No. 3 — Post-earnings drift, $10k paper
          </h3>
          <span className="tag" style={{ color: "var(--blue)" }}>Paper · Stocks</span>
        </div>
        <p className="num text-[0.7rem] text-ink-2 leading-relaxed mt-1 max-w-3xl">
          Pre-registered rule: long any EPS beat ≥ +{config.minSurprisePct}%
          ({fmtUsd(config.perPositionUsd)} each, max {config.maxConcurrent}), hold{" "}
          {config.holdCalendarDays}d, exit at market. Verdict metric is excess return vs SPY over
          the identical window — kill if mean ≤ 0 at n={config.killMinSettles}.
        </p>
      </header>

      {/* Stat strip — excess-vs-SPY is the headline, not P&L */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-rule border-b border-rule bg-paper-2">
        <Tile
          label="Avg excess vs SPY"
          value={
            stats.avgExcessRetPct != null
              ? `${stats.avgExcessRetPct >= 0 ? "+" : ""}${stats.avgExcessRetPct.toFixed(2)}pp`
              : "—"
          }
          tone={excessTone}
          sub={
            stats.excessTStat != null
              ? `t=${stats.excessTStat.toFixed(2)} · n=${stats.settledWithBenchmark}`
              : `n=${stats.settledWithBenchmark} of ${config.killMinSettles} needed`
          }
        />
        <Tile
          label="Verdict gate"
          value={verdict.label}
          tone={verdict.tone}
          sub={`${stats.settledWithBenchmark}/${config.killMinSettles} settled`}
        />
        <Tile
          label="Realized P&L"
          value={`${stats.realizedPnlUsd >= 0 ? "+" : ""}${fmtUsd2(stats.realizedPnlUsd)}`}
          tone={pnlTone}
          sub={hasSettles ? `${stats.roiPct >= 0 ? "+" : ""}${stats.roiPct.toFixed(2)}% of book` : "—"}
        />
        <Tile
          label="Open exposure"
          value={fmtUsd2(stats.exposureUsd)}
          sub={`${stats.openCount} of ${config.maxConcurrent} slots`}
        />
      </div>

      {hasSettles && (
        <>
          {equityCurve.length >= 2 && (
            <figure className="p-4 border-b border-rule">
              <figcaption className="eyebrow mb-3">Equity curve (realized)</figcaption>
              <KalshiEquityCurve data={equityCurve} baseline={stats.bookUsd} />
            </figure>
          )}
          <div className="overflow-x-auto border-b border-rule">
            <table className="ledger-table">
              <caption className="sr-only">Recently settled PEAD paper positions</caption>
              <thead>
                <tr>
                  <th scope="col">Settled</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Surprise</th>
                  <th scope="col" className="text-right">vs SPY</th>
                  <th scope="col" className="text-right">P&L</th>
                </tr>
              </thead>
              <tbody>
                {closed.slice(0, 15).map(p => (
                  <tr key={`${p.symbol}-${p.reportDate}`}>
                    <td className="text-sm text-ink">
                      <span className="num font-semibold">{p.symbol}</span>
                      <span className="num text-[0.65rem] text-ink-3 block">rep. {p.reportDate}</span>
                    </td>
                    <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                      +{p.surprisePct.toFixed(0)}%
                    </td>
                    <td
                      className="num text-sm text-right"
                      style={{
                        color:
                          (p.excessRetPct ?? 0) >= 0 ? "var(--win)" : "var(--loss)",
                      }}
                    >
                      {p.excessRetPct != null
                        ? `${p.excessRetPct >= 0 ? "+" : ""}${p.excessRetPct.toFixed(2)}pp`
                        : "—"}
                    </td>
                    <td
                      className="num text-sm text-right font-semibold"
                      style={{ color: (p.pnlUsd ?? 0) >= 0 ? "var(--win)" : "var(--loss)" }}
                    >
                      {(p.pnlUsd ?? 0) >= 0 ? "+" : ""}
                      {fmtUsd2(p.pnlUsd ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!hasPositions && (
        <p className="px-4 sm:px-5 py-3 border-b border-rule tag" style={{ color: "var(--hold)" }}>
          Awaiting first qualifying surprise · scans weekday earnings at 15:05 UTC
        </p>
      )}

      {open.length > 0 && (
        <details className="group">
          <summary className="px-4 sm:px-5 py-2.5 cursor-pointer list-none flex items-baseline justify-between hover:bg-paper-3/60 transition-colors">
            <span className="eyebrow">Open positions · {open.length}</span>
            <span className="eyebrow text-ink-3 group-open:hidden">+ Unfold</span>
            <span className="eyebrow text-ink-3 hidden group-open:inline">− Fold</span>
          </summary>
          <div className="overflow-x-auto border-t border-rule">
            <table className="ledger-table">
              <caption className="sr-only">Open PEAD paper positions</caption>
              <thead>
                <tr>
                  <th scope="col">Symbol</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Surprise</th>
                  <th scope="col" className="text-right">Entry</th>
                  <th scope="col" className="text-right">Exit due</th>
                </tr>
              </thead>
              <tbody>
                {open.map(p => {
                  const d = daysUntil(p.exitDue);
                  return (
                    <tr key={`${p.symbol}-${p.reportDate}`}>
                      <td className="text-sm text-ink">
                        <span className="num font-semibold">{p.symbol}</span>
                        <span className="num text-[0.65rem] text-ink-3 block">rep. {p.reportDate}</span>
                      </td>
                      <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                        +{p.surprisePct.toFixed(0)}%
                      </td>
                      <td className="num text-sm text-right text-ink">${p.entryPrice.toFixed(2)}</td>
                      <td className="num text-xs text-right text-ink-2">
                        {d != null ? (d <= 0 ? "next cycle" : `${Math.ceil(d)}d`) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <p className="eyebrow text-ink-3 leading-relaxed px-4 sm:px-5 py-2.5 border-t border-rule">
        Simulated on Alpaca paper · not financial advice. Taker market orders during regular hours;
        paper fills carry no market impact, so results are an upper bound. Edge basis:
        post-earnings-announcement drift (Bernard–Thomas 1989; Chan–Marsh 2024) — pre-registered
        in PEAD_PAPER_SPEC.md, parameters frozen before the first order.
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
