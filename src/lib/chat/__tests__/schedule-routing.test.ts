// SCHEDULE ROUTING — "what games are on today?" must never cost a routing model
// call, and must never land on a league that is dark.
//
// THE MEASURED FAILURE (2026-09-12, ~19:00 ET, local server, fresh odds):
//
//   Q "What games are on today?"          → lane B, league NBA, 18.6s, fallback
//   Q "Any player props worth looking at
//      tonight?"                          → lane B, league NBA, 30.2s, fallback
//
// NBA's earliest snapshot game was OCTOBER 20. Two defects compounded:
//
//   1. Neither phrasing matched SLATE_LEVEL_HINTS, so both fell through to
//      looksGameSpecific (\btoday\b / \btonight\b) → the Haiku tiebreaker.
//   2. The tiebreaker was handed `new Set([...ent.teams.values()])` as "leagues
//      with games tonight" — which counted October NBA rows and next week's
//      WNBA rows — answered "NBA", and nothing validated it against the board.
//
// These tests pin both halves plus the substitution guard.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chatSpendCounter: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi
        .fn()
        .mockResolvedValue({ utcDate: "2026-09-12", tokensUsed: 0, modelCalls: 0 }),
      update: vi.fn().mockResolvedValue({}),
    },
    chatRateLimit: {
      upsert: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

import {
  looksScheduleLevel,
  looksSlateLevel,
  classifyDeterministic,
  buildSlateEntities,
  primaryLeagueWithGames,
  leaguesWithGamesToday,
  type SlateEntities,
} from "../router";
import { answer } from "../sharp";
import type { GameOdds } from "@/lib/agent/tools";

const NOW = new Date("2026-09-12T23:00:00.000Z"); // 7:00 PM ET, Sat Sep 12

function ev(commenceTime: string, awayTeam: string, homeTeam: string): GameOdds {
  return {
    eventId: `${awayTeam}@${homeTeam}`,
    commenceTime,
    homeTeam,
    awayTeam,
    consensus: { home: null, away: null, spread: null, total: null },
    bestPrice: { home: null, away: null },
    bookSpread: { home: null, away: null },
    bookCount: 1,
  };
}

// The real 2026-09-12 shape: MLB live tonight, NBA's board opens in October,
// WNBA's next week.
const SEPTEMBER_BOARD: Record<string, { fetchedAt: string | null; events: GameOdds[] }> = {
  MLB: {
    fetchedAt: "2026-09-12T22:43:46.264Z",
    events: [
      ev("2026-09-12T23:16:00.000Z", "Philadelphia Phillies", "Atlanta Braves"),
      ev("2026-09-13T17:36:00.000Z", "New York Mets", "New York Yankees"),
    ],
  },
  NBA: {
    fetchedAt: "2026-09-12T22:43:25.339Z",
    events: [ev("2026-10-20T19:00:00.000Z", "Boston Celtics", "Detroit Pistons")],
  },
  WNBA: {
    fetchedAt: "2026-09-12T22:43:26.240Z",
    events: [ev("2026-09-17T23:30:00.000Z", "Connecticut Sun", "Atlanta Dream")],
  },
  NFL: { fetchedAt: null, events: [] },
};

function septemberSlate(): SlateEntities {
  return buildSlateEntities({
    odds: ((lg: string) => SEPTEMBER_BOARD[lg] ?? { fetchedAt: null, events: [] }) as never,
    props: (() => ({ available: false, topProps: [] })) as never,
    hrLikes: (() => []) as never,
    now: NOW,
  });
}

describe("looksScheduleLevel", () => {
  const YES = [
    "What games are on today?",
    "what games are on tonight",
    "which games are on today?",
    "what's on tonight",
    "what is on today?",
    "who's playing today",
    "who is playing tonight?",
    "who plays tonight",
    "what's tonight's slate look like",
    "show me today's slate",
    "what's the schedule",
    "any games today?",
    "are there any games tonight",
    "what's the card tonight",
    "today's games please",
    "schedule for tonight",
  ];
  for (const q of YES) {
    it(`treats "${q}" as a schedule question`, () => {
      expect(looksScheduleLevel(q)).toBe(true);
    });
  }

  const NO = [
    "what's CLV?",
    "why do you pass so much?",
    "what's your bankroll rule?",
    "how much should I bet on the Braves?",
    "what is expected value",
  ];
  for (const q of NO) {
    it(`does NOT treat "${q}" as a schedule question`, () => {
      expect(looksScheduleLevel(q)).toBe(false);
    });
  }
});

describe("classifyDeterministic — schedule intent", () => {
  it("REGRESSION: 'What games are on today?' routes to Lane B schedule, NOT the ambiguous tiebreaker", () => {
    const d = classifyDeterministic("What games are on today?", septemberSlate());
    expect(d.lane).toBe("B");
    if (d.lane === "B" && !("mode" in d)) {
      expect(d.reason).toBe("schedule-level");
      expect(d.intent).toBe("schedule");
      // The league with games TODAY — never the October NBA board.
      expect(d.league).toBe("MLB");
    }
    expect("ambiguous" in d).toBe(false);
  });

  it("'what's on tonight' and 'who's playing today' route the same way", () => {
    for (const q of ["what's on tonight", "who's playing today"]) {
      const d = classifyDeterministic(q, septemberSlate());
      expect(d.lane).toBe("B");
      if (d.lane === "B" && !("mode" in d)) expect(d.intent).toBe("schedule");
    }
  });

  it("a BEST-PLAY question still wins over the schedule read", () => {
    // "what do you like tonight?" is slate-level, not a calendar question.
    expect(looksSlateLevel("what do you like tonight?")).toBe(true);
    const d = classifyDeterministic("what do you like tonight?", septemberSlate());
    if (d.lane === "B" && !("mode" in d)) {
      expect(d.reason).toBe("slate-level");
      expect(d.intent).toBeUndefined();
    }
  });

  it("a NAMED matchup still beats the schedule read", () => {
    const d = classifyDeterministic(
      "are the Braves playing today and what's the line",
      septemberSlate()
    );
    if (d.lane === "B" && !("mode" in d)) {
      expect(d.reason).toContain("entity-match");
      expect(d.intent).toBeUndefined();
    }
  });

  it("an NFL schedule question stays on the receipts lane", () => {
    const d = classifyDeterministic("what NFL games are on today?", septemberSlate());
    expect(d.lane).toBe("R");
  });

  it("a schedule question still routes when EVERY league is dark", () => {
    const dark = buildSlateEntities({
      odds: (() => ({ fetchedAt: null, events: [] })) as never,
      props: (() => ({ available: false, topProps: [] })) as never,
      hrLikes: (() => []) as never,
      now: NOW,
    });
    const d = classifyDeterministic("what games are on today?", dark);
    // "nothing is on" is the correct, checkable answer to a calendar question.
    expect(d.lane).toBe("B");
    if (d.lane === "B" && !("mode" in d)) expect(d.intent).toBe("schedule");
  });
});

describe("the slate index is date-aware", () => {
  it("REGRESSION: gamesToday counts ONLY games starting today (ET)", () => {
    const ent = septemberSlate();
    expect(ent.gamesToday.get("MLB")).toBe(1); // tomorrow's Mets/Yankees excluded
    expect(ent.gamesToday.get("NBA")).toBe(0); // October 20 is not tonight
    expect(ent.gamesToday.get("WNBA")).toBe(0); // September 17 is not tonight
  });

  it("still INDEXES future-dated teams so a named matchup routes to a real read", () => {
    // Entity routing is deliberately broader than the today filter: a user who
    // names the Celtics deserves a grounded answer about the game that exists.
    const ent = septemberSlate();
    expect(ent.teams.get("boston celtics")).toBe("NBA");
  });

  it("primaryLeagueWithGames / leaguesWithGamesToday read gamesToday, not teams", () => {
    const ent = septemberSlate();
    expect(primaryLeagueWithGames(ent)).toBe("MLB");
    expect(leaguesWithGamesToday(ent)).toEqual(["MLB"]);
  });
});

// ─── The substitution guard (sharp.ts) ───────────────────────────────────────

const openSpend = async () => ({ open: true as const, tokensUsed: 0, modelCalls: 0 });

function laneBStub() {
  const runner = vi.fn().mockResolvedValue({
    reply: "Nothing on tonight's board clears my number.",
    toolsUsed: ["get_board_edges"],
    toolResultTexts: ["{}"],
    iterations: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usageTokens: 10,
  });
  return runner;
}

describe("the tiebreaker may not send a turn to a DARK board", () => {
  it("REGRESSION: a tiebreaker answering NBA on a night with no NBA games is substituted to MLB", async () => {
    const runner = laneBStub();
    const res = await answer("should I bet the over?", [], {
      slate: septemberSlate(),
      spendCheck: openSpend as never,
      laneBRunner: runner as never,
      // The measured wrong answer: NBA, on 2026-09-12.
      ambiguityClassifier: (async () => ({ lane: "B" as const, league: "NBA" as const })) as never,
      client: { messages: { create: vi.fn() } } as never,
    });
    expect(res.lane).toBe("B");
    expect(runner).toHaveBeenCalledTimes(1);
    // First positional arg of runLaneB is the league.
    expect(runner.mock.calls[0]![0]).toBe("MLB");
  });

  it("a tiebreaker answering a LIVE league is honoured unchanged", async () => {
    const runner = laneBStub();
    await answer("should I bet the over?", [], {
      slate: septemberSlate(),
      spendCheck: openSpend as never,
      laneBRunner: runner as never,
      ambiguityClassifier: (async () => ({ lane: "B" as const, league: "MLB" as const })) as never,
      client: { messages: { create: vi.fn() } } as never,
    });
    expect(runner.mock.calls[0]![0]).toBe("MLB");
  });

  it("when NOTHING is on anywhere, the turn drops to Lane A instead of surveying an empty board", async () => {
    const runner = laneBStub();
    const dark = buildSlateEntities({
      odds: (() => ({ fetchedAt: null, events: [] })) as never,
      props: (() => ({ available: false, topProps: [] })) as never,
      hrLikes: (() => []) as never,
      now: NOW,
    });
    const create = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Name a matchup and I'll take a look." }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const res = await answer("should I bet the over?", [], {
      slate: dark,
      spendCheck: openSpend as never,
      laneBRunner: runner as never,
      ambiguityClassifier: (async () => ({ lane: "B" as const, league: "NBA" as const })) as never,
      client: { messages: { create } } as never,
    });
    expect(res.lane).toBe("A");
    expect(runner).not.toHaveBeenCalled();
  });
});

// ─── The Lane B prompt states today's date as ground truth ───────────────────

import { buildLaneBSystemPrompt } from "../persona";

describe("today's date is ground truth in the Lane B prompt", () => {
  it("REGRESSION: every scope/mode states the REAL date, in ET, from the server clock", () => {
    // MEASURED 2026-09-12: asked for the best play, the desk correctly reported
    // that the model snapshot was 96 hours old and then wrote "Tonight is
    // September 9" — it had read today's date off the STALE FILE. The grounding
    // guard exempts dates by design, so a wrong date ships unchallenged.
    for (const scope of ["matchup", "slate", "schedule"] as const) {
      for (const mode of ["bets", "stats"] as const) {
        const p = buildLaneBSystemPrompt("MLB", scope, mode, NOW);
        expect(p).toContain("TODAY IS Saturday, September 12, 2026");
        expect(p).toContain("NEVER infer today's date from a snapshot's timestamp");
      }
    }
  });

  it("uses the ET calendar day, not UTC", () => {
    // 2026-09-13T02:00Z is 10:00 PM ET on September 12.
    const p = buildLaneBSystemPrompt("MLB", "slate", "bets", new Date("2026-09-13T02:00:00.000Z"));
    expect(p).toContain("September 12, 2026");
  });

  it("is DAY-resolution only — a clock in the cached system block would bust the prompt cache every turn", () => {
    const a = buildLaneBSystemPrompt("MLB", "slate", "bets", new Date("2026-09-12T23:00:00.000Z"));
    const b = buildLaneBSystemPrompt("MLB", "slate", "bets", new Date("2026-09-13T01:30:00.000Z"));
    expect(a).toBe(b);
  });
});

describe("the schedule prompt tells the model to read, not to compute", () => {
  it("names get_todays_slate first and forbids timezone math", () => {
    const p = buildLaneBSystemPrompt("MLB", "schedule", "bets", NOW);
    expect(p).toContain("CALL get_todays_slate FIRST");
    expect(p).toContain("Do NOT do timezone arithmetic");
    // Dark leagues are part of the answer, not an omission.
    expect(p).toContain("nextSlateDateEt");
    // NFL stays on the receipts lane.
    expect(p).toContain("SCHEDULE ONLY");
  });

  it("the MATCHUP prompt warns that a team can appear on the board twice", () => {
    const p = buildLaneBSystemPrompt("MLB", "matchup", "bets", NOW);
    expect(p).toContain("WHICH GAME, EXACTLY");
    expect(p).toContain("commenceTime");
    expect(p).toContain("get_todays_slate");
  });

  it("the BETS prompt says a price alone is a real answer", () => {
    const p = buildLaneBSystemPrompt("MLB", "matchup", "bets", NOW);
    expect(p).toContain("A PRICE IS A READ");
    expect(p).toContain("SAY WHAT IS MISSING, WITH ITS DATE");
    expect(p).toContain("PROPS, WHEN THE BOARD IS EMPTY");
  });
});
