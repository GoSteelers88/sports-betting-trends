import type { KillStats } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";

function relTime(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "NOW";
  if (m < 60) return `${m}M`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}H`;
  return `${Math.floor(h / 24)}D`;
}

export function KillRoom({ data }: { data: KillStats }) {
  const totalCategorized = data.categories.reduce((s, c) => s + c.examples, 0);
  return (
    <section className="space-y-4">
      <SectionHeader
        id="kill-room"
        index="04"
        label="KILL ROOM"
        title={
          data.totalKilledLast14d > 0
            ? `${data.totalKilledLast14d} IDEAS PROSECUTED`
            : "PROSECUTION DARK"
        }
        subtitle="Discipline is edge. Every rejected pick is the system earning trust by refusing action. Killed picks are valuable — they prove the agent isn't just shipping volume."
        status={data.criticKillRatePct !== null ? `${data.criticKillRatePct}% KILL RATE` : "—"}
        statusColor={data.criticKillRatePct !== null && data.criticKillRatePct >= 25 ? "edge" : "warn"}
      />

      {/* Headline metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Headline
          label="KILLED · 7D"
          value={`${data.totalKilledLast7d}`}
          color="kill"
        />
        <Headline label="KILLED · 14D" value={`${data.totalKilledLast14d}`} color="kill" />
        <Headline
          label="GRADER REJECT"
          value={data.graderRejectRatePct !== null ? `${data.graderRejectRatePct}%` : "—"}
          color="signal"
          sub="PRE-CRITIC"
        />
        <Headline
          label="BANKROLL CUT"
          value={`${data.bankrollCuts14d}`}
          color="warn"
          sub="CAP / DUP / CLUSTER"
        />
      </div>

      {/* Kill taxonomy — what the critic looks for */}
      <div className="surface">
        <header className="px-4 py-2.5 border-b border-[var(--border)] flex items-center justify-between">
          <span className="eyebrow text-[var(--muted)]">KILL TAXONOMY</span>
          <span className="eyebrow text-[var(--kill)]">{totalCategorized} ALLOCATED</span>
        </header>
        <ul className="divide-y divide-[var(--border)]">
          {data.categories.map(c => {
            const pct = totalCategorized > 0 ? (c.examples / totalCategorized) * 100 : 0;
            return (
              <li key={c.key} className="px-4 py-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 items-center">
                <div className="min-w-0">
                  <p className="font-sans text-sm text-[var(--text)]">
                    {c.label}
                  </p>
                  <p className="font-mono text-[0.7rem] text-[var(--muted)] truncate">
                    {c.description}
                  </p>
                </div>
                <span className="numeric text-xl text-[var(--kill)] tabular-nums">
                  {c.examples}
                </span>
                <div className="col-span-2 meter h-1">
                  <div
                    className="meter-fill"
                    style={{ width: `${pct}%`, background: "var(--kill)", opacity: 0.7 }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        <p className="px-4 py-2.5 border-t border-[var(--border)] eyebrow text-[var(--muted)]">
          NOTE — INDIVIDUAL CRITIC DECISIONS NOT YET PERSISTED PER PICK · DISTRIBUTION ESTIMATED FROM CRITIC SYSTEM PROMPT · SCHEMA EXTENSION IN PROGRESS
        </p>
      </div>

      {/* Recent run prosecution log */}
      {data.recentRuns.length > 0 && (
        <div className="surface">
          <header className="px-4 py-2.5 border-b border-[var(--border)] flex items-center justify-between">
            <span className="eyebrow text-[var(--muted)]">PROSECUTION LOG</span>
            <span className="eyebrow text-[var(--muted)]">RECENT RUNS</span>
          </header>
          <ul className="divide-y divide-[var(--border)]">
            {data.recentRuns.map(r => (
              <li
                key={r.runId}
                className="px-4 py-2.5 grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 items-center text-sm"
              >
                <span className="pill" style={{ color: "var(--signal)", borderColor: "var(--signal)" }}>
                  {r.league}
                </span>
                <span className="font-mono text-[var(--muted)] text-xs truncate">
                  {r.runId.slice(0, 16)}… <span className="text-[var(--muted)]">· {relTime(r.createdAt)}</span>
                </span>
                <span className="numeric text-xs">
                  <span className="text-[var(--muted)]">RAW</span> {r.rawAnalystPicks}
                </span>
                <span className="numeric text-xs">
                  <span className="text-[var(--kill)]">KILL</span>{" "}
                  <span className="text-[var(--text)]">{r.criticKilled}</span>
                </span>
                <span
                  className="numeric text-xs"
                  style={{ color: r.killRate !== null && r.killRate >= 0.5 ? "var(--edge)" : "var(--warn)" }}
                >
                  {r.killRate !== null ? `${Math.round(r.killRate * 100)}%` : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Headline({
  label,
  value,
  sub,
  color = "text",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: "edge" | "warn" | "kill" | "signal" | "text" | "muted";
}) {
  return (
    <div className="surface p-4">
      <p className="eyebrow text-[var(--muted)]">{label}</p>
      <p className="numeric text-3xl sm:text-4xl mt-1" style={{ color: `var(--${color})` }}>
        {value}
      </p>
      {sub && <p className="eyebrow text-[var(--muted)] mt-0.5">{sub}</p>}
    </div>
  );
}
