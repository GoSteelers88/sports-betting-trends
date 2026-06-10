/**
 * pead-watchdog.ts — post-cycle health check + entry annotation for the PEAD
 * paper book. Runs after run-pead-paper.ts in pead-paper.yml (if: always()).
 * Read-only against Alpaca; label-only against the book. Posts a Discord
 * digest only when there's something to say.
 *
 *   npx tsx scripts/pead-watchdog.ts
 */
import { prisma } from "@/lib/prisma";
import { runWatchdog } from "@/lib/stocks/peadWatchdog";
import { notifyPeadWatchdog } from "@/lib/agent/notify";

async function main() {
  const result = await runWatchdog();
  const status = result.reconciled ? "reconciled" : "reconcile SKIPPED (no Alpaca creds)";
  console.log(
    `[pead-watchdog] open=${result.openCount} ${status} | issues=${result.issues.length} annotated=${result.annotated}`,
  );
  for (const issue of result.issues) console.log(`[pead-watchdog]   ⚠ ${issue}`);

  if (result.issues.length > 0 || result.annotated > 0) {
    const lines = [`🩺 **PEAD watchdog** — ${result.openCount} open positions`];
    if (result.issues.length > 0) {
      lines.push(...result.issues.map((i) => `⚠️ ${i}`));
    } else {
      lines.push(`✅ book matches Alpaca`);
    }
    if (result.annotated > 0) lines.push(`🏷️ annotated ${result.annotated} new entr${result.annotated === 1 ? "y" : "ies"}`);
    await notifyPeadWatchdog(lines.join("\n"), result.issues.length > 0);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[pead-watchdog] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
