import type { OverallRecord } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

function fmtUnits(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}U`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).toUpperCase();
}

const STREAK_COLOR: Record<string, string> = {
  W: "var(--edge)",
  L: "var(--kill)",
  P: "var(--muted)",
  "—": "var(--muted)",
};

export function OverallLedger({ data }: { data: OverallRecord }) {
  const {
    startDate, totalPicks, graded, pending,
    wins, losses, pushes, pnl, totalStake, roi, winRate,
    currentStreak, longestWinStreak, longestLossStreak,
    best, worst, byLeague,
  } = data;

  if (totalPicks === 0) {
    return (
      <section className="space-y-4">
        <SectionHeader
          id="ledger"
          index="10"
          label="ALL-TIME LEDGER"
          title="NO PICKS RECORDED"
          status="STANDBY"
          statusColor="muted"
        />
        <div className="surface p-6">
          <p className="font-mono text-sm text-[var(--muted)]">
            ▸ The agent has not shipped a pick yet. Ledger initializes on first persisted pick.
          </p>
        </div>
      </section>
    );
  }

  const wlRecord = `${wins}-${losses}${pushes > 0 ? `-${pushes}` : ""}`;
  const pnlColor = pnl > 0 ? "var(--edge)" : pnl < 0 ? "var(--kill)" : "var(--text)";
  const roiColor = roi !== null && roi > 0 ? "edge" : roi !== null && roi < 0 ? "kill" : "muted";

  const leagues = Object.entries(byLeague).sort((a, b) => (b[1].pnl ?? 0) - (a[1].pnl ?? 0));
  const markets = Object.entries(data.byMarket).sort((a, b) => (b[1].pnl ?? 0) - (a[1].pnl ?? 0));

  return (
    <section className="space-y-4">
      <SectionHeader
        id="ledger"
        index="10"
        label="ALL-TIME LEDGER"
        title={`${wlRecord} · ${fmtUnits(pnl)}`}
        subtitle={`Every pick the agent has ever shipped, going back to ${fmtDate(startDate)}. ${totalPicks} total picks · ${graded} graded · ${pending} pending.`}
        status={roi !== null ? `ROI ${(roi * 100).toFixed(1)}%` : "PAPER"}
        statusColor={roi !== null && roi > 0 ? "edge" : roi !== null && roi < 0 ? "kill" : "muted"}
      />

      {/* Headline P&L card */}
      <div className="surface-edge p-5 sm:p-7 relative overflow-hidden scanlines">
        <div className="relative z-10 grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-6 lg:gap-10 items-center">
          <div>
            <p className="eyebrow text-[var(--muted)] mb-2">CUMULATIVE UNITS</p>
            <p
              className="font-display font-bold leading-none"
              style={{
                fontSize: "clamp(4.5rem, 12vw, 9rem)",
                color: pnlColor,
                letterSpacing: "-0.05em",
              }}
            >
              {pnl > 0 ? "+" : ""}{pnl.toFixed(2)}
              <span className="text-[var(--muted)]">U</span>
            </p>
            <p className="mt-2 font-mono text-sm text-[var(--text)] max-w-md">
              <span className="reactor-active" style={{ color: pnlColor }}>●</span>{" "}
              <span className="numeric" style={{ color: pnlColor }}>{wlRecord}</span>{" "}
              on <span className="numeric">{totalStake.toFixed(2)}U</span> staked since paper trial began.
            </p>
          </div>

          {/* Headline stat grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border border-[var(--border)]">
            <Datum
              label="WIN RATE"
              value={winRate !== null ? `${(winRate * 100).toFixed(1)}%` : "—"}
              color={winRate !== null && winRate >= 0.55 ? "edge" : winRate !== null && winRate >= 0.5 ? "signal" : "muted"}
            />
            <Datum
              label="ROI"
              value={roi !== null ? `${roi > 0 ? "+" : ""}${(roi * 100).toFixed(1)}%` : "—"}
              color={roiColor}
            />
            <Datum
              label="STREAK"
              value={currentStreak.length > 0 ? `${currentStreak.kind}${currentStreak.length}` : "—"}
              color={currentStreak.kind === "W" ? "edge" : currentStreak.kind === "L" ? "kill" : "muted"}
            />
            <Datum
              label="PEAK / TROUGH"
              value={`W${longestWinStreak} / L${longestLossStreak}`}
            />
          </div>
        </div>
      </div>

      {/* By-market breakdown (ML vs prop) */}
      {markets.length > 0 && (
        <div className="surface">
          <div className="px-4 py-2 border-b border-[var(--border)]">
            <p className="eyebrow text-[var(--muted)]">BY MARKET</p>
          </div>
          <ul>
            {markets.map(([market, mk], i) => (
              <li
                key={market}
                className={`grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
              >
                <span className="pill" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>
                  {market.toUpperCase()}
                </span>
                <span className="font-mono text-xs text-[var(--muted)]">
                  {mk.wins}-{mk.losses}{mk.pushes > 0 ? `-${mk.pushes}` : ""}
                  {mk.pending > 0 ? ` · ${mk.pending} PEND` : ""}
                </span>
                <span className="numeric text-xs text-[var(--muted)] hidden sm:inline">
                  {mk.totalStake.toFixed(2)}U STAKED
                </span>
                <span
                  className="numeric text-sm"
                  style={{ color: mk.pnl > 0 ? "var(--edge)" : mk.pnl < 0 ? "var(--kill)" : "var(--text)" }}
                >
                  {mk.pnl > 0 ? "+" : ""}{mk.pnl.toFixed(2)}U
                </span>
                <span
                  className="numeric text-xs w-16 text-right"
                  style={{ color: mk.roi !== null && mk.roi > 0 ? "var(--edge)" : mk.roi !== null && mk.roi < 0 ? "var(--kill)" : "var(--muted)" }}
                >
                  {mk.roi !== null ? `${mk.roi > 0 ? "+" : ""}${(mk.roi * 100).toFixed(0)}%` : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* By-league breakdown + best/worst */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4">
        <div className="surface">
          <div className="px-4 py-2 border-b border-[var(--border)]">
            <p className="eyebrow text-[var(--muted)]">BY LEAGUE</p>
          </div>
          <ul>
            {leagues.map(([league, lg], i) => {
              const pnlSign = lg.pnl > 0 ? "+" : "";
              return (
                <li
                  key={league}
                  className={`grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
                >
                  <span className="pill" style={{ color: "var(--signal)", borderColor: "var(--signal)" }}>
                    {league}
                  </span>
                  <span className="font-mono text-xs text-[var(--muted)]">
                    {lg.wins}-{lg.losses}{lg.pushes > 0 ? `-${lg.pushes}` : ""}
                    {lg.pending > 0 ? ` · ${lg.pending} PEND` : ""}
                  </span>
                  <span className="numeric text-xs text-[var(--muted)] hidden sm:inline">
                    {lg.totalStake.toFixed(2)}U STAKED
                  </span>
                  <span
                    className="numeric text-sm"
                    style={{ color: lg.pnl > 0 ? "var(--edge)" : lg.pnl < 0 ? "var(--kill)" : "var(--text)" }}
                  >
                    {pnlSign}{lg.pnl.toFixed(2)}U
                  </span>
                  <span
                    className="numeric text-xs w-16 text-right"
                    style={{ color: lg.roi !== null && lg.roi > 0 ? "var(--edge)" : lg.roi !== null && lg.roi < 0 ? "var(--kill)" : "var(--muted)" }}
                  >
                    {lg.roi !== null ? `${lg.roi > 0 ? "+" : ""}${(lg.roi * 100).toFixed(0)}%` : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="grid grid-rows-2 gap-3 min-w-[260px]">
          <BestWorstCard label="BEST PICK" pick={best} color="edge" />
          <BestWorstCard label="WORST PICK" pick={worst} color="kill" />
        </div>
      </div>
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
    <div className="px-3 py-2 border-r border-b border-[var(--border)] last:border-r-0 sm:border-b-0">
      <p className="eyebrow text-[var(--muted)]">{label}</p>
      <p className="numeric text-lg sm:text-xl mt-0.5" style={{ color: `var(--${color === "muted" ? "muted" : color})` }}>
        {value}
      </p>
    </div>
  );
}

function BestWorstCard({
  label,
  pick,
  color,
}: {
  label: string;
  pick: OverallRecord["best"];
  color: "edge" | "kill";
}) {
  if (!pick) {
    return (
      <div className="surface px-4 py-3">
        <p className="eyebrow text-[var(--muted)]">{label}</p>
        <p className="font-mono text-xs text-[var(--muted)] mt-1">—</p>
      </div>
    );
  }
  return (
    <div className="surface px-4 py-3">
      <div className="flex items-baseline justify-between">
        <p className="eyebrow" style={{ color: `var(--${color})` }}>{label}</p>
        <p className="numeric text-sm" style={{ color: `var(--${color})` }}>
          {pick.unitsPnl > 0 ? "+" : ""}{pick.unitsPnl.toFixed(2)}U
        </p>
      </div>
      <p className="font-display font-semibold text-sm mt-1 truncate">{pick.matchup}</p>
      <p className="font-mono text-xs text-[var(--muted)] truncate">
        {pick.league} · {pick.selection}
      </p>
    </div>
  );
}
