import { describe, it, expect } from "vitest";
import { buildTodayRows, type NflLiveLeg } from "../today-list";
import {
  DISCORD_MAX_CHARS,
  formatDailyPlays,
  formatRow,
  playsSignature,
  type PostPick,
} from "../daily-plays-post";

// Wed 2026-10-28 14:30Z = 10:30 AM EDT.
const NOW = Date.parse("2026-10-28T14:30:00Z");
const SITE = "https://sports-betting-trends.vercel.app";

function pick(over: Partial<PostPick> & { id: number }): PostPick {
  return {
    edge: 0.071,
    gameDate: "2026-10-28T23:30:00Z",
    outcome: null,
    league: "NBA",
    matchup: "New York Knicks @ Boston Celtics",
    selection: "Boston Celtics",
    oddsAmerican: -120,
    modelProb: 0.616,
    marketProb: 0.545,
    kellyStakeUnits: 1.5,
    player: null,
    propType: null,
    line: null,
    side: null,
    ...over,
  };
}

function leg(over: Partial<NflLiveLeg> = {}): NflLiveLeg {
  return {
    legId: "abc123",
    season: 2026,
    week: 9,
    publishedAt: "2026-10-27T14:00:00Z",
    matchup: "GB @ CAR",
    awayAbbr: "GB",
    homeAbbr: "CAR",
    selectedAbbr: "GB",
    opponentAbbr: "CAR",
    selectedIsAway: true,
    kickoffUtc: "2026-11-01T17:00:00Z",
    modelPct: 58.1,
    marketPct: 50.9,
    gapPp: 7.2,
    entryPriceAmerican: 105,
    book: "fanduel",
    snapshotFetchedAt: "2026-10-27T13:55:00Z",
    clvEligible: true,
    ...over,
  };
}

describe("formatRow", () => {
  it("words an agent moneyline like the site card: entry, stake, edge", () => {
    const [row] = buildTodayRows([pick({ id: 1 })], [], [], NOW);
    const text = formatRow(row!);
    expect(text).toContain("**NBA**");
    expect(text).toContain("7:30 PM ET");
    expect(text).toContain("**Boston Celtics ML** vs New York Knicks");
    expect(text).toContain("entry -120 · 1.50u · edge +7.1%");
    expect(text).toContain("(model 61.6% / market 54.5%)");
  });

  it("says 'at' when the pick is the away team", () => {
    const [row] = buildTodayRows([pick({ id: 1, selection: "New York Knicks" })], [], [], NOW);
    expect(formatRow(row!)).toContain("**New York Knicks ML** at Boston Celtics");
  });

  it("words a prop as player, side, line and the site's stat label", () => {
    const p = pick({ id: 2, player: "Jayson Tatum", propType: "player_points", line: 27.5, side: "over" });
    const [row] = buildTodayRows([], [p], [], NOW);
    expect(formatRow(row!)).toContain("**Jayson Tatum OVER 27.5 pts** · New York Knicks @ Boston Celtics");
  });

  it("never prints a stake or units on an NFL board play", () => {
    const [row] = buildTodayRows([], [], [leg()], NOW);
    const text = formatRow(row!);
    expect(text).toContain("**GB ML** at CAR · entry +105 @ FANDUEL");
    expect(text).toContain("disagreement +7.2 pp (model 58.1% / market 50.9%)");
    expect(text).not.toMatch(/\du\b|units|stake|roi|clv/i);
  });

  it("claims no disagreement when the board had no market read", () => {
    const [row] = buildTodayRows([], [], [leg({ marketPct: null, gapPp: null })], NOW);
    expect(formatRow(row!)).not.toContain("disagreement");
  });
});

describe("formatDailyPlays", () => {
  it("posts nothing when the site has no plays", () => {
    expect(formatDailyPlays([], NOW, SITE)).toEqual([]);
  });

  it("leads with the date, the count and the site link", () => {
    const rows = buildTodayRows([pick({ id: 1 })], [], [leg()], NOW);
    const [msg] = formatDailyPlays(rows, NOW, SITE);
    expect(msg).toMatch(/^🎯 \*\*Today's plays\*\* — .*WED OCT 28.* · as of 10:30 AM ET/);
    expect(msg).toContain(`2 plays · full cards and receipts: <${SITE}>`);
  });

  it("keeps the site's order: earliest start first", () => {
    const rows = buildTodayRows(
      [pick({ id: 1, gameDate: "2026-10-29T00:00:00Z", selection: "Late Pick", matchup: "X @ Late Pick" })],
      [],
      [leg({ kickoffUtc: "2026-10-28T23:00:00Z" })],
      NOW,
    );
    const [msg] = formatDailyPlays(rows, NOW, SITE);
    expect(msg!.indexOf("NFL")).toBeLessThan(msg!.indexOf("Late Pick"));
  });

  it("splits a long slate into Discord-sized messages on row boundaries", () => {
    const many = Array.from({ length: 30 }, (_, i) => pick({ id: i + 1 }));
    const rows = buildTodayRows(many, [], [], NOW);
    const msgs = formatDailyPlays(rows, NOW, SITE);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS);
    const total = msgs.join("\n\n").match(/\*\*NBA\*\*/g)?.length;
    expect(total).toBe(30);
  });
});

describe("playsSignature", () => {
  it("is the same for the same plays in any order, and changes with the day", () => {
    const a = buildTodayRows([pick({ id: 1 }), pick({ id: 2 })], [], [leg()], NOW);
    const b = [...a].reverse();
    expect(playsSignature(a, NOW)).toBe(playsSignature(b, NOW));
    expect(playsSignature(a, NOW + 24 * 3_600_000)).not.toBe(playsSignature(a, NOW));
  });

  it("changes when a play is added", () => {
    const a = buildTodayRows([pick({ id: 1 })], [], [], NOW);
    const b = buildTodayRows([pick({ id: 1 }), pick({ id: 3 })], [], [], NOW);
    expect(playsSignature(a, NOW)).not.toBe(playsSignature(b, NOW));
  });
});
