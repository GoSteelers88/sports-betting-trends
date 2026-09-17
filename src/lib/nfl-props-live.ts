// nfl-props-live.ts — best available NFL player-prop lines for a live week.
//
// PURE over its inputs (an Odds API event-odds payload + a player→team
// resolver); the script owns fs and network. Grading is NOT reimplemented here:
// these rows convert to the loop's existing PropPick shape so gradePropPick()
// and buildActualStatMap() in nfl-loop.ts do the grading, exactly as they do
// for the backtest. One grader, one definition of a win.

import type { PropStat, PropPick } from "./nfl-loop";

// Odds API market key → the loop's PropStat. Every entry must be a PropStat or
// it can never join the graded record.
//   player_reception_tds is mapped but, as measured 2026-09-17, the API returns
//   no book for it on NFL — an unreturned market is simply not billed.
export const NFL_PROP_MARKETS: Record<string, PropStat> = {
  player_pass_yds: "passYds",
  player_pass_tds: "passTDs",
  player_rush_yds: "rushYds",
  player_reception_yds: "recYds",
  player_reception_tds: "recTDs",
};

export const NFL_PROP_MARKET_KEYS = Object.keys(NFL_PROP_MARKETS);

export type OddsOutcome = {
  name?: string;        // "Over" | "Under"
  description?: string; // player name
  point?: number;
  price?: number;       // American
};
export type OddsMarket = { key?: string; outcomes?: OddsOutcome[] };
export type OddsBookmaker = { key?: string; title?: string; markets?: OddsMarket[] };
export type OddsEvent = {
  id?: string;
  home_team?: string;
  away_team?: string;
  commence_time?: string;
  bookmakers?: OddsBookmaker[];
};

export type BestLine = {
  player: string;
  team: string;          // resolved; "" when unknown (the row is still recorded)
  position: string;
  stat: PropStat;
  side: "over" | "under";
  point: number;
  priceAmerican: number;
  book: string;
  booksOffering: number; // how many books posted this player/stat/side
};

/** Is `a` a better American price than `b`? Raw numeric comparison is correct:
 *  +150 beats -110 beats -200. */
function betterPrice(a: number, b: number): boolean {
  return a > b;
}

/** Best line for a side. For an OVER a LOWER number is easier to clear; for an
 *  UNDER a HIGHER number is. Point dominates price — a half-point is worth far
 *  more than a few cents of juice — and price breaks ties. */
function beats(side: "over" | "under", cand: { point: number; priceAmerican: number }, cur: { point: number; priceAmerican: number }): boolean {
  if (cand.point !== cur.point) {
    return side === "over" ? cand.point < cur.point : cand.point > cur.point;
  }
  return betterPrice(cand.priceAmerican, cur.priceAmerican);
}

export type ResolvePlayer = (player: string) => { team: string; position: string } | null;

/** Collapse every book's quotes for one event into the single best line per
 *  (player, stat, side). */
export function selectBestLines(event: OddsEvent, resolve: ResolvePlayer): BestLine[] {
  const best = new Map<string, BestLine>();

  for (const bk of event.bookmakers ?? []) {
    const book = bk.key ?? bk.title ?? "unknown";
    for (const mkt of bk.markets ?? []) {
      const stat = mkt.key ? NFL_PROP_MARKETS[mkt.key] : undefined;
      if (!stat) continue;
      for (const o of mkt.outcomes ?? []) {
        const player = (o.description ?? "").trim();
        const sideRaw = (o.name ?? "").trim().toLowerCase();
        if (!player || (sideRaw !== "over" && sideRaw !== "under")) continue;
        if (typeof o.point !== "number" || typeof o.price !== "number") continue;
        const side = sideRaw as "over" | "under";

        const k = `${player}|${stat}|${side}`;
        const cur = best.get(k);
        if (cur) cur.booksOffering++;

        if (!cur || beats(side, { point: o.point, priceAmerican: o.price }, cur)) {
          const who = resolve(player);
          best.set(k, {
            player,
            team: who?.team ?? cur?.team ?? "",
            position: who?.position ?? cur?.position ?? "",
            stat,
            side,
            point: o.point,
            priceAmerican: o.price,
            book,
            booksOffering: cur ? cur.booksOffering : 1,
          });
        }
      }
    }
  }

  return [...best.values()].sort(
    (a, b) => a.player.localeCompare(b.player) || a.stat.localeCompare(b.stat) || a.side.localeCompare(b.side),
  );
}

/** Convert best lines into the loop's PropPick shape so the EXISTING grader
 *  scores them. `confidence` is the market's own implied probability — these
 *  are market lines being tracked, not model picks, and recording a fake
 *  model confidence here would poison the calibration tables downstream. */
export function toPropPicks(lines: BestLine[]): PropPick[] {
  return lines.map((l) => ({
    player: l.player,
    team: l.team,
    position: l.position,
    stat: l.stat,
    threshold: l.point,
    side: l.side,
    confidence: impliedProb(l.priceAmerican),
    rationale: `best line ${l.side} ${l.point} @ ${l.priceAmerican >= 0 ? "+" : ""}${l.priceAmerican} (${l.book}, ${l.booksOffering} books)`.slice(0, 200),
  }));
}

/** American odds → implied probability (with vig; these are single-side quotes). */
export function impliedProb(american: number): number {
  return american >= 0 ? 100 / (american + 100) : -american / (-american + 100);
}
