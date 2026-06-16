// Tests for deriveEventId — the per-game identifier that distinguishes split
// doubleheaders (same matchup + commence_time) which the gameDate-based unique
// key cannot. Prefers the analyst-copied Odds API event.id; falls back to a
// deterministic synthetic id so ordinary games stay idempotent across reruns.

import { describe, it, expect } from "vitest";
import { deriveEventId } from "../analyst";

const TIP = new Date("2026-06-11T23:00:00.000Z");

describe("deriveEventId", () => {
  it("prefers the analyst-copied Odds API event id", () => {
    expect(
      deriveEventId({ eventId: "abc123", matchup: "Phillies @ Mets" }, TIP)
    ).toBe("abc123");
  });

  it("ignores blank/whitespace event ids and synthesizes instead", () => {
    expect(deriveEventId({ eventId: "   ", matchup: "Phillies @ Mets" }, TIP)).toMatch(/^syn:/);
    expect(deriveEventId({ eventId: undefined, matchup: "Phillies @ Mets" }, TIP)).toMatch(/^syn:/);
  });

  it("is deterministic across reruns for the same game (idempotency)", () => {
    const a = deriveEventId({ matchup: "Phillies @ Mets" }, TIP);
    const b = deriveEventId({ matchup: "Phillies @ Mets" }, new Date(TIP));
    expect(a).toBe(b);
  });

  it("distinguishes a distinct-time doubleheader via the timestamp", () => {
    const game1 = deriveEventId({ matchup: "Phillies @ Mets" }, new Date("2026-06-11T17:00:00.000Z"));
    const game2 = deriveEventId({ matchup: "Phillies @ Mets" }, new Date("2026-06-11T20:30:00.000Z"));
    expect(game1).not.toBe(game2);
  });

  it("distinguishes an identical-time doubleheader when the model supplies event ids", () => {
    // The case the synthetic alone cannot separate — the analyst-copied eventId
    // is what makes the two legs distinct.
    const game1 = deriveEventId({ eventId: "evt-dh-1", matchup: "Phillies @ Mets" }, TIP);
    const game2 = deriveEventId({ eventId: "evt-dh-2", matchup: "Phillies @ Mets" }, TIP);
    expect(game1).not.toBe(game2);
  });

  it("normalizes matchup punctuation/case in the synthetic id", () => {
    const a = deriveEventId({ matchup: "Phillies @ Mets" }, TIP);
    const b = deriveEventId({ matchup: "PHILLIES  @  METS" }, TIP);
    expect(a).toBe(b);
  });
});
