import type { DashboardData } from "../_data/dashboard";

function fmtRelative(iso: string | null): string {
  if (!iso) return "NEVER";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "NOW";
  if (m < 60) return `${m}M AGO`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}H AGO`;
  const d = Math.floor(h / 24);
  return `${d}D AGO`;
}

function fmtTimeUntilEt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function Hero({ data }: { data: DashboardData }) {
  const { status, trackRecord7 } = data;
  const todayEt = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const nba = data.slate.filter(g => g.league === "NBA").length;
  const mlb = data.slate.filter(g => g.league === "MLB").length;
  const wnba = data.slate.filter(g => g.league === "WNBA").length;
  const nhl = data.slate.filter(g => g.league === "NHL").length;

  return (
    <section className="relative">
      <div className="hazard-tape h-3 mb-4" aria-hidden="true" />

      <div className="brutal-card p-6 sm:p-10">
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <span className="display-eyebrow text-[var(--hazard)]">// LIVE</span>
          <span className="flex items-center gap-2">
            <span className="live-dot hazard-blink" />
            <span className="display-eyebrow text-white">
              LAST RUN — {fmtRelative(status.lastAgentRunAt)}
            </span>
          </span>
        </div>

        <h1 className="display-tight text-white text-[clamp(2.5rem,9vw,7rem)]">
          {todayEt.toUpperCase()}
        </h1>

        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 display-eyebrow text-white text-[0.85rem]">
          <span>MLB <span className="text-[var(--hazard)] mono text-base">{mlb}</span></span>
          <span>NBA <span className="text-[var(--hazard)] mono text-base">{nba}</span></span>
          {wnba > 0 && <span>WNBA <span className="text-[var(--hazard)] mono text-base">{wnba}</span></span>}
          {nhl > 0 && <span>NHL <span className="text-[var(--hazard)] mono text-base">{nhl}</span></span>}
          <span>PICKS LIVE <span className="text-[var(--hazard)] mono text-base">{status.todayPickCount}</span></span>
          <span>NEXT <span className="text-white mono text-base">{fmtTimeUntilEt(status.nextScheduledRunUtc)}</span></span>
        </div>

        <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-0 border-t-[3px] border-white">
          <Stat label="TODAY P&L" value={fmtUnits(status.todayPnl)} pos={status.todayPnl >= 0} />
          <Stat label="7D RECORD" value={`${trackRecord7.wins}-${trackRecord7.losses}${trackRecord7.pushes ? `-${trackRecord7.pushes}` : ""}`} />
          <Stat label="7D UNITS" value={fmtUnits(trackRecord7.pnl)} pos={trackRecord7.pnl >= 0} />
          <Stat
            label="7D ROI"
            value={trackRecord7.roi !== null ? `${(trackRecord7.roi * 100).toFixed(1)}%` : "—"}
            pos={trackRecord7.roi !== null && trackRecord7.roi >= 0}
          />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, pos }: { label: string; value: string; pos?: boolean }) {
  const color = pos === undefined ? "text-white" : pos ? "text-[var(--color-win)]" : "text-[var(--color-loss)]";
  return (
    <div className="border-r-[3px] border-white last:border-r-0 last-of-type:border-r-0 py-4 px-3 sm:px-5">
      <p className="display-eyebrow text-white/60 text-[0.6rem]">{label}</p>
      <p className={`odds-display mt-2 text-3xl sm:text-4xl ${color}`}>{value}</p>
    </div>
  );
}

function fmtUnits(n: number): string {
  if (n === 0) return "0.00U";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}U`;
}
