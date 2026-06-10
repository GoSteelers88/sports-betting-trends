/**
 * boost-ev.ts — price a sportsbook boost/promo against the de-vigged sharp
 * line. The documented largest retail edge is promo harvesting; this makes
 * each boost decision rigorous in five seconds.
 *
 *   npm run boost:ev -- --boosted +250 --sharp -125 +105
 *   npm run boost:ev -- --boosted +180 --fair 0.46 --bankroll 2000
 *
 * --sharp A B   sharp two-way American prices, YOUR SIDE FIRST (de-vigged
 *               multiplicatively to a fair probability)
 * --fair P      skip de-vig and supply the fair probability directly
 * --boosted X   the boosted American price the book is offering
 * --bankroll N  optional, default 1000 — sizes the quarter-Kelly stake
 */
import {
  noVigFairProbTwoWay,
  expectedValue,
  kellyFraction,
  americanToDecimal,
  probToAmerican,
} from "@/lib/devig";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const boosted = Number(argValue("--boosted"));
  const bankroll = Number(argValue("--bankroll") ?? 1000);
  if (!Number.isFinite(boosted)) {
    console.error("usage: npm run boost:ev -- --boosted +250 (--sharp -125 +105 | --fair 0.46) [--bankroll 1000]");
    process.exit(1);
  }

  let fair: number | null = null;
  const fairArg = argValue("--fair");
  if (fairArg != null) {
    fair = Number(fairArg);
    if (!(fair! > 0 && fair! < 1)) {
      console.error("--fair must be a probability in (0,1)");
      process.exit(1);
    }
  } else {
    const i = process.argv.indexOf("--sharp");
    const a = Number(process.argv[i + 1]);
    const b = Number(process.argv[i + 2]);
    if (i < 0 || !Number.isFinite(a) || !Number.isFinite(b)) {
      console.error("provide --sharp <yourSide> <otherSide> or --fair <prob>");
      process.exit(1);
    }
    const devigged = noVigFairProbTwoWay(a, b);
    if (devigged == null) {
      console.error("could not de-vig those prices");
      process.exit(1);
    }
    fair = devigged.fairA;
    console.log(`sharp ${a > 0 ? "+" : ""}${a} / ${b > 0 ? "+" : ""}${b} → fair ${(fair * 100).toFixed(1)}% (${probToAmerican(fair) > 0 ? "+" : ""}${Math.round(probToAmerican(fair))})`);
  }

  const ev = expectedValue(fair!, boosted);
  const dec = americanToDecimal(boosted);
  const kelly = kellyFraction(fair!, boosted, 0.25);
  const stake = Math.max(0, +(bankroll * kelly).toFixed(2));

  console.log(`boosted ${boosted > 0 ? "+" : ""}${boosted} (decimal ${dec.toFixed(3)})`);
  console.log(`EV: ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(2)}%  ${ev >= 0.0 ? "✓ positive" : "✗ negative — pass"}`);
  if (ev > 0) {
    console.log(`¼-Kelly stake on $${bankroll}: $${stake.toFixed(2)} (${(kelly * 100).toFixed(2)}% of bankroll)`);
  }
}

main();
