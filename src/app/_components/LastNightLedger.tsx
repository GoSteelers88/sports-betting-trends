// Last night's page of the ledger — a reusable settled-picks table. WIN/LOSS
// on settled rows is one of the three true-stamp moments; push/pending read
// as plain tags. The front page mounts the games table; the props desk
// mounts the props table. Mobile rows collapse to the designed two-line
// pattern — no mid-word clipping, no dropped information.

import type { LastNightLedger as LastNightLedgerData, SlatePick } from "../_data/dashboard";
import { fmtAmerican, fmtUnits, propLabel } from "./format";

function gameTimeEt(iso: string): string {
  return new Date(iso)
    .toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    })
    .toUpperCase();
}

const RESULT_TONE: Record<string, string> = {
  win: "var(--win)",
  loss: "var(--loss)",
  push: "var(--ink-3)",
  void: "var(--ink-3)",
  pending: "var(--hold)",
};

export function lastNightSummary(data: LastNightLedgerData): {
  record: string;
  pnl: number;
  graded: number;
  pending: number;
} {
  return {
    record: `${data.wins}-${data.losses}${data.pushes > 0 ? `-${data.pushes}` : ""}`,
    pnl: data.pnl,
    graded: data.graded,
    pending: data.pending,
  };
}

/** The settled book — every pick whose game resolved in the window. */
export function SettledTable({
  picks,
  caption,
}: {
  picks: SlatePick[];
  caption: string;
}) {
  if (picks.length === 0) return null;
  return (
    <div className="panel overflow-x-auto">
      <table className="ledger-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Result</th>
            <th scope="col" className="hidden sm:table-cell">Lg</th>
            <th scope="col">Pick</th>
            <th scope="col" className="text-right hidden sm:table-cell">Stake</th>
            <th scope="col" className="text-right">Units</th>
            <th scope="col" className="text-right hidden sm:table-cell">Edge</th>
          </tr>
        </thead>
        <tbody>
          {picks.map(p => (
            <PickRow key={p.id} pick={p} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PickRow({ pick }: { pick: SlatePick }) {
  const result = pick.outcome?.result ?? "pending";
  const tone = RESULT_TONE[result] ?? "var(--ink-3)";
  const units = pick.outcome?.unitsPnl ?? null;
  const isProp = pick.market === "prop" && pick.player;
  const settled = result === "win" || result === "loss";

  const headline = isProp ? pick.player : pick.matchup;
  const detail = isProp
    ? `${pick.side?.toUpperCase()} ${pick.line} ${propLabel(pick.propType)} @ ${fmtAmerican(pick.oddsAmerican)} · ${pick.matchup}`
    : `${pick.selection} @ ${fmtAmerican(pick.oddsAmerican)} · ${gameTimeEt(pick.createdAt)}`;

  return (
    <tr>
      <td>
        {settled ? (
          <span className="stamp-row" style={{ color: tone }}>
            {result}
          </span>
        ) : (
          <span className="tag" style={{ color: tone }}>
            {result}
          </span>
        )}
      </td>
      <td className="hidden sm:table-cell">
        <span className="tag">{isProp ? "PROP" : pick.league}</span>
      </td>
      <td className="min-w-0 max-w-[340px]">
        {/* Two-line row — wraps at word boundaries, never clips mid-word */}
        <p className="text-sm text-ink font-medium leading-snug break-words">{headline}</p>
        <p className="num text-xs text-ink-2 leading-snug break-words">
          {detail}
          {/* Mobile folds the hidden columns into line two — zero info loss */}
          <span className="sm:hidden">
            {" "}· {isProp ? "PROP" : pick.league} · {pick.kellyStakeUnits.toFixed(2)}u ·{" "}
            {(pick.edge * 100).toFixed(1)}%
          </span>
        </p>
      </td>
      <td className="num text-xs text-ink-2 text-right hidden sm:table-cell">
        {pick.kellyStakeUnits.toFixed(2)}u
      </td>
      <td
        className="num text-sm text-right font-semibold"
        style={{
          color:
            units === null
              ? "var(--ink-3)"
              : units > 0
              ? "var(--win)"
              : units < 0
              ? "var(--loss)"
              : "var(--ink)",
        }}
      >
        {units !== null ? fmtUnits(units) : "—"}
      </td>
      <td className="num text-xs text-ink-2 text-right hidden sm:table-cell">
        {(pick.edge * 100).toFixed(1)}%
      </td>
    </tr>
  );
}
