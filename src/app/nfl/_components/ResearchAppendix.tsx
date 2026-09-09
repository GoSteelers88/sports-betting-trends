// ResearchAppendix — PART TWO of /nfl. The backtest, walled off from the live
// ledger above it.
//
// This half exists under one rule: a reader who lands on a screenshot of any
// figure below must be able to see, in the same frame, that it is in-sample
// and that the one out-of-sample test came back negative. That is why the
// caveat is a repeated device (<Caveat/>) rather than a footnote — three
// appearances is the point, not chartjunk.
//
// Two more rules the markup enforces:
//
//  * NO --blue. Blue is the live model's voice on the board above; the
//    research half is deliberately monochrome so the two halves cannot be
//    confused at a glance, in a screenshot, or in a thumbnail.
//  * NO result colour on an example row. Hit and miss are distinguished by
//    weight, never by green and red — --win is at zero uses on this page until
//    a live leg settles as beat-close, and it stays there.
//
// The props block prints no rate of return and no closing-line value because
// the data has neither: those picks were graded against nflverse box scores,
// never against a market price. exp5-view.ts refuses to expose such a field so
// this file cannot invent one.

import {
  HOLDOUT_DOC_URL,
  HOLDOUT_HEADLINE,
  PREREG_DOC,
  PREREG_DOC_URL,
  RESEARCH_SPAN,
  fmtCount,
  fmtRatePct,
  fmtYieldPct,
  propPickLabel,
  propProvenance,
  type ParlaysBlock,
  type PropsBlock,
  type ResearchView,
} from "@/lib/nfl-receipts/exp5-view";

/** The date the pre-registration's no-ROI rule was narrowed. Stated on the
 *  page because an amendment a reader cannot see is an edit. */
export const AMENDMENT_DATE = "2026-09-09";

export function ResearchAppendix({ research }: { research: ResearchView }) {
  const { props, parlays } = research;
  if (!props && !parlays) return null;

  return (
    <>
      <section className="receipts-section part-front" id="research">
        <p className="eyebrow part-kicker">
          Part two · Research · Not the live ledger
        </p>
        <h2 className="headline part-title">
          What the model did before it went public
        </h2>
        <p className="prose part-lede">
          Everything above this line is live: published before kickoff, at
          prices a book was really offering, and no rate of return is claimed
          for any of it. Everything below is a <strong>backtest</strong> — the
          same doctrine re-run over seasons that had already finished,{" "}
          <strong>in-sample, {RESEARCH_SPAN}</strong>. It is the working, not
          the results.
        </p>
        <p className="prose part-lede">
          {HOLDOUT_HEADLINE}{" "}
          <a href={HOLDOUT_DOC_URL} rel="noreferrer">
            Read the holdout write-up
          </a>
          . Nothing below has been tested out of sample.
        </p>
        <Amendment />
      </section>

      {props && <PropsSection block={props} />}
      {parlays && <ParlaysSection block={parlays} />}
    </>
  );
}

/* ─── The amendment — dated, on the page, because the rule was ───────────── */

function Amendment() {
  return (
    <div className="amendment" id="amendment-1">
      <p className="eyebrow amendment-head">
        Amendment 1 — {AMENDMENT_DATE}
      </p>
      <p className="prose">
        The pre-registration frozen on <span className="num">2026-08-29</span>{" "}
        said: <em>&ldquo;No ROI claim appears anywhere on /nfl.&rdquo;</em> As of{" "}
        <span className="num">{AMENDMENT_DATE}</span> that rule is{" "}
        <strong>narrowed, not dropped</strong>. It now reads: no ROI claim
        appears anywhere on /nfl <strong>for a live pick</strong>. The board,
        the passed games and the ledger above still carry no return figure and
        never will.
      </p>
      <p className="prose">
        What changed: the backtest below reports a flat-stake yield, and
        publishing the record while hiding the number it produced was the more
        misleading of the two options. What did not change: that yield is
        in-sample, it is graded against approximate closing lines so it banks no
        closing-line value, and the one out-of-sample test this model has taken
        came back negative. Those three facts travel with every figure below.
      </p>
      <p className="prose">
        This note is dated and public because the original rule was. A
        pre-registration you can quietly edit is not a pre-registration — the
        amended text is appended to{" "}
        <a href={PREREG_DOC_URL} className="num path" rel="noreferrer">
          {`docs/research/${PREREG_DOC}`}
        </a>{" "}
        under its own date, with the original rule left standing above it.
      </p>
    </div>
  );
}

/* ─── The travelling caveat ─────────────────────────────────────────────── */

/** Sits directly under every figure block. Adjacent and unmissable is the
 *  requirement; a footnote at the bottom of the page is neither. */
function Caveat({ children }: { children?: React.ReactNode }) {
  return (
    <aside className="caveat">
      <p className="eyebrow caveat-head">
        In-sample {RESEARCH_SPAN} · 2025 holdout: negative
      </p>
      <p className="prose caveat-body">{children}</p>
      {/* The source path gets its own line. Inline, a 51-character path lands
          at the end of a measure and breaks mid-word ("…2025.m / d"), which
          reads as a rendering fault on the one link a sceptic will click. */}
      <p className="caveat-src">
        <a href={HOLDOUT_DOC_URL} rel="noreferrer">
          docs/research/2026-08-18-holdout-validation-2025.md
        </a>
      </p>
    </aside>
  );
}

/* ─── Figures ───────────────────────────────────────────────────────────── */

/** A figure rail, not a tile grid. Every value is the SAME size on purpose:
 *  a yield printed larger than the break-even it must clear is an argument,
 *  not a table. */
function Figures({ items }: { items: Array<[string, string, string?]> }) {
  return (
    <dl className="figures">
      {items.map(([term, value, note]) => (
        <div key={term}>
          <dt className="eyebrow">{term}</dt>
          <dd className="num-display">{value}</dd>
          {note && <p className="figure-note">{note}</p>}
        </div>
      ))}
    </dl>
  );
}

function ResearchHead({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="section-head">
      <h3 className="headline section-title">{title}</h3>
      <p className="eyebrow section-meta">{meta}</p>
    </div>
  );
}

/* ─── Player props ──────────────────────────────────────────────────────── */

function PropsSection({ block }: { block: PropsBlock }) {
  return (
    <section className="receipts-section" id="research-props">
      <ResearchHead
        title="PLAYER PROPS"
        meta={`BACKTEST · ${fmtCount(block.settled)} SETTLED · IN-SAMPLE ${RESEARCH_SPAN} · NO PRICE, SO NO ROI AND NO CLV`}
      />
      <Figures
        items={[
          ["Correct", fmtCount(block.wins)],
          ["Missed", fmtCount(block.losses)],
          ["Pushed", fmtCount(block.pushes)],
          ["Settled", fmtCount(block.settled)],
          [
            "Hit rate",
            fmtRatePct(block.hitRatePct),
            `${fmtCount(block.wins)} of ${fmtCount(block.decided)} decided`,
          ],
          ["No line posted", fmtCount(block.noData)],
        ]}
      />
      <Caveat>
        There is no rate of return and no closing-line value on this block, and
        none is estimated: these picks were graded against nflverse box scores,
        never against a market price. A hit rate against a threshold is not a
        return — without the price the book was asking, it cannot be turned into
        one. The picks were made under strict week-by-week blind discipline over{" "}
        {RESEARCH_SPAN}; the model has never been tested on a season it had not
        already seen, except once, and that test failed.
      </Caveat>

      {block.examples.length > 0 && (
        <>
          <p className="prose research-note">
            A sample of {block.examples.length} settled rows, with the reasoning
            recorded at the time. These publish only after settlement — an open
            pick never leaves the private log, so nothing here could have been
            written to fit a result.
          </p>
          <table className="ledger-table agate props-table">
            <colgroup>
              <col className="col-prop-pick" />
              <col className="col-prop-result" />
              <col className="col-prop-why" />
              <col className="col-prop-when" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Pick</th>
                <th scope="col">Outcome</th>
                <th scope="col">Reasoning recorded at the time</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {block.examples.map((e, i) => (
                <tr className="prop-row" key={`${e.player}-${e.stat}-${i}`}>
                  <td className="num c-prop-pick">
                    <span className="prop-player">{e.player}</span>
                    <span className="prop-team"> {e.team}</span>
                    <span className="prop-pick"> {propPickLabel(e)}</span>
                  </td>
                  {/* Weight, never colour: --win green stays at zero uses on
                      this page and a red miss would read as a live loss. */}
                  <td className="c-prop-result">
                    <span
                      className={`tag${e.result === "win" ? " is-hit" : ""}`}
                    >
                      {e.result === "win"
                        ? "HIT"
                        : e.result === "loss"
                          ? "MISS"
                          : "PUSH"}
                    </span>
                  </td>
                  <td className="c-prop-why">{e.rationale}</td>
                  <td className="num c-prop-when">{propProvenance(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/* ─── Three-leg parlays ─────────────────────────────────────────────────── */

function ParlaysSection({ block }: { block: ParlaysBlock }) {
  const clears = block.winRatePct > block.breakEvenPct;
  return (
    <section className="receipts-section" id="research-parlays">
      <ResearchHead
        title="THREE-LEG PARLAYS"
        meta={`BACKTEST · ${fmtCount(block.settled)} SETTLED · IN-SAMPLE ${RESEARCH_SPAN} · YIELD IS AN UPPER BOUND`}
      />
      {/* The upper-bound caveat runs ABOVE the number it qualifies. Under it,
          it is a disclaimer; above it, it is a condition of reading. */}
      <p className="prose upper-bound">
        <strong>Read this before the number.</strong> The yield below is graded
        against nflverse approximate closing lines, which means the backtest
        bought at the closing price and banked{" "}
        <strong>no closing-line value at all</strong>. Live betting does not
        work that way: you either beat the close or you do not, and this test
        never had to. Treat the figure as an{" "}
        <strong>optimistic upper bound</strong> — the best case the doctrine
        could have produced with perfect prices — not a forecast, and not
        something anyone earned.
      </p>
      <Figures
        items={[
          [
            "Flat-stake yield",
            fmtYieldPct(block.flatYieldPct),
            "profit per 1u risked",
          ],
          ["Win rate", fmtRatePct(block.winRatePct), "of decided parlays"],
          [
            "Break-even",
            fmtRatePct(block.breakEvenPct),
            "what the odds require",
          ],
          ["Won", fmtCount(block.wins)],
          ["Lost", fmtCount(block.losses)],
          ["Settled", fmtCount(block.settled)],
        ]}
      />
      <Caveat>
        {clears ? (
          <>
            The {fmtRatePct(block.winRatePct)} win rate clears the{" "}
            {fmtRatePct(block.breakEvenPct)} the odds require, which is what
            makes the yield positive — in sample.
          </>
        ) : (
          <>
            The {fmtRatePct(block.winRatePct)} win rate is short of the{" "}
            {fmtRatePct(block.breakEvenPct)} the odds require.
          </>
        )}{" "}
        That is the whole claim: a doctrine that cleared its own break-even on
        seasons it had already seen. On the one season it had not, the same
        doctrine lost.
      </Caveat>
      <p className="prose research-note">
        Reported as a flat <span className="num">1u</span> per parlay, not a
        compounding bankroll: the research engine sizes quarter-Kelly off a
        running balance, and a handful of long-odds hits inflate that curve into
        a number nobody could have staked.
        {block.avgLegEdgePct != null && (
          <>
            {" "}
            Mean model-minus-market edge across legs was{" "}
            <span className="num">{block.avgLegEdgePct.toFixed(1)} pp</span>.
          </>
        )}{" "}
        Aggregates only — per-parlay rows stay in the private log.
      </p>
    </section>
  );
}
