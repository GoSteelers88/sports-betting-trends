import { describe, expect, it } from "vitest";
import { legId } from "../leg-id";

const base = {
  boardFile: "board-2026-wk01.json",
  gameId: "2026_01_KC_PHI",
  market: "ats",
  selection: "KC +3.5",
  point: 3.5,
};

describe("legId (threat T8: identity, not append-order)", () => {
  it("is deterministic", () => {
    expect(legId(base)).toBe(legId({ ...base }));
    expect(legId(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("distinguishes every identity component", () => {
    const ids = new Set([
      legId(base),
      legId({ ...base, boardFile: "board-2026-wk02.json" }),
      legId({ ...base, gameId: "2026_01_DAL_NYG" }),
      legId({ ...base, market: "moneyline" }),
      legId({ ...base, selection: "PHI -3.5" }),
      legId({ ...base, point: -3.5 }),
    ]);
    expect(ids.size).toBe(6);
  });

  it("point null and point 0 are distinct identities", () => {
    expect(legId({ ...base, point: null })).not.toBe(legId({ ...base, point: 0 }));
  });
});
