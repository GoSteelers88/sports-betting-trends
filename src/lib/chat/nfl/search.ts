// search.ts — the web-search channel for receipts mode.
//
// Anthropic runs this server-side: we declare the tool, the model issues the
// query, the API executes it and hands back a `web_search_tool_result` block in
// the SAME response. There is no scraper here and no search vendor to add.
//
// TWO rules make the feature safe on a betting page:
//
//   1. SEARCH RESULTS ARE UNTRUSTED CONTENT AND NEVER ENTER THE GROUNDING
//      HAYSTACK. The haystack is what a numeric claim is checked against; if a
//      scraped page could enter it, an affiliate blog writing "22% edge on the
//      Jets" would GROUND the desk's own fabricated 22%. Search blocks are
//      therefore never pushed onto `toolResultTexts` — they live in a separate
//      channel that can ground nothing, by construction rather than by policy.
//   2. AN ALLOWLIST, NOT A BLOCKLIST. A blocklist against the sports-betting
//      web is unwinnable: the tout/affiliate layer IS most of that corpus and
//      it regenerates under new domains weekly. An allowlist of schedule /
//      injury / transaction sources is a small, auditable set, and everything
//      the desk needs from the web (who plays when, who is hurt, who signed)
//      lives on it.
//
// The API also does not RAISE on a search failure: it returns HTTP 200 with a
// result block whose `content` is an OBJECT (`{error_code: ...}`) rather than
// the usual LIST. Branching on that shape before indexing is mandatory —
// see extractSearchSources.

import type Anthropic from "@anthropic-ai/sdk";

/** Reputable schedule / news / injury sources. Subdomains are covered by the
 *  API's own matching, so bare hostnames are correct here. Deliberately short:
 *  every addition is a new trust decision, and the desk needs facts, not takes.
 *
 *  ⚠️ EVERY ENTRY MUST BE CRAWLABLE BY ANTHROPIC'S USER AGENT. A domain that
 *  blocks the crawler does NOT get silently dropped from the list — the API
 *  rejects the WHOLE REQUEST with a 400:
 *
 *    "The following domains are not accessible to our user agent:
 *     ['apnews.com', 'nytimes.com', 'reuters.com', 'theathletic.com',
 *      'usatoday.com']"  — and, on the next run, ['sportingnews.com']
 *
 *  Those five were in this list on the first live run and took the entire chat
 *  turn down with a 500 — a page that publishes nothing but its own committed
 *  files, broken by a newspaper's robots.txt. They are removed. Before adding a
 *  domain here, make one live call with it in the list; a 400 naming it is the
 *  answer. (The lane no longer dies if this happens again — see the
 *  search-disabled retry in receipts.ts — but a 400 per turn is still a bug.) */
export const SEARCH_ALLOWED_DOMAINS: readonly string[] = [
  "nfl.com",
  "espn.com",
  "cbssports.com",
  "nbcsports.com",
  "foxsports.com",
  "si.com",
  "pro-football-reference.com",
  "profootballtalk.nbcsports.com",
  "yahoo.com",
];

/** Three searches is enough for "who plays Sunday" or "is he practicing" and
 *  bounds both latency and the per-turn bill. `max_uses_exceeded` comes back as
 *  a 200 with an error object, which extractSearchSources handles. */
export const SEARCH_MAX_USES = 3;

/** The server-tool definition. `web_search_20260209` needs no beta header and
 *  runs on Opus 5. `allowed_domains` and `blocked_domains` are mutually
 *  exclusive — passing both is a 400 — so only the allowlist is set. */
export const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: SEARCH_MAX_USES,
  allowed_domains: [...SEARCH_ALLOWED_DOMAINS],
} as const satisfies Anthropic.WebSearchTool20260209;

export interface SearchSource {
  title: string;
  url: string;
}

export interface SearchChannel {
  /** Did a search actually run this turn (successfully or not)? */
  used: boolean;
  /** Distinct sources the API returned, for the attribution check + the log. */
  sources: SearchSource[];
  /** Error codes the API reported (200-with-error-object), if any. */
  errors: string[];
}

export function emptySearchChannel(): SearchChannel {
  return { used: false, sources: [], errors: [] };
}

/** Fold one response's content blocks into the search channel.
 *
 *  `.content` is a LIST on success and an OBJECT on error, and neither case
 *  throws — so the Array.isArray branch below is the whole error path. */
export function collectSearchBlocks(
  content: readonly Anthropic.ContentBlock[],
  channel: SearchChannel
): SearchChannel {
  const seen = new Set(channel.sources.map((s) => s.url));
  for (const block of content) {
    if (block.type === "server_tool_use" && block.name === "web_search") {
      channel.used = true;
      continue;
    }
    if (block.type !== "web_search_tool_result") continue;
    channel.used = true;
    const body = block.content;
    if (!Array.isArray(body)) {
      // { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }
      const code =
        body && typeof body === "object" && "error_code" in body
          ? String((body as { error_code: unknown }).error_code)
          : "unknown";
      channel.errors.push(code);
      continue;
    }
    for (const r of body) {
      if (r.type !== "web_search_result") continue;
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      channel.sources.push({ title: r.title ?? r.url, url: r.url });
    }
  }
  return channel;
}

/** Host of a result URL, for the "per <source>" attribution the reply must
 *  carry. Unparseable URLs degrade to the raw string rather than throwing. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Human-readable source names for the attribution check + the forensic log. */
export function sourceNames(channel: SearchChannel): string[] {
  return [...new Set(channel.sources.map((s) => sourceHost(s.url)))];
}

// ─── The attribution rule ────────────────────────────────────────────────────
//
// A searched fact is somebody else's reporting. It may be repeated, attributed;
// it may not be spoken in the desk's own voice, because the desk's voice on this
// page means "pre-registered, notarised, and checkable" and a scraped headline
// is none of those. This is deterministic so it cannot be argued out of.

const ATTRIBUTION_RE =
  /\b(?:per|according to|via|reports?|reporting|reported by|says|said)\b|\bper\s+\w+\.(?:com|org|net)\b/i;

export const UNATTRIBUTED_REPLACEMENT =
  "I can tell you what's being reported, but not in my own voice — on this page my voice means a number that was pre-registered before kickoff and can be checked against a published receipt, and somebody else's reporting is neither. Ask me again and I'll name the outlet alongside the fact, or ask me about the board and I'll speak for that one myself.";

/** When a turn used web search, its reply must attribute. A reply that used
 *  search and names no source is replaced, not regenerated. */
export function checkSearchAttribution(
  reply: string,
  channel: SearchChannel
): { ok: true } | { ok: false; reason: string; replacement: string } {
  if (!channel.used || channel.sources.length === 0) return { ok: true };
  if (ATTRIBUTION_RE.test(reply)) return { ok: true };
  // The source's own name counts as attribution ("ESPN's wire has him limited").
  const names = sourceNames(channel);
  for (const n of names) {
    const bare = n.split(".")[0];
    if (bare && bare.length >= 3 && new RegExp(`\\b${bare}\\b`, "i").test(reply)) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    reason: `search-used-without-attribution (sources: ${names.join(",") || "none"})`,
    replacement: UNATTRIBUTED_REPLACEMENT,
  };
}
