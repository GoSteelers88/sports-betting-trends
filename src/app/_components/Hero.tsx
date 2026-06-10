// The front page — folio 01. A morning edition: the nameplate over the
// dateline, then the lead story answers "how did we do last night?" with
// the verdict stamp (true stamp moment No. 1), the settled net units, gate
// progress, and a one-line teaser for tonight's play. The settled book
// prints below the fold. Server component; motion via motion.tsx.

import type { DashboardData, SlatePick } from "../_data/dashboard";
import { Reveal, StampIn } from "./motion";
import { SettledTable } from "./LastNightLedger";
import { fmtAmerican, isInScopeGame, propLabel } from "./format";

function fmtDate(d: Date): string {
  return d
    .toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
}

type Verdict = { label: "WIN" | "LOSS" | "PUSH" | "PENDING"; tone: string };

function verdictOf(pnl: number, graded: number, pending: number): Verdict {
  if (graded > 0) {
    if (pnl > 0) return { label: "WIN", tone: "var(--win)" };
    if (pnl < 0) return { label: "LOSS", tone: "var(--loss)" };
    return { label: "PUSH", tone: "var(--ink-3)" };
  }
  void pending;
  return { label: "PENDING", tone: "var(--hold)" };
}

function teaserFor(games: SlatePick[], props: SlatePick[]): string | null {
  const top =
    [...games].sort((a, b) => b.edge - a.edge)[0] ??
    [...props].sort((a, b) => b.edge - a.edge)[0] ??
    null;
  if (!top) return null;
  const what =
    top.market === "prop" && top.player
      ? `${top.player} ${top.side?.toUpperCase()} ${top.line} ${propLabel(top.propType)}`
      : `${top.selection}`;
  return `${top.league} · ${what} @ ${fmtAmerican(top.oddsAmerican)} · ${(top.edge * 100).toFixed(1)}% edge`;
}

export function Hero({ data }: { data: DashboardData }) {
  const { paperTrial } = data;
  const lnG = data.lastNight.games;
  const lnP = data.lastNight.props;

  // Last night, whole book — games + props
  const lnPnl = +(lnG.pnl + lnP.pnl).toFixed(2);
  const lnWins = lnG.wins + lnP.wins;
  const lnLosses = lnG.losses + lnP.losses;
  const lnPushes = lnG.pushes + lnP.pushes;
  const lnGraded = lnG.graded + lnP.graded;
  const lnPending = lnG.pending + lnP.pending;
  const lnRecord = `${lnWins}-${lnLosses}${lnPushes > 0 ? `-${lnPushes}` : ""}`;
  const verdict = verdictOf(lnPnl, lnGraded, lnPending);
  const pnlColor =
    lnGraded === 0 ? "var(--ink)" : lnPnl > 0 ? "var(--win)" : lnPnl < 0 ? "var(--loss)" : "var(--ink)";

  // Gate progress — ML track is the canonical gate
  const mlCriteria = paperTrial.criteria.filter(c => c.track === "ml");
  const gatesMet = mlCriteria.filter(c => c.met).length;
  const gateLine = `${gatesMet}/${mlCriteria.length} · ${paperTrial.totalGraded}/200 graded`;

  // Tonight
  const shipped = data.picks.games.length + data.picks.props.length;
  const teaser = teaserFor(data.picks.games, data.picks.props);

  // Slate — in-scope (real NBA + real MLB) only
  const inScopeSlate = data.slate.filter(isInScopeGame).length;

  return (
    <section id="front-page" className="pt-8 sm:pt-10">
      {/* Nameplate — shrunk to give the lead the room */}
      <div className="text-center">
        <p className="eyebrow">Vol. 2026 · NBA + MLB Desk · Picks twice daily</p>
        <Reveal className="mt-2">
          <h1
            className="headline text-ink"
            style={{ fontSize: "clamp(2.3rem, 6.6vw, 6rem)" }}
          >
            The Paper Trial
          </h1>
        </Reveal>
        <div className="mt-4 rule-double" />
        <div className="flex items-baseline justify-between py-2 flex-wrap gap-2">
          <p className="eyebrow">{fmtDate(new Date())}</p>
          <p className="eyebrow text-ink-3 hidden sm:block">
            An agent bets on paper until it earns real money
          </p>
          <p className="folio">No. {String(paperTrial.dayNumber).padStart(3, "0")}</p>
        </div>
        <div className="border-b border-rule-strong" />
      </div>

      {/* Lead story — the morning verdict, asymmetric 7/5 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-0 pt-8 sm:pt-12 pb-8">
        <div className="lg:col-span-7 lg:pr-12">
          <article>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3 mb-4">
              <p className="eyebrow">Morning edition · last night&rsquo;s verdict</p>
            </div>

            {/* True stamp moment No. 1 — the verdict over the lead */}
            <StampIn className="mb-5">
              <span className="stamp-true" style={{ color: verdict.tone }}>
                {verdict.label}
              </span>
            </StampIn>

            <Reveal className="mt-4">
              <h2 className="headline text-ink" style={{ fontSize: "clamp(2.1rem, 4.6vw, 3.9rem)" }}>
                {lnGraded > 0 ? (
                  <>
                    Last night settled{" "}
                    <span className="num" style={{ color: pnlColor, letterSpacing: "-0.04em" }}>
                      {lnPnl > 0 ? "+" : ""}
                      {lnPnl.toFixed(2)}u
                    </span>{" "}
                    on <span className="num">{lnRecord}</span>.
                  </>
                ) : lnPending > 0 ? (
                  <>
                    {lnPending} pick{lnPending === 1 ? "" : "s"} await the grader.
                  </>
                ) : (
                  <>The book sat out last night.</>
                )}
              </h2>
            </Reveal>

            <p className="num text-sm sm:text-base text-ink-2 mt-5">
              <span className="tag text-ink-3 mr-2">Gate</span>
              <span className="font-semibold text-ink">{gateLine}</span>
              <span className="text-ink-3"> · funding {paperTrial.mlReady ? "unlocked" : "locked"}</span>
            </p>

            <p className="num text-sm sm:text-base mt-2">
              <span className="tag text-ink-3 mr-2">Tonight</span>
              {teaser ? (
                <a href="#tonights-play" className="text-ink hover:text-loss transition-colors font-semibold">
                  {teaser}
                </a>
              ) : (
                <span className="text-ink-2">no pick cleared the 6% floor — capital held</span>
              )}
            </p>
          </article>
        </div>

        {/* Stats rail — bordered ledger strip */}
        <aside className="lg:col-span-5 lg:border-l lg:border-rule lg:pl-12">
          <p className="eyebrow pb-2">At a glance</p>
          <dl className="rule-double">
            <RailRow
              label="Last night"
              value={lnGraded > 0 ? `${lnPnl > 0 ? "+" : ""}${lnPnl.toFixed(2)}u` : "—"}
              sub={lnGraded > 0 ? `${lnRecord} settled` : lnPending > 0 ? `${lnPending} pending` : "no picks"}
              tone={pnlColor}
            />
            <RailRow label="Gate" value={`${gatesMet}/${mlCriteria.length}`} sub={`${paperTrial.totalGraded}/200 graded`} />
            <RailRow
              label="Tonight"
              value={`${shipped}`}
              sub={`${data.picks.games.length} game · ${data.picks.props.length} prop shipped`}
            />
            <RailRow label="Slate" value={`${inScopeSlate}`} sub="NBA + MLB games tonight" />
          </dl>
        </aside>
      </div>

      {/* The settled book — last night's game picks, stamped in ink
          (true stamp moment No. 3 lives on these rows) */}
      {lnG.picks.length > 0 ? (
        <div className="pb-10">
          <p className="eyebrow mb-2">
            Settled since last edition · {lnG.graded} graded{lnG.pending > 0 ? ` · ${lnG.pending} pending` : ""}
          </p>
          <SettledTable picks={lnG.picks} caption="Game picks resolved in the last 36 hours" />
        </div>
      ) : (
        <p className="tag text-ink-3 pb-10">No game picks resolved in the last 36 hours</p>
      )}
    </section>
  );
}

function RailRow({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3 border-b border-rule">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-right">
        <span className="num-display text-3xl sm:text-4xl" style={{ color: tone ?? "var(--ink)" }}>
          {value}
        </span>
        <p className="eyebrow text-ink-3 mt-1">{sub}</p>
      </dd>
    </div>
  );
}
