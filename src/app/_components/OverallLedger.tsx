// Folio 04 — the account. One oversized cumulative-units figure (counted
// into place), a vertical stat rail, then the by-league table with in-scope
// leagues (NBA/MLB) first and legacy out-of-scope leagues demoted below an
// agate rule. ROI prints only where the graded sample clears n=20 — display
// type is not lent to noise.

import type { OverallRecord } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";
import { Tally } from "./motion";

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

const IN_SCOPE = ["NBA", "MLB"];

export function OverallLedger({ data }: { data: OverallRecord }) {
  const {
    startDate, totalPicks, graded, pending,
    wins, losses, pushes, pnl, totalStake, roi, winRate,
    currentStreak, longestWinStreak, longestLossStreak,
    best, worst, byLeague,
  } = data;

  if (totalPicks === 0) {
    return (
      <section>
        <SectionHeader
          id="ledger"
          index="04"
          label="THE ACCOUNT · TRIAL TO DATE"
          title="No game picks recorded"
          status="Standby"
          statusTone="mute"
        />
        <p className="tag text-ink-3 mt-4">The agent has not shipped a game pick yet</p>
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
    <section className="space-y-10">
      <SectionHeader
        id="ledger"
        index="04"
        label="THE ACCOUNT · GAMES · TRIAL TO DATE"
        title="The account, in units"
        subtitle={`Since ${fmtDate(startDate)} · ${totalPicks} shipped · ${graded} graded · ${pending} pending.`}
        status={pnl > 0 ? "In profit" : pnl < 0 ? "In red ink" : "Flat"}
        statusTone={pnl > 0 ? "win" : pnl < 0 ? "loss" : "mute"}
      />

      {/* The figure — 5/7 split, number dominates */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-end">
        <div className="lg:col-span-7">
          <p className="eyebrow mb-3">Cumulative units · trial</p>
          <Tally
            value={pnl}
            decimals={2}
            signed
            suffix="u"
            className="num-display block"
            style={{
              color: pnlColor,
              fontSize: "clamp(4.5rem, 13vw, 11rem)",
            }}
          />
          <p className="mt-5 text-base text-ink-2 max-w-lg leading-relaxed">
            <span className="num font-semibold" style={{ color: pnlColor }}>{wlRecord}</span>{" "}
            record on <span className="num text-ink">{totalStake.toFixed(2)}u</span> staked
            since the paper trial opened.
          </p>
        </div>

        <dl className="lg:col-span-5 lg:border-l lg:border-rule lg:pl-10 grid grid-cols-2 gap-x-8 gap-y-8">
          <RailStat
            label="Win rate"
            value={winRate !== null ? `${(winRate * 100).toFixed(1)}%` : "—"}
            tone={winRate !== null && winRate >= 0.55 ? "var(--win)" : winRate !== null && winRate >= 0.5 ? "var(--blue)" : "var(--ink-2)"}
          />
          <RailStat
            label={graded >= ROI_MIN_N ? "ROI" : "ROI (n<20)"}
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
          <RailStat label="Peak · Trough" value={`W${longestWinStreak} · L${longestLossStreak}`} tone="var(--ink)" />
        </dl>
      </div>

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
                <th scope="col" className="text-right">ROI</th>
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

        <div className="lg:col-span-4 grid grid-rows-2 gap-4">
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
        className="num text-xs text-right"
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
    <div className="border-b border-rule pb-3">
      <dt className="eyebrow mb-2">{label}</dt>
      <dd className="num-display text-3xl sm:text-4xl" style={{ color: tone }}>
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
