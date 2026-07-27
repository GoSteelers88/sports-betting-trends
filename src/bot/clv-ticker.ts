// Per-game CLV capture loop, running inside the always-on Railway bot
// process. Vercel Hobby tier only allows daily-cadence crons, and GitHub
// Actions has a 5-min cron floor with unreliable timing — neither is a fit
// for the tight 2–12 minute pre-tip-off capture window we need. The bot is
// already up 24/7, so we piggyback on it.
//
// Calls captureClv() directly (no HTTP round-trip through /api/cron). That
// path requires CRON_SECRET — by importing the library we skip the auth
// boundary entirely since this is the same trust domain as the bot.

import { captureClv } from "@/lib/clv-tracker";

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 min — matches the capture window's half-overlap

export function startClvTicker(): NodeJS.Timeout {
  // First tick fires immediately on boot so we don't wait 5 min for the
  // initial run after a deploy.
  void runOnce();
  return setInterval(runOnce, TICK_INTERVAL_MS);
}

async function runOnce(): Promise<void> {
  try {
    const result = await captureClv();
    // Only log when something interesting happened — silent ticks would
    // dominate the Railway log otherwise (most ticks have 0 pending picks
    // because games aren't starting in the next 12 min).
    if (result.pendingChecked > 0 || result.errors.length > 0) {
      console.log(
        `[clv-ticker] checked=${result.pendingChecked} captured=${result.clvCaptured} unmatched=${result.unmatched} avg=${result.averageClvProbPoints ?? "n/a"}pp${result.errors.length ? ` errs=${result.errors.length}` : ""}`
      );
    }
  } catch (err) {
    console.error("[clv-ticker] tick failed:", err);
  }
}
