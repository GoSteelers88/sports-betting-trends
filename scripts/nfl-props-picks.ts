/**
 * nfl-props-picks.ts — pick against the week's REAL posted prop lines.
 *
 *   npm run nfl:props-picks -- <season> <week> [--dry-run]
 *
 * Reads  data/processed/nfl-live/props-<season>-wkNN.json  (the captured market)
 *        data/private/nfl-loop/{games.csv,injuries.csv,player_stats.csv}
 * Writes the `picks` block back into that same public receipt.
 *
 * 🚨 This is NOT the backtest prop path. That one hardcodes whole-number
 * thresholds (50/250/75) with no price, and the 2025 holdout showed it adds
 * +0.4pp over blindly backing the same player every week — it was naming good
 * players, not finding edges. Here the model sees the actual half-point lines
 * and the actual prices, and a pick only survives if the model's probability
 * beats what the price implies.
 *
 * 🚨 UNTESTED OUT OF SAMPLE. No calibration map exists for props, so raw model
 * confidence is used and the floors do the work. Everything published from this
 * carries NO STAKE and is graded in public.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultStateDir,
  loadGames,
  loadInjuries,
  loadPlayerStats,
  buildBlindWeek,
} from "../src/lib/nfl-loop";
import { getAnthropic, MODELS } from "../src/lib/agent/client";
import {
  toCandidates,
  buildPick,
  CONFIDENCE_FLOOR,
  EDGE_FLOOR,
  type LivePropPick,
  type LineCandidate,
} from "../src/lib/nfl-live-props-pick";

const B = "\x1b[1m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const D = "\x1b[2m";

const fmtPrice = (n: number): string => (n >= 0 ? `+${n}` : String(n));
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function systemPrompt(): string {
  return [
    "You are an NFL player-prop analyst pricing REAL posted lines.",
    "",
    "You see pre-game context only: each player's season averages from PRIOR",
    "weeks, injury status, and the matchup. You also see the actual line and",
    "the actual price on offer for each side.",
    "",
    "Your job is NOT to project a number. It is to say, for lines where you",
    "have a genuine view, the probability that a side hits. A price already",
    "encodes the market's probability; you are only useful where you disagree",
    "with it for a reason you can name.",
    "",
    "Rules:",
    "  - Return a view ONLY where a specific factor justifies it (usage trend,",
    "    injury to a competing target, opponent scheme, weather, game script).",
    "  - Skip anything where the season average sits near the line with nothing",
    "    to differentiate. An empty array is a correct and common answer.",
    "  - confidence is your probability that the chosen side hits, 0..1. Do not",
    "    inflate it: it is compared directly against the price's implied",
    "    probability, and a wrong number is worse than no pick.",
    "  - Never pick a side the market does not offer.",
    "",
    "Respond with ONLY a JSON array of objects with these fields:",
    "  player (string, exactly as given), stat (string, exactly as given),",
    "  side (over or under), confidence (number 0..1),",
    "  rationale (string, <=200 chars, cite the specific factor)",
    "",
    "No prose outside the JSON array.",
  ].join("\n");
}

function userPrompt(candidates: LineCandidate[], contexts: unknown): string {
  const menu = candidates.map((c) => {
    const o = c.over ? `over ${c.over.point} @ ${fmtPrice(c.over.priceAmerican)}` : "over —";
    const u = c.under ? `under ${c.under.point} @ ${fmtPrice(c.under.priceAmerican)}` : "under —";
    return `${c.player} (${c.team}) ${c.stat} | ${o} | ${u} | ${c.matchup}`;
  });
  return [
    `PLAYER CONTEXT (prior weeks only):\n${JSON.stringify(contexts)}\n`,
    `LINES ON OFFER (${candidates.length}) — pick only from these:`,
    ...menu,
  ].join("\n");
}

type ModelView = {
  player: string;
  stat: string;
  side: string;
  confidence: number;
  rationale?: string;
};

function parseViews(text: string): ModelView[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? (arr as ModelView[]) : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const season = Number(process.argv[2]);
  const week = Number(process.argv[3]);
  const dryRun = process.argv.includes("--dry-run");
  if (!Number.isFinite(season) || !Number.isFinite(week)) {
    console.error("usage: nfl-props-picks.ts <season> <week> [--dry-run]");
    process.exit(1);
  }

  const wk = String(week).padStart(2, "0");
  const boardPath = path.join(
    process.cwd(),
    "data",
    "processed",
    "nfl-live",
    `props-${season}-wk${wk}.json`,
  );
  if (!fs.existsSync(boardPath)) {
    console.error(
      `${Y}no captured prop board at ${path.relative(process.cwd(), boardPath)} — run nfl:props-week first${R}`,
    );
    process.exit(1);
  }
  const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  const candidates = toCandidates(board.lines);

  const dir = defaultStateDir();
  const cursor = { season, phase: "REG" as const, week };
  const blind = buildBlindWeek(
    loadGames(dir),
    cursor,
    "",
    loadInjuries(dir),
    loadPlayerStats(dir),
  );
  if (blind.playerContexts.length === 0) {
    console.error(
      `${Y}no player contexts for ${season} wk${week} — the model would be picking blind. Run nfl:ingest-props-stats.${R}`,
    );
    process.exit(1);
  }

  // Only send context for players who actually have a line on offer.
  const wanted = new Set(candidates.map((c) => c.player));
  const contexts = blind.playerContexts.filter((c) => wanted.has(c.player));

  console.log(
    `${B}NFL prop picks${R} — ${season} wk${week}: ${B}${candidates.length}${R} lines on offer, ${contexts.length} with prior-week context`,
  );
  console.log(
    `${D}floors: confidence >= ${pct(CONFIDENCE_FLOOR)}, edge >= ${pct(EDGE_FLOOR)} over the offered price${R}`,
  );

  const client = getAnthropic();
  const res = await client.messages
    .stream({
      model: MODELS.nflLoop,
      // 232 candidate lines with rationales overran 16K and tripped the
      // truncation guard. Streaming, so a high ceiling costs nothing.
      max_tokens: 48000,
      system: systemPrompt(),
      messages: [{ role: "user", content: userPrompt(candidates, contexts) }],
    })
    .finalMessage();

  if (res.stop_reason === "refusal") {
    console.error(`${Y}refused by safety classifiers — no picks written${R}`);
    process.exit(1);
  }
  if (res.stop_reason === "max_tokens") {
    console.error(`${Y}truncated at max_tokens — a cut-off pick list must never publish${R}`);
    process.exit(1);
  }

  let text = "";
  for (const b of res.content) if (b.type === "text") text += b.text;
  const views = parseViews(text);

  const byKey = new Map(candidates.map((c) => [`${c.player}|${c.stat}`, c]));
  const picks: LivePropPick[] = [];
  let unmatched = 0;
  for (const v of views) {
    const c = byKey.get(`${v.player}|${v.stat}`);
    if (!c) {
      unmatched++;
      continue;
    }
    const side = String(v.side).toLowerCase();
    if (side !== "over" && side !== "under") {
      unmatched++;
      continue;
    }
    const p = buildPick(c, side, Number(v.confidence), String(v.rationale ?? ""));
    if (p) picks.push(p);
    else unmatched++;
  }

  const plays = picks.filter((p) => p.verdict === "play");
  console.log(
    `\n  model returned ${views.length} views · ${picks.length} matched a real line · ${unmatched} discarded`,
  );
  console.log(`  ${G}${plays.length} PLAY${R} · ${picks.length - plays.length} PASS\n`);
  for (const p of plays) {
    console.log(
      `  ${G}PLAY${R} ${B}${p.player}${R} ${p.stat} ${p.side} ${p.point} @ ${fmtPrice(p.priceAmerican)} ${D}(${p.book})${R}`,
    );
    console.log(
      `       conf ${pct(p.confidence)} vs implied ${pct(p.impliedProb)} → edge ${G}+${pct(p.edge)}${R}`,
    );
    console.log(`       ${D}${p.rationale}${R}`);
  }
  // Print the PASSES too. The receipts lane shows what it declined and why —
  // an unexplained empty board is indistinguishable from a broken one.
  for (const p of picks.filter((x) => x.verdict === "pass")) {
    console.log(
      `  ${D}PASS${R} ${p.player} ${p.stat} ${p.side} ${p.point} @ ${fmtPrice(p.priceAmerican)}  ` +
        `conf ${pct(p.confidence)} vs implied ${pct(p.impliedProb)} → edge ${p.edge >= 0 ? "+" : ""}${pct(p.edge)}`,
    );
    console.log(`       ${D}${p.passReason}${R}`);
  }

  if (plays.length === 0) {
    console.log(`  ${D}nothing cleared both floors — an empty board is a valid answer${R}`);
  }

  if (dryRun) {
    console.log(`\n${D}--dry-run: receipt not written.${R}`);
    return;
  }

  board.picks = picks;
  // Persist the RAW model views too. Gating is pure, so a floor change can be
  // re-applied offline instead of paying for a fresh (and non-deterministic) run.
  board.rawViews = views;
  board.picksGeneratedAt = new Date().toISOString();
  board.pickFloors = { confidence: CONFIDENCE_FLOOR, edge: EDGE_FLOOR };
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2) + "\n");
  console.log(
    `\n${G}→ ${path.relative(process.cwd(), boardPath)}${R} ${D}(${picks.length} picks recorded)${R}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
