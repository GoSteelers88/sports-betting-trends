// THE SMUGGLE TESTS — the negative controls the systems-reviewer proved red.
//
// Round 1 of this fix widened TEXT_VALUE_KEYS to let the desk quote its own
// staleness banner ("the model file is 94 hours old"). The mechanism chosen —
// harvesting every number out of `dataWarning`, `rule`, `reasoning` and `notes`
// into the context-free `quoted` bucket — bought that one honest sentence at the
// price of the guard itself.
//
// `get_dream_memory` returns the dream agent's RULE PROSE: LLM-written, long,
// and dense with percentages. It is in `toolsUsed` on 11 of 17 logged Lane B
// turns. Its four COMMITTED seeds alone contribute 24 numeric tokens, 9 of them
// percents (3, 3, 18, 90, 14.6, 15.1, 2.4, 20, 20) — production adds every
// nightly rule on top. A "quoted" bucket is context-free: a number is real if it
// appears ANYWHERE in ANY payload this turn. So a fabricated "20% edge tonight"
// grounded off a parlay rule's "20% hold", and shipped as `laneB_grounded`.
//
// These tests are the frozen anchor on the narrower fix: an age phrase is
// exempted in the REPLY (it adds nothing to the haystack), and memory prose
// contributes ONLY to the record bucket, which grounds a claim solely when the
// reply writes it in N-M form.

import { describe, it, expect } from "vitest";
import { checkGrounding } from "../grounding";
import { PARLAY_LEARNINGS } from "@/lib/agent/memory";

// get_dream_memory's real payload shape (tools/index.ts:1018-1027), carrying the
// four committed seeds verbatim.
const DREAM_MEMORY = JSON.stringify({
  activeRules: PARLAY_LEARNINGS.map((l, i) => ({
    id: i + 1,
    type: "parlay-learning",
    scope: "MLB",
    rule: l.rule,
    reasoning: l.reasoning,
    weight: l.weight,
  })),
  latestDreamRun: null,
  note: "Rules with weight ≥ 0.5 are HARD GUARDRAILS.",
});

// Tonight's real Braves/Phillies row, as get_odds returns it.
const ODDS = JSON.stringify({
  fetchedAt: "2026-09-12T22:43:46.264Z",
  events: [
    {
      commenceTime: "2026-09-12T23:16:00.000Z",
      homeTeam: "Atlanta Braves",
      awayTeam: "Philadelphia Phillies",
      consensus: {
        home: { american: -134, impliedProb: 0.5726 },
        away: { american: 116, impliedProb: 0.463 },
        total: { line: 8.5, overPrice: -132, underPrice: 108 },
      },
    },
  ],
});

const STALE_BOARD = JSON.stringify({
  generatedAt: "2026-09-09T00:38:33.098Z",
  edges: [],
  note: "No games could be joined between the odds feed and the model.",
  dataWarning:
    "DATA WARNING: mlb-model-output.json is 94.2h old (stale > 6h). Numbers may not reflect the current slate — treat with caution and prefer skipping rather than picking on stale data.",
});

describe("MUST 1 — dream-memory prose must not ground a fabricated edge", () => {
  // Every one of these was REJECTED before the round-1 change and GROUNDED
  // after it. The numbers are lifted from the seeds: "20% hold", "−90% EV",
  // "−18%", "15.1% expected", "2.4%".
  const SMUGGLED = [
    "Braves are a 20% edge tonight, hammer it.",
    "The model has the Braves at 90% tonight.",
    "Clean 15.1% edge on the Phillies here.",
    "That is an 18% edge, bet it big.",
    "Only a 2.4% edge, pass.",
    "The model sits at 14.6% over the market.",
  ];
  for (const reply of SMUGGLED) {
    it(`REJECTS "${reply}"`, () => {
      const v = checkGrounding(reply, [ODDS, DREAM_MEMORY]);
      expect(v.grounded).toBe(false);
    });
  }

  it("a sub-1 decimal probability cannot borrow a memory percent either", () => {
    // "0.90" routes to the percent path (×100) and used to land on "−90% EV".
    const v = checkGrounding("The model has them at 0.90 to win.", [ODDS, DREAM_MEMORY]);
    expect(v.grounded).toBe(false);
  });

  it("a fabricated PRICE cannot borrow a memory integer", () => {
    const v = checkGrounding("Take the Braves at -190.", [ODDS, DREAM_MEMORY]);
    expect(v.grounded).toBe(false);
    expect(v.ungrounded).toContain("-190");
  });

  it("KEEPS what the loosening was for: a memory rule's RECORD still quotes", () => {
    // The record bucket grounds only a claim the reply writes in N-M form.
    const memory = JSON.stringify({
      activeRules: [
        {
          id: 30,
          rule: "Lean NYK moneyline at -130 or better; the desk is 9-2 on it.",
          reasoning: "Small sample, but the net-rating gap has held.",
          weight: 0.6,
        },
      ],
    });
    expect(checkGrounding("My own book has me 9-2 on that side.", [memory]).grounded).toBe(true);
    // …and a record that is NOT in the prose still fails.
    expect(checkGrounding("My own book has me 14-1 on that side.", [memory]).grounded).toBe(false);
  });

  it("a bare integer cannot borrow a memory record column", () => {
    const memory = JSON.stringify({
      activeRules: [{ id: 1, rule: "The desk is 9-2 on that side.", weight: 0.6 }],
    });
    // "lay the 9" is not an N-M form, so the record bucket must not back it.
    expect(checkGrounding("Just lay the 9 and move on.", [memory]).grounded).toBe(false);
  });
});

describe("MUST 1 — a staleness AGE is exempt in the reply, not harvested into the haystack", () => {
  it("KEEPS the fix: 'the model file is 94 hours old' grounds", () => {
    const v = checkGrounding(
      "Straight with you: the model file is 94 hours old, so there's no priceable edge here.",
      [STALE_BOARD]
    );
    expect(v.grounded).toBe(true);
  });

  it("accepts the spellings the desk actually uses", () => {
    for (const phrase of [
      "the board is 94.2 hours old",
      "that file is 94h old",
      "roughly 96 hrs old",
      "anything past 6h I treat as stale",
      "the model is 4 days old",
    ]) {
      expect(checkGrounding(`No bet — ${phrase}.`, [STALE_BOARD]).grounded).toBe(true);
    }
  });

  it("REGRESSION: an age no longer smuggles a TOTAL or a PRICE into the reply", () => {
    // The reviewer's measured collisions: a dataWarning age of 8.5h grounded
    // "over 8.5"; 45.5h grounded "over 45.5"; 94.2h grounded "94.2 innings".
    const warn8 = JSON.stringify({
      dataWarning: "DATA WARNING: latest-odds-api-baseball_mlb.json is 8.5h old (stale > 6h).",
    });
    expect(checkGrounding("Over 8.5 is the play.", [warn8]).grounded).toBe(false);
    expect(checkGrounding("He's thrown 94.2 innings.", [STALE_BOARD]).grounded).toBe(false);
  });

  it("an age phrase exemption does NOT wave through a bare number", () => {
    // "94" with no unit is still a claim.
    expect(checkGrounding("The model has them at 94 tonight.", [STALE_BOARD]).grounded).toBe(false);
  });
});

describe("SHOULD 5 — `confidence` carries TWO scales, sometimes in one payload", () => {
  // get_trend_summary's real shape, measured in data/processed/latest-summary.json:
  // leagues[].confidence is a 0–1 fraction (0.35) while bestBets[].confidence is
  // 0–100 (61, 56, 53) — the SAME KEY, the SAME TOOL, the SAME payload. Round 1
  // declared the key already-percent for every producer, which fixed a truthful
  // "95%" off get_player_props and broke a truthful "35%" here.
  const summary = [
    JSON.stringify({
      league: "MLB",
      confidence: 0.35,
      bestBets: [
        { selection: "Atlanta Braves", confidence: 61 },
        { selection: "Chicago Cubs", confidence: 56 },
      ],
    }),
  ];

  it("a 0–100 confidence grounds ('61% confidence')", () => {
    expect(checkGrounding("That one's a 61% confidence read.", summary).grounded).toBe(true);
  });

  it("a 0–1 confidence grounds too ('35% confidence')", () => {
    expect(checkGrounding("League confidence sits at 35%.", summary).grounded).toBe(true);
  });

  it("both scales in ONE payload ground in one reply", () => {
    const v = checkGrounding(
      "League read is 35% confidence; the Braves best bet is tagged 61%.",
      summary
    );
    expect(v.grounded).toBe(true);
  });

  it("a figure matching NEITHER scale still fails", () => {
    const v = checkGrounding("That's an 88% confidence read.", summary);
    expect(v.grounded).toBe(false);
    expect(v.ungrounded).toContain("88%");
  });

  it("REGRESSION: the 0-100 props confidence still grounds (the round-1 fix holds)", () => {
    const props = [JSON.stringify({ topProps: [{ player: "X", confidence: 95 }] })];
    expect(checkGrounding("The model's on it at 95% confidence.", props).grounded).toBe(true);
  });
});

describe("the whole-number doctrine exemption may not justify a BET", () => {
  const odds = [JSON.stringify({ events: [{ consensus: { home: { american: -134 } } }] })];

  it("KEEPS the doctrine phrase: 'my 6% floor' needs no backing", () => {
    expect(checkGrounding("Nothing clears my 6% floor tonight.", odds).grounded).toBe(true);
  });

  it("REGRESSION: a FRACTIONAL percent no longer rides the count exemption", () => {
    // "6.4%" truncated to "6" and sailed through — and 6.4% is ABOVE the edge
    // floor, i.e. a fabricated number that justifies a bet.
    const v = checkGrounding("That's a 6.4% edge, it's a play.", odds);
    expect(v.grounded).toBe(false);
    expect(v.ungrounded).toContain("6.4%");
  });

  it("and neither does a small fabricated edge used to justify a pass", () => {
    expect(checkGrounding("Only a 2.4% edge, pass.", odds).grounded).toBe(false);
  });

  it("non-percent prose counts are untouched ('1 unit', '2 plays')", () => {
    expect(checkGrounding("One play, 1 unit. That's it.", odds).grounded).toBe(true);
  });
});
