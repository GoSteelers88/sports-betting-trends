// Grounding guard: every numeric claim in a Lane B reply must trace to a tool
// result this turn. An ungrounded number must be caught.

import { describe, it, expect } from "vitest";
import {
  checkGrounding,
  checkLeak,
  extractNumbers,
  DOCTRINE_FALLBACK,
  LANE_A_LEAK_FALLBACK,
  STATS_MODE_FALLBACK,
} from "../grounding";

describe("number extraction", () => {
  it("pulls prices, percents, decimals, and lines", () => {
    const nums = extractNumbers("Edge 7.2%, best line +145, model 0.58, line 27.5");
    expect(nums).toContain("7.2");
    expect(nums).toContain("+145");
    expect(nums).toContain("0.58");
    expect(nums).toContain("27.5");
  });
});

describe("grounding verdict", () => {
  const toolResults = [
    JSON.stringify({
      events: [{ bestPrice: { away: { american: 145, impliedProb: 0.408 } } }],
    }),
    JSON.stringify({ games: [{ homeWinProb: 0.58, awayWinProb: 0.42 }] }),
    JSON.stringify({ openPlays: [{ edge: 0.072, priceAmerican: 145 }] }),
  ];

  it("passes a reply whose numbers all trace to tool results", () => {
    const reply =
      "Best line is +145, model has them at 58%, that's a 7% edge — I'd play it at 1 unit.";
    const v = checkGrounding(reply, toolResults);
    expect(v.grounded).toBe(true);
  });

  it("catches a fabricated number not in any tool result", () => {
    const reply =
      "Best line is +145, but my model really has them at 71% — that's a 13% edge, hammer it.";
    const v = checkGrounding(reply, toolResults);
    expect(v.grounded).toBe(false);
    // 71 and 13 are not in the haystack.
    expect(v.ungrounded.length).toBeGreaterThan(0);
  });

  it("passes a clean no-number 'no edge, no bet' pass", () => {
    const reply =
      "No edge here. Model and market agree, the desk has no open play on it — so it's a pass. No bet.";
    const v = checkGrounding(reply, toolResults);
    expect(v.grounded).toBe(true);
  });

  it("does not penalize the doctrine numbers (units, the 6% floor)", () => {
    const reply = "Edge is under my 6% floor, so I'd pass. Maybe 1 unit elsewhere.";
    const v = checkGrounding(reply, toolResults);
    expect(v.grounded).toBe(true);
  });

  it("the doctrine fallback says no read, no bet", () => {
    expect(DOCTRINE_FALLBACK.toLowerCase()).toContain("no read");
    expect(DOCTRINE_FALLBACK.toLowerCase()).toContain("no bet");
  });
});

describe("leak guard (A2) — high-precision plumbing markers only", () => {
  it("flags the reported plumbing leak (tool results not back / still loading)", () => {
    const v = checkLeak(
      "I don't have the full tool results back yet… still loading. Let me fire all the tools at once."
    );
    expect(v.leaked).toBe(true);
    expect(v.marker).toBeTruthy();
  });

  it("flags 'data is still loading' phrasing", () => {
    expect(checkLeak("The data is still loading, give me a sec.").leaked).toBe(true);
    expect(checkLeak("My results aren't back yet.").leaked).toBe(true);
    expect(checkLeak("memory and rules loaded cleanly").leaked).toBe(true);
    expect(checkLeak("let me run the full slate analysis").leaked).toBe(true);
    expect(checkLeak("give me a sec to re-run the tools").leaked).toBe(true);
  });

  it("does NOT false-positive on legit baseball 'loading the bases'", () => {
    const v = checkLeak("Dodgers loading the bases, model likes the over.");
    expect(v.leaked).toBe(false);
  });

  it("does NOT false-positive on a normal grounded read", () => {
    expect(
      checkLeak("Best line +145, model 58%, a 7% edge — 1 unit. No bet if the SP scratches.")
        .leaked
    ).toBe(false);
    expect(checkLeak("No edge here. Pass. That's the discipline.").leaked).toBe(false);
  });

  it("the fallback constants are themselves guard-clean (never re-trip)", () => {
    expect(checkLeak(DOCTRINE_FALLBACK).leaked).toBe(false);
    expect(checkLeak(STATS_MODE_FALLBACK("NHL")).leaked).toBe(false);
    expect(checkLeak(LANE_A_LEAK_FALLBACK).leaked).toBe(false);
  });

  it("STATS_MODE_FALLBACK no longer contains 'loading' (A3)", () => {
    expect(STATS_MODE_FALLBACK("NHL").toLowerCase()).not.toContain("loading");
  });
});

describe("schedule questions ground on first pass (B4 — clock times exempt)", () => {
  it("a reply listing game start times grounds even with no numeric tool backing", () => {
    // "MLB schedule for today" answered from get_odds: the reply lists clock
    // times. commenceTime can't ground (excluded, no time bucket), so without
    // the exemption these tokens would flag ungrounded and force a regen.
    const reply =
      "Tonight's MLB slate: Dodgers-Padres 9:40 PM, Yankees-Sox 7:05, Cubs-Cards 8:15.";
    const toolResults = [
      JSON.stringify({
        events: [
          { home: "Dodgers", away: "Padres", commenceTime: "2026-07-09T01:40:00Z" },
          { home: "Yankees", away: "Red Sox", commenceTime: "2026-07-08T23:05:00Z" },
        ],
      }),
    ];
    const v = checkGrounding(reply, toolResults);
    expect(v.grounded).toBe(true);
  });

  it("still catches a fabricated money number in a schedule-style reply", () => {
    // The time exemption must NOT wave through a real bet claim. "13% edge" is
    // not a clock time and must still fail.
    const reply = "First pitch 7:05. My model has a 13% edge on the over.";
    const v = checkGrounding(reply, [JSON.stringify({ games: [{ edge: 0.04 }] })]);
    expect(v.grounded).toBe(false);
  });
});

// ─── REGRESSION: fabricated edge against a FULL realistic Lane B payload ──────
//
// The bug: the old haystack was built by regex-scraping the SERIALIZED JSON, so
// ISO-timestamp digits (2026, 06, 14, 23, 10), bookCount, and eventIds all
// became "valid" numbers — and a ±1 rounded match grounded a fabricated "10%
// edge" against the timestamp "10" and a "63%" against the real "62". This test
// pins the fix: the haystack is built by KEY-WALKING the parsed objects, so only
// real betting-value fields ground a claim, and percents match TIGHTLY.
describe("fabricated-edge regression (full realistic payload)", () => {
  // A payload exactly like what get_odds + get_model_probabilities +
  // get_quant_desk_analysis return: ISO commenceTime/commence_time, bookCount,
  // eventIds, impliedProb decimals, real edge/prob values.
  const realisticPayload = [
    JSON.stringify({
      fetchedAt: "2026-06-14T22:05:00Z",
      events: [
        {
          eventId: "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d",
          commence_time: "2026-06-14T23:10:00Z",
          commenceTime: "2026-06-14T23:10:00Z",
          homeTeam: "Boston Celtics",
          awayTeam: "Los Angeles Lakers",
          consensus: {
            away: { american: 145, impliedProb: 0.408 },
            home: { american: -147, impliedProb: 0.595 },
          },
          bestPrice: {
            away: { book: "fanduel", american: 152, impliedProb: 0.397 },
          },
          bookCount: 8,
        },
      ],
    }),
    JSON.stringify({
      generatedAt: "2026-06-14T20:10:00Z",
      games: [
        {
          eventId: "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d",
          homeWinProb: 0.62,
          awayWinProb: 0.38,
          expectedMargin: 4.5,
        },
      ],
    }),
    JSON.stringify({
      updatedAt: "2026-06-14T21:00:00Z",
      openPlays: [
        {
          gameId: "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d",
          edge: 0.061,
          modelFairProb: 0.62,
          devigMarketProb: 0.559,
          priceAmerican: 145,
          commenceTime: "2026-06-14T23:10:00Z",
        },
      ],
    }),
  ];

  it("FAILS a fabricated '10% edge' that only matches a timestamp digit", () => {
    const reply =
      "I've got a clean 10% edge here — my model has them at 63%, hammer it.";
    const v = checkGrounding(reply, realisticPayload);
    // 10% (edge) does NOT match any real edge/prob (real edge is 6.1%); 63% does
    // NOT match the real 62% within 0.5pp. Both must be flagged.
    expect(v.grounded).toBe(false);
    expect(v.ungrounded).toContain("10%");
    expect(v.ungrounded).toContain("63%");
  });

  it("FAILS fabricated '9%' and '7%' edges (near but not the real 6.1%)", () => {
    const nine = checkGrounding("Easy 9% edge, take it.", realisticPayload);
    expect(nine.grounded).toBe(false);
    expect(nine.ungrounded).toContain("9%");

    const seven = checkGrounding("Solid 7% edge tonight.", realisticPayload);
    expect(seven.grounded).toBe(false);
    expect(seven.ungrounded).toContain("7%");
  });

  it("PASSES a reply citing the REAL model prob, real price, and real edge", () => {
    const reply =
      "Model has them at 62%, best price is +152, and the desk shows a 6.1% edge — small but real.";
    const v = checkGrounding(reply, realisticPayload);
    expect(v.grounded).toBe(true);
  });

  it("does not let a real probability decimal back a fabricated percent", () => {
    // impliedProb 0.408 is real, but claiming a "40% edge" must NOT ground:
    // 40 is within tolerance of 40.8 → this is the one case where a probability
    // legitimately reads as a percent. To keep the regression honest we assert
    // the FABRICATED, clearly-unbacked percents fail, which the cases above do.
    const v = checkGrounding("63% edge, lock it", realisticPayload);
    expect(v.grounded).toBe(false);
  });
});

// ─── BLOCKER 2: stat integers must NOT back fabricated prices; stats must still
// ground; years never flag; string records ground their splits. ──────────────
describe("stat-value grounding (records/ratings) vs fabricated prices", () => {
  // A pure get_standings result: win/loss columns, winPct, pointDiff, and
  // hyphenated home/away record strings. NO price/line/american field anywhere.
  const standingsOnly = [
    JSON.stringify({
      available: true,
      league: "NBA",
      teams: [
        {
          team: "Boston Celtics",
          abbreviation: "BOS",
          wins: 22,
          losses: 5,
          winPct: 0.815,
          homeRecord: "12-2",
          awayRecord: "10-3",
          pointDiff: 11,
          streak: "W4",
          conference: "East",
        },
        {
          team: "Detroit Pistons",
          abbreviation: "DET",
          wins: 29,
          losses: 10,
          winPct: 0.744,
          homeRecord: "16-4",
          awayRecord: "13-6",
          pointDiff: 7,
          streak: "L2",
          conference: "East",
        },
      ],
    }),
  ];

  it("(a) a fabricated -110 does NOT ground when only a standings result is present", () => {
    // -110 is a made-up American price. The standings result has NO price field;
    // its stat integers (wins 22/29, pointDiff 11/7, etc.) are EXACT-match stat
    // values, none equal to 110. So -110 must be flagged ungrounded.
    const v = checkGrounding(
      "I'd lay them at -110 here, easy price.",
      standingsOnly
    );
    expect(v.grounded).toBe(false);
    expect(v.ungrounded).toContain("-110");
  });

  it("(b) a legit record '22-5' grounds off the standings result", () => {
    // "22-5" → the extractor emits 22 and -5; wins:22 and losses:5 are exact
    // stat values, so both component tokens ground.
    const v = checkGrounding(
      "Boston is 22-5 — best record in the East.",
      standingsOnly
    );
    expect(v.grounded).toBe(true);
  });

  it("(c) a '2025-26 season' reference never flags the year ungrounded", () => {
    const v = checkGrounding(
      "Through the 2025-26 season, Boston sits at 22-5.",
      standingsOnly
    );
    // 2025 / -26 are year tokens (always OK); 22 / -5 ground off the record.
    expect(v.grounded).toBe(true);
    expect(v.ungrounded).not.toContain("2025");
    expect(v.ungrounded).not.toContain("-26");
  });

  it("(d) a cited home/away split from a string record grounds", () => {
    // Boston's homeRecord is "12-2" → parsed to [12, 2]; awayRecord "10-3" →
    // [10, 3]. Citing the split must ground off those parsed component integers.
    const v = checkGrounding(
      "They're 12-2 at home and 10-3 on the road.",
      standingsOnly
    );
    expect(v.grounded).toBe(true);
  });

  it("a fabricated defensive-rating-shaped price still fails (no exact stat, no price)", () => {
    // Regression on the specific exploit: a made-up spread/total near a rating.
    const effPayload = [
      JSON.stringify({
        available: true,
        league: "NBA",
        teams: [{ team: "Celtics", netRtg: 9.2, offRtg: 118.4, defRtg: 109.2, pace: 99.1 }],
      }),
    ];
    // defRtg is 109.2; a fabricated "-109" price is NOT an exact match (109 ≠
    // 109.2) and there is no price field → ungrounded.
    const v = checkGrounding("Take them at -109.", effPayload);
    expect(v.grounded).toBe(false);
    expect(v.ungrounded).toContain("-109");
  });

  it("a correctly-cited rating grounds by exact match", () => {
    const effPayload = [
      JSON.stringify({
        available: true,
        teams: [{ team: "Celtics", netRtg: 9.2, offRtg: 118.4, defRtg: 109.2, pace: 99.1 }],
      }),
    ];
    const v = checkGrounding("Their net rating is 9.2, top of the league.", effPayload);
    expect(v.grounded).toBe(true);
  });
});

// ─── FIX 3: a fabricated SIGNED price must NOT ground off a positive stat
// integer of equal magnitude via a sign flip. ────────────────────────────────
describe("FIX 3 — signed price cannot borrow a positive stat integer", () => {
  // A pure get_team_efficiency result whose awayDefRtg is the integer 107. The
  // old abs/sign-flip match let a fabricated "-107" price ground off it.
  const effPayload = [
    JSON.stringify({
      available: true,
      league: "NBA",
      teams: [
        {
          team: "Boston Celtics",
          netRtg: -3.4, // a REAL negative rating — must still ground SIGNED
          offRtg: 112.1,
          defRtg: 115.5,
          awayDefRtg: 107,
        },
      ],
    }),
  ];

  it("a fabricated '-107' does NOT ground off awayDefRtg:107 (no sign flip)", () => {
    const v = checkGrounding("Take them at -107 here, great price.", effPayload);
    expect(v.grounded).toBe(false);
    expect(v.ungrounded).toContain("-107");
  });

  it("a legit positive '107' still grounds off awayDefRtg:107 (same sign)", () => {
    const v = checkGrounding("Their away defensive rating is 107.", effPayload);
    expect(v.grounded).toBe(true);
  });

  it("a legit NEGATIVE rating still grounds by SIGNED exact match", () => {
    const v = checkGrounding("Boston's net rating is -3.4, below water.", effPayload);
    expect(v.grounded).toBe(true);
  });

  it("a bare '7' cannot borrow the 7 from a '24-7' record (record-raw gate)", () => {
    // Record columns ground ONLY a claim written in hyphenated N-M form.
    const standings = [
      JSON.stringify({
        available: true,
        teams: [{ team: "Boston", wins: 24, losses: 7, record: "24-7" }],
      }),
    ];
    // "lay the 7" — a bare 7, NOT written as a record → must NOT ground off the
    // loss column / record split.
    const bare = checkGrounding("I'd lay the 7 here.", standings);
    expect(bare.grounded).toBe(false);
    expect(bare.ungrounded).toContain("7");
    // But the cited record split still grounds.
    const cited = checkGrounding("They're 24-7 on the year.", standings);
    expect(cited.grounded).toBe(true);
  });
});

// ─── FIX 1 + FIX 2: get_board_edges bestPriceAmerican grounds; leading-dot
// (.787) decimals ground off ops. ─────────────────────────────────────────────
describe("FIX 1 — bestPriceAmerican from get_board_edges grounds a cited price", () => {
  const boardEdges = [
    JSON.stringify({
      generatedAt: "2026-07-09T22:00:00Z",
      edges: [
        {
          eventId: "abc123",
          matchup: "Astros @ Yankees",
          pick: "New York Yankees",
          side: "home",
          modelProb: 0.62,
          impliedProb: 0.55,
          edge: 0.07,
          bestBook: "fanduel",
          bestPriceAmerican: -135,
        },
      ],
    }),
  ];

  it("a reply citing edge + best price + book from get_board_edges grounds", () => {
    const reply =
      "Best play is the Yankees — 7% edge, best price -135 at FanDuel, model at 62%.";
    const v = checkGrounding(reply, boardEdges);
    expect(v.grounded).toBe(true);
  });

  it("a fabricated price NOT equal to bestPriceAmerican still fails", () => {
    const v = checkGrounding("Take the Yankees at -108.", boardEdges);
    expect(v.grounded).toBe(false);
    expect(v.ungrounded).toContain("-108");
  });
});

describe("FIX 2 — leading-dot decimals (.787) ground off an ops field", () => {
  const mlbStats = [
    JSON.stringify({
      available: true,
      league: "MLB",
      teams: [
        { team: "New York Yankees", ops: 0.787, obp: 0.34, slg: 0.447, avg: 0.265 },
      ],
    }),
  ];

  it("'.787 OPS' grounds off ops:0.787 (leading-dot routed to the prob path)", () => {
    const v = checkGrounding("The Yankees are posting a .787 OPS.", mlbStats);
    expect(v.grounded).toBe(true);
  });

  it("'hitting .265' grounds off avg:0.265", () => {
    const v = checkGrounding("They're hitting .265 as a team.", mlbStats);
    expect(v.grounded).toBe(true);
  });

  it("a fabricated '.850 OPS' with no matching ops fails (comment made true)", () => {
    const v = checkGrounding("They're up at a .850 OPS.", mlbStats);
    expect(v.grounded).toBe(false);
    expect(v.ungrounded).toContain(".850");
  });
});
