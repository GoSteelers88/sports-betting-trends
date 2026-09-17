// PropMarket — the week's player-prop MARKET, published as a receipt.
//
// 🚨 These are NOT picks. Each row is the best NUMBER available across US books
// for that player/stat/side at capture time. No model chose them and no stake
// is implied — the same rule every board leg follows. The heading says so, and
// nothing here may render a stake, an ROI, or a "we like it".
//
// Both sides of a player/stat appear on purpose: the best over sits at the
// LOWEST number on offer and the best under at the HIGHEST, so they are not
// mirrors — when the actual lands between them both cashed. That gap is what
// line shopping buys, and measuring it is the whole point of publishing this.
//
// One collapsed block per game: 476 rows in a single wall would bury the page,
// and <details> keeps every row in the DOM (findable, crawlable) while costing
// no JS.

import type { PublicPropBoard } from "@/lib/nfl-receipts/prop-board";
import { propsByGame } from "@/lib/nfl-receipts/prop-board";

const STAT_LABEL: Record<string, string> = {
  passYds: "PASS YDS",
  passTDs: "PASS TDS",
  rushYds: "RUSH YDS",
  recYds: "REC YDS",
  recTDs: "REC TDS",
};

function price(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

export function PropMarket({ board }: { board: PublicPropBoard | null }) {
  if (!board || board.lines.length === 0) return null;

  const t = board.totals;
  const ungraded = t.settled === 0;

  return (
    <section className="receipts-section" id="props">
      <div className="section-head">
        <h2 className="headline section-title">THE PROP MARKET</h2>
        <p className="eyebrow section-meta">
          {board.season} WEEK {board.week} · {t.lines} BEST LINES ACROSS {board.games} GAMES ·{" "}
          {ungraded ? "UNGRADED — GAMES NOT PLAYED" : `${t.settled} SETTLED · ${t.pending} PENDING`}
        </p>
      </div>

      <p className="prose standfirst-block">
        The best number on offer across US books for each player, stat and side at
        capture time — <strong>the market, not a pick list</strong>. Nothing here was
        chosen by a model and no stake is implied. Both sides are kept: the best over
        sits at the lowest number available and the best under at the highest, so when
        the result lands between them both sides won. That gap is what line shopping
        buys, and it is what this record exists to measure.
      </p>

      <dl className="account-rail">
        {board.byStat.map((s) => (
          <div key={s.stat}>
            <dt>{STAT_LABEL[s.stat] ?? s.stat.toUpperCase()}</dt>
            <dd className="num">
              {s.n}
              {s.hitRatePct != null && (
                <span className="text-ink-3"> · {s.hitRatePct}%</span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {propsByGame(board.lines).map((g) => (
        <details className="prior-week" key={g.gameId}>
          <summary>
            <span className="prior-week__wk">{g.matchup}</span>
            <span className="prior-week__counts">{g.lines.length} LINES</span>
            <span className="prior-week__cue">OPEN</span>
          </summary>
          <div className="panel overflow-x-auto">
            <table className="ledger-table">
              <caption className="sr-only">
                Best available prop lines for {g.matchup}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col">Stat</th>
                  <th scope="col">Side</th>
                  <th scope="col" className="text-right">Number</th>
                  <th scope="col" className="text-right">Price</th>
                  <th scope="col" className="hidden sm:table-cell">Book</th>
                  <th scope="col" className="text-right">Result</th>
                </tr>
              </thead>
              <tbody>
                {g.lines.map((l, i) => (
                  <tr key={`${l.player}-${l.stat}-${l.side}-${i}`}>
                    <th scope="row">{l.player}</th>
                    <td>{STAT_LABEL[l.stat] ?? l.stat}</td>
                    <td>{l.side.toUpperCase()}</td>
                    <td className="text-right num">{l.point}</td>
                    <td className="text-right num">{price(l.priceAmerican)}</td>
                    <td className="hidden sm:table-cell text-ink-3">{l.book}</td>
                    <td className="text-right">
                      {l.result === "pending" ? (
                        <span className="text-ink-3">—</span>
                      ) : l.result === "no-data" ? (
                        <span className="text-ink-3">no box score</span>
                      ) : (
                        <span
                          style={{
                            color:
                              l.result === "win"
                                ? "var(--win)"
                                : l.result === "loss"
                                  ? "var(--loss)"
                                  : "var(--ink)",
                          }}
                        >
                          {l.result.toUpperCase()}
                          {l.actualValue != null && (
                            <span className="text-ink-3"> ({l.actualValue})</span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </section>
  );
}
