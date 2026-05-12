import type { PaperTrial as PaperTrialData } from "../_data/dashboard";

const TARGET = 200;

export function PaperTrial({ data }: { data: PaperTrialData }) {
  const samplePct = Math.min(100, (data.totalGraded / TARGET) * 100);
  const remaining = Math.max(0, TARGET - data.totalGraded);
  const clvBeat = data.clvBeatRate !== null ? `${(data.clvBeatRate * 100).toFixed(1)}%` : "—";
  const clvAvg =
    data.clvAverageCents !== null
      ? `${data.clvAverageCents >= 0 ? "+" : ""}${data.clvAverageCents.toFixed(1)}¢`
      : "—";
  const roi = data.roi !== null ? `${(data.roi * 100).toFixed(1)}%` : "—";

  return (
    <Panel label="PAPER_TRIAL // CLV-GATED" status={data.ready ? "READY" : `${remaining} TO GO`}>
      {/* Sample progress — radar-style bar */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between mb-2 var-mono text-[0.65rem] uppercase tracking-[0.3em] text-[var(--concrete)]">
          <span>SAMPLE</span>
          <span style={{ color: "var(--foreground)" }}>
            {data.totalGraded}/{TARGET}
          </span>
        </div>
        <div className="relative h-3 bg-[var(--concrete-dark)] border border-[var(--rust-deep)]">
          <div
            className="absolute inset-y-0 left-0"
            style={{
              width: `${samplePct}%`,
              background: data.ready ? "var(--rust-flash)" : "var(--rust)",
            }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4 mb-5">
        <Telemetry label="CLV BEAT" value={clvBeat} sub={`N=${data.clvSampleSize}`} hot={data.clvBeatRate !== null && data.clvBeatRate >= 0.55} cold={data.clvBeatRate !== null && data.clvBeatRate < 0.5} />
        <Telemetry label="AVG CLV" value={clvAvg} hot={data.clvAverageCents !== null && data.clvAverageCents >= 2} cold={data.clvAverageCents !== null && data.clvAverageCents < 0} />
        <Telemetry label="P&L" value={`${data.pnl >= 0 ? "+" : ""}${data.pnl.toFixed(2)}U`} hot={data.pnl >= 0} cold={data.pnl < 0} />
        <Telemetry label="ROI" value={roi} hot={data.roi !== null && data.roi >= 0} cold={data.roi !== null && data.roi < 0} />
      </div>

      <ul className="space-y-1">
        {data.criteria.map((c, i) => (
          <li
            key={i}
            className="flex items-center justify-between gap-3 px-2 py-1.5 var-mono text-[0.7rem] uppercase tracking-wider"
            style={{
              color: c.met ? "var(--rust-flash)" : "var(--concrete)",
              borderLeft: `3px solid ${c.met ? "var(--rust-flash)" : "var(--concrete-dark)"}`,
            }}
          >
            <span>
              {c.met ? "▸" : "▹"} {c.label}
            </span>
            <span style={{ color: c.met ? "var(--rust-flash)" : "var(--foreground)" }}>
              {c.current} / {c.target}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// Local Panel wrapper — exported pattern reused by other telemetry blocks
function Panel({
  label,
  status,
  children,
}: {
  label: string;
  status?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="relative">
      <div className="flex items-baseline justify-between mb-3">
        <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--rust)]">
          // {label}
        </span>
        {status && (
          <span className="var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--foreground)] scramble">
            {status}
          </span>
        )}
      </div>
      <div
        className="relative p-5 sm:p-6 bg-[var(--concrete-dark)]/30"
        style={{ border: "1px solid var(--rust-deep)" }}
      >
        {children}
      </div>
    </section>
  );
}

function Telemetry({
  label,
  value,
  sub,
  hot,
  cold,
}: {
  label: string;
  value: string;
  sub?: string;
  hot?: boolean;
  cold?: boolean;
}) {
  const color = hot ? "var(--rust-flash)" : cold ? "var(--cold)" : "var(--foreground)";
  const weight = hot ? 800 : cold ? 300 : 500;
  return (
    <div>
      <p className="var-mono text-[0.6rem] uppercase tracking-[0.3em] text-[var(--concrete)]">
        {label}
      </p>
      <p
        className="var-display text-2xl sm:text-3xl mt-1"
        style={{ color, ["--wght" as string]: String(weight) }}
      >
        {value}
      </p>
      {sub && (
        <p className="var-mono text-[0.55rem] uppercase tracking-wider text-[var(--concrete)] mt-0.5">
          {sub}
        </p>
      )}
    </div>
  );
}

export { Panel };
