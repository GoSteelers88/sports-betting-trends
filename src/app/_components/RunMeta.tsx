// One line of run telemetry: when the analyst last ran, when it runs next.
// The only thing that survives from CommandHeader, and it lives in content
// (the "/" today-section meta; the "/desk" status line), never in the header.
//
// Same fields CommandHeader read: status.lastAgentRunAt and
// status.nextScheduledRunUtc. When the last run is older than 26h the token
// prints in the hold tone — same number, honest tone. A three-day-old run is
// an operator alert, and the front page is where he will see it.

import type { DashboardData } from "../_data/dashboard";
import { RUN_HOLD_AFTER_HOURS, runIsStale } from "@/lib/today-list";
import { fmtEtClock, rel } from "./format";

export function RunMeta({
  status,
  lead = [],
  trail = [],
  className = "",
}: {
  status: DashboardData["status"];
  /** Tokens printed before the run tokens, e.g. "2 LIVE PLAYS". */
  lead?: ReadonlyArray<string>;
  /** Tokens printed after, e.g. "63 RUNS / 14D". */
  trail?: ReadonlyArray<string>;
  className?: string;
}) {
  const nowMs = Date.now();
  const stale = runIsStale(status.lastAgentRunAt, nowMs);
  return (
    <p className={`eyebrow section-meta ${className}`.trim()}>
      {lead.map((t) => (
        <span key={t}>{t} · </span>
      ))}
      {/* No run on record is the pipeline-down proxy: every DB loader
          degrades to empties, so a Turso outage would otherwise render as a
          calm "Nothing is live". Say the absence instead. */}
      <span
        style={stale ? { color: "var(--hold)" } : undefined}
        title={stale ? `No agent run in the last ${RUN_HOLD_AFTER_HOURS} hours` : undefined}
      >
        {status.lastAgentRunAt === null
          ? "NO RUN ON RECORD — THE DESK COULD NOT READ ITS LEDGER"
          : `ANALYST LAST RAN ${rel(status.lastAgentRunAt, nowMs)}`}
      </span>
      {" · NEXT RUN "}
      {fmtEtClock(status.nextScheduledRunUtc)}
      {trail.map((t) => (
        <span key={t}> · {t}</span>
      ))}
    </p>
  );
}
