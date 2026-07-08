// The front page — folio 01. A morning edition: the nameplate over the
// dateline, then the lead story answers the reader's real first question —
// "is the model winning AND on track to earn real money?" — with the FUNDING
// verdict stamp (true stamp moment No. 1) over the trial-to-date ROI, the
// trial record, a teaser for tonight's play, and last night demoted to a
// single one-liner. The settled book prints below the fold. Server component;
// motion via motion.tsx.

import type { DashboardData, SlatePick } from "../_data/dashboard";
import { Reveal, StampIn, Tally } from "./motion";
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
  const pnlColor =
    lnGraded === 0 ? "var(--ink)" : lnPnl > 0 ? "var(--win)" : lnPnl < 0 ? "var(--loss)" : "var(--ink)";

  // THE LEAD (fixed 2026-06-11 per crit): the reader's first question is "is the
  // model winning AND on track to earn real money?" — so the TRIAL-TO-DATE
  // verdict leads, not last night's noise. ROI is the number a sharp judges a
  // model by, so it is the hero; net units is the animated rail figure; last
  // night demotes to a single one-liner + the settled book below. Each headline
  // number prints exactly once in the fold.
  const trialPnl = paperTrial.pnl;
  const trialRoi = paperTrial.roi;
  const trialGraded = paperTrial.totalGraded;
  const trialRecord = `${paperTrial.wins}-${paperTrial.losses}${paperTrial.pushes > 0 ? `-${paperTrial.pushes}` : ""}`;
  const trialColor =
    trialGraded === 0 ? "var(--ink)" : trialPnl > 0 ? "var(--win)" : trialPnl < 0 ? "var(--loss)" : "var(--ink)";
  const roiColor =
    trialRoi === null || trialGraded === 0
      ? "var(--ink)"
      : trialRoi > 0
        ? "var(--win)"
        : trialRoi < 0
          ? "var(--loss)"
          : "var(--ink)";
  const roiText = trialRoi !== null ? `${trialRoi > 0 ? "+" : ""}${(trialRoi * 100).toFixed(1)}%` : "—";
  const fundingLocked = !paperTrial.mlReady;
  // Red ink is reserved for money lost — "locked" is a neutral hold, not a loss.
  const fundingLabel = fundingLocked ? "FUNDING LOCKED" : "FUNDING UNLOCKED";
  const fundingTone = fundingLocked ? "var(--hold)" : "var(--win)";

  // Gate progress — ML track is the canonical gate
  const mlCriteria = paperTrial.criteria.filter(c => c.track === "ml");
  const gatesMet = mlCriteria.filter(c => c.met).length;

  // Tonight
  const shipped = data.picks.games.length + data.picks.props.length;
  const teaser = teaserFor(data.picks.games, data.picks.props);

  // Slate — in-scope (real NBA + real MLB) only
  const inScopeSlate = data.slate.filter(isInScopeGame).length;

  return (
    <section id="front-page" className="pt-8 sm:pt-10">
      {/* Nameplate — shrunk to give the lead the room */}
      <div className="text-center">
        <p className="eyebrow">Vol. 2026 · NBA · MLB · WNBA Desk · Picks twice daily</p>
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

      {/* Lead story — the trial-to-date verdict, asymmetric 7/5 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-0 pt-8 sm:pt-12 pb-8">
        <div className="lg:col-span-7 lg:pr-12">
          <article>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3 mb-4">
              <p className="eyebrow">The trial to date · day {paperTrial.dayNumber}</p>
            </div>

            {/* True stamp moment No. 1 — the funding verdict, which answers the
                reader's real question: can it bet real money yet? */}
            <StampIn className="mb-5">
              <span className="stamp-true" style={{ color: fundingTone }}>
                {fundingLabel}
              </span>
            </StampIn>

            <Reveal className="mt-4">
              <h2 className="headline text-ink" style={{ fontSize: "clamp(2.1rem, 4.6vw, 3.9rem)" }}>
                {trialGraded > 0 && trialRoi !== null ? (
                  <>
                    The book is{" "}
                    <span className="num" style={{ color: roiColor, letterSpacing: "-0.04em" }}>
                      {roiText}
                    </span>{" "}
                    ROI over <span className="num">{trialGraded}</span> graded.
                  </>
                ) : trialGraded > 0 ? (
                  <>
                    The book is{" "}
                    <span className="num" style={{ color: trialColor, letterSpacing: "-0.04em" }}>
                      {trialPnl > 0 ? "+" : ""}
                      {trialPnl.toFixed(2)}u
                    </span>{" "}
                    over <span className="num">{trialGraded}</span> graded.
                  </>
                ) : (
                  <>The trial hasn&rsquo;t graded a pick yet.</>
                )}
              </h2>
            </Reveal>

            <p className="num text-sm sm:text-base text-ink-2 mt-5">
              <span className="tag text-ink-3 mr-2">Status</span>
              <span className="font-semibold text-ink">
                real money {paperTrial.mlReady ? "unlocked" : "still locked"}
              </span>
              <span className="text-ink-3"> · {trialRecord} on the trial</span>
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

            {/* Last night, demoted to a single one-liner — the per-pick detail
                lives in the settled book below; this is its only fold mention. */}
            <p className="num text-sm text-ink-2 mt-2">
              <span className="tag text-ink-3 mr-2">Last night</span>
              {lnGraded > 0 ? (
                <>
                  <span style={{ color: pnlColor }}>
                    {lnPnl > 0 ? "+" : ""}
                    {lnPnl.toFixed(2)}u
                  </span>
                  <span className="text-ink-3"> on {lnRecord}</span>
                </>
              ) : lnPending > 0 ? (
                <span className="text-ink-3">{lnPending} pending the grader</span>
              ) : (
                <span className="text-ink-3">the book sat out</span>
              )}
            </p>
          </article>
        </div>

        {/* Stats rail — secondary box score beside the lead (smaller numerals) */}
        <aside className="lg:col-span-5 lg:border-l lg:border-rule lg:pl-12">
          <p className="eyebrow pb-2">At a glance</p>
          <dl className="rule-double">
            <RailRow
              label="Net"
              value={`${trialPnl > 0 ? "+" : ""}${trialPnl.toFixed(2)}u`}
              tally={trialGraded > 0 ? trialPnl : undefined}
              sub={`${trialGraded}/200 graded`}
              tone={trialColor}
            />
            <RailRow
              label="Gate"
              value={`${gatesMet}/${mlCriteria.length}`}
              sub={paperTrial.mlReady ? "criteria clear" : "criteria to clear"}
            />
            <RailRow
              label="Tonight"
              value={`${shipped}`}
              sub={`${data.picks.games.length} game · ${data.picks.props.length} prop`}
            />
            <RailRow label="Slate" value={`${inScopeSlate}`} sub="NBA · MLB · WNBA tonight" />
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
  tally,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: string;
  /** When set, the figure counts up from zero on scroll-in (the headline
   *  P&L number). SSR still renders the final value, so no-JS reads right. */
  tally?: number;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3 border-b border-rule">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-right">
        {tally !== undefined ? (
          <Tally
            value={tally}
            decimals={2}
            signed
            suffix="u"
            className="num-display text-2xl sm:text-3xl"
            style={{ color: tone ?? "var(--ink)" }}
          />
        ) : (
          <span className="num-display text-2xl sm:text-3xl" style={{ color: tone ?? "var(--ink)" }}>
            {value}
          </span>
        )}
        <p className="eyebrow text-ink-3 mt-1">{sub}</p>
      </dd>
    </div>
  );
}
