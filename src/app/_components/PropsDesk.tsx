"use client";

// Folio 08 — the props desk. The entire props track on one dense page:
// today's prop survivors, last night's settled props, the prop account in
// brief, and the model's prop signals as a single agate table (the
// consensus note prints once, as a footnote — not five times as cards).
// Set small, no stamps except WIN/LOSS on settled rows.

import { useState } from "react";
import type {
  LastNightLedger as LastNightLedgerData,
  OverallRecord,
  PlayerProp,
  SlatePick,
} from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";
import { PickAutopsy } from "./PickAutopsy";
import { SettledTable } from "./LastNightLedger";
import { fmtAmerican, fmtUnits, propLabel } from "./format";

const ROI_MIN_N = 20;

export function PropsDesk({
  picks,
  lastNight,
  record,
  signals,
}: {
  picks: SlatePick[];
  lastNight: LastNightLedgerData;
  record: OverallRecord;
  signals: PlayerProp[];
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  const open = openId !== null ? picks.find(p => p.id === openId) ?? null : null;

  const sorted = [...picks].sort((a, b) => b.edge - a.edge);
  const graded = record.wins + record.losses + record.pushes;
  const recordLine = `${record.wins}-${record.losses}${record.pushes > 0 ? `-${record.pushes}` : ""}`;

  return (
    <section className="space-y-8">
      <SectionHeader
        id="props-desk"
        index="08"
        dense
        label="THE PROPS DESK · INDEPENDENT TRACK"
        title="Props, in brief"
        subtitle="Player props validate separately from games — win rate over CLV (prop markets lack market-making liquidity). Survivors, last night, the account, and the model's signals, on one page."
        status={picks.length > 0 ? `${picks.length} shipped tonight` : "No prop edge tonight"}
        statusTone={picks.length > 0 ? "win" : "mute"}
      />

      {/* a — tonight's prop survivors */}
      <div>
        <p className="eyebrow mb-2">Tonight&rsquo;s prop survivors</p>
        {sorted.length === 0 ? (
          <p className="tag text-ink-3">
            No prop pick survived today — the projector found no qualifying edge, or the critic killed every one
          </p>
        ) : (
          <div className="panel overflow-x-auto">
            <table className="ledger-table">
              <caption className="sr-only">Tonight&rsquo;s surviving prop picks</caption>
              <thead>
                <tr>
                  <th scope="col">Player · prop</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Odds</th>
                  <th scope="col" className="text-right">Edge</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Stake</th>
                  <th scope="col" className="text-right"><span className="sr-only">Autopsy</span></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(p => (
                  <tr key={p.id}>
                    <td className="min-w-0 max-w-[340px]">
                      <p className="text-sm text-ink font-medium leading-snug break-words">{p.player ?? p.matchup}</p>
                      <p className="num text-xs text-ink-2 leading-snug break-words">
                        {p.side?.toUpperCase()} {p.line} {propLabel(p.propType)} · {p.matchup}
                        <span className="sm:hidden">
                          {" "}· {fmtAmerican(p.oddsAmerican)} · {p.kellyStakeUnits.toFixed(2)}u
                        </span>
                      </p>
                    </td>
                    <td className="num text-sm text-ink text-right hidden sm:table-cell">
                      {fmtAmerican(p.oddsAmerican)}
                    </td>
                    <td className="num text-sm text-right font-medium" style={{ color: "var(--win)" }}>
                      {(p.edge * 100).toFixed(1)}%
                    </td>
                    <td className="num text-xs text-ink-2 text-right hidden sm:table-cell">
                      {p.kellyStakeUnits.toFixed(2)}u
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        onClick={() => setOpenId(p.id)}
                        className="eyebrow px-2 py-1 border border-rule text-ink-2 hover:text-loss hover:border-loss transition-colors"
                      >
                        Autopsy
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* b — last night's props */}
      <div>
        <p className="eyebrow mb-2">
          Last night · props
          {lastNight.graded > 0 && (
            <>
              {" "}· settled {lastNight.wins}-{lastNight.losses}
              {lastNight.pushes > 0 ? `-${lastNight.pushes}` : ""},{" "}
              <span
                className="num"
                style={{
                  color:
                    lastNight.pnl > 0 ? "var(--win)" : lastNight.pnl < 0 ? "var(--loss)" : "var(--ink-2)",
                }}
              >
                {fmtUnits(lastNight.pnl)}
              </span>
            </>
          )}
        </p>
        {lastNight.picks.length === 0 ? (
          <p className="tag text-ink-3">No prop picks resolved in the last 36 hours</p>
        ) : (
          <SettledTable picks={lastNight.picks} caption="Prop picks resolved in the last 36 hours" />
        )}
      </div>

      {/* c — the prop account, in a quad */}
      <div>
        <p className="eyebrow mb-2">The prop account · trial to date</p>
        {record.totalPicks === 0 ? (
          <p className="tag text-ink-3">The agent has not shipped a prop pick yet</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 border border-rule divide-x divide-y sm:divide-y-0 divide-rule bg-paper-2">
              <Quad label="Record" value={recordLine} tone="var(--ink)" sub={`${record.totalPicks} shipped`} />
              <Quad
                label="Units"
                value={fmtUnits(record.pnl)}
                tone={record.pnl > 0 ? "var(--win)" : record.pnl < 0 ? "var(--loss)" : "var(--ink-3)"}
                sub={`${record.totalStake.toFixed(2)}u staked`}
              />
              <Quad
                label="Win rate"
                value={record.winRate !== null ? `${(record.winRate * 100).toFixed(1)}%` : "—"}
                tone={
                  record.winRate !== null && record.winRate >= 0.55
                    ? "var(--win)"
                    : record.winRate !== null
                    ? "var(--ink-2)"
                    : "var(--ink-3)"
                }
                sub="vig clears at ~55%"
              />
              <Quad
                label={graded >= ROI_MIN_N ? "ROI" : "Pending"}
                value={
                  graded >= ROI_MIN_N && record.roi !== null
                    ? `${record.roi > 0 ? "+" : ""}${(record.roi * 100).toFixed(1)}%`
                    : `${record.pending}`
                }
                tone={
                  graded >= ROI_MIN_N && record.roi !== null
                    ? record.roi > 0 ? "var(--win)" : "var(--loss)"
                    : "var(--hold)"
                }
                sub={graded >= ROI_MIN_N ? `${graded} graded` : `ROI prints at n≥${ROI_MIN_N} (now ${graded})`}
              />
            </div>
            {(record.best || record.worst || graded > 0) && (
              <p className="num text-xs text-ink-2 mt-2 leading-relaxed">
                {graded > 0 && (
                  <>
                    Streak:{" "}
                    <span
                      style={{
                        color:
                          record.currentStreak.kind === "W"
                            ? "var(--win)"
                            : record.currentStreak.kind === "L"
                            ? "var(--loss)"
                            : "var(--ink-2)",
                      }}
                    >
                      {record.currentStreak.length > 0
                        ? `${record.currentStreak.kind}${record.currentStreak.length}`
                        : "—"}
                    </span>{" "}
                    (peak W{record.longestWinStreak} · trough L{record.longestLossStreak})
                    {(record.best || record.worst) && " · "}
                  </>
                )}
                {record.best && (
                  <>
                    Best:{" "}
                    <span style={{ color: "var(--win)" }}>
                      {record.best.matchup} · {record.best.selection} ({fmtUnits(record.best.unitsPnl)})
                    </span>
                  </>
                )}
                {record.best && record.worst && " · "}
                {record.worst && (
                  <>
                    Worst:{" "}
                    <span style={{ color: "var(--loss)" }}>
                      {record.worst.matchup} · {record.worst.selection} ({fmtUnits(record.worst.unitsPnl)})
                    </span>
                  </>
                )}
              </p>
            )}
          </>
        )}
      </div>

      {/* d — the signals table */}
      {signals.length > 0 && <SignalsTable signals={signals} />}

      <PickAutopsy pick={open} onClose={() => setOpenId(null)} />
    </section>
  );
}

function SignalsTable({ signals }: { signals: PlayerProp[] }) {
  // The consensus note prints once. If every rationale follows the
  // "N-book consensus line …" pattern, summarize it; otherwise list the
  // distinct notes verbatim so nothing is lost.
  const rationales = signals.map(s => s.rationaleSignals?.[0] ?? "").filter(Boolean);
  const bookCounts = new Set(
    rationales.map(r => r.match(/^(\d+)-book consensus/)?.[1] ?? "?")
  );
  const allConsensus = !bookCounts.has("?") && bookCounts.size === 1;
  const footnote = allConsensus
    ? `All lines are ${[...bookCounts][0]}-book consensus medians (zero spread across books); the agent cites these as supporting evidence — high-confidence entries are eligible for future direct-prop deployment.`
    : [...new Set(rationales)].join(" · ");

  // Column honesty — same ≥95% auto-drop rule as the board. A confidence
  // column that is ≥95% identical across rows is dead ink: it collapses to
  // one agate line ("ALL CONF 95") and the column doesn't print.
  const confCounts = new Map<number, number>();
  for (const s of signals) confCounts.set(s.confidence, (confCounts.get(s.confidence) ?? 0) + 1);
  const [topConf, topConfCount] = [...confCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  const showConf = signals.length > 0 && topConfCount / signals.length < 0.95;

  return (
    <div>
      <p className="eyebrow mb-2">Prop signals · model-ranked</p>
      <div className="panel overflow-x-auto">
        <table className="ledger-table">
          <caption className="sr-only">Model-ranked player prop signals</caption>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col" className="text-right">Line</th>
              <th scope="col" className="text-right">Price</th>
              {showConf && <th scope="col" className="text-right">Conf</th>}
            </tr>
          </thead>
          <tbody>
            {signals.map((p, idx) => {
              const price = p.pickSide === "over" ? p.overPrice : p.underPrice;
              const isOver = p.pickSide === "over";
              return (
                <tr key={`${p.player}-${p.market}-${idx}`}>
                  <td className="min-w-0 max-w-[280px]">
                    <p className="text-sm text-ink font-medium leading-snug break-words">{p.player}</p>
                    <p className="num text-[0.68rem] text-ink-2 leading-snug break-words">
                      {p.team ?? "—"}
                      {p.opponent ? ` vs ${p.opponent}` : ""}
                    </p>
                  </td>
                  {/* Market folds into the line cell — "UNDER 25.5 PTS" */}
                  <td className="num text-sm text-right whitespace-nowrap">
                    <span
                      className="font-semibold"
                      style={{ color: isOver ? "var(--win)" : "var(--loss)" }}
                    >
                      {p.pickSide.toUpperCase()}
                    </span>{" "}
                    <span className="text-ink">{p.line}</span>{" "}
                    <span className="text-xs text-ink-2">{propLabel(p.market).toUpperCase()}</span>
                  </td>
                  <td className="num text-sm text-right text-ink">{fmtAmerican(price)}</td>
                  {showConf && (
                    <td className="num text-sm text-right font-semibold" style={{ color: "var(--blue)" }}>
                      {p.confidence}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={showConf ? 4 : 3} className="!border-t !border-rule">
                {!showConf && (
                  <p className="eyebrow py-1" style={{ color: "var(--blue)" }}>
                    All conf {topConf}
                  </p>
                )}
                <p className="eyebrow text-ink-3 leading-relaxed py-1">{footnote}</p>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function Quad({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: string;
}) {
  return (
    <div className="px-4 py-3">
      <p className="eyebrow text-ink-3">{label}</p>
      <p className="num-display text-xl mt-1" style={{ color: tone }}>
        {value}
      </p>
      {sub && <p className="eyebrow text-ink-3 mt-0.5">{sub}</p>}
    </div>
  );
}
