import type { DashboardData, SlatePick } from "../_data/dashboard";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
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

// Full-viewport editorial hero — magazine style. Bottom-aligned big title,
// at-a-glance stats on the right rail, no SectionHeader chrome. The first
// thing you see when the dashboard loads.
export function Hero({ data }: { data: DashboardData }) {
  const games = data.picks.games;
  const props = data.picks.props;
  const headline = pickHeadline(games, props);
  const slate = data.slate;
  const todayPnl = data.status.todayPnl;
  const pnlColor =
    todayPnl > 0 ? "var(--edge)" : todayPnl < 0 ? "var(--kill)" : "var(--text)";

  return (
    <section
      id="hero"
      className="min-h-[88vh] flex flex-col justify-between py-12 sm:py-16 relative"
    >
      {/* Top rail — eyebrow + date */}
      <div className="flex items-baseline justify-between flex-wrap gap-3">
        <p className="eyebrow">Edition · {fmtDate(new Date())}</p>
        <p className="eyebrow text-[var(--faint)]">No. {data.paperTrial.dayNumber.toString().padStart(3, "0")}</p>
      </div>

      {/* Center — massive editorial headline */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-12 lg:gap-16 items-end py-12">
        <div>
          {headline ? (
            <HeadlinePick pick={headline} />
          ) : (
            <NoEdgeHeadline slateCount={slate.length} />
          )}
        </div>

        {/* Right rail — at-a-glance stats grid */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-8 font-mono lg:border-l lg:border-[var(--border)] lg:pl-10">
          <Stat label="Slate" value={`${slate.length}`} sub="games tonight" />
          <Stat label="Picks" value={`${games.length + props.length}`} sub={`${games.length} game · ${props.length} prop`} />
          <Stat
            label="Today P&L"
            value={`${todayPnl > 0 ? "+" : ""}${todayPnl.toFixed(2)}u`}
            sub={pnlColorLabel(todayPnl)}
            valueColor={pnlColor}
          />
          <Stat
            label="Run"
            value={data.status.lastAgentRunAt ? relCompact(data.status.lastAgentRunAt) : "—"}
            sub="last analyst pass"
          />
        </dl>
      </div>

      {/* Bottom — scroll hint */}
      <div className="flex items-baseline justify-between">
        <a
          href="#ledger"
          className="eyebrow text-[var(--muted)] hover:text-[var(--text)] inline-flex items-center gap-3 transition-colors"
        >
          <span className="w-8 h-px bg-current" />
          Continue to ledger
        </a>
        <p className="eyebrow text-[var(--faint)] hidden sm:block">↓ Scroll</p>
      </div>
    </section>
  );
}

function HeadlinePick({ pick }: { pick: SlatePick }) {
  const isProp = pick.market === "prop" && pick.player;
  return (
    <div>
      <p className="eyebrow mb-6">Tonight's headline · {pick.league}</p>
      <h2
        className="font-display leading-[0.95] text-[var(--text)]"
        style={{
          fontStyle: "italic",
          fontSize: "clamp(3rem, 8vw, 7.5rem)",
          letterSpacing: "-0.025em",
        }}
      >
        {isProp ? pick.player : pick.matchup}
      </h2>
      <p className="mt-4 font-display text-2xl sm:text-3xl text-[var(--edge)]" style={{ fontStyle: "italic" }}>
        {isProp ? (
          <>
            {pick.side?.toUpperCase()} {pick.line} {propLabel(pick.propType)}{" "}
            <span className="numeric text-[var(--text)]" style={{ fontStyle: "normal" }}>@ {fmtAmerican(pick.oddsAmerican)}</span>
          </>
        ) : (
          <>
            {pick.selection}{" "}
            <span className="numeric text-[var(--text)]" style={{ fontStyle: "normal" }}>@ {fmtAmerican(pick.oddsAmerican)}</span>
          </>
        )}
      </p>
      <p className="mt-6 max-w-2xl text-sm text-[var(--muted)] leading-relaxed line-clamp-3">
        {pick.thesis}
      </p>
    </div>
  );
}

function NoEdgeHeadline({ slateCount }: { slateCount: number }) {
  return (
    <div>
      <p className="eyebrow mb-6">Tonight's verdict</p>
      <h2
        className="font-display leading-[0.95] text-[var(--text)]"
        style={{
          fontStyle: "italic",
          fontSize: "clamp(3rem, 8vw, 7.5rem)",
          letterSpacing: "-0.025em",
        }}
      >
        No&nbsp;edge<br />found.
      </h2>
      <p className="mt-6 max-w-xl text-base text-[var(--muted)] leading-relaxed">
        The analyst worked through {slateCount} games tonight. None cleared the 6% edge floor after the critic
        pass. Discipline beats action — capital stays on the bench.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string;
  value: string;
  sub: string;
  valueColor?: string;
}) {
  return (
    <div className="space-y-2">
      <p className="eyebrow">{label}</p>
      <p
        className="font-display text-3xl sm:text-4xl leading-none"
        style={{ fontStyle: "italic", color: valueColor ?? "var(--text)" }}
      >
        {value}
      </p>
      <p className="eyebrow text-[var(--faint)]">{sub}</p>
    </div>
  );
}

function pickHeadline(games: SlatePick[], props: SlatePick[]): SlatePick | null {
  const all = [...games, ...props];
  if (all.length === 0) return null;
  return [...all].sort((a, b) => b.edge - a.edge)[0];
}

function pnlColorLabel(pnl: number): string {
  if (pnl === 0) return "no resolution yet";
  if (pnl > 0) return "in profit";
  return "in red";
}

function relCompact(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const PROP_LABELS: Record<string, string> = {
  player_points: "pts",
  player_rebounds: "reb",
  player_assists: "ast",
  player_threes: "3PM",
  player_blocks: "blk",
  player_steals: "stl",
  player_points_rebounds_assists: "PRA",
  player_points_rebounds: "P+R",
  player_points_assists: "P+A",
  player_rebounds_assists: "R+A",
  player_blocks_steals: "B+S",
  batter_hits: "hits",
  batter_home_runs: "HR",
  batter_rbis: "RBI",
  batter_runs_scored: "runs",
  batter_total_bases: "TB",
  pitcher_strikeouts: "K",
  pitcher_earned_runs: "ER",
};

function propLabel(propType: string | null): string {
  if (!propType) return "";
  return PROP_LABELS[propType] ?? propType.replace(/^player_|^batter_|^pitcher_/, "");
}
