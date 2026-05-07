import type { PaperTrial as PaperTrialData } from "../_data/dashboard";

// CLV-validated trial: needs ~200 graded picks for statistical significance.
// At 1-3 picks/day this takes 70-200 days, so we measure progress against
// the sample-size target rather than calendar days.
const TARGET_SAMPLE = 200;

export function PaperTrial({ data }: { data: PaperTrialData }) {
  const samplePct = Math.min(100, (data.totalGraded / TARGET_SAMPLE) * 100);
  const decided = data.wins + data.losses;
  const winRate = decided > 0 ? ((data.wins / decided) * 100).toFixed(1) : "—";
  const roiPct = data.roi !== null ? `${(data.roi * 100).toFixed(1)}%` : "—";

  const clvBeatPct =
    data.clvBeatRate !== null ? `${(data.clvBeatRate * 100).toFixed(1)}%` : "—";
  const clvAvg =
    data.clvAverageCents !== null
      ? `${data.clvAverageCents >= 0 ? "+" : ""}${data.clvAverageCents.toFixed(1)}¢`
      : "—";
  const clvAccent: "lime" | "redx" | undefined =
    data.clvAverageCents === null
      ? undefined
      : data.clvAverageCents >= 2
      ? "lime"
      : data.clvAverageCents < 0
      ? "redx"
      : undefined;

  // Color the bar by readiness state
  const barColor = data.ready
    ? "from-emerald-400 to-emerald-300"
    : data.totalGraded >= TARGET_SAMPLE
    ? "from-rose-500 to-rose-400"
    : "from-cyan-400 to-violet-400";

  const remaining = Math.max(0, TARGET_SAMPLE - data.totalGraded);

  return (
    <section className="glass-strong rounded-3xl p-5 sm:p-6 relative overflow-hidden">
      <div className="absolute top-0 right-0 h-40 w-40 rounded-full bg-cyan-400/10 blur-3xl -translate-y-1/2 translate-x-1/2" />

      <div className="relative">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
          <div className="flex items-baseline gap-3">
            <span className="display-eyebrow text-cyan-300">📋 Paper Trial · CLV-gated</span>
            <span className="mono text-xs text-slate-400">
              Day <span className="text-white">{data.dayNumber}</span> · {data.totalGraded}/{TARGET_SAMPLE} picks
            </span>
          </div>
          <span
            className={`mono text-xs px-2 py-0.5 rounded-full ${
              data.ready
                ? "bg-emerald-500/20 text-emerald-200"
                : data.totalGraded >= TARGET_SAMPLE
                ? "bg-rose-500/20 text-rose-200"
                : "bg-slate-700/40 text-slate-300"
            }`}
          >
            {data.ready
              ? "READY TO FUND"
              : data.totalGraded >= TARGET_SAMPLE
              ? "REVIEW & ADJUST"
              : `${remaining} picks to go`}
          </span>
        </div>

        {/* Sample-size progress bar (replaces day progress) */}
        <div className="relative h-2 rounded-full bg-white/5 overflow-hidden mb-4">
          <div
            className={`absolute left-0 top-0 h-full rounded-full bg-gradient-to-r ${barColor}`}
            style={{ width: `${samplePct}%` }}
          />
        </div>

        {/* Top-line stats — CLV is the headliner */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Mini
            label="CLV Beat"
            value={clvBeatPct}
            sub={`n=${data.clvSampleSize}`}
            accent={
              data.clvBeatRate !== null && data.clvBeatRate >= 0.55
                ? "lime"
                : data.clvBeatRate !== null && data.clvBeatRate < 0.5
                ? "redx"
                : undefined
            }
          />
          <Mini label="Avg CLV" value={clvAvg} accent={clvAccent} />
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

        {/* Footnote — record + CLV explainer */}
        <p className="mt-3 text-xs text-slate-500">
          {decided > 0 ? `Record ${data.wins}-${data.losses}${data.pushes ? `-${data.pushes}` : ""} (${winRate}% W). ` : ""}
          CLV beat rate is the leading indicator — &gt;55% over 200+ picks signals real edge. Trial unlocks Kalshi placement when all 5 criteria are met.
        </p>
      </div>
    </section>
  );
}

function Mini({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "lime" | "redx";
}) {
  const color = accent === "lime" ? "text-[#22ff88]" : accent === "redx" ? "text-[#ff3b3b]" : "text-white";
  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2">
      <p className="display-eyebrow text-slate-500 text-[0.6rem]">{label}</p>
      <p className={`mono mt-0.5 text-base font-semibold ${color}`}>{value}</p>
      {sub ? <p className="mono text-[0.55rem] text-slate-600 -mt-0.5">{sub}</p> : null}
    </div>
  );
}
