import type { PaperTrial as PaperTrialData } from "../_data/dashboard";

export function PaperTrial({ data }: { data: PaperTrialData }) {
  const pct = Math.min(100, (data.dayNumber / 30) * 100);
  const decided = data.wins + data.losses;
  const winRate = decided > 0 ? ((data.wins / decided) * 100).toFixed(1) : "—";
  const roiPct = data.roi !== null ? `${(data.roi * 100).toFixed(1)}%` : "—";

  // Color the bar by readiness state
  const barColor = data.ready
    ? "from-emerald-400 to-emerald-300"
    : data.dayNumber >= 30
    ? "from-rose-500 to-rose-400"
    : "from-cyan-400 to-violet-400";

  return (
    <section className="glass-strong rounded-3xl p-5 sm:p-6 relative overflow-hidden">
      <div className="absolute top-0 right-0 h-40 w-40 rounded-full bg-cyan-400/10 blur-3xl -translate-y-1/2 translate-x-1/2" />

      <div className="relative">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
          <div className="flex items-baseline gap-3">
            <span className="display-eyebrow text-cyan-300">📋 Kalshi Paper Trial</span>
            <span className="mono text-xs text-slate-400">
              Day <span className="text-white">{data.dayNumber}</span> / 30
            </span>
          </div>
          <span
            className={`mono text-xs px-2 py-0.5 rounded-full ${
              data.ready
                ? "bg-emerald-500/20 text-emerald-200"
                : data.dayNumber >= 30
                ? "bg-rose-500/20 text-rose-200"
                : "bg-slate-700/40 text-slate-300"
            }`}
          >
            {data.ready ? "READY TO FUND" : data.dayNumber >= 30 ? "REVIEW & ADJUST" : `${data.daysRemaining}d remaining`}
          </span>
        </div>

        {/* Progress bar */}
        <div className="relative h-2 rounded-full bg-white/5 overflow-hidden mb-4">
          <div
            className={`absolute left-0 top-0 h-full rounded-full bg-gradient-to-r ${barColor}`}
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Top-line stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Mini label="Graded" value={`${data.totalGraded}`} />
          <Mini label="Record" value={`${data.wins}-${data.losses}${data.pushes ? `-${data.pushes}` : ""}`} />
          <Mini
            label="P&L"
            value={`${data.pnl >= 0 ? "+" : ""}${data.pnl.toFixed(2)}u`}
            accent={data.pnl >= 0 ? "lime" : "redx"}
          />
          <Mini label="ROI" value={roiPct} accent={data.roi !== null && data.roi >= 0 ? "lime" : "redx"} />
        </div>

        {/* Criteria checklist */}
        <div>
          <p className="display-eyebrow text-slate-400 mb-2 text-[0.65rem]">Funding Criteria</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {data.criteria.map((c, i) => (
              <div
                key={i}
                className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs ${
                  c.met ? "bg-emerald-500/10 border border-emerald-400/20" : "bg-white/[0.03] border border-white/5"
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className={c.met ? "text-emerald-300" : "text-slate-500"}>{c.met ? "✓" : "○"}</span>
                  <span className="text-slate-200 truncate">{c.label}</span>
                </span>
                <span className={`mono shrink-0 ${c.met ? "text-emerald-200" : "text-slate-400"}`}>
                  {c.current}
                  <span className="text-slate-600"> / {c.target}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Win-rate footnote */}
        <p className="mt-3 text-xs text-slate-500">
          {decided > 0 ? `Win rate ${winRate}% on ${decided} decided picks. ` : ""}
          {data.maxLossStreak > 0 ? `Max losing streak: ${data.maxLossStreak}. ` : ""}
          Trial ends after Day 30; if all 5 criteria met, the agent can begin Kalshi placement.
        </p>
      </div>
    </section>
  );
}

function Mini({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "lime" | "redx";
}) {
  const color = accent === "lime" ? "text-[#22ff88]" : accent === "redx" ? "text-[#ff3b3b]" : "text-white";
  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2">
      <p className="display-eyebrow text-slate-500 text-[0.6rem]">{label}</p>
      <p className={`mono mt-0.5 text-base font-semibold ${color}`}>{value}</p>
    </div>
  );
}
