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
    <section className="receipts-section space-y-6 relative">
      {/* True stamp moment No. 2 — the seal, once, site-wide. Locked is a
          hold, not a loss, so it seals in ochre until the gate clears. At
          narrow widths it stamps in flow ABOVE the head on ink-free paper;
          from sm up it seats over the rules as before. */}
      <div className="sm:hidden flex justify-end mb-2 pointer-events-none">
        <StampIn>
          <span
            className="stamp-true"
            style={{ color: mlReady ? "var(--win)" : "var(--hold)", transform: "rotate(-4deg)" }}
          >
            Funding · {mlReady ? "Unlocked" : "Locked"}
          </span>
        </StampIn>
      </div>

      <SectionHeader
        id="deployment-gate"
        label={`TRIAL TO DATE · SINCE MAY 6 · ${mlReady ? "TERMS SATISFIED" : "REAL MONEY STAYS LOCKED"}`}
        title="THE FUNDING GATE"
        subtitle="Canonical trial-to-date numbers. Capital cannot deploy until every gate on a track clears; the ML and prop tracks are independent."
        status={`${gatesMet}/${mlCriteria.length} ML criteria clear`}
        statusTone={mlReady ? "win" : "hold"}
      />

      {/* The same seal, absolute over the rule at sm+ (crit-approved at 1280/1800) */}
      <div className="hidden sm:block absolute right-0 top-2 z-10 pointer-events-none">
        <StampIn>
          <span
            className="stamp-true"
            style={{ color: mlReady ? "var(--win)" : "var(--hold)", transform: "rotate(-4deg)" }}
          >
            Funding · {mlReady ? "Unlocked" : "Locked"}
          </span>
        </StampIn>
      </div>

      {/* Sample progress — ML only; prop sample reads on its own line item */}
      <div className="panel px-4 py-3">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <span className="eyebrow">ML sample · trial</span>
          <span className="num text-sm">
            <span className="text-ink font-semibold">{data.totalGraded}</span>
            <span className="text-ink-3"> / {TARGET_SAMPLE} graded</span>
            <span className="text-ink-3 hidden sm:inline">
              {remaining > 0 ? ` · ${remaining} remaining` : " · target met"}
            </span>
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
      </div>

      <GateTable
        title="Moneyline track"
        sub="Gates initial Kalshi placement — the primary venue. Window: trial to date."
        ready={mlReady}
        criteria={mlCriteria}
        anyMet={anyMet}
      />

      {/* The prop track folds: n=4, and the ML track is the gate that matters
          for Kalshi placement. The summary carries its count and state. */}
      {propCriteria.length > 0 && (
        <details className="group panel">
          <summary className="px-4 sm:px-5 py-2.5 cursor-pointer list-none flex items-baseline justify-between gap-3 hover:bg-paper-3/60 transition-colors">
            <span className="eyebrow">
              Prop track · {propCriteria.filter((c) => c.met).length}/{propCriteria.length} clear ·{" "}
              <span style={{ color: propReady ? "var(--win)" : "var(--hold)" }}>
                {propReady ? "unlocked" : "locked"}
              </span>
            </span>
            <span className="eyebrow text-ink-3 group-open:hidden">+ Unfold</span>
            <span className="eyebrow text-ink-3 hidden group-open:inline">− Fold</span>
          </summary>
          <div className="border-t border-rule">
            <GateTable
              title="Prop track"
              sub="Gates prop placement; validated by win rate, not CLV. Window: trial to date."
              ready={propReady}
              criteria={propCriteria}
              anyMet={anyMet}
            />
          </div>
        </details>
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
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5"
        style={{ borderBottom: "3px double var(--rule-strong)" }}
      >
        <div className="min-w-0">
          <h3 className="font-display font-semibold text-base text-ink leading-tight">{title}</h3>
          <p className="eyebrow text-ink-3 mt-0.5 hidden sm:block">{sub}</p>
        </div>
        <div className="flex items-center gap-4">
          <span className="num text-sm text-ink-2">
            {passed}/{criteria.length} clear
          </span>
          <span className="tag" style={{ color: ready ? "var(--win)" : "var(--hold)" }}>
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
