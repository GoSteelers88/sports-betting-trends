// Prompt caching wired into the analyst tool loop. Verifies the two
// cache_control breakpoints (system + a single rolling conversation
// breakpoint) and that analyze() sums cache usage across the loop.
//
// Caching is cost-only — the model-visible content is unchanged — so these
// assertions look at the SHAPE of the args passed to messages.create and the
// usage returned, never at the picks. That matters: a caching regression here
// produces identical picks and a larger bill, which is exactly the failure a
// behavioural test cannot see.
//
// Mirrors chat/__tests__/laneB-caching.test.ts, which covers the same helper
// on the chat loop.

import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();

// The analyst resolves its client at call time via getAnthropic(); MODELS must
// survive the mock because the loop and the result both read MODELS.analyst.
vi.mock("../client", () => ({
  getAnthropic: () => ({ messages: { create } }),
  MODELS: { analyst: "claude-sonnet-4-6" },
}));

// Per-run state is loaded from Prisma before the loop; stub it so the test
// touches no database. Empty results are fine — the caching assertions do not
// depend on prompt content, only on its stability across iterations.
vi.mock("../memory", () => ({
  getActiveMemoriesForScope: vi.fn().mockResolvedValue([]),
  formatMemoriesForPrompt: () => "(no memory rules)",
  getRecentRecord: vi.fn().mockResolvedValue({ wins: 0, losses: 0 }),
  formatRecordForPrompt: () => "(no record)",
  getLatestDreamSummary: vi.fn().mockResolvedValue(null),
  getRecentResultsByTeam: vi.fn().mockResolvedValue([]),
  formatTeamRecordsForPrompt: () => "(no team records)",
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { analyze } from "../analyst";

type Block = { cache_control?: unknown; [k: string]: unknown };
type CreateArg = { system: unknown; messages: Array<{ content: unknown }> };

function countBreakpoints(messages: Array<{ content: unknown }>): number {
  let n = 0;
  for (const m of messages)
    if (Array.isArray(m.content))
      for (const b of m.content as Block[])
        if (b && typeof b === "object" && "cache_control" in b) n++;
  return n;
}

function lastArrayBlock(messages: Array<{ content: unknown }>): Block | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (Array.isArray(c) && c.length > 0) return c[c.length - 1] as Block;
  }
  return undefined;
}

const NO_PICKS = '{ "picks": [] }';

describe("analyst prompt caching — breakpoints + telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mockReset();
  });

  it("caches tools+system on the last system block", async () => {
    create.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: NO_PICKS }],
      usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 5900 },
    });

    await analyze("MLB");

    const arg = create.mock.calls[0][0] as CreateArg;
    // system must be a block array — a bare string cannot carry cache_control,
    // which is how this loop went uncached in the first place.
    expect(Array.isArray(arg.system)).toBe(true);
    const sys = arg.system as Block[];
    expect(sys[sys.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("keeps the system prefix byte-identical across iterations", async () => {
    let call = 0;
    create.mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_1", name: "get_odds", input: { league: "MLB" } }],
          usage: {},
        });
      }
      return Promise.resolve({
        stop_reason: "end_turn",
        content: [{ type: "text", text: NO_PICKS }],
        usage: {},
      });
    });

    await analyze("MLB");

    // Caching is a prefix match, so a single byte of drift between iterations
    // (a timestamp, a re-rendered memory block) silently kills every hit.
    const first = (create.mock.calls[0][0] as CreateArg).system;
    const second = (create.mock.calls[1][0] as CreateArg).system;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("after a tool round-trip, exactly ONE rolling breakpoint on the last conversation block", async () => {
    // The loop mutates `messages` by reference, so snapshot the args at call
    // time — inspecting the live array afterwards shows the final state, not
    // what each request actually carried.
    const snapshots: Array<Array<{ content: unknown }>> = [];
    let call = 0;
    create.mockImplementation((arg: CreateArg) => {
      snapshots.push(JSON.parse(JSON.stringify(arg.messages)));
      call++;
      if (call === 1) {
        return Promise.resolve({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_1", name: "get_odds", input: { league: "MLB" } }],
          usage: {},
        });
      }
      return Promise.resolve({
        stop_reason: "end_turn",
        content: [{ type: "text", text: NO_PICKS }],
        usage: {},
      });
    });

    await analyze("MLB");

    expect(create).toHaveBeenCalledTimes(2);

    // Iteration 1 sends only the string-content seed message — nothing markable,
    // so no conversation breakpoint yet (the system breakpoint carries it).
    expect(countBreakpoints(snapshots[0])).toBe(0);

    // Iteration 2 carries the assistant turn + tool_result array. Exactly ONE
    // mark survives (prior ones cleared), on the last block — accumulating one
    // per iteration would exceed the 4-breakpoint request budget by iteration 4.
    expect(countBreakpoints(snapshots[1])).toBe(1);
    expect(lastArrayBlock(snapshots[1])?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sums all three token counts across the loop", async () => {
    let call = 0;
    create.mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_1", name: "get_odds", input: { league: "MLB" } }],
          usage: {
            input_tokens: 40,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 5900,
          },
        });
      }
      return Promise.resolve({
        stop_reason: "end_turn",
        content: [{ type: "text", text: NO_PICKS }],
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 5900,
          cache_creation_input_tokens: 400,
        },
      });
    });

    const out = await analyze("MLB");

    // input_tokens is the uncached remainder, NOT the prompt size — it is
    // tracked separately so the hit rate is computed over the real prompt
    // (input + read + write) rather than over cached traffic alone, which
    // would report a flattering number exactly when caching is failing.
    expect(out.uncachedInputTokens).toBe(52);
    expect(out.cacheReadTokens).toBe(6000);
    expect(out.cacheCreationTokens).toBe(6300);
  });

  it("guards missing usage fields to 0 (no NaN in the telemetry)", async () => {
    create.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: NO_PICKS }],
      // no usage field at all
    });

    const out = await analyze("MLB");

    expect(out.uncachedInputTokens).toBe(0);
    expect(out.cacheReadTokens).toBe(0);
    expect(out.cacheCreationTokens).toBe(0);
  });
});
