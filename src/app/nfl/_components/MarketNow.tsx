// MarketNow — the sharp week board on /nfl.
//
// THE BOARD above froze at publish and never moves again. This table is the
// market as of the last daily refresh, and the whole reason it sits on this
// page is that the difference between those two instants is the thing the
// experiment is about. It is deliberately NOT joined to the board: a pair join
// across an odds feed that spans a whole season is a bug factory, and no claim
// here needs one. Each surface prints its own provenance and its own instant.
//
// It shares its data file with the homepage section (data/processed/nfl-slate.json,
// committed daily), so the two never disagree; the presentation is different
// because the neighbours are. Two structural rules keep it from reading as a
// second pass grid immediately above it:
//
//  * NO day bands. The day rides in the kickoff cell instead, so the two tables
//    do not share a silhouette.
//  * NO --blue and NO sparkline. This is the MARKET talking, and on this page
//    blue is the model's voice. Whole percents, not one decimal: nothing in
//    this table is subtracted from anything, and 16 rows of "61.6%" is false
//    precision on a line that moves every day.

import type { NflSlate } from "@/lib/nfl-receipts/site-slate";
import { etDayLabel, etTimeLabel } from "@/lib/nfl-receipts/receipts-view";
import {
  fairPairWhole,
  fmtFairPct,
  fmtSlatePrice,
  fmtSlateSpread,
  fmtSlateTotal,
  slateRows,
} from "@/lib/nfl-receipts/slate-view";

function fmtStampUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${iso.slice(0, 16).replace("T", " ")}Z`;
}

export function MarketNow({ slate }: { slate: NflSlate | null }) {
  const rows = slateRows(slate);

  return (
    <section className="receipts-section" id="market">
      <div className="section-head">
        <h2 className="headline section-title">THE MARKET NOW</h2>
        <p className="eyebrow section-meta">
          {rows.length} GAMES IN THE WINDOW · PINNACLE MAIN LINES · DE-VIGGED
          (POWER) · REFRESHED {fmtStampUtc(slate?.generatedAt)}
        </p>
      </div>

      <p className="prose standfirst-block">
        The board above stopped moving the moment it was published. This one has
        not: it is the sharp market as of the last daily refresh, at Pinnacle&rsquo;s
        main lines, de-vigged by the same power method the ledger grades against.
        Nothing here is a pick and nothing here is graded — it is the number the
        model was arguing with, printed so a reader can watch it move.
      </p>

      {rows.length === 0 ? (
        <p className="prose market-empty">
          No NFL games sit inside the week window right now. The board refreshes
          daily from the sharp feed; between seasons it is empty, and an empty
          feed is printed as empty rather than backfilled.
        </p>
      ) : (
        <table className="ledger-table agate market-table">
          <colgroup>
            <col className="col-mkt-kick" />
            <col className="col-mkt-game" />
            <col className="col-mkt-ml" />
            <col className="col-mkt-fair" />
            <col className="col-mkt-spread" />
            <col className="col-mkt-total" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Kickoff ET</th>
              <th scope="col">Game</th>
              <th scope="col" className="th-right">
                Moneyline
              </th>
              <th scope="col" className="th-right">
                Fair win %
              </th>
              <th scope="col" className="th-right">
                Spread (home)
              </th>
              <th scope="col" className="th-right">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr className="market-row" key={`${r.kickoffUtc}-${r.homeTeam}`}>
                <td className="num c-mkt-kick">
                  <span className="mkt-day">{etDayLabel(r.kickoffUtc)}</span>{" "}
                  <span className="mkt-time">{etTimeLabel(r.kickoffUtc)}</span>
                </td>
                <td className="num c-mkt-game">
                  {r.awayShort} <span className="at">@</span> {r.homeShort}
                </td>
                <td className="num c-mkt-ml">
                  <span className="cell-label">{"Moneyline "}</span>
                  {fmtSlatePrice(r.moneylineAway)}
                  <span className="slash"> / </span>
                  {fmtSlatePrice(r.moneylineHome)}
                </td>
                {/* Rounded as a PAIR. Independently rounded sides printed
                    "19% / 82%" and "48% / 53%" — two complementary
                    probabilities adding to 101, on four of sixteen rows. */}
                <td className="num c-mkt-fair">
                  <span className="cell-label">{"Fair "}</span>
                  {fmtFairPct(fairPairWhole(r.fairHomePct, r.fairAwayPct).away)}
                  <span className="slash"> / </span>
                  {fmtFairPct(fairPairWhole(r.fairHomePct, r.fairAwayPct).home)}
                </td>
                <td className="num c-mkt-spread">
                  <span className="cell-label">{"Spread "}</span>
                  {fmtSlateSpread(r.spreadPoint, r.spreadHomePrice)}
                </td>
                <td className="num c-mkt-total">
                  <span className="cell-label">{"Total "}</span>
                  {fmtSlateTotal(r.totalPoint)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="retired-note">
        Away / home throughout. Fair win % is the de-vigged Pinnacle moneyline —
        the market&rsquo;s own probability with the vig taken out, not the
        model&rsquo;s. Prices move; a figure read here will not match a figure
        read tomorrow, and neither of them is the price on the frozen board
        above.
      </p>
    </section>
  );
}
