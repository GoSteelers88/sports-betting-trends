/**
 * healthchecks-setup.ts — create/update the Healthchecks.io checks that watch
 * the LOCAL NFL scheduled tasks.
 *
 *   npm run healthchecks:setup            # upsert the checks
 *   npm run healthchecks:setup -- --list  # show their current status
 *
 * Needs in .env.local:
 *   HEALTHCHECKS_API_KEY   project Settings -> API Access -> read-write key
 *   HEALTHCHECKS_PING_KEY  project Settings -> Ping key (used by scheduled-task.ps1)
 *
 * Why an outside service: a job cannot report that it never ran. On 09-22 the
 * publish script failed to even parse, and a PC that is asleep, signed out
 * (the tasks are LogonType=Interactive) or has a disabled task sends nothing
 * at all. Healthchecks alerts on the ABSENCE of the success ping, so it is the
 * one check that does not depend on this machine working.
 *
 * The slugs MUST match the -Name each task passes to scripts/scheduled-task.ps1.
 * Schedules mirror the Task Scheduler triggers (America/New_York). Grace covers
 * run time plus a StartWhenAvailable catch-up after the PC wakes.
 */

type CheckSpec = { slug: string; name: string; schedule: string; graceMin: number; desc: string };

export const CHECKS: CheckSpec[] = [
  {
    slug: "nfl-daily",
    name: "NFL Exp5 daily loop",
    schedule: "0 5 * * *",
    graceMin: 240,
    desc: "Task NFL-Exp5-DailyLoop -> scripts/nfl-cron.ps1. Commits data/processed/nfl-exp5.json.",
  },
  {
    slug: "nfl-dream",
    name: "NFL Exp5 weekly dream",
    schedule: "0 6 * * 2",
    graceMin: 240,
    desc: "Task NFL-Exp5-WeeklyDream -> scripts/nfl-dream-cron.ps1. Refreshes the private NFL doctrine.",
  },
  {
    slug: "nfl-publish",
    name: "NFL weekly publish",
    schedule: "7 10 * * 2",
    graceMin: 120,
    desc: "Task NFL-Weekly-Publish -> scripts/nfl-publish-day.ps1. Publishes the week's /nfl board. Kickoff is Thursday night - act same day.",
  },
];

const API = "https://healthchecks.io/api/v3/checks/";

async function main(): Promise<void> {
  const key = process.env.HEALTHCHECKS_API_KEY;
  if (!key) {
    console.error("HEALTHCHECKS_API_KEY missing from .env.local (project Settings -> API Access, read-write key)");
    process.exit(1);
  }
  const headers = { "X-Api-Key": key, "Content-Type": "application/json" };

  if (process.argv.includes("--list")) {
    const res = await fetch(API, { headers });
    if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
    const { checks } = (await res.json()) as { checks: Array<{ slug: string; status: string; last_ping: string | null; next_ping: string | null }> };
    for (const c of checks) console.log(`${c.slug.padEnd(12)} ${c.status.padEnd(8)} last=${c.last_ping ?? "never"} next=${c.next_ping ?? "-"}`);
    return;
  }

  for (const c of CHECKS) {
    const res = await fetch(API, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: c.name,
        slug: c.slug,
        desc: c.desc,
        schedule: c.schedule,
        tz: "America/New_York",
        grace: c.graceMin * 60,
        channels: "*",
        unique: ["slug"],
      }),
    });
    if (!res.ok) throw new Error(`${c.slug}: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { status: string };
    console.log(`${res.status === 201 ? "created" : "updated"} ${c.slug} (${c.schedule} ET, grace ${c.graceMin}m) status=${body.status}`);
  }
  if (!process.env.HEALTHCHECKS_PING_KEY) {
    console.log("\nNOTE: HEALTHCHECKS_PING_KEY is not set yet - scheduled-task.ps1 will not ping until it is.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
