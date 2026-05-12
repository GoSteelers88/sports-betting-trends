import type { DashboardData } from "../_data/dashboard";
import { BetBackground } from "./BetBackground";

function rel(iso: string | null): string {
  if (!iso) return "NEVER";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "NOW";
  if (m < 60) return `T-${m}M`;
  const h = Math.floor(m / 60);
  if (h < 24) return `T-${h}H`;
  return `T-${Math.floor(h / 24)}D`;
}

function nextRunEt(iso: string): string {
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

export function Hero({ data }: { data: DashboardData }) {
  const { status, trackRecord7 } = data;
  const todayCode = new Date()
    .toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
    })
    .replace(/\//g, ".");

  return (
    <section className="relative min-h-[100svh] flex items-center justify-center px-6 sm:px-12 overflow-hidden">
      <BetBackground league="DEFAULT" />

      {/* Transmission frame */}
      <div className="absolute top-0 left-0 right-0 px-6 sm:px-12 py-5 flex items-center justify-between var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--concrete-light)] z-10">
        <span style={{ color: "var(--rust)" }}>// NATESTACKS</span>
        <span className="scramble">TRANSMISSION_001 // {todayCode}</span>
        <span>SYS_LAST_{rel(status.lastAgentRunAt)}</span>
      </div>

      <div className="relative w-full max-w-7xl">
        {/* Headline */}
        <h1
          className="var-display text-[var(--foreground)] text-[clamp(3.5rem,17vw,17rem)]"
          style={{ ["--wght" as string]: "900", ["--lsp" as string]: "-0.06em" }}
        >
          EDGE
          <br />
          <span style={{ color: "var(--rust-flash)" }}>FOUND.</span>
        </h1>

        {/* Sub-readout */}
        <div className="mt-10 sm:mt-14 grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-6 max-w-3xl">
          <Stat label="PICKS LIVE" value={String(status.todayPickCount)} hot />
          <Stat
            label="7D RECORD"
            value={`${trackRecord7.wins}-${trackRecord7.losses}${trackRecord7.pushes ? `-${trackRecord7.pushes}` : ""}`}
          />
          <Stat
            label="7D UNITS"
            value={`${trackRecord7.pnl >= 0 ? "+" : ""}${trackRecord7.pnl.toFixed(2)}U`}
            warm={trackRecord7.pnl >= 0}
            cold={trackRecord7.pnl < 0}
          />
          <Stat
            label="7D ROI"
            value={trackRecord7.roi !== null ? `${(trackRecord7.roi * 100).toFixed(1)}%` : "—"}
            warm={trackRecord7.roi !== null && trackRecord7.roi >= 0}
            cold={trackRecord7.roi !== null && trackRecord7.roi < 0}
          />
        </div>

        {/* Slate inventory line */}
        <p className="mt-14 var-mono text-xs sm:text-sm uppercase tracking-[0.25em] text-[var(--concrete-light)]">
          {data.slate.length} GAMES TONIGHT ▸ NEXT TX {nextRunEt(status.nextScheduledRunUtc)} ▸ SCROLL TO RECEIVE
        </p>
      </div>

      {/* Footer frame */}
      <div className="absolute bottom-0 left-0 right-0 px-6 sm:px-12 py-5 flex items-center justify-between var-mono text-[0.7rem] uppercase tracking-[0.3em] text-[var(--concrete)] z-10">
        <span>▼ ▼ ▼</span>
        <span>{status.todayPickCount} TX QUEUED</span>
        <span>▼ ▼ ▼</span>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  hot,
  warm,
  cold,
}: {
  label: string;
  value: string;
  hot?: boolean;
  warm?: boolean;
  cold?: boolean;
}) {
  const color = hot
    ? "var(--rust-flash)"
    : warm
    ? "var(--rust)"
    : cold
    ? "var(--cold)"
    : "var(--foreground)";
  const weight = hot ? 900 : warm ? 700 : cold ? 300 : 600;
  return (
    <div>
      <p className="var-mono text-[0.65rem] uppercase tracking-[0.3em] text-[var(--concrete)] mb-2">
        {label}
      </p>
      <p
        className={`var-display text-3xl sm:text-5xl ${hot ? "hot-vibrate" : ""}`}
        style={{
          color,
          ["--wght" as string]: String(weight),
          ["--lsp" as string]: "-0.03em",
        }}
      >
        {value}
      </p>
    </div>
  );
}
