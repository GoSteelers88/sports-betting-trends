import type { DashboardData } from "../_data/dashboard";

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtTimeUntilEt(iso: string): string {
  const t = new Date(iso);
  return t.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function Hero({ data }: { data: DashboardData }) {
  const { status, trackRecord7 } = data;
  const todayDateEt = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const nbaCount = data.slate.filter(g => g.league === "NBA").length;
  const mlbCount = data.slate.filter(g => g.league === "MLB").length;

  return (
    <section className="relative overflow-hidden rounded-3xl glass-strong p-6 sm:p-8">
      <div className="absolute -top-20 -right-20 h-60 w-60 rounded-full bg-[#a855f7]/30 blur-3xl" />
      <div className="absolute -bottom-20 -left-20 h-60 w-60 rounded-full bg-[#00d9ff]/20 blur-3xl" />
      <div className="relative">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <span className="display-eyebrow text-cyan-300">Tonight&apos;s Slate</span>
          <span className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1 text-xs">
            <span className="live-dot" />
            <span className="text-emerald-300">live</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-300">last run {fmtRelative(status.lastAgentRunAt)}</span>
          </span>
        </div>
        <h1 className="display text-4xl sm:text-5xl font-bold leading-tight">
          {todayDateEt}
        </h1>
        <p className="mt-2 text-slate-300 text-sm sm:text-base">
          <span className="mono text-white">{mlbCount}</span> MLB
          <span className="mx-2 text-slate-600">·</span>
          <span className="mono text-white">{nbaCount}</span> NBA
          <span className="mx-2 text-slate-600">·</span>
          <span className="mono text-emerald-300">{status.todayPickCount}</span> picks live
          <span className="mx-2 text-slate-600">·</span>
          <span className="text-slate-400">next run</span>{" "}
          <span className="mono text-cyan-200">{fmtTimeUntilEt(status.nextScheduledRunUtc)}</span>
        </p>

        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Today P&L" value={fmtUnits(status.todayPnl)} accent={status.todayPnl >= 0 ? "lime" : "redx"} />
          <Stat label="Last 7d Record" value={`${trackRecord7.wins}-${trackRecord7.losses}${trackRecord7.pushes ? `-${trackRecord7.pushes}` : ""}`} />
          <Stat label="Last 7d Units" value={fmtUnits(trackRecord7.pnl)} accent={trackRecord7.pnl >= 0 ? "lime" : "redx"} />
          <Stat
            label="ROI 7d"
            value={trackRecord7.roi !== null ? `${(trackRecord7.roi * 100).toFixed(1)}%` : "—"}
            accent={trackRecord7.roi !== null && trackRecord7.roi >= 0 ? "lime" : "redx"}
          />
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "lime" | "redx" | "cyan";
}) {
  const color =
    accent === "lime"
      ? "text-[#22ff88]"
      : accent === "redx"
      ? "text-[#ff3b3b]"
      : accent === "cyan"
      ? "text-[#00d9ff]"
      : "text-white";
  return (
    <div className="glass rounded-xl p-3">
      <p className="display-eyebrow text-slate-400">{label}</p>
      <p className={`mono mt-1 text-xl font-semibold ${color}`}>{value}</p>
    </div>
  );
}

function fmtUnits(n: number): string {
  if (n === 0) return "0.00u";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}u`;
}
