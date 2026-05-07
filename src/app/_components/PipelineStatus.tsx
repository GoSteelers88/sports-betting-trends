import type { PipelineStatus as PipelineStatusData } from "../_data/dashboard";

export function PipelineStatus({ data }: { data: PipelineStatusData }) {
  if (data.totalRunsLast14d === 0) return null; // hide before data exists

  const clvColor =
    data.avgClvCents === null
      ? "text-slate-400"
      : data.avgClvCents > 0
      ? "text-[#22ff88]"
      : "text-[#ff3b3b]";

  const killRateColor =
    data.killRatePct === null
      ? "text-slate-400"
      : data.killRatePct >= 25
      ? "text-[#22ff88]"
      : "text-amber-300";

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="display-eyebrow text-cyan-300">⚙ Pipeline Status (last 14d)</h2>
        <span className="text-xs text-slate-500 mono">{data.totalRunsLast14d} runs</span>
      </div>
      <div className="glass rounded-2xl p-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        <Stat label="Raw picks" value={`${data.rawAnalystPicks14d}`} hint="LLM proposed" />
        <Stat label="Grader kept" value={`${data.graderKept14d}`} hint="passed rubric" />
        <Stat label="Critic killed" value={`${data.criticKilled14d}`} hint="devil's advocate" />
        <Stat label="Bankroll dropped" value={`${data.bankrollDropped14d}`} hint="cap/dup" />
        <Stat
          label="Kill rate"
          value={data.killRatePct !== null ? `${data.killRatePct}%` : "—"}
          hint="critic / raw"
          colorClass={killRateColor}
        />
        <Stat label="Final shipped" value={`${data.finalShipped14d}`} hint="went to DB/Discord" />
        <Stat
          label="Avg CLV"
          value={data.avgClvCents !== null ? `${data.avgClvCents > 0 ? "+" : ""}${data.avgClvCents}¢` : "—"}
          hint={`n=${data.clvSampleSize} picks`}
          colorClass={clvColor}
        />
        {data.parseFailedRuns14d > 0 && (
          <Stat
            label="Parse fails"
            value={`${data.parseFailedRuns14d}`}
            hint="critic JSON broke"
            colorClass="text-amber-300"
          />
        )}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  colorClass,
}: {
  label: string;
  value: string;
  hint?: string;
  colorClass?: string;
}) {
  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/5 px-3 py-2">
      <p className="display-eyebrow text-slate-500 text-[0.6rem]">{label}</p>
      <p className={`mono mt-0.5 text-base font-semibold ${colorClass ?? "text-white"}`}>{value}</p>
      {hint && <p className="text-[0.6rem] text-slate-600 mt-0.5">{hint}</p>}
    </div>
  );
}
