/**
 * parlay-dream.ts — weekly parlay research memo (Experiment No. 4).
 * Quarantined hypothesis factory: writes a memo file + Discord post, never
 * touches the trading rule. Scheduled weekly via parlay-paper.yml (dream job).
 *
 *   npm run paper:parlay:dream
 *   npx tsx scripts/parlay-dream.ts
 */
import fs from "node:fs";
import path from "node:path";
import { runParlayDream } from "@/lib/parlay/parlayDream";
import { notifyPeadMemo } from "@/lib/agent/notify";

const DATA_DIR = path.join(process.cwd(), "data", "processed");
const MEMO_DIR = path.join(DATA_DIR, "parlay-memos");

// Minimal env loader so the tsx runner gets ANTHROPIC_API_KEY / webhook without
// Next's env (same pattern as ingest-soft-props.ts).
for (const envFile of [".env", ".env.local"]) {
  try {
    const envPath = path.resolve(process.cwd(), envFile);
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* ignore */
  }
}

async function main() {
  const result = await runParlayDream(DATA_DIR);
  if (result.skipped === "no-parlays") {
    console.log("[parlay-dream] no parlays yet — nothing to dream about");
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(MEMO_DIR, `${date}.md`);
  fs.mkdirSync(MEMO_DIR, { recursive: true });
  fs.writeFileSync(file, `# Parlay weekly memo — ${date}\n\n${result.memo}\n`, "utf-8");

  const v = result.stats.verdict;
  console.log(
    `[parlay-dream] memo written: ${file} | parlays=${result.stats.parlays.total} ` +
      `settled=${v.settled}/${v.needed} verdict=${v.state}`,
  );
  await notifyPeadMemo(
    `🎲 **Parlay weekly memo** (${date}) — ${result.stats.parlays.total} parlays, ` +
      `${v.settled}/${v.needed} decisive, verdict: ${v.state}\n\n` +
      result.memo.slice(0, 1700),
  );
}

main().catch((e) => {
  console.error("[parlay-dream] FAILED:", e);
  process.exit(1);
});
