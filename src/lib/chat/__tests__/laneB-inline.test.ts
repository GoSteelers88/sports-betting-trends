// B3 — the regen/finalize input must be WHOLE tool-result payloads only, never
// a mid-JSON char-slice. The old blind `join("\n").slice(0, 20_000)` cut a
// single tool result mid-object (get_injuries(MLB) alone ~26KB), and the model
// accurately narrated the incompleteness — the literal source of the "tool
// results not back yet" plumbing leak. This asserts inlineToolResults includes
// only complete, parseable JSON objects and drops trailing ones behind a marker.

import { describe, it, expect } from "vitest";
import { inlineToolResults } from "../laneB";

// A realistic large tool payload (well over 20KB so three of them blow the old
// 20k cap and even the new 40k budget), always valid JSON.
function bigPayload(tag: string, sizeChars: number): string {
  const filler = "x".repeat(Math.max(0, sizeChars - 60));
  return JSON.stringify({ tool: tag, note: filler, edge: 0.072, price: -110 });
}

describe("inlineToolResults (B3) — whole payloads, no mid-JSON cut", () => {
  it("drops trailing whole payloads past the budget and appends the marker", () => {
    // Three ~18KB payloads = ~54KB joined → exceeds the 40k budget, so at least
    // one whole payload is dropped and the marker is appended.
    const results = [
      bigPayload("get_odds", 18_000),
      bigPayload("get_injuries", 18_000),
      bigPayload("get_board_edges", 18_000),
    ];
    const out = inlineToolResults(results);

    expect(out).toContain("[additional tool results omitted for length]");

    // Split off the marker, then EVERY remaining block must be valid JSON — no
    // block was cut mid-object.
    const marker = "\n[additional tool results omitted for length]";
    const body = out.endsWith(marker) ? out.slice(0, -marker.length) : out;
    const blocks = body.split("\n").filter((b) => b.length > 0);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.length).toBeLessThan(results.length); // at least one dropped
    for (const block of blocks) {
      // Must not throw — proves each inlined block is a complete object.
      expect(() => JSON.parse(block)).not.toThrow();
    }
  });

  it("keeps all payloads and adds NO marker when they fit the budget", () => {
    const results = [
      bigPayload("get_odds", 5_000),
      bigPayload("get_injuries", 5_000),
    ];
    const out = inlineToolResults(results);
    expect(out).not.toContain("omitted for length");
    for (const block of out.split("\n")) {
      expect(() => JSON.parse(block)).not.toThrow();
    }
  });

  it("includes at least one WHOLE payload even if it alone exceeds the budget", () => {
    // A single payload larger than the whole 40k budget: we ship it whole (never
    // an empty block, never a mid-object cut).
    const results = [bigPayload("get_injuries", 60_000), bigPayload("get_odds", 5_000)];
    const out = inlineToolResults(results);
    const marker = "\n[additional tool results omitted for length]";
    const body = out.endsWith(marker) ? out.slice(0, -marker.length) : out;
    const blocks = body.split("\n").filter((b) => b.length > 0);
    expect(blocks.length).toBe(1);
    expect(() => JSON.parse(blocks[0]!)).not.toThrow();
    expect(out).toContain("omitted for length"); // the 2nd was dropped
  });
});
