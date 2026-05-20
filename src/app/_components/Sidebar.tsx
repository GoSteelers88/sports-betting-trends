import type { DashboardData } from "../_data/dashboard";

function rel(iso: string | null): string {
  if (!iso) return "—";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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

function fmtDate(d: Date): string {
  return d
    .toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      month: "long",
      day: "numeric",
    })
    .toUpperCase();
}

const NAV = [
  { id: "hero", index: "00", label: "Tonight" },
  { id: "ledger", index: "01", label: "Games Ledger" },
  { id: "reactor", index: "02", label: "Pipeline" },
  { id: "survivors", index: "03", label: "Game Picks" },
  { id: "last-night", index: "04", label: "Last Night" },
  { id: "deployment-gate", index: "05", label: "Funding Gate" },
  { id: "market-feed", index: "06", label: "Slate" },
  { id: "prop-survivors", index: "07", label: "Prop Picks" },
  { id: "prop-ledger", index: "08", label: "Prop Ledger" },
  { id: "system-memory", index: "09", label: "Memory" },
];

export function Sidebar({ data }: { data: DashboardData }) {
  const { status, paperTrial, overallRecord } = data;
  const games = overallRecord.games;
  const wl = `${games.wins}-${games.losses}${games.pushes > 0 ? `-${games.pushes}` : ""}`;
  const pnl = games.pnl;
  const pnlSign = pnl > 0 ? "+" : "";
  const pnlColor = pnl > 0 ? "var(--edge)" : pnl < 0 ? "var(--kill)" : "var(--text)";

  // Paper trial progress — ML sample size is the primary "close to deploying"
  // signal. Prop sample is tracked separately and isn't surfaced here.
  const sampleCriterion = paperTrial.criteria.find(
    c => c.track === "ml" && c.label.toLowerCase().includes("sample size")
  );
  const sampleCur = sampleCriterion?.current ?? "0";
  const sampleTarget = sampleCriterion?.target ?? "200";
  const samplePct = Math.min(
    100,
    (parseInt(sampleCur, 10) / parseInt(sampleTarget, 10)) * 100
  );

  return (
    <aside
      aria-label="Primary"
      className="lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-r lg:border-[var(--border)] flex flex-col gap-8 px-5 lg:px-7 py-6 lg:py-10"
    >
      {/* Brand */}
      <div>
        <p className="eyebrow mb-1">2026 · NATESTACKS</p>
        <h1
          className="font-display text-3xl lg:text-4xl leading-none text-[var(--text)]"
          style={{ fontStyle: "italic" }}
        >
          Edge<br />Ledger
        </h1>
      </div>

      {/* Date + day of trial */}
      <div className="space-y-1">
        <p className="eyebrow">{fmtDate(new Date())}</p>
        <p className="font-mono text-xs text-[var(--muted)]">
          Day <span className="text-[var(--text)] numeric">{paperTrial.dayNumber}</span> of paper trial
        </p>
      </div>

      {/* Hairline divider */}
      <div className="hairline" />

      {/* Compact game ledger */}
      <div className="space-y-3">
        <p className="eyebrow">Games · all-time</p>
        <p
          className="font-display leading-none"
          style={{
            fontStyle: "italic",
            fontSize: "clamp(2.5rem, 4vw, 3.25rem)",
            color: pnlColor,
            letterSpacing: "-0.03em",
          }}
        >
          {pnlSign}{pnl.toFixed(2)}<span className="text-[var(--muted)]" style={{ fontStyle: "normal" }}>u</span>
        </p>
        <p className="font-mono text-xs text-[var(--muted)]">
          <span className="numeric text-[var(--text)]">{wl}</span> · {games.totalPicks} picks
        </p>
      </div>

      <div className="hairline" />

      {/* Paper trial mini meter */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <p className="eyebrow">Sample</p>
          <p className="numeric text-xs text-[var(--text)]">
            {sampleCur}<span className="text-[var(--muted)]"> / {sampleTarget}</span>
          </p>
        </div>
        <div className="meter">
          <div
            className="meter-fill"
            style={{
              width: `${samplePct}%`,
              background: paperTrial.ready ? "var(--edge)" : "var(--signal)",
            }}
          />
        </div>
        <p className="eyebrow text-[var(--faint)]">
          {paperTrial.ready ? "Deployment ready" : "Capital locked"}
        </p>
      </div>

      <div className="hairline" />

      {/* Vertical section nav */}
      <nav aria-label="Sections" className="flex flex-col gap-0">
        {NAV.map(n => (
          <a
            key={n.id}
            href={`#${n.id}`}
            className="group flex items-baseline gap-3 py-2 border-b border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)] transition-colors"
          >
            <span className="font-mono text-[0.65rem] text-[var(--faint)] tabular-nums tracking-widest w-6">
              {n.index}
            </span>
            <span className="font-display text-base group-hover:text-[var(--edge)] transition-colors">
              {n.label}
            </span>
          </a>
        ))}
      </nav>

      {/* Footer — system status */}
      <div className="mt-auto space-y-1 pt-6 hairline border-t">
        <div className="flex items-center gap-2">
          <span
            className="dot dot-pulse"
            style={{ color: status.lastAgentRunAt ? "var(--edge)" : "var(--muted)" }}
          />
          <p className="eyebrow">Last run · {rel(status.lastAgentRunAt)}</p>
        </div>
        <p className="eyebrow text-[var(--faint)]">
          Next · {fmtEt(status.nextScheduledRunUtc)}
        </p>
      </div>
    </aside>
  );
}
