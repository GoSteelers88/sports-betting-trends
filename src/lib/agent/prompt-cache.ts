// Prompt-cache breakpoint helpers, shared by every Anthropic tool loop.
//
// Prompt caching is a PREFIX MATCH: the cache key is the exact bytes of the
// rendered prompt up to each cache_control breakpoint, and render order is
// tools → system → messages. Two consequences drive everything here:
//
//   1. A breakpoint on the last system block caches the tool definitions AND
//      the system prompt together, because tools render ahead of system.
//   2. A tool loop re-sends the ENTIRE conversation on every iteration. Without
//      a breakpoint inside `messages`, every accumulated tool result is billed
//      at full input price on every remaining round.
//
// This lived in chat/laneB.ts, which was the only loop that had caching wired.
// It is here because analyst.ts needs the identical behaviour and a second copy
// of a cache-correctness helper is the kind of thing that silently diverges —
// one call site gets a fix, the other quietly keeps paying.

/**
 * Move the conversation's single rolling cache breakpoint to the end.
 *
 * Marks EXACTLY ONE cache_control breakpoint: the LAST content block of the
 * LAST array-content message. Prior marks are cleared first so the rolling
 * breakpoint does not accumulate — a loop that added one per iteration would
 * blow the 4-breakpoint-per-request budget partway through and start erroring.
 * Paired with the one breakpoint on the system block, the total is 2 ≤ 4.
 *
 * Seed/user messages have STRING content, which has no block to mark, so the
 * first iteration marks nothing and simply reads the system+tools prefix. The
 * assistant `response.content` and the tool_result arrays pushed afterward ARE
 * arrays, so the breakpoint lands from iteration 2 on — exactly where the
 * expensive accumulated tool output sits.
 *
 * Clearing a previous mark does NOT invalidate that earlier cache entry: reads
 * land on any position a previous request wrote, and the moving marker is the
 * one thing that legitimately differs between adjacent requests.
 *
 * This is byte-invisible to the model. cache_control is caching metadata, not
 * content — the model's view of the conversation is unchanged.
 */
export function markRollingCacheBreakpoint(
  messages: Array<{ role: string; content: unknown }>
): void {
  for (const m of messages)
    if (Array.isArray(m.content))
      for (const b of m.content)
        if (b && typeof b === "object" && "cache_control" in b)
          delete (b as { cache_control?: unknown }).cache_control;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (Array.isArray(c) && c.length > 0) {
      const last = c[c.length - 1];
      if (last && typeof last === "object")
        (last as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
      break;
    }
  }
}
