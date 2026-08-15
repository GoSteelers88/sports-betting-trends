// extractJson — the pick/props response parser's JSON isolation + repair.
//
// The missing-colon cases reproduce a live Sonnet 5 failure shape from the
// 2026-08-15 walk: every dumped 0-pick response contained one key emitted
// without its colon (`"rationale "text..."`), which failed JSON.parse for the
// whole response and stalled the burst at 2021 POST wk19.

import { describe, expect, it } from "vitest";

import { extractJson } from "../nfl-agent";

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"picks":[{"gameId":"g1"}]}')).toEqual({
      picks: [{ gameId: "g1" }],
    });
  });

  it("parses a fenced JSON object with surrounding prose", () => {
    const text = 'Here you go:\n```json\n{"picks":[]}\n```\nDone.';
    expect(extractJson(text)).toEqual({ picks: [] });
  });

  it("isolates the first JSON array from leading prose", () => {
    expect(extractJson('picks below\n[{"gameId":"g1"}]')).toEqual([
      { gameId: "g1" },
    ]);
  });

  it("repairs a key emitted without its colon (live Sonnet 5 failure shape)", () => {
    const text =
      '{"picks":[{"gameId":"2021_20_CIN_TEN","confidence":0.57,\n   "rationale "TEN is only a modest -4 home favorite"}]}';
    const parsed = extractJson(text) as { picks: Array<Record<string, unknown>> };
    expect(parsed).not.toBeNull();
    expect(parsed.picks[0].rationale).toBe(
      "TEN is only a modest -4 home favorite",
    );
  });

  it("repairs the missing colon after an array value, mid-object", () => {
    const text =
      '{"picks":[{"gameId":"g1","keyFactors":["wind doesn\'t suppress Mahomes"],\n    "rationale "Roethlisberger\'s declining arm","confidence":0.6}]}';
    const parsed = extractJson(text) as { picks: Array<Record<string, unknown>> };
    expect(parsed).not.toBeNull();
    expect(parsed.picks[0].rationale).toBe("Roethlisberger's declining arm");
    expect(parsed.picks[0].confidence).toBe(0.6);
  });

  it("does not rewrite string VALUES that end in a space", () => {
    // Value position follows a colon, not { or , — the repair must not touch it.
    const text = '{"totalSide": "under ", "confidence": 0.55}';
    expect(extractJson(text)).toEqual({ totalSide: "under ", confidence: 0.55 });
  });

  it("returns null for unrepairable text", () => {
    expect(extractJson("no json here at all")).toBeNull();
    expect(extractJson('{"picks": [truncated mid arr')).toBeNull();
  });
});
