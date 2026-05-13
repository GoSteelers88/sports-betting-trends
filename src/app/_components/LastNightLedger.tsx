import type { LastNightLedger as LastNightLedgerData, SlatePick } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtUnits(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "" : "";
  return `${sign}${n.toFixed(2)}U`;
}

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

const RESULT_COLOR: Record<string, string> = {
  win: "var(--edge)",
  loss: "var(--kill)",
  push: "var(--muted)",
  void: "var(--muted)",
  pending: "var(--warn)",
};

export function LastNightLedger({ data }: { data: LastNightLedgerData }) {
  const { picks, graded, pending, wins, losses, pushes, pnl, totalStake } = data;
  const roi = totalStake > 0 && graded > 0 ? pnl / totalStake : null;
  const wlRecord = `${wins}-${losses}${pushes > 0 ? `-${pushes}` : ""}`;

  if (picks.length === 0) {
    return (
      <section className="space-y-4">
        <SectionHeader
          id="last-night"
          index="06"
          label="LAST NIGHT"
          title="LEDGER QUIET"
          status="NO PICKS"
          statusColor="muted"
        />
        <div className="surface p-6">
          <p className="font-mono text-sm text-[var(--muted)]">
            ▸ No picks resolved in the last 36 hours.
          </p>
        </div>
      </section>
    );
  }

  const pnlColor =
    graded === 0 ? "var(--muted)"
    : pnl > 0 ? "var(--edge)"
    : pnl < 0 ? "var(--kill)"
    : "var(--text)";
  const pendingBadge = pending > 0 ? `${pending} PENDING` : "ALL GRADED";
  const pendingColor: "warn" | "edge" = pending > 0 ? "warn" : "edge";

  return (
    <section className="space-y-4">
      <SectionHeader
        id="last-night"
        index="06"
        label="LAST NIGHT"
        title={`${wlRecord} · ${fmtUnits(pnl)}`}
        subtitle="Every pick whose game tipped, pitched, or dropped the puck in the last 36 hours. Pending rows clear when the autograder runs at 13:00 UTC."
        status={pendingBadge}
        statusColor={pendingColor}
      />

      {/* Header strip — quick totals */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat label="W-L-P" value={wlRecord} color="text" />
        <Stat label="UNITS" value={fmtUnits(pnl)} color={pnl > 0 ? "edge" : pnl < 0 ? "kill" : "muted"} />
        <Stat
          label="ROI"
          value={roi !== null ? `${(roi * 100).toFixed(1)}%` : "—"}
          color={roi !== null && roi > 0 ? "edge" : roi !== null && roi < 0 ? "kill" : "muted"}
        />
        <Stat label="GRADED" value={`${graded}`} color="signal" />
        <Stat label="PENDING" value={`${pending}`} color={pending > 0 ? "warn" : "muted"} />
      </div>

      {/* Pick list */}
      <ul className="surface">
        {picks.map((p, i) => (
          <PickRow key={p.id} pick={p} divider={i > 0} pnlColor={pnlColor} />
        ))}
      </ul>
    </section>
  );
}

function PickRow({ pick, divider }: { pick: SlatePick; divider: boolean; pnlColor: string }) {
  const result = pick.outcome?.result ?? "pending";
  const color = RESULT_COLOR[result] ?? "var(--muted)";
  const units = pick.outcome?.unitsPnl ?? null;

  return (
    <li
      className={`grid grid-cols-[auto_1fr_auto] sm:grid-cols-[auto_auto_1fr_auto_auto_auto] items-center gap-3 px-4 py-3 ${divider ? "border-t border-[var(--border)]" : ""}`}
    >
      <span
        className="pill"
        style={{ color, borderColor: color }}
      >
        {result.toUpperCase()}
      </span>
      <span className="pill hidden sm:inline-block" style={{ color: "var(--signal)", borderColor: "var(--signal)" }}>
        {pick.league}
      </span>
      <div className="min-w-0">
        <p className="font-display font-semibold text-sm truncate">{pick.matchup}</p>
        <p className="font-mono text-xs text-[var(--muted)] truncate">
          {pick.selection} <span className="text-[var(--text)]">@ {fmtAmerican(pick.oddsAmerican)}</span>
          <span className="hidden sm:inline"> · {gameTimeEt(pick.createdAt)}</span>
        </p>
      </div>
      <span className="numeric text-xs text-[var(--muted)] hidden sm:inline">
        {pick.kellyStakeUnits.toFixed(2)}U
      </span>
      <span
        className="numeric text-sm"
        style={{ color: units === null ? "var(--muted)" : units > 0 ? "var(--edge)" : units < 0 ? "var(--kill)" : "var(--text)" }}
      >
        {units !== null ? fmtUnits(units) : "—"}
      </span>
      <span className="numeric text-[0.65rem] text-[var(--muted)] hidden sm:inline">
        EDGE {(pick.edge * 100).toFixed(1)}%
      </span>
    </li>
  );
}

function Stat({
  label,
  value,
  color = "text",
}: {
  label: string;
  value: string;
  color?: "edge" | "warn" | "kill" | "signal" | "muted" | "text";
}) {
  return (
    <div className="surface px-4 py-3">
      <p className="eyebrow text-[var(--muted)]">{label}</p>
      <p className="numeric text-2xl mt-1" style={{ color: `var(--${color === "muted" ? "muted" : color})` }}>
        {value}
      </p>
    </div>
  );
}
