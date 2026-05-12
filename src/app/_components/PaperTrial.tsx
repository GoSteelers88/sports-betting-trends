import type { PaperTrial as PaperTrialData } from "../_data/dashboard";

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
  const remaining = Math.max(0, TARGET_SAMPLE - data.totalGraded);

  const statusLabel = data.ready
    ? "READY"
    : data.totalGraded >= TARGET_SAMPLE
    ? "REVIEW"
    : `${remaining} TO GO`;

  return (
    <section className={`brutal-card ${data.ready ? "brutal-card-hazard" : ""} p-5 sm:p-6`}>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5 pb-4 border-b-[3px] border-white">
        <div className="flex items-baseline gap-4">
          <span className="display text-2xl sm:text-3xl text-[var(--hazard)]">PAPER TRIAL</span>
          <span className="display-eyebrow text-white/60">
            DAY {data.dayNumber} · {data.totalGraded}/{TARGET_SAMPLE}
          </span>
        </div>
        <span
          className={`display px-3 py-1 text-sm ${
            data.ready
              ? "brutal-fill-hazard"
              : "border-[3px] border-white text-white"
          }`}
        >
          {statusLabel}
        </span>
      </div>

      <div className="relative h-4 bg-black border-[3px] border-white mb-6">
        <div
          className="absolute inset-y-0 left-0 bg-[var(--hazard)]"
          style={{ width: `${samplePct}%` }}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border-[3px] border-white mb-5">
        <Mini label="CLV BEAT" value={clvBeatPct} sub={`N=${data.clvSampleSize}`} pos={data.clvBeatRate !== null && data.clvBeatRate >= 0.55} neg={data.clvBeatRate !== null && data.clvBeatRate < 0.5} />
        <Mini label="AVG CLV" value={clvAvg} pos={data.clvAverageCents !== null && data.clvAverageCents >= 2} neg={data.clvAverageCents !== null && data.clvAverageCents < 0} />
        <Mini label="P&L" value={`${data.pnl >= 0 ? "+" : ""}${data.pnl.toFixed(2)}U`} pos={data.pnl >= 0} neg={data.pnl < 0} />
        <Mini label="ROI" value={roiPct} pos={data.roi !== null && data.roi >= 0} neg={data.roi !== null && data.roi < 0} />
      </div>

      <div>
        <p className="display-eyebrow text-white mb-2">FUNDING CRITERIA</p>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-0 border-[3px] border-white">
          {data.criteria.map((c, i) => (
            <li
              key={i}
              className={`flex items-center justify-between px-3 py-3 text-xs border-b-[3px] border-r-[3px] border-white last:border-b-0 ${
                c.met ? "bg-[var(--hazard)] text-black" : "bg-black text-white"
              }`}
            >
              <span className="display flex items-center gap-2 min-w-0 text-[0.8rem]">
                <span>{c.met ? "✓" : "○"}</span>
                <span className="truncate">{c.label.toUpperCase()}</span>
              </span>
              <span className="mono shrink-0 font-semibold">
                {c.current} <span className="opacity-50">/ {c.target}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-4 mono text-[0.7rem] text-white/50 uppercase tracking-wider">
        {decided > 0 ? `RECORD ${data.wins}-${data.losses}${data.pushes ? `-${data.pushes}` : ""} (${winRate}% W) // ` : ""}
        CLV BEAT RATE IS THE LEADING INDICATOR — &gt;55% OVER 200+ PICKS SIGNALS REAL EDGE
      </p>
    </section>
  );
}

function Mini({
  label,
  value,
  sub,
  pos,
  neg,
}: {
  label: string;
  value: string;
  sub?: string;
  pos?: boolean;
  neg?: boolean;
}) {
  const color = pos ? "text-[var(--color-win)]" : neg ? "text-[var(--color-loss)]" : "text-white";
  return (
    <div className="px-4 py-3 border-r-[3px] border-b-[3px] border-white last:border-r-0 sm:[&:nth-child(4)]:border-r-0 sm:[&:nth-child(n+3)]:border-b-0 [&:nth-child(n+3)]:border-b-0">
      <p className="display-eyebrow text-white/60 text-[0.6rem]">{label}</p>
      <p className={`odds-display mt-1 text-2xl ${color}`}>{value}</p>
      {sub && <p className="mono text-[0.6rem] text-white/40 mt-0.5">{sub}</p>}
    </div>
  );
}
