import { getDevigLedgerView } from "@/lib/devig-paper";
import { SectionHeader } from "./SectionHeader";
import { DevigEquityCurve } from "./DevigEquityCurve";

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtUsd2 = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const fmtOdds = (n: number) => (n > 0 ? `+${n}` : `${n}`);

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
    return null; // book unavailable — hide the section
  }
  const { stats, config, open, settled, equityCurve } = view;

  const pnlColor =
    stats.realizedPnlUsd > 0 ? "var(--edge)" : stats.realizedPnlUsd < 0 ? "var(--kill)" : "var(--muted)";

  const tiles: Array<{ label: string; value: string; color?: string; sub?: string }> = [
    { label: "EQUITY", value: fmtUsd2(stats.equityUsd), sub: `of ${fmtUsd(stats.startingBankrollUsd)} start` },
    {
      label: "REALIZED P&L",
      value: `${stats.realizedPnlUsd >= 0 ? "+" : ""}${fmtUsd2(stats.realizedPnlUsd)}`,
      color: pnlColor,
      sub: `${stats.roiPct >= 0 ? "+" : ""}${stats.roiPct.toFixed(2)}% ROI`,
    },
    { label: "OPEN EXPOSURE", value: fmtUsd2(stats.exposureUsd), sub: `${stats.openCount} bet${stats.openCount === 1 ? "" : "s"}` },
    {
      label: "RECORD",
      value: `${stats.wins}–${stats.losses}${stats.pushes ? `–${stats.pushes}` : ""}`,
      sub: stats.yieldPct != null ? `${stats.yieldPct >= 0 ? "+" : ""}${stats.yieldPct}% yield` : "no settles yet",
    },
  ];

  return (
    <section className="space-y-4">
      <SectionHeader
        id="devig-paper-book"
        index="00"
        label="DE-VIGGED SHARP · POSITIVE-EV"
        title="$10K PAPER BOOK"
        subtitle="A live, simulated $10,000 book that bets only when a soft sportsbook's price beats the de-vigged Pinnacle (sharp) fair value by ≥2% — the genuine retail edge. Best price taken at entry, quarter-Kelly stakes, settled on real game results. No real money; taker fills at posted prices (no fill assumption needed)."
        status="PAPER · LIVE"
        statusColor="signal"
      />

      {/* Stat tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <article key={t.label} className="surface p-4 sm:p-5 flex flex-col gap-2">
            <span className="eyebrow text-[var(--muted)]">{t.label}</span>
            <span className="numeric text-2xl" style={{ color: t.color ?? "var(--text)" }}>
              {t.value}
            </span>
            {t.sub && <span className="eyebrow text-[var(--muted)]">{t.sub}</span>}
          </article>
        ))}
      </div>

      {/* Equity curve */}
      <div className="surface p-4 sm:p-5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="eyebrow text-[var(--muted)]">EQUITY CURVE</span>
          <span className="eyebrow text-[var(--muted)]">
            +EV ≥ {(config.evFloor * 100).toFixed(0)}% · {config.kellyMultiplier}× KELLY · {config.leagues.join("/")}
          </span>
        </div>
        <DevigEquityCurve data={equityCurve} baseline={stats.startingBankrollUsd} />
      </div>

      {/* Open bets */}
      <div className="surface p-4 sm:p-5">
        <span className="eyebrow text-[var(--muted)]">OPEN BETS · {open.length}</span>
        {open.length === 0 ? (
          <p className="eyebrow text-[var(--muted)] mt-3 leading-relaxed">
            NO OPEN BETS — THE STRATEGY ONLY FIRES ON +EV ≥ {(config.evFloor * 100).toFixed(0)}% PLAYS,
            WHICH ARE RARE. AN EMPTY BOOK IS THE HONEST RESULT WHEN THE MARKET IS EFFICIENT.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm numeric">
              <thead>
                <tr className="eyebrow text-[var(--muted)] text-left">
                  <th className="py-1 pr-3 font-normal">BET</th>
                  <th className="py-1 px-3 font-normal text-right">PRICE</th>
                  <th className="py-1 px-3 font-normal text-right">EV</th>
                  <th className="py-1 px-3 font-normal text-right">STAKE</th>
                  <th className="py-1 pl-3 font-normal text-right">GAME</th>
                </tr>
              </thead>
              <tbody>
                {open.slice(0, 20).map((b) => (
                  <tr key={b.id} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-3 max-w-[280px] truncate font-sans text-[var(--text)]" title={b.matchup}>
                      {b.team} <span className="text-[var(--muted)] text-xs">@ {b.book}</span>
                    </td>
                    <td className="py-1.5 px-3 text-right text-[var(--text)]">{fmtOdds(b.oddsAmerican)}</td>
                    <td className="py-1.5 px-3 text-right" style={{ color: "var(--edge)" }}>
                      +{(b.evVsSharp * 100).toFixed(1)}%
                    </td>
                    <td className="py-1.5 px-3 text-right text-[var(--muted)]">{fmtUsd2(b.stakeUsd)}</td>
                    <td className="py-1.5 pl-3 text-right text-[var(--muted)] text-xs">{gameTime(b.commenceTime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {open.length > 20 && (
              <p className="eyebrow text-[var(--muted)] mt-2">+ {open.length - 20} MORE</p>
            )}
          </div>
        )}
      </div>

      {/* Recently settled */}
      {settled.length > 0 && (
        <div className="surface p-4 sm:p-5">
          <span className="eyebrow text-[var(--muted)]">RECENTLY SETTLED</span>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm numeric">
              <thead>
                <tr className="eyebrow text-[var(--muted)] text-left">
                  <th className="py-1 pr-3 font-normal">BET</th>
                  <th className="py-1 px-3 font-normal text-right">PRICE</th>
                  <th className="py-1 px-3 font-normal text-right">RESULT</th>
                  <th className="py-1 pl-3 font-normal text-right">P&L</th>
                </tr>
              </thead>
              <tbody>
                {settled.slice(0, 15).map((b) => {
                  const won = b.status === "won";
                  const lost = b.status === "lost";
                  const color = won ? "var(--edge)" : lost ? "var(--kill)" : "var(--muted)";
                  return (
                    <tr key={b.id} className="border-t border-[var(--border)]">
                      <td className="py-1.5 pr-3 max-w-[320px] truncate font-sans text-[var(--text)]" title={b.finalScore ?? b.matchup}>
                        {b.team}
                      </td>
                      <td className="py-1.5 px-3 text-right text-[var(--muted)]">{fmtOdds(b.oddsAmerican)}</td>
                      <td className="py-1.5 px-3 text-right" style={{ color }}>
                        {b.status.toUpperCase()}
                      </td>
                      <td className="py-1.5 pl-3 text-right" style={{ color: (b.pnlUsd ?? 0) >= 0 ? "var(--edge)" : "var(--kill)" }}>
                        {(b.pnlUsd ?? 0) >= 0 ? "+" : ""}{fmtUsd2(b.pnlUsd ?? 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="eyebrow text-[var(--muted)] leading-relaxed">
        SIMULATED · NOT FINANCIAL ADVICE. Bets are taker fills at the best soft-book price recorded at entry,
        sized at quarter-Kelly on the de-vigged Pinnacle fair value. Edge basis: positive expected value vs the
        sharp closing line (Miller–Davidow). The companion CLV-proof harness measures whether these entries beat the close.
      </p>
    </section>
  );
}
