// Experiment No. 2 — the de-vigged sharp-line $10k paper book, compressed
// to a ledger card until the first settle. Data logic untouched
// (getDevigLedgerView). Equity chart prints only once settles exist; the
// open book lives behind a printed disclosure.

import { getDevigLedgerView } from "@/lib/devig-paper";
import { DevigEquityCurve } from "./DevigEquityCurve";

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtUsd2 = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
// Invalid American prices (|n| < 100, NaN) render as em-dash — render guard only.
const fmtOdds = (n: number) =>
  Number.isFinite(n) && Math.abs(n) >= 100 ? (n > 0 ? `+${n}` : `${n}`) : "—";

function gameTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function DevigPaperBook() {
  let view;
  try {
    view = getDevigLedgerView();
  } catch {
    return null; // book unavailable — hide the card
  }
  const { stats, config, open, settled, equityCurve } = view;

  const pnlTone =
    stats.realizedPnlUsd > 0 ? "var(--win)" : stats.realizedPnlUsd < 0 ? "var(--loss)" : "var(--ink-3)";
  const hasSettles = settled.length > 0;

  return (
    <article id="devig-paper-book" className="panel">
      <header className="px-4 sm:px-5 py-3" style={{ borderBottom: "3px double var(--rule-strong)" }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display font-semibold text-lg text-ink leading-tight">
            Exp. No. 2 — De-vigged sharp +EV, $10k paper
          </h3>
          <span className="tag" style={{ color: "var(--blue)" }}>Paper · Live</span>
        </div>
        <p className="num text-[0.7rem] text-ink-2 leading-relaxed mt-1 max-w-3xl">
          Bets only when a soft book&rsquo;s price beats the de-vigged Pinnacle fair value by
          ≥{(config.evFloor * 100).toFixed(0)}% ({config.leagues.join("/")}) — the genuine retail
          edge. Best price at entry, {config.kellyMultiplier}× Kelly, settled on real results.
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
        <Tile
          label="Open exposure"
          value={fmtUsd2(stats.exposureUsd)}
          sub={`${stats.openCount} bet${stats.openCount === 1 ? "" : "s"}`}
        />
        <Tile
          label="Record"
          value={`${stats.wins}–${stats.losses}${stats.pushes ? `–${stats.pushes}` : ""}`}
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
              <DevigEquityCurve data={equityCurve} baseline={stats.startingBankrollUsd} />
            </figure>
          )}
          <div className="overflow-x-auto border-b border-rule">
            <table className="ledger-table">
              <caption className="sr-only">Recently settled de-vig paper bets</caption>
              <thead>
                <tr>
                  <th scope="col">Settled bet</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Price</th>
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
                      <td className="max-w-[340px] text-sm text-ink">
                        <span className="block leading-snug break-words line-clamp-2" title={b.finalScore ?? b.matchup}>
                          {b.team}
                        </span>
                        <span className="num text-[0.65rem] text-ink-3 sm:hidden">{fmtOdds(b.oddsAmerican)}</span>
                      </td>
                      <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                        {fmtOdds(b.oddsAmerican)}
                      </td>
                      <td className="text-right">
                        <span className="tag" style={{ color: tone }}>
                          {b.status}
                        </span>
                      </td>
                      <td
                        className="num text-sm text-right font-semibold"
                        style={{ color: (b.pnlUsd ?? 0) >= 0 ? "var(--win)" : "var(--loss)" }}
                      >
                        {(b.pnlUsd ?? 0) >= 0 ? "+" : ""}
                        {fmtUsd2(b.pnlUsd ?? 0)}
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
            ? ` · no open bets — +EV ≥ ${(config.evFloor * 100).toFixed(0)}% plays are rare; an empty book is the honest result of an efficient market`
            : ` · ${open.length} open bet${open.length === 1 ? "" : "s"} riding`}
        </p>
      )}

      {/* Open book — printed disclosure */}
      {open.length > 0 && (
        <details className="group">
          <summary className="px-4 sm:px-5 py-2.5 cursor-pointer list-none flex items-baseline justify-between hover:bg-paper-3/60 transition-colors">
            <span className="eyebrow">Open bets · {open.length}</span>
            <span className="eyebrow text-ink-3 group-open:hidden">+ Unfold</span>
            <span className="eyebrow text-ink-3 hidden group-open:inline">− Fold</span>
          </summary>
          <div className="overflow-x-auto border-t border-rule">
            <table className="ledger-table">
              <caption className="sr-only">Open de-vig paper bets</caption>
              <thead>
                <tr>
                  <th scope="col">Bet</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Price</th>
                  <th scope="col" className="text-right">EV</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Stake</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Game</th>
                </tr>
              </thead>
              <tbody>
                {open.slice(0, 20).map(b => (
                  <tr key={b.id}>
                    <td className="max-w-[320px] text-sm text-ink">
                      <span className="block leading-snug break-words line-clamp-2" title={b.matchup}>
                        {b.team} <span className="eyebrow text-ink-3">@ {b.book}</span>
                      </span>
                      <span className="num text-[0.65rem] text-ink-3 sm:hidden">
                        {fmtOdds(b.oddsAmerican)} · {fmtUsd2(b.stakeUsd)} · {gameTime(b.commenceTime)}
                      </span>
                    </td>
                    <td className="num text-sm text-right text-ink hidden sm:table-cell">
                      {fmtOdds(b.oddsAmerican)}
                    </td>
                    <td className="num text-sm text-right font-medium" style={{ color: "var(--win)" }}>
                      +{(b.evVsSharp * 100).toFixed(1)}%
                    </td>
                    <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                      {fmtUsd2(b.stakeUsd)}
                    </td>
                    <td className="num text-xs text-right text-ink-2 hidden sm:table-cell">
                      {gameTime(b.commenceTime)}
                    </td>
                  </tr>
                ))}
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
        Simulated · not financial advice. Taker fills at the best soft-book price recorded at
        entry, sized at quarter-Kelly on the de-vigged Pinnacle fair value. Edge basis: positive
        EV vs the sharp closing line (Miller–Davidow). The companion CLV-proof harness measures
        whether these entries beat the close.
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
