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

  const mlCriteria = data.criteria.filter(c => c.track === "ml");
  const propCriteria = data.criteria.filter(c => c.track === "prop");
  const mlReady = mlCriteria.length > 0 && mlCriteria.every(c => c.met);
  const propReady = propCriteria.length > 0 && propCriteria.every(c => c.met);

  return (
    <section className="space-y-4">
      <SectionHeader
        id="deployment-gate"
        index="01"
        label="DEPLOYMENT GATE"
        title="FUNDING LOCKED"
        subtitle="Capital cannot deploy until all gates on a track clear. ML and Prop tracks are independent — props were enabled later and validate on their own metrics."
        status={mlReady ? "ML UNLOCKED" : "LOCKED"}
        statusColor={mlReady ? "edge" : "kill"}
      />

      {/* Sample-size deployment bar (ML only — prop sample is shown in its own track) */}
      <div className="surface p-4 sm:p-5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="eyebrow text-[var(--muted)]">ML SAMPLE PROGRESS</span>
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
              background: mlReady ? "var(--edge)" : "var(--signal)",
            }}
          />
        </div>
        <p className="eyebrow text-[var(--muted)]">
          {remaining > 0 ? `${remaining} REMAINING TO DEPLOY ML` : "ML SAMPLE TARGET MET"}
        </p>
      </div>

      {/* ML track */}
      <TrackGroup
        title="MONEYLINE TRACK"
        readyLabel={mlReady ? "UNLOCKED" : "LOCKED"}
        readyColor={mlReady ? "var(--edge)" : "var(--kill)"}
        criteria={mlCriteria}
        anyMet={anyMet}
      />

      {/* Prop track — only rendered once props have started accumulating */}
      {propCriteria.length > 0 && (
        <TrackGroup
          title="PROP TRACK"
          readyLabel={propReady ? "UNLOCKED" : "LOCKED"}
          readyColor={propReady ? "var(--edge)" : "var(--kill)"}
          criteria={propCriteria}
          anyMet={anyMet}
        />
      )}
    </section>
  );
}

function TrackGroup({
  title,
  readyLabel,
  readyColor,
  criteria,
  anyMet,
}: {
  title: string;
  readyLabel: string;
  readyColor: string;
  criteria: PaperTrialData["criteria"];
  anyMet: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow text-[var(--muted)]">{title}</span>
        <span className="pill" style={{ color: readyColor, borderColor: readyColor }}>
          {readyLabel}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {criteria.map((c, i) => (
          <GateModule key={i} criterion={c} state={gateState(c, anyMet)} />
        ))}
      </div>
    </div>
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
