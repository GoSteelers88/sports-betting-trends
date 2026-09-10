// The receipts tool menu: what it publishes, what it STRIPS, and how it
// degrades. These run against the REAL committed files, so a change to a
// publisher's output surfaces here rather than in production.

import { describe, it, expect } from "vitest";
import {
  nflBoard,
  nflLedger,
  nflMarket,
  nflResearch,
  nflInjuries,
  nflStandings,
  NFL_TOOL_DEFINITIONS,
  NFL_TOOL_NAMES,
} from "../tools";
import { standingsSeasonGate } from "../data";
import { checkStakeTalk } from "../validators";
import { checkGrounding } from "../../grounding";

describe("the strip rules — enforced by the tool, not by the prompt", () => {
  it("get_nfl_board NEVER emits stakeFraction or evPct", () => {
    const payload = JSON.stringify(nflBoard({}));
    expect(payload).not.toContain("stakeFraction");
    expect(payload).not.toContain("evPct");
    // …while still carrying the fields a truthful report needs.
    expect(payload).toContain("entryPriceAmerican");
    expect(payload).toContain("passReason");
    expect(payload).toContain("calibratedConfidence");
  });

  it("get_nfl_market DOES emit fairHomeProb / fairAwayProb (operator decision 2026-09-09)", () => {
    // These were stripped so the model could not compute an edge on a game the
    // board never registered. That also made it impossible to answer "what do
    // you like" or to build a parlay, which is the product the operator wants.
    // The ledger's integrity does not depend on withholding them — it depends
    // on a live read never being written anywhere or labelled pre-registered.
    const payload = JSON.stringify(nflMarket({}));
    expect(payload).toContain("fairHomeProb");
    expect(payload).toContain("fairAwayProb");
    // Prices still survive.
    expect(payload).toContain("homeMoneylineAmerican");
    expect(payload).toContain("totalPoint");
    // And the payload still tells the model what kind of number it is holding.
    expect(payload).toMatch(/LIVE read|not a pre-registered|CLV ledger/i);
  });

  it("get_nfl_board STILL never emits stakeFraction or evPct", () => {
    // Unchanged by the 09-09 loosening: stake is never public, and evPct is a
    // fraction on the NFL board while the props board writes it as a percent.
    const payload = JSON.stringify(nflBoard({}));
    expect(payload).not.toContain("stakeFraction");
    expect(payload).not.toContain("evPct");
  });

  it("no tool emits a URL", () => {
    const all = [
      nflBoard({}),
      nflLedger(),
      nflMarket({}),
      nflResearch(),
      nflInjuries({ limit: 5 }),
      nflStandings(),
    ].map((x) => JSON.stringify(x));
    for (const payload of all) {
      expect(payload).not.toMatch(/https?:\/\//);
    }
  });
});

describe("get_nfl_board", () => {
  it("reads the committed Week 1 receipt with its roles intact", () => {
    const res = nflBoard({ season: 2026, week: 1 });
    expect(res.available).toBe(true);
    if (!res.available) return;
    const b = res.boards[0]!;
    expect(b.season).toBe(2026);
    expect(b.week).toBe(1);
    expect(b.playCount).toBe(2);
    expect(b.passCount).toBe(46);
    // The parlay slot is published as null — the fact behind "there is no NFL
    // parlay product" is data, not prompt text.
    expect(b.parlay).toBeNull();
    const nyj = b.legs.find((l) => l.selection === "NYJ ML");
    expect(nyj?.entryPriceAmerican).toBe(106);
    expect(nyj?.book).toBe("fanduel");
    expect(nyj?.role).toBe("play");
  });

  it("returns available:false with the published weeks for an unpublished week", () => {
    const res = nflBoard({ season: 2026, week: 14 });
    expect(res.available).toBe(false);
    if (res.available) return;
    expect(res.reason).toMatch(/no board published/i);
    expect(res.boards).toEqual([]);
  });
});

describe("get_nfl_ledger", () => {
  it("reports statuses, the notary hashes, and the frozen verdict floor", () => {
    const res = nflLedger();
    expect(res.available).toBe(true);
    if (!res.available) return;
    expect(res.rowCount).toBe(50);
    expect(res.verdictMinN).toBe(150);
    expect(res.insufficientN).toBe(true);
    expect(res.weeksPublished[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("get_nfl_research — a figure can never travel without its caveat", () => {
  const res = nflResearch();
  it("carries the headline figures", () => {
    expect(res.available).toBe(true);
    if (!res.available) return;
    expect(res.parlays.flatYieldPct).toBe(38.96);
    expect(res.moneyline.roiPct).toBe(8.21);
    expect(res.parlays.winRatePct).toBe(18.8);
    expect(res.props.sampleSize).toBe(1079);
    expect(res.parlays.sampleSize).toBe(547);
  });
  it("attaches the in-sample span to EVERY block, with the right span each", () => {
    if (!res.available) return;
    // The props/parlays logs span 2019–2024; the moneyline book is wider.
    expect(res.props.seasonSpan).toBe("2019–2024");
    expect(res.parlays.seasonSpan).toBe("2019–2024");
    expect(res.moneyline.seasonSpan).toBe("2015–2024");
  });
  it("attaches the NEGATIVE holdout caveat to every block", () => {
    if (!res.available) return;
    for (const block of [res.moneyline, res.props, res.parlays]) {
      expect(block.caveat).toMatch(/NEGATIVE/i);
      expect(block.inSample).toBe(true);
    }
    expect(res.holdout.result).toBe("negative");
    expect(res.parlays.upperBound).toBe(true);
  });
  it("states the NO-CLV reason correctly per block — they are NOT the same", () => {
    if (!res.available) return;
    // The two priced blocks bank no CLV because they were graded against
    // approximate CLOSING LINES. The props block has no CLV for a different
    // reason entirely: it was graded against BOX SCORES, so there was never a
    // price behind it. Collapsing the two would put an ROI where none exists.
    expect(res.moneyline.caveat).toMatch(/closing lines/i);
    expect(res.parlays.caveat).toMatch(/closing lines/i);
    expect(res.props.caveat).toMatch(/box scores/i);
    expect(res.props.caveat).toMatch(/NO ROI and NO CLV/i);
  });
  it("offers the props block as a HIT RATE, with no ROI and no CLV", () => {
    if (!res.available) return;
    const propsJson = JSON.stringify(res.props);
    expect(propsJson).not.toMatch(/"roiPct"/);
    expect(propsJson).not.toMatch(/"clv/i);
    expect(res.props.hitRatePct).toBeGreaterThan(0);
  });
});

describe("get_nfl_standings — the season gate", () => {
  it("gates OUT the committed file, which is last season's final table", () => {
    // standings-nfl.json says "New England Patriots 14-3": 17 games played
    // against a week-1 board. available:false, not a warning string beside
    // real-looking rows — a warning the model can read past is one it will.
    const res = nflStandings();
    expect(res.available).toBe(false);
    expect(res.teams).toEqual([]);
    if (!res.available) expect(res.reason).toMatch(/PRIOR season|completed season/i);
  });

  it("the gate is content-derived, not mtime-derived", () => {
    const wk1 = [{ team: "A", wins: 1, losses: 0 }];
    const finished = [{ team: "A", wins: 14, losses: 3 }];
    expect(standingsSeasonGate(wk1, 1).current).toBe(true);
    expect(standingsSeasonGate(finished, 1).current).toBe(false);
    expect(standingsSeasonGate(finished, 17).current).toBe(true);
    // No board to date the season against: a completed 17-game season still
    // gates out rather than failing open.
    expect(standingsSeasonGate(finished, null).current).toBe(false);
    expect(standingsSeasonGate(null, 1).current).toBe(false);
    expect(standingsSeasonGate([], 1).current).toBe(false);
  });
});

describe("get_nfl_injuries", () => {
  it("reads the wire and filters by team", () => {
    const all = nflInjuries({ limit: 5 });
    expect(all.available).toBe(true);
    expect(all.players.length).toBeLessThanOrEqual(5);
    const jets = nflInjuries({ team: "Jets", limit: 50 });
    if (jets.available && jets.players.length > 0) {
      for (const p of jets.players) expect(p.team.toLowerCase()).toContain("jets");
    }
  });
});

describe("degradation — a missing data directory is an ANSWER, never a throw", () => {
  const nowhere = "C:/__no_such_repo_root__";
  it("every tool returns available:false instead of throwing", () => {
    expect(() => nflBoard({}, nowhere)).not.toThrow();
    expect(nflBoard({}, nowhere).available).toBe(false);
    expect(nflLedger(nowhere).available).toBe(false);
    expect(nflMarket({}, nowhere).available).toBe(false);
    expect(nflResearch(nowhere).available).toBe(false);
    expect(nflInjuries({}, nowhere).available).toBe(false);
    expect(nflStandings(nowhere).available).toBe(false);
  });
});

describe("tool definitions", () => {
  it("expose exactly the six read-only NFL tools, with schemas", () => {
    expect(NFL_TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([...NFL_TOOL_NAMES].sort());
    for (const t of NFL_TOOL_DEFINITIONS) {
      expect(t.input_schema.type).toBe("object");
      // `description` is optional on Anthropic.Tool; on these it is required in
      // practice, and asserting its presence is part of the point — a tool the
      // model cannot understand is a tool it will misuse.
      expect(t.description).toBeDefined();
      expect(t.description?.length ?? 0).toBeGreaterThan(60);
    }
  });
  it("expose NO tool that could return a fair value for an unregistered game", () => {
    // The structural claim, asserted rather than left in a comment: none of the
    // pick-pipeline tools that CAN produce a model probability or an edge is
    // reachable from this lane. (The word "fair value" does appear — inside
    // get_nfl_market's description, saying it returns none. A substring test on
    // the prose would be testing the prose; the names are what the model can
    // actually call.)
    const names = new Set<string>(NFL_TOOL_NAMES);
    for (const forbidden of [
      "get_model_probabilities",
      "get_board_edges",
      "get_quant_desk_analysis",
      "get_props_board",
      "get_odds",
      "get_prop_projection",
    ]) {
      expect(names.has(forbidden)).toBe(false);
    }
    expect(NFL_TOOL_DEFINITIONS.length).toBe(NFL_TOOL_NAMES.length);
  });
});

// ─── The grounding regression this feature was blocked on ───────────────────

describe("grounding — a truthful board quote must SHIP (it did not, before)", () => {
  const payload = JSON.stringify(nflBoard({ season: 2026, week: 1 }));

  it("GROUNDS '+106', '-124' and a '16.6% edge' read straight off the board", () => {
    // MEASURED: before entryPriceAmerican / entryOtherSideAmerican were added to
    // PRICE_KEYS this exact reply came back ungrounded on ["+106","-124"] — so
    // the desk regenerated, failed again, and shipped the fallback. A perfectly
    // honest answer, blocked, on the page whose whole claim is that its numbers
    // are real.
    const truthful =
      "The one play is NYJ ML at +106 with the other side at -124, a 16.6% edge, taken at FanDuel.";
    expect(checkGrounding(truthful, [payload])).toEqual({ grounded: true, ungrounded: [] });
  });

  it("does NOT ground a fabricated price or a fabricated edge", () => {
    const fabricated = "I make it NYJ ML at -240 for a 24% edge.";
    const v = checkGrounding(fabricated, [payload]);
    expect(v.grounded).toBe(false);
    expect(v.ungrounded).toContain("-240");
    expect(v.ungrounded).toContain("24%");
  });

  it("MEASURED LIMIT: grounding alone does NOT stop a stake — the guard does", () => {
    // "3.5 units" GROUNDS against this payload, because 3.5 sits inside the ±1
    // price band of a real +3 spread point on the board. That band is right for
    // prices and wrong for stakes, and widening it would break price quoting
    // everywhere else. So the stake rule lives in the receipts validator, where
    // it can be exact — this asserts both halves of that division of labour, so
    // nobody later "fixes" grounding to cover a case it deliberately doesn't.
    const staked = "Put 3.5 units on it.";
    expect(checkGrounding(staked, [payload]).grounded).toBe(true);
    expect(checkStakeTalk(staked).ok).toBe(false);
    expect(checkStakeTalk("Risk $200 on the Jets.").ok).toBe(false);
    expect(checkStakeTalk("2u on GB").ok).toBe(false);
    // Talking ABOUT stake, with no number, is the correct answer and survives.
    expect(
      checkStakeTalk("Stake isn't a published field on this board, and it won't be.").ok
    ).toBe(true);
  });
});

// ─── Regressions found by RUNNING it, not by reading it ─────────────────────
//
// Every case here shipped a fallback in production while the whole unit suite
// was green. They are the reason "run it and paste the transcript" is a
// separate step from "the tests pass".

describe("grounding regressions caught on live receipts turns", () => {
  const payload = JSON.stringify(nflBoard({ season: 2026, week: 1 }));

  it("a PASS REASON quoted verbatim grounds (it did not, before)", () => {
    // The board's own passReason string: "home-favorite 54–60% trap, no
    // secondary edge". Reading the desk's published reason back is the most
    // valuable thing this page does, and the guard was flagging 54 and 60% as
    // fabricated because they live inside a STRING, not a numeric field.
    const reply =
      "SEA ML was a pass. The reason on the row is a home-favorite 54-60% trap with no secondary edge.";
    const v = checkGrounding(reply, [payload]);
    expect(v.grounded).toBe(true);
  });

  it("a DOCTRINE NOTE quoted verbatim grounds", () => {
    const reply =
      "The note on that row reads: 2026 gate, calibrated edge 16.6% where the raw-conf edge was 8.2% — calibration transferred, raw edge did not.";
    expect(checkGrounding(reply, [payload]).grounded).toBe(true);
  });

  it("an ISO publish timestamp does not flag ungrounded", () => {
    // "…T14:09:00.447Z": the hour is preceded by "T", a word character, so the
    // clock-time exemption's \b never matched and "14" / "00.447" flagged.
    // Intermittent in production — it depended on the model choosing the ISO
    // spelling — which is exactly why it survived every unit test.
    const reply =
      "That board was published 2026-09-08T14:09:00.447Z, before any line had moved.";
    expect(checkGrounding(reply, [payload])).toEqual({ grounded: true, ungrounded: [] });
  });

  it("the in-sample span '2019-2024' does not flag ungrounded", () => {
    // The ROI guard REQUIRES this caveat; the year exemption only handled the
    // YYYY-YY form, so the guard was punishing the caveat the other guard
    // demanded. Both spellings must pass.
    const research = JSON.stringify(nflResearch());
    for (const span of ["2019-2024", "2019–2024", "2015-2024"]) {
      const reply = `The parlay study is in-sample over ${span} and its one out-of-sample holdout came back negative.`;
      expect(checkGrounding(reply, [research]).grounded).toBe(true);
    }
  });

  it("but a FABRICATED figure still fails — the widening did not open a hole", () => {
    for (const bad of [
      "SEA ML was a pass on a home-favorite 71-88% trap.",
      "That board was published 2026-09-08T14:09:00.447Z and the edge was 41.3%.",
      "The row was priced at -377.",
    ]) {
      expect(checkGrounding(bad, [payload]).grounded).toBe(false);
    }
  });
});
