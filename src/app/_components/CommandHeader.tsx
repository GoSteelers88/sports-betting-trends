// The desk strip — slim sticky bar above the ledger: mode, trial day,
// last/next agent run, funding state, and the folio index. The index maps
// 1:1 onto the page's folios and anchor-links to each. Solid paper, no
// glass; the funding state reads as plain ink (the bordered stamp is
// reserved for the page's three true-stamp moments).

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

// 1:1 with the page's folios, in print order.
const NAV = [
  { id: "front-page", num: "01", label: "Front page" },
  { id: "tonights-play", num: "02", label: "Tonight" },
  { id: "deployment-gate", num: "03", label: "Gate" },
  { id: "ledger", num: "04", label: "Account" },
  { id: "kill-room", num: "05", label: "Kill room" },
  { id: "experiments", num: "06", label: "Experiments" },
  { id: "market-feed", num: "07", label: "Board" },
  { id: "props-desk", num: "08", label: "Props desk" },
  { id: "back-of-book", num: "BB", label: "Back of book" },
];

export function CommandHeader({ data }: { data: DashboardData }) {
  const { status, paperTrial } = data;
  return (
    <header className="sticky top-0 z-50 bg-paper border-b border-rule-strong">
      {/* Telemetry row */}
      <div className="px-4 sm:px-8 py-2 flex items-center gap-3 sm:gap-5 flex-wrap border-b border-rule">
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
          <a
            href="#deployment-gate"
            className="tag hover:underline underline-offset-4"
            style={{ color: paperTrial.ready ? "var(--win)" : "var(--loss)" }}
          >
            Funding · {paperTrial.ready ? "Unlocked" : "Locked"}
          </a>
        </div>
      </div>

      {/* Folio index */}
      <nav
        aria-label="Folio index"
        className="px-4 sm:px-8 flex items-center overflow-x-auto"
      >
        {NAV.map(n => (
          <a
            key={n.id}
            href={`#${n.id}`}
            className="eyebrow shrink-0 py-2 pr-4 text-ink-3 hover:text-ink transition-colors flex items-baseline gap-1.5"
          >
            <span className="num text-[0.6rem] text-ink-3">{n.num}</span>
            {n.label}
          </a>
        ))}
      </nav>
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
