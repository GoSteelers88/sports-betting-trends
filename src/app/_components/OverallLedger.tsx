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

const OVERALL_LABELS = {
  games: {
    anchor: "ledger",
    index: "10",
    eyebrow: "ALL-TIME LEDGER · GAMES",
    subtitlePrefix: "Every game pick (ML/spread/total) the agent has shipped",
    emptyTitle: "NO GAME PICKS RECORDED",
    emptyBody: "The agent has not shipped a game pick yet.",
  },
  props: {
    anchor: "prop-ledger",
    index: "12",
    eyebrow: "ALL-TIME LEDGER · PROPS",
    subtitlePrefix: "Every player-prop pick the agent has shipped",
    emptyTitle: "NO PROP PICKS RECORDED",
    emptyBody: "The agent hasn't shipped a player prop yet — the projector hasn't found a qualifying edge.",
  },
} as const;

export function OverallLedger({
  data,
  kind = "games",
}: {
  data: OverallRecord;
  kind?: "games" | "props";
}) {
  const labels = OVERALL_LABELS[kind];
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
          id={labels.anchor}
          index={labels.index}
          label={labels.eyebrow}
          title={labels.emptyTitle}
          status="STANDBY"
          statusColor="muted"
        />
        <div className="surface p-6">
          <p className="font-mono text-sm text-[var(--muted)]">
            ▸ {labels.emptyBody}
          </p>
        </div>
      </section>
    );
  }

  const wlRecord = `${wins}-${losses}${pushes > 0 ? `-${pushes}` : ""}`;
  const pnlColor = pnl > 0 ? "var(--edge)" : pnl < 0 ? "var(--kill)" : "var(--text)";
  const roiColor = roi !== null && roi > 0 ? "edge" : roi !== null && roi < 0 ? "kill" : "muted";

  const leagues = Object.entries(byLeague).sort((a, b) => (b[1].pnl ?? 0) - (a[1].pnl ?? 0));

  return (
    <section id={labels.anchor} className="space-y-10">
      {/* Editorial banner — no SectionHeader chrome. Tag + record on one
          baseline, then the massive number takes the page. */}
      <div className="flex items-baseline justify-between flex-wrap gap-3 pb-3 border-b border-[var(--border)]">
        <p className="eyebrow">{labels.eyebrow}</p>
        <p className="eyebrow text-[var(--faint)]">
          since {fmtDate(startDate)} · {totalPicks} shipped · {graded} graded · {pending} pending
        </p>
      </div>

      {/* Hero number — spans wide, italic serif, single dominant element */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-10 lg:gap-16 items-start">
        <div>
          <p className="eyebrow mb-4">Cumulative units</p>
          <p
            className="font-display leading-[0.85]"
            style={{
              fontStyle: "italic",
              fontSize: "clamp(5.5rem, 16vw, 14rem)",
              color: pnlColor,
              letterSpacing: "-0.05em",
            }}
          >
            {pnl > 0 ? "+" : ""}{pnl.toFixed(2)}
            <span
              className="text-[var(--muted)]"
              style={{ fontStyle: "normal", fontSize: "0.4em", marginLeft: "0.1em" }}
            >
              u
            </span>
          </p>
          <p className="mt-6 font-sans text-base text-[var(--text)] max-w-lg leading-relaxed">
            <span style={{ color: pnlColor }}>●</span>{" "}
            <span className="numeric font-medium" style={{ color: pnlColor }}>{wlRecord}</span>{" "}
            <span className="text-[var(--muted)]">record on </span>
            <span className="numeric text-[var(--text)]">{totalStake.toFixed(2)}u</span>{" "}
            <span className="text-[var(--muted)]">staked since paper trial began.</span>
          </p>
        </div>

        {/* Right rail — vertical stat list, editorial-table style */}
        <dl className="grid grid-cols-2 gap-x-8 gap-y-10 lg:border-l lg:border-[var(--border)] lg:pl-12 pt-6">
          <StatBlock
            label="Win rate"
            value={winRate !== null ? `${(winRate * 100).toFixed(1)}%` : "—"}
            color={winRate !== null && winRate >= 0.55 ? "edge" : winRate !== null && winRate >= 0.5 ? "signal" : "muted"}
          />
          <StatBlock
            label="ROI"
            value={roi !== null ? `${roi > 0 ? "+" : ""}${(roi * 100).toFixed(1)}%` : "—"}
            color={roiColor}
          />
          <StatBlock
            label="Streak"
            value={currentStreak.length > 0 ? `${currentStreak.kind}${currentStreak.length}` : "—"}
            color={currentStreak.kind === "W" ? "edge" : currentStreak.kind === "L" ? "kill" : "muted"}
          />
          <StatBlock
            label="Peak · Trough"
            value={`W${longestWinStreak} · L${longestLossStreak}`}
          />
        </dl>
      </div>

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

function StatBlock({
  label,
  value,
  color = "text",
}: {
  label: string;
  value: string;
  color?: "edge" | "warn" | "kill" | "signal" | "muted" | "text";
}) {
  return (
    <div>
      <p className="eyebrow mb-3">{label}</p>
      <p
        className="font-display leading-none"
        style={{
          fontStyle: "italic",
          fontSize: "clamp(2.25rem, 4.5vw, 3.5rem)",
          letterSpacing: "-0.02em",
          color: `var(--${color === "muted" ? "muted" : color})`,
        }}
      >
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
      <p className="font-sans text-sm mt-1 truncate text-[var(--text)]">{pick.matchup}</p>
      <p className="font-mono text-xs text-[var(--muted)] truncate">
        {pick.league} · {pick.selection}
      </p>
    </div>
  );
}
