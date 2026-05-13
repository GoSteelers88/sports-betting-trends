import type { PaperTrial as PaperTrialData } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

const TARGET_SAMPLE = 200;

type GateState = "passed" | "failed" | "pending" | "locked";

function gateState(c: PaperTrialData["criteria"][number], anyMet: boolean): GateState {
  if (c.met) return "passed";
  if (!anyMet) return "locked";
  // "failed" if it has a measurable current that fell short; "pending" otherwise
  if (c.current === "—" || c.current === "" || /^0$/.test(c.current)) return "pending";
  return "failed";
}

export function DeploymentGate({ data }: { data: PaperTrialData }) {
  const samplePct = Math.min(100, (data.totalGraded / TARGET_SAMPLE) * 100);
  const remaining = Math.max(0, TARGET_SAMPLE - data.totalGraded);
  const anyMet = data.criteria.some(c => c.met);

  return (
    <section className="space-y-4">
      <SectionHeader
        id="deployment-gate"
        index="01"
        label="DEPLOYMENT GATE"
        title="FUNDING LOCKED"
        subtitle="Capital cannot deploy until all five gates clear. CLV beat rate is the leading edge signal — calendar days are irrelevant."
        status={data.ready ? "UNLOCKED" : "LOCKED"}
        statusColor={data.ready ? "edge" : "kill"}
      />

      {/* Sample-size deployment bar */}
      <div className="surface p-4 sm:p-5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="eyebrow text-[var(--muted)]">SAMPLE PROGRESS</span>
          <span className="numeric text-sm">
            <span className="text-[var(--text)]">{data.totalGraded}</span>
            <span className="text-[var(--muted)]"> / {TARGET_SAMPLE}</span>
          </span>
        </div>
        <div className="meter h-2 mb-2">
          <div
            className="meter-fill"
            style={{
              width: `${samplePct}%`,
              background: data.ready ? "var(--edge)" : "var(--signal)",
            }}
          />
        </div>
        <p className="eyebrow text-[var(--muted)]">
          {remaining > 0 ? `${remaining} REMAINING TO DEPLOY` : "SAMPLE TARGET MET"}
        </p>
      </div>

      {/* Five gate modules */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {data.criteria.map((c, i) => (
          <GateModule key={i} criterion={c} state={gateState(c, anyMet)} />
        ))}
      </div>
    </section>
  );
}

function GateModule({
  criterion,
  state,
}: {
  criterion: PaperTrialData["criteria"][number];
  state: GateState;
}) {
  const palette =
    state === "passed"
      ? { color: "var(--edge)", label: "PASSED", glyph: "✓" }
      : state === "failed"
      ? { color: "var(--kill)", label: "FAILED", glyph: "×" }
      : state === "pending"
      ? { color: "var(--warn)", label: "PENDING", glyph: "○" }
      : { color: "var(--muted)", label: "LOCKED", glyph: "⊘" };

  return (
    <article
      className="p-4 sm:p-5 surface flex flex-col gap-3"
      style={{
        borderColor:
          state === "passed" ? "rgba(217,122,61,0.35)"
          : state === "failed" ? "rgba(178,58,72,0.35)"
          : "var(--border)",
      }}
    >
      <div className="flex items-center justify-between">
        <span
          className="font-mono text-base leading-none"
          aria-hidden="true"
          style={{ color: palette.color }}
        >
          {palette.glyph}
        </span>
        <span
          className="pill"
          style={{ color: palette.color, borderColor: palette.color }}
        >
          {palette.label}
        </span>
      </div>
      <h3 className="font-display text-lg leading-tight text-[var(--text)]">
        {criterion.label}
      </h3>
      <div className="flex items-baseline justify-between mt-auto">
        <span className="eyebrow text-[var(--muted)]">CURRENT</span>
        <span className="numeric text-base" style={{ color: palette.color }}>
          {criterion.current}
        </span>
      </div>
      <div className="flex items-baseline justify-between">
        <span className="eyebrow text-[var(--muted)]">TARGET</span>
        <span className="numeric text-xs text-[var(--muted)]">{criterion.target}</span>
      </div>
    </article>
  );
}
