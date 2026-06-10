/**
 * pead-dream.ts — weekly PEAD research memo (Experiment No. 3).
 * Quarantined hypothesis factory: writes a memo file + Discord post, never
 * touches the trading rule. Scheduled Mondays via pead-dream.yml.
 *
 *   npx tsx scripts/pead-dream.ts
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { runPeadDream } from "@/lib/stocks/peadDream";
import { notifyPeadMemo } from "@/lib/agent/notify";

const MEMO_DIR = path.join(process.cwd(), "data", "processed", "pead-memos");

async function main() {
  const result = await runPeadDream();
  if (result.skipped === "no-entries") {
    console.log("[pead-dream] no entries yet — nothing to dream about");
    await prisma.$disconnect();
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(MEMO_DIR, `${date}.md`);
  fs.mkdirSync(MEMO_DIR, { recursive: true });
  fs.writeFileSync(file, `# PEAD weekly memo — ${date}\n\n${result.memo}\n`, "utf-8");

  const v = result.stats.verdict;
  console.log(
    `[pead-dream] memo written: ${file} | entries=${result.stats.entries.total} ` +
      `settled=${v.settled}/${v.needed} verdict=${v.state}`,
  );
  await notifyPeadMemo(
    `📜 **PEAD weekly memo** (${date}) — ${result.stats.entries.total} entries, ` +
      `${v.settled}/${v.needed} settled, verdict: ${v.state}\n\n` +
      result.memo.slice(0, 1700),
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[pead-dream] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
