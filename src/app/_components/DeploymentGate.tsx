// Folio 03 — the funding gate. The contract the agent must satisfy before a
// real dollar moves, and the CANONICAL trial-to-date numbers: every figure
// in these tables is the full paper-trial window (since May 6). The big
// FUNDING seal across the folio is true-stamp moment No. 2. Row verdicts
// are plain tags — the bordered stamp stays exclusive.

import type { PaperTrial as PaperTrialData } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";
import { StampIn } from "./motion";

const TARGET_SAMPLE = 200;

type GateState = "passed" | "failed" | "pending" | "locked";

function gateState(c: PaperTrialData["criteria"][number], anyMet: boolean): GateState {
  if (c.met) return "passed";
  if (!anyMet) return "locked";
  if (c.current === "—" || c.current === "" || /^0$/.test(c.current)) return "pending";
  return "failed";
}

const STATE_TONE: Record<GateState, { color: string; label: string }> = {
  passed: { color: "var(--win)", label: "passed" },
  failed: { color: "var(--loss)", label: "failed" },
  pending: { color: "var(--hold)", label: "pending" },
  locked: { color: "var(--ink-3)", label: "locked" },
};

export function DeploymentGate({ data }: { data: PaperTrialData }) {
  const samplePct = Math.min(100, (data.totalGraded / TARGET_SAMPLE) * 100);
  const remaining = Math.max(0, TARGET_SAMPLE - data.totalGraded);
  const anyMet = data.criteria.some(c => c.met);

  const mlCriteria = data.criteria.filter(c => c.track === "ml");
  const propCriteria = data.criteria.filter(c => c.track === "prop");
  const mlReady = mlCriteria.length > 0 && mlCriteria.every(c => c.met);
  const propReady = propCriteria.length > 0 && propCriteria.every(c => c.met);
  const gatesMet = mlCriteria.filter(c => c.met).length;

  return (
    <section className="space-y-6 relative">
      {/* True stamp moment No. 2 — the seal. At narrow widths it stamps
          in flow ABOVE the kicker on ink-free paper (same rotation, same
          size); from sm up it seats over the rules as before. */}
      <div className="sm:hidden flex justify-end -mb-10 pointer-events-none">
        <StampIn>
          <span
            className="stamp-true"
            style={{ color: mlReady ? "var(--win)" : "var(--loss)", transform: "rotate(-4deg)" }}
          >
            Funding · {mlReady ? "Unlocked" : "Locked"}
          </span>
        </StampIn>
      </div>

      <SectionHeader
        id="deployment-gate"
        index="03"
        label="THE FUNDING GATE · TRIAL TO DATE"
        title={mlReady ? "Terms satisfied" : "Real money stays locked"}
        subtitle="Canonical trial-to-date numbers — every figure below covers the full paper trial since May 6. Capital cannot deploy until every gate on a track clears. ML and prop tracks are independent."
        status={`${gatesMet}/${mlCriteria.length} ML criteria clear`}
        statusTone={mlReady ? "win" : "loss"}
      />

      {/* The same seal, absolute over the rule at sm+ (crit-approved at 1280/1800) */}
      <div className="hidden sm:block absolute right-0 top-2 z-10 pointer-events-none">
        <StampIn>
          <span
            className="stamp-true"
            style={{ color: mlReady ? "var(--win)" : "var(--loss)", transform: "rotate(-4deg)" }}
          >
            Funding · {mlReady ? "Unlocked" : "Locked"}
          </span>
        </StampIn>
      </div>

      {/* Sample progress — ML only; prop sample reads on its own line item */}
      <div className="panel p-5">
        <div className="flex items-baseline justify-between mb-3">
          <span className="eyebrow">ML sample progress · trial</span>
          <span className="num text-sm">
            <span className="text-ink font-semibold">{data.totalGraded}</span>
            <span className="text-ink-3"> / {TARGET_SAMPLE} graded</span>
          </span>
        </div>
        <div className="meter" style={{ height: 6 }}>
          <div
            className="meter-fill"
            style={{
              width: `${samplePct}%`,
              background: mlReady ? "var(--win)" : "var(--ink)",
            }}
          />
        </div>
        <p className="eyebrow text-ink-3 mt-3">
          {remaining > 0
            ? `${remaining} graded picks remaining before ML can deploy`
            : "ML sample target met"}
        </p>
      </div>

      <GateTable
        title="Moneyline track"
        sub="Gates initial Kalshi placement — the primary venue. Window: trial to date."
        ready={mlReady}
        criteria={mlCriteria}
        anyMet={anyMet}
      />

      {propCriteria.length > 0 && (
        <GateTable
          title="Prop track"
          sub="Gates prop placement; validated by win rate, not CLV. Window: trial to date."
          ready={propReady}
          criteria={propCriteria}
          anyMet={anyMet}
        />
      )}
    </section>
  );
}

function GateTable({
  title,
  sub,
  ready,
  criteria,
  anyMet,
}: {
  title: string;
  sub: string;
  ready: boolean;
  criteria: PaperTrialData["criteria"];
  anyMet: boolean;
}) {
  const passed = criteria.filter(c => c.met).length;
  return (
    <div className="panel">
      <header
        className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
        style={{ borderBottom: "3px double var(--rule-strong)" }}
      >
        <div>
          <h3 className="font-display font-semibold text-lg text-ink leading-tight">{title}</h3>
          <p className="eyebrow text-ink-3 mt-0.5">{sub}</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="num text-sm text-ink-2">
            {passed}/{criteria.length} clear
          </span>
          <span className="tag" style={{ color: ready ? "var(--win)" : "var(--loss)" }}>
            {ready ? "Unlocked" : "Locked"}
          </span>
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="ledger-table">
          <caption className="sr-only">{title} funding criteria</caption>
          <thead>
            {/* No TARGET column — every target is already restated in the
                criterion label ("ML sample size ≥ 200"); printing it twice
                was dead ink and pushed the table off-canvas at 360. */}
            <tr>
              <th scope="col">Verdict</th>
              <th scope="col">Criterion</th>
              <th scope="col" className="text-right">Current · trial</th>
            </tr>
          </thead>
          <tbody>
            {criteria.map((c, i) => {
              const state = gateState(c, anyMet);
              const tone = STATE_TONE[state];
              return (
                <tr
                  key={i}
                  style={
                    state === "failed"
                      ? { background: "var(--loss-wash)" }
                      : state === "passed"
                      ? { background: "var(--win-wash)" }
                      : undefined
                  }
                >
                  <td>
                    <span className="tag" style={{ color: tone.color }}>
                      {tone.label}
                    </span>
                  </td>
                  <td className="text-sm text-ink font-medium">{c.label}</td>
                  <td className="num text-sm text-right font-semibold" style={{ color: tone.color }}>
                    {c.current}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
