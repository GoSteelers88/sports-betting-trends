/**
 * +EV board — prints tonight's slate with de-vigged Pinnacle fair value next
 * to the best soft-book price, and flags the positive-EV plays.
 *
 * This is the read-only proof of the de-vigged-sharp pivot: run it after
 * `npm run ingest:sharp` + `npm run ingest:odds` and eyeball whether the sharp
 * line is actually finding mispriced soft prices. It touches no DB and places
 * no bets.
 *
 *   npm run board:ev            # both leagues, +2% EV floor
 *   npm run board:ev -- MLB 1   # MLB only, +1% floor
 */
import {
  buildFairValueBoard,
  positiveEvOpportunities,
  suspiciousOpportunities,
  type EvGame,
} from "../src/lib/fair-value";

const YELLOW = "\x1b[33m";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

function fmtAmerican(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}
function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "   —  ";
  const s = (n * 100).toFixed(1) + "%";
  return n >= 0 ? `+${s}` : s;
}

function printGame(g: EvGame, floor: number) {
  const t = new Date(g.commence_time);
  const time = Number.isNaN(t.getTime())
    ? "??:??"
    : t.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  console.log(
    `${BOLD}${g.matchup}${RESET} ${DIM}· ${time} · Pinnacle vig ${(g.overround * 100).toFixed(1)}%${RESET}`,
  );
  for (const s of g.sides) {
    const soft = s.bestSoft
      ? `${fmtAmerican(s.bestSoft.american)} @ ${s.bestSoft.book}`
      : "no soft price";
    const evNum = s.evPct ?? -Infinity;
    const color = s.suspicious
      ? YELLOW
      : evNum >= floor
        ? GREEN
        : evNum >= 0
          ? CYAN
          : DIM;
    const flag = s.suspicious
      ? `${YELLOW}${BOLD} ⚠ SUSPECT${RESET}`
      : evNum >= floor
        ? `${GREEN}${BOLD} ◄ +EV${RESET}`
        : "";
    console.log(
      `  ${color}${s.team.padEnd(24)}${RESET} ` +
        `fair ${fmtAmerican(s.fairAmerican).padStart(6)} (${(s.fairProb * 100).toFixed(1)}%)  ` +
        `soft ${soft.padEnd(20)}  ` +
        `EV ${color}${fmtPct(s.evPct)}${RESET}  ` +
        `CLV ${s.clvCents != null ? (s.clvCents > 0 ? "+" : "") + s.clvCents : "—"}¢${flag}`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const leagueArg = (args[0] ?? "").toUpperCase();
  const leagues: Array<"NBA" | "MLB"> =
    leagueArg === "NBA" || leagueArg === "MLB"
      ? [leagueArg]
      : ["MLB", "NBA"];
  const floorArg = parseFloat(args[1] ?? args[0] ?? "");
  const floor = Number.isFinite(floorArg) && floorArg > 0 ? floorArg / 100 : 0.02;

  for (const league of leagues) {
    const board = buildFairValueBoard(league);
    console.log(
      `\n${BOLD}${CYAN}══ ${league} ══${RESET} ` +
        `${DIM}sharp ${board.sharpGames} games (${board.sharpFetchedAt ?? "?"}) · ` +
        `soft ${board.softGames} games (${board.softFetchedAt ?? "?"}) · ` +
        `matched ${board.gamesMatched}${RESET}`,
    );
    if (board.games.length === 0) {
      console.log(`${DIM}  no sharp games — run npm run ingest:sharp${RESET}`);
      continue;
    }
    for (const g of board.games) printGame(g, floor);
    if (board.unmatched.length) {
      console.log(
        `${DIM}  unmatched (no soft counterpart): ${board.unmatched.join(", ")}${RESET}`,
      );
    }

    const opps = positiveEvOpportunities(board, floor);
    console.log(
      `\n${BOLD}+EV plays ≥ ${(floor * 100).toFixed(1)}% (${league}): ${opps.length}${RESET}`,
    );
    for (const o of opps) {
      console.log(
        `  ${GREEN}${fmtPct(o.evPct).padStart(6)}${RESET}  ` +
          `${o.team.padEnd(24)} ${fmtAmerican(o.bestSoft!.american).padStart(6)} @ ${o.bestSoft!.book.padEnd(8)} ` +
          `${DIM}(fair ${fmtAmerican(o.fairAmerican)}, ¼-Kelly ${(o.kelly * 100).toFixed(2)}% bankroll)${RESET}`,
      );
    }

    const suspect = suspiciousOpportunities(board);
    if (suspect.length) {
      console.log(
        `${YELLOW}${BOLD}quarantined (likely stale/mismatched line, NOT bet): ${suspect.length}${RESET}`,
      );
      for (const o of suspect) {
        console.log(
          `  ${YELLOW}${fmtPct(o.evPct).padStart(6)}${RESET}  ` +
            `${o.team.padEnd(24)} ${fmtAmerican(o.bestSoft!.american).padStart(6)} @ ${o.bestSoft!.book} ` +
            `${DIM}vs fair ${fmtAmerican(o.fairAmerican)} — Δ${o.clvCents}¢${RESET}`,
        );
      }
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
