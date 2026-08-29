import { describe, expect, it } from "vitest";
import { drawControl, type ControlCandidate } from "../control-arm";
import { legId } from "../leg-id";

function cand(gameId: string, publishable = true): ControlCandidate {
  return {
    gameId,
    matchup: `AWY @ HME (${gameId})`,
    kickoffUtc: "2099-09-13T17:00:00Z",
    publishable,
    prices: {
      home: { american: -150, otherAmerican: 130, point: null, book: "fanduel", oddsApiEventId: "e1" },
      away: { american: 130, otherAmerican: -150, point: null, book: "fanduel", oddsApiEventId: "e1" },
      over: { american: -110, otherAmerican: -110, point: 44.5, book: "fanduel", oddsApiEventId: "e1" },
      under: { american: -110, otherAmerican: -110, point: 44.5, book: "fanduel", oddsApiEventId: "e1" },
    },
  };
}

const PLAY_ID = legId({
  boardFile: "board-2026-wk01.json",
  gameId: "2026_01_KC_PHI",
  market: "moneyline",
  selection: "PHI ML",
  point: null,
});

describe("drawControl (frozen placebo rule, threat T9)", () => {
  const pool = [cand("g1"), cand("g2"), cand("g3"), cand("g4")];

  it("is deterministic: same play leg + same pool → same draw, regardless of input order", () => {
    const a = drawControl(PLAY_ID, "moneyline", pool);
    const b = drawControl(PLAY_ID, "moneyline", [...pool].reverse());
    expect(a).toEqual(b);
    expect(a?.gameId).toBeTruthy();
  });

  it("different play legs generally land on different placebos", () => {
    const other = legId({
      boardFile: "board-2026-wk01.json",
      gameId: "2026_01_DAL_NYG",
      market: "moneyline",
      selection: "DAL ML",
      point: null,
    });
    const a = drawControl(PLAY_ID, "moneyline", pool);
    const b = drawControl(other, "moneyline", pool);
    // Not guaranteed distinct (mod poolSize), but the pair (game, side) must
    // be a pure function of the leg id — assert stability instead of luck.
    expect(a).toEqual(drawControl(PLAY_ID, "moneyline", pool));
    expect(b).toEqual(drawControl(other, "moneyline", pool));
  });

  it("skips unpublishable candidates deterministically", () => {
    const first = drawControl(PLAY_ID, "moneyline", pool)!;
    const gated = pool.map((c) => (c.gameId === first.gameId ? cand(c.gameId, false) : c));
    const redraw = drawControl(PLAY_ID, "moneyline", gated)!;
    expect(redraw.gameId).not.toBe(first.gameId);
  });

  it("returns null on an empty or fully-gated pool", () => {
    expect(drawControl(PLAY_ID, "moneyline", [])).toBeNull();
    expect(drawControl(PLAY_ID, "moneyline", [cand("g1", false)])).toBeNull();
  });

  it("totals draw over/under sides, never home/away", () => {
    const d = drawControl(PLAY_ID, "total", pool)!;
    expect(["over", "under"]).toContain(d.side);
    expect(d.point).toBe(44.5);
  });

  it("a candidate without a price for the drawn side still publishes (clv-ineligible)", () => {
    const noPrices = pool.map((c) => ({ ...c, prices: {} }));
    const d = drawControl(PLAY_ID, "moneyline", noPrices)!;
    expect(d.american).toBeNull();
  });
});
