// The desk strip — slim sticky bar above the ledger: mode, trial day,
// last/next agent run, funding state. The folio index row has been replaced
// by the TabShell tab rail which sits directly below this header.
// Solid paper, no glass; the funding state reads as plain ink (the bordered
// stamp is reserved for the page's three true-stamp moments).

import type { DashboardData } from "../_data/dashboard";

function rel(iso: string | null): string {
  if (!iso) return "—";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "NOW";
  if (m < 60) return `${m}M AGO`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}H AGO`;
  return `${Math.floor(h / 24)}D AGO`;
}

function fmtEt(iso: string): string {
  return new Date(iso)
    .toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    })
    .toUpperCase();
}

export function CommandHeader({ data }: { data: DashboardData }) {
  const { status, paperTrial } = data;
  return (
    <header className="sticky top-0 z-50 bg-paper border-b border-rule-strong">
      {/* Telemetry row — the only row; the nav row moved to TabShell */}
      <div className="px-4 sm:px-8 py-2 flex items-center gap-3 sm:gap-5 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <span className="dot dot-pulse" style={{ color: status.lastAgentRunAt ? "var(--win)" : "var(--ink-3)" }} />
          <span className="font-display font-black text-sm tracking-tight text-ink">
            NATESTACKS<span style={{ color: "var(--loss)" }}>*</span>
          </span>
          <span className="eyebrow hidden sm:inline">The Paper Trial</span>
        </div>
        <Divider />
        <Bit label="MODE" value="PAPER" tone="var(--hold)" />
        <Bit label="DAY" value={String(paperTrial.dayNumber).padStart(3, "0")} />
        <Bit label="LAST RUN" value={rel(status.lastAgentRunAt)} />
        <span className="hidden md:contents">
          <Bit label="NEXT" value={fmtEt(status.nextScheduledRunUtc)} />
        </span>
        <div className="ml-auto shrink-0">
          <span
            className="tag"
            style={{ color: paperTrial.ready ? "var(--win)" : "var(--hold)" }}
          >
            Funding · {paperTrial.ready ? "Unlocked" : "Locked"}
          </span>
        </div>
      </div>
    </header>
  );
}

function Bit({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5 shrink-0">
      <span className="eyebrow text-ink-3">{label}</span>
      <span className="num text-xs font-medium" style={{ color: tone ?? "var(--ink)" }}>
        {value}
      </span>
    </div>
  );
}

function Divider() {
  return <span className="hidden sm:inline-block h-3 w-px bg-rule-strong" aria-hidden />;
}
