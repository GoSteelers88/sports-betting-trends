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

const NAV = [
  { id: "ledger", label: "Ledger" },
  { id: "reactor", label: "Reactor" },
  { id: "survivors", label: "Survivors" },
  { id: "last-night", label: "Last Night" },
  { id: "kill-room", label: "Kill Room" },
  { id: "prop-signals", label: "Props" },
  { id: "market-feed", label: "Market Feed" },
  { id: "system-memory", label: "Memory" },
];

export function CommandHeader({ data }: { data: DashboardData }) {
  const { status, paperTrial } = data;
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--border)] backdrop-blur-xl bg-[#05070A]/85">
      {/* Top row — brand + status */}
      <div className="px-4 sm:px-6 py-2 flex items-center gap-3 sm:gap-6 flex-wrap text-xs hairline">
        <div className="flex items-center gap-2 shrink-0">
          <span className="dot dot-pulse" style={{ color: "var(--edge)" }} />
          <span className="font-display font-bold text-sm sm:text-base tracking-tight">
            NATESTACKS<span style={{ color: "var(--edge)" }}>·</span>OS
          </span>
        </div>
        <Divider />
        <Bit label="MODE" value="PAPER_TRIAL" color="warn" />
        <Bit label="DAY" value={String(paperTrial.dayNumber)} />
        <Bit label="LAST_RUN" value={rel(status.lastAgentRunAt)} />
        <Bit label="NEXT_RUN" value={fmtEt(status.nextScheduledRunUtc)} />
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <span className="eyebrow text-[var(--muted)]">FUNDING</span>
          <span
            className="pill"
            style={{
              color: paperTrial.ready ? "var(--edge)" : "var(--kill)",
              borderColor: paperTrial.ready ? "var(--edge)" : "var(--kill)",
            }}
          >
            {paperTrial.ready ? "UNLOCKED" : "LOCKED"}
          </span>
        </div>
      </div>

      {/* Nav row — anchor jumps */}
      <nav
        aria-label="Section navigation"
        className="px-4 sm:px-6 py-2 flex items-center gap-1 overflow-x-auto"
      >
        {NAV.map(n => (
          <a
            key={n.id}
            href={`#${n.id}`}
            className="eyebrow shrink-0 px-2.5 py-1 text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface)] border border-transparent hover:border-[var(--border)] transition-colors"
          >
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
  color,
}: {
  label: string;
  value: string;
  color?: "edge" | "warn" | "kill" | "signal";
}) {
  const cssColor = color ? `var(--${color})` : "var(--text)";
  return (
    <div className="flex items-baseline gap-1.5 shrink-0">
      <span className="eyebrow text-[var(--muted)]">{label}</span>
      <span className="numeric text-xs" style={{ color: cssColor }}>
        {value}
      </span>
    </div>
  );
}

function Divider() {
  return <span className="hidden sm:inline-block h-3 w-px bg-[var(--border)]" />;
}
