// "/" — today. The front door for the reader who arrives from a receipts post.
//
// The verdict in one line, then every live action across leagues in one list
// (agent picks for NBA/MLB/WNBA and the NFL board's PLAY legs together), then
// what settled, then the account. When nothing is live, say so once and say
// what is next. The operator views (/desk, /experiments) are one tap away in
// the header; the receipts (/nfl) are one tap away from every NFL row.
//
// Three states, told apart honestly (see @/lib/today-list):
//   (a) live actions exist;
//   (b) nothing qualifies — "Nothing cleared the 6% floor" is only claimed
//       when the analyst actually read today's slate;
//   (c) the odds snapshot is stale (older than 36h, or no game in it falls
//       on today in America/New_York) — the refresh time prints plainly.
// A missing last-run record is the pipeline-down proxy (every DB loader
// degrades to empties): it must never render as a calm "Nothing is live".
//
// Server component. The two file readers (getDashboardData, loadLiveActions)
// are composed here and their results handed to client components as plain
// props. ISR 300s: `now` is render time, so a row may read "in play" up to
// five minutes late; that is accepted.

import { getDashboardData, type SlatePick } from "./_data/dashboard";
import { loadLiveActions } from "./_data/live-actions";
import { buildTodayRows, fmtAgeHours, fmtEtDayTime } from "@/lib/today-list";
import { Hero } from "./_components/Hero";
import { RunMeta } from "./_components/RunMeta";
import { TodayList } from "./_components/TodayList";
import { SettledTable } from "./_components/LastNightLedger";
import { OverallLedger } from "./_components/OverallLedger";
import { AskSection } from "./_components/AskSection";
import { Footer } from "./_components/Footer";
import { LegacyHashRedirect } from "./_components/LegacyHashRedirect";
import { fmtEtClock, fmtUnits, relUntil } from "./_components/format";

// ISR, not force-dynamic: the data behind this page changes on a cron cadence
// (agent runs 14:00/22:30 UTC + daily grading); 300s staleness is invisible
// against a twice-daily data cycle, and nothing in the render path reads
// cookies or headers.
export const revalidate = 300;

/** One entry per pick id, first list wins. `picks.*` is keyed on
 *  createdAt ≥ UTC midnight and empties at 8 PM ET while games are still on;
 *  `lastNight.*` holds anything with a start inside the last 36h. Merging the
 *  two lets the 4h live window admit an in-play row either list would drop.
 *  The pre-tip hole (a 22:30 UTC pick for a 10 PM ET game, between 8 PM ET
 *  and tip) is a dashboard.ts window fix and stays LATER. */
function mergeById(...lists: SlatePick[][]): SlatePick[] {
  const seen = new Map<number, SlatePick>();
  for (const list of lists) for (const p of list) if (!seen.has(p.id)) seen.set(p.id, p);
  return [...seen.values()];
}

export default async function Home() {
  const data = await getDashboardData();
  const nowMs = Date.now();
  const live = loadLiveActions(nowMs);

  const rows = buildTodayRows(
    mergeById(data.picks.games, data.lastNight.games.picks),
    mergeById(data.picks.props, data.lastNight.props.picks),
    live.nflLegs,
    nowMs,
  );
  const liveAgentIds = new Set<number>();
  for (const r of rows) if (r.kind !== "nfl") liveAgentIds.add(r.pick.id);
  // No pick prints twice on "/": settled rows are last night's game picks
  // minus anything the live list already shows.
  const settled = data.lastNight.games.picks.filter((p) => !liveAgentIds.has(p.id));
  const nflCount = rows.filter((r) => r.kind === "nfl").length;

  const ln = data.lastNight.games;
  const fresh = live.freshness;
  const pipelineDown = data.status.lastAgentRunAt === null;
  const refreshed = fresh.fetchedAt ? fmtEtDayTime(fresh.fetchedAt) : null;
  const age = fresh.ageHours !== null ? fmtAgeHours(fresh.ageHours) : null;
  const refreshLine = refreshed
    ? `lines last refreshed ${refreshed}${age ? ` (${age} ago)` : ""}`
    : "no odds snapshot on file";

  const emptySub = pipelineDown
    ? "No agent run on record — the desk could not read its ledger, so no slate was read. No NFL play is inside its window."
    : fresh.stale
      ? `The desk has not run on today's slate — ${refreshLine}. No NFL play is inside its window.`
      : "Nothing cleared the 6% floor and the critic, and no NFL play is inside its window.";
  const staleNote =
    !pipelineDown && fresh.stale && rows.length > 0
      ? `Agent leagues: the desk has not run on today's slate — ${refreshLine}.`
      : null;
  const nextLine = `Analyst runs ${fmtEtClock(data.status.nextScheduledRunUtc)} (${relUntil(
    data.status.nextScheduledRunUtc,
    nowMs,
  )}) · ${live.nextBoard}.`;

  const countToken =
    rows.length === 0 ? "NOTHING LIVE" : `${rows.length} LIVE ${rows.length === 1 ? "PLAY" : "PLAYS"}`;
  const lead = nflCount > 0 && live.board ? [countToken, `NFL WEEK ${live.board.week}`] : [countToken];

  const lnRecord = `${ln.wins}-${ln.losses}${ln.pushes > 0 ? `-${ln.pushes}` : ""}`;
  const lnTone = ln.pnl > 0 ? "var(--win)" : ln.pnl < 0 ? "var(--loss)" : "var(--ink)";

  return (
    <div className="receipts">
      <main className="receipts-shell">
        <div className="margin-rule">
          <Hero data={data} />

          <section id="today" className="receipts-section">
            <div className="section-head">
              <h2 className="headline section-title">TODAY</h2>
              <RunMeta status={data.status} lead={lead} />
            </div>

            <TodayList rows={rows} emptyLede="Nothing is live." emptySub={emptySub} />

            <div className="today-foot">
              {staleNote ? (
                <p className="prose today-note" style={{ color: "var(--hold)" }}>
                  {staleNote}
                </p>
              ) : null}
              <p className="prose today-note">
                <strong>Next</strong> · {nextLine}
              </p>
              {nflCount > 0 ? (
                <p className="today-receipts">
                  <a href="/nfl">THE RECEIPTS →</a>
                </p>
              ) : null}
            </div>
          </section>

          <section id="settled" className="receipts-section">
            <div className="section-head">
              <h2 className="headline section-title">SETTLED</h2>
              <p className="eyebrow section-meta">
                LAST 36 HOURS · GAMES
                {ln.graded > 0 ? (
                  <>
                    {" · "}
                    {lnRecord}
                    {" · "}
                    <span style={{ color: lnTone }}>{fmtUnits(ln.pnl)}</span>
                  </>
                ) : null}
                {ln.pending > 0 ? ` · ${ln.pending} PENDING THE GRADER` : ""}
              </p>
            </div>
            {settled.length > 0 ? (
              <div className="settled-table">
                <SettledTable picks={settled} caption="Game picks resolved in the last 36 hours" />
              </div>
            ) : (
              <p className="prose standfirst-block">No game picks settled in the last 36 hours.</p>
            )}
          </section>

          <OverallLedger data={data.overallRecord.games} />

          <AskSection />

          <Footer generatedAt={data.generatedAt} ask />
        </div>
      </main>
      <LegacyHashRedirect />
    </div>
  );
}
