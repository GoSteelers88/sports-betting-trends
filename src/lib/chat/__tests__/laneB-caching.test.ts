// Prompt caching wired into the Lane B tool loop. Verifies the two cache_control
// breakpoints (system + a single rolling conversation breakpoint) and that
// runLaneB sums cache usage across the loop. Caching is cost/latency-only — the
// model-visible content is unchanged — so these assertions look at the shape of
// the args passed to messages.create and the usage returned, NOT the reply.

import { describe, it, expect, vi, beforeEach } from "vitest";

// runLaneB (stats mode) fetches only the desk-record summary from Turso; mock it
// so the test hits no DB. Every other stats tool is a pure file/record read, and
// this turn only exercises get_desk_record (a pure handler over the mocked record).
vi.mock("@/lib/agent/memory", () => ({
  getActiveMemoriesForScope: vi.fn().mockResolvedValue([]),
  getLatestDreamSummary: vi.fn().mockResolvedValue({ available: false }),
  getRecentResultsByTeam: vi.fn().mockResolvedValue([]),
  getDeskRecordSummary: vi.fn().mockResolvedValue({ available: false }),
}));

import { runLaneB } from "../laneB";

const NO_TURNS: Array<{ role: "user" | "assistant"; content: string }> = [];

type Block = { cache_control?: unknown; [k: string]: unknown };
type CreateArg = { system: unknown; messages: Array<{ content: unknown }> };

// Count how many content blocks across ALL messages carry a cache_control mark.
function countBreakpoints(messages: Array<{ content: unknown }>): number {
  let n = 0;
  for (const m of messages)
    if (Array.isArray(m.content))
      for (const b of m.content as Block[])
        if (b && typeof b === "object" && "cache_control" in b) n++;
  return n;
}

// The last block of the last array-content message — where the rolling
// breakpoint must land.
function lastArrayBlock(messages: Array<{ content: unknown }>): Block | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (Array.isArray(c) && c.length > 0) return c[c.length - 1] as Block;
  }
  return undefined;
}

describe("Lane B prompt caching — breakpoints + telemetry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("caches tools+system on the last system block", async () => {
    // Single-shot: model answers immediately (no tool round-trip).
    const create = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Bruins are 41-12." }],
      usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 4096 },
    });
    const client = { messages: { create } } as never;

    await runLaneB("NHL", "how are the Bruins?", NO_TURNS, client, undefined, "slate", "stats");

    const arg = create.mock.calls[0][0] as CreateArg;
    // system is a block array; its LAST block carries an ephemeral breakpoint.
    expect(Array.isArray(arg.system)).toBe(true);
    const sys = arg.system as Block[];
    expect(sys[sys.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("after a tool round-trip, exactly ONE rolling breakpoint on the last conversation block", async () => {
    let call = 0;
    // The loop mutates `messages` by reference after each create call, so
    // deep-snapshot the messages at call time to inspect the breakpoint state
    // exactly as it was sent (not after the next push mutates the same array).
    const snapshots: Array<Array<{ content: unknown }>> = [];
    const create = vi.fn().mockImplementation((arg: CreateArg) => {
      snapshots.push(JSON.parse(JSON.stringify(arg.messages)));
      call++;
      if (call === 1) {
        // First response: request a (pure) stats tool → forces a tool_result push.
        return Promise.resolve({
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "toolu_1", name: "get_desk_record", input: {} },
          ],
          usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 },
        });
      }
      // Second response: finish with text.
      return Promise.resolve({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "The desk record is unavailable right now." }],
        usage: { cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
      });
    });
    const client = { messages: { create } } as never;

    await runLaneB("NHL", "how's the desk doing?", NO_TURNS, client, undefined, "slate", "stats");

    // Two model calls happened (tool round-trip).
    expect(create).toHaveBeenCalledTimes(2);

    // On the SECOND call, the messages array carries the pushed assistant
    // (array) + tool_result (array) messages. Exactly ONE rolling breakpoint
    // exists (prior marks cleared), and it is on the LAST array-content block —
    // inspected via the call-time snapshot (the live array is mutated afterward).
    const secondMessages = snapshots[1];
    expect(countBreakpoints(secondMessages)).toBe(1);
    const last = lastArrayBlock(secondMessages);
    expect(last?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("runLaneB returns cacheReadTokens/cacheCreationTokens summed across the loop", async () => {
    let call = 0;
    const create = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "toolu_1", name: "get_desk_record", input: {} },
          ],
          usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 4096 },
        });
      }
      return Promise.resolve({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done." }],
        usage: { cache_read_input_tokens: 4096, cache_creation_input_tokens: 0 },
      });
    });
    const client = { messages: { create } } as never;

    const result = await runLaneB(
      "NHL",
      "how's the desk doing?",
      NO_TURNS,
      client,
      undefined,
      "slate",
      "stats"
    );

    // 100 + 4096 read, 4096 + 0 creation.
    expect(result.cacheReadTokens).toBe(4196);
    expect(result.cacheCreationTokens).toBe(4096);
  });

  it("guards undefined usage fields to 0 (no NaN)", async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok." }],
      // no usage field at all
    });
    const client = { messages: { create } } as never;

    const result = await runLaneB("NHL", "hi", NO_TURNS, client, undefined, "slate", "stats");
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
  });
});
