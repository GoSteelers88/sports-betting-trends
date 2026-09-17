// The account — the honest record, trial to date: units on record, win rate,
// ROI (games), streaks, the by-league table with in-scope leagues first and
// legacy out-of-scope leagues demoted below an agate rule, best and worst.
//
// Condensed 2026-09-12: the oversized counted-up units figure and the "in red
// ink" tag are gone (the verdict on "/" already states the trial's number);
// the figures are rail-size and every one is the same field it was.
//
// Two ROIs on "/" on purpose, each labelled: the verdict prints
// paperTrial.roi (the whole trial); this section prints
// overallRecord.games.roi (games only). They are different quantities. ROI
// prints only where the graded sample clears n=20 — display type is not lent
// to noise.

import type { OverallRecord } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

const ROI_MIN_N = 20;

function fmtDate(iso: string): string {
  return new Date(iso)
    .toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
    })
    .toUpperCase();
}

// Mirrors IN_SCOPE_LEAGUES in src/lib/agent/tools/index.ts. NFL joined the
// account 2026-09-10 — moneyline only, its picks are a subset of the /nfl
// doctrine board's PLAY legs (see nfl-model-from-board.ts).
const IN_SCOPE = ["NBA", "MLB", "WNBA", "NFL"];

export function OverallLedger({ data }: { data: OverallRecord }) {
  const {
    startDate, totalPicks, graded, pending,
    wins, losses, pushes, pnl, totalStake, roi, winRate,
    currentStreak, longestWinStreak, longestLossStreak,
    best, worst, byLeague,
  } = data;

  if (totalPicks === 0) {
    return (
      <section className="receipts-section">
        <SectionHeader
          id="account"
          label="GAMES · TRIAL TO DATE"
          title="THE ACCOUNT"
          status="Standby"
        />
        <p className="prose standfirst-block">The agent has not shipped a game pick yet.</p>
      </section>
    );
  }

  const wlRecord = `${wins}-${losses}${pushes > 0 ? `-${pushes}` : ""}`;
  const pnlColor = pnl > 0 ? "var(--win)" : pnl < 0 ? "var(--loss)" : "var(--ink)";

  const entries = Object.entries(byLeague);
  const inScope = entries
    .filter(([lg]) => IN_SCOPE.includes(lg))
    .sort((a, b) => IN_SCOPE.indexOf(a[0]) - IN_SCOPE.indexOf(b[0]));
  const legacy = entries
    .filter(([lg]) => !IN_SCOPE.includes(lg))
    .sort((a, b) => (b[1].pnl ?? 0) - (a[1].pnl ?? 0));

  return (
    <section className="receipts-section space-y-6">
      <SectionHeader
        id="account"
        label={`GAMES · TRIAL TO DATE · SINCE ${fmtDate(startDate)} · ${totalPicks} SHIPPED · ${graded} GRADED · ${pending} PENDING`}
        title="THE ACCOUNT"
      />

      {/* The figure — rail-size, one line. */}
      <p className="num account-line">
        <span className="font-semibold" style={{ color: pnlColor }}>
          {pnl > 0 ? "+" : ""}
          {pnl.toFixed(2)}u
        </span>
        <span className="text-ink-2"> on a </span>
        <span className="font-semibold text-ink">{wlRecord}</span>
        <span className="text-ink-2"> record · </span>
        <span className="text-ink">{totalStake.toFixed(2)}u</span>
        <span className="text-ink-2"> staked</span>
      </p>

      <dl className="account-rail">
        <RailStat
          label="Win rate"
          value={winRate !== null ? `${(winRate * 100).toFixed(1)}%` : "—"}
          tone={winRate !== null && winRate >= 0.55 ? "var(--win)" : winRate !== null && winRate >= 0.5 ? "var(--blue)" : "var(--ink-2)"}
        />
        <RailStat
          label={graded >= ROI_MIN_N ? "ROI · games" : "ROI · games (n<20)"}
          value={
            graded >= ROI_MIN_N && roi !== null
              ? `${roi > 0 ? "+" : ""}${(roi * 100).toFixed(1)}%`
              : "—"
          }
          tone={
            graded >= ROI_MIN_N && roi !== null
              ? roi > 0 ? "var(--win)" : roi < 0 ? "var(--loss)" : "var(--ink-2)"
              : "var(--ink-3)"
          }
        />
        <RailStat
          label="Streak"
          value={currentStreak.length > 0 ? `${currentStreak.kind}${currentStreak.length}` : "—"}
          tone={currentStreak.kind === "W" ? "var(--win)" : currentStreak.kind === "L" ? "var(--loss)" : "var(--ink-2)"}
        />
        <RailStat label="Peak · trough" value={`W${longestWinStreak} · L${longestLossStreak}`} tone="var(--ink)" />
      </dl>

      {/* By-league table + best/worst clippings */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 panel overflow-x-auto">
          <table className="ledger-table">
            <caption className="sr-only">All-time record by league</caption>
            <thead>
              <tr>
                <th scope="col">League</th>
                <th scope="col">Record</th>
                <th scope="col" className="text-right hidden sm:table-cell">Staked</th>
                <th scope="col" className="text-right">Units</th>
                <th scope="col" className="text-right hidden sm:table-cell">ROI</th>
              </tr>
            </thead>
            <tbody>
              {inScope.map(([league, lg]) => (
                <LeagueRow key={league} league={league} lg={lg} />
              ))}
              {legacy.length > 0 && (
                <tr>
                  <td colSpan={5} className="!py-1.5" style={{ background: "var(--paper-3)" }}>
                    <span className="tag text-ink-3">Legacy · out of scope since May 20</span>
                  </td>
                </tr>
              )}
              {legacy.map(([league, lg]) => (
                <LeagueRow key={league} league={league} lg={lg} legacy />
              ))}
            </tbody>
          </table>
        </div>

        <div className="lg:col-span-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-4">
          <Clipping label="Best pick" pick={best} tone="var(--win)" />
          <Clipping label="Worst pick" pick={worst} tone="var(--loss)" />
        </div>
      </div>
    </section>
  );
}

function LeagueRow({
  league,
  lg,
  legacy = false,
}: {
  league: string;
  lg: OverallRecord["byLeague"][string];
  legacy?: boolean;
}) {
  const lgGraded = lg.wins + lg.losses + lg.pushes;
  const lgColor = lg.pnl > 0 ? "var(--win)" : lg.pnl < 0 ? "var(--loss)" : "var(--ink)";
  const showRoi = lgGraded >= ROI_MIN_N && lg.roi !== null;
  return (
    <tr style={legacy ? { opacity: 0.72 } : undefined}>
      <td>
        <span className="tag text-ink">{league}</span>
      </td>
      <td className="num text-xs text-ink-2">
        {lg.wins}-{lg.losses}
        {lg.pushes > 0 ? `-${lg.pushes}` : ""}
        {lg.pending > 0 ? ` · ${lg.pending} pend` : ""}
      </td>
      <td className="num text-xs text-ink-2 text-right hidden sm:table-cell">
        {lg.totalStake.toFixed(2)}u
      </td>
      <td className="num text-sm text-right font-medium" style={{ color: lgColor }}>
        {lg.pnl > 0 ? "+" : ""}
        {lg.pnl.toFixed(2)}u
      </td>
      <td
        className="num text-xs text-right hidden sm:table-cell"
        style={{
          color: showRoi
            ? lg.roi! > 0 ? "var(--win)" : lg.roi! < 0 ? "var(--loss)" : "var(--ink-3)"
            : "var(--ink-3)",
        }}
        title={showRoi ? undefined : `ROI suppressed — ${lgGraded} graded < ${ROI_MIN_N}`}
      >
        {showRoi ? `${lg.roi! > 0 ? "+" : ""}${(lg.roi! * 100).toFixed(0)}%` : `n=${lgGraded}`}
      </td>
    </tr>
  );
}

function RailStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="account-stat">
      <dt className="eyebrow">{label}</dt>
      <dd className="num account-stat-value" style={{ color: tone }}>
        {value}
      </dd>
    </div>
  );
}

function Clipping({
  label,
  pick,
  tone,
}: {
  label: string;
  pick: OverallRecord["best"];
  tone: string;
}) {
  return (
    <article className="panel p-4 flex flex-col">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow" style={{ color: tone }}>{label}</p>
        <p className="num text-base font-semibold" style={{ color: tone }}>
          {pick ? `${pick.unitsPnl > 0 ? "+" : ""}${pick.unitsPnl.toFixed(2)}u` : "—"}
        </p>
      </div>
      {pick ? (
        <>
          <p className="font-display font-semibold text-base mt-2 text-ink truncate">
            {pick.matchup}
          </p>
          <p className="num text-xs text-ink-2 truncate mt-0.5">
            {pick.league} · {pick.selection}
          </p>
        </>
      ) : (
        <p className="num text-xs text-ink-3 mt-2">Nothing graded yet.</p>
      )}
    </article>
  );
}
