/**
 * verify-notary.ts — standalone receipt audit (threat T7).
 *
 *   npx tsx scripts/verify-notary.ts [--require-remote]
 *
 * Checks, for every board registered in ledger.json:
 *   1. local bytes hash to the SHA256 recorded at publish (boards immutable);
 *   2. origin/master holds the identical content (with --require-remote or in
 *      CI this is mandatory; locally an unpushed board is a warning);
 *   3. when a GitHub token is available (GH_TOKEN / GITHUB_TOKEN), master's
 *      branch protection has allow_force_pushes DISABLED — without that, the
 *      "immutable" history can be rewritten by any bot with push rights.
 *      Missing protection is a FAILURE in CI (it silently voids the notary),
 *      a loud warning locally.
 */
import { execFileSync } from "node:child_process";
import { verifyNotary } from "../src/lib/nfl-receipts/notary";

const REPO = "GoSteelers88/sports-betting-trends";

async function gh(pathname: string, token: string): Promise<Response> {
  return fetch(`https://api.github.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "nfl-receipts-notary",
    },
    signal: AbortSignal.timeout(15000),
  });
}

async function checkBranchProtection(): Promise<"ok" | "unprotected" | "unknown"> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) return "unknown";
  try {
    // Rulesets first: /rules/branches/{branch} lists ACTIVE rules from both
    // rulesets and readable with the default workflow token. A
    // non_fast_forward rule blocks force pushes; a deletion rule blocks delete.
    const rulesRes = await gh(`/repos/${REPO}/rules/branches/master`, token);
    if (rulesRes.ok) {
      const rules = (await rulesRes.json()) as Array<{ type: string }>;
      const types = new Set(rules.map((r) => r.type));
      if (types.has("non_fast_forward") && types.has("deletion")) return "ok";
    }
    // Classic branch protection (requires admin-read; 403 → can't assert).
    const res = await gh(`/repos/${REPO}/branches/master/protection`, token);
    if (res.status === 404)
      return rulesRes.ok ? "unprotected" : "unknown"; // neither API shows protection
    if (!res.ok) return "unknown"; // token lacks scope — can't assert either way
    const data = (await res.json()) as {
      allow_force_pushes?: { enabled?: boolean };
      allow_deletions?: { enabled?: boolean };
    };
    if (data.allow_force_pushes?.enabled || data.allow_deletions?.enabled)
      return "unprotected";
    return "ok";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const inCi = process.env.GITHUB_ACTIONS === "true";
  const requireRemote = inCi || process.argv.includes("--require-remote");

  const result = verifyNotary({
    requireRemote,
    execGit: (args) => execFileSync("git", args, { encoding: "utf8" }),
  });
  for (const line of result.log) console.log(line);

  const protection = await checkBranchProtection();
  let protectionOk = true;
  if (protection === "ok") {
    console.log("ok branch protection: force pushes + deletions disabled on master");
  } else if (protection === "unprotected") {
    const msg =
      "master has NO force-push protection — history is rewritable and the git notary is decorative. " +
      "Fix: repo Settings → Branches → protect master (or a repo ruleset) with force pushes + deletions blocked.";
    if (inCi) {
      console.error(`FAIL ${msg}`);
      protectionOk = false;
    } else {
      console.warn(`WARN ${msg}`);
    }
  } else {
    console.log("branch protection: not assertable (no token / insufficient scope)");
  }

  if (!result.ok || !protectionOk) process.exit(1);
  console.log("\nnotary: all receipts verify");
}

main().catch((err) => {
  console.error("NOTARY ERROR:", err);
  process.exit(1);
});
