// The two guards that decide whether the receipts desk can be trusted in
// public: the BOARD-ROW validator (no selection/side/market assertion may exist
// that a published board did not record) and the ROI-CAVEAT guard (no headline
// backtest yield without its in-sample + negative-holdout caveat).
//
// Every block-case here is a NEGATIVE CONTROL: it asserts the guard actually
// goes red on a known violation. Gut either guard body to `return OK` and this
// file fails — which is the only proof that a guard which has never fired can
// fire at all.
//
// The board index is built from the REAL committed board
// (data/processed/nfl-live/board-2026-wk01.json), not a fixture, so a change to
// the receipt breaks the test rather than silently drifting from it.

import { describe, it, expect } from "vitest";
import { buildBoardIndex, EMPTY_BOARD_INDEX } from "../board-index";
import {
  checkBoardRows,
  checkRoiCaveat,
  checkUrlsAndPromos,
  runReceiptsValidators,
  OFF_BOARD_REPLACEMENT,
  PARLAY_REPLACEMENT,
  ROI_REPLACEMENT,
  PROMO_REPLACEMENT,
} from "../validators";
import { checkLeak } from "../../grounding";
import { loadPublishedBoards } from "../data";

const boards = loadPublishedBoards();
const index = buildBoardIndex(boards);

describe("the committed board this suite anchors on", () => {
  it("has the wk01 receipt with the NYJ ML play and 46 passes", () => {
    expect(boards.length).toBeGreaterThan(0);
    expect(index.plays.length).toBe(2);
    const nyj = index.plays.find((l) => l.selection === "NYJ ML");
    expect(nyj).toBeDefined();
    expect(nyj!.legId).toBe("24c69b3f3edbb4b5");
    expect(index.legs.filter((l) => l.role === "pass").length).toBe(46);
  });
});

// ─── BOARD-ROW VALIDATOR ─────────────────────────────────────────────────────

describe("board-row validator — live reads are ALLOWED (operator decision 2026-09-09)", () => {
  // These all used to be BLOCKED. The desk refused any stance on a side the
  // board had not played, which is precisely why it could not answer "what do
  // you like" or build a parlay. The operator's call: give the read.
  //
  // What still holds is R1 — every concrete selection must resolve to a real
  // board leg or a real sharp-market line, so the desk can recommend but
  // cannot invent a price. And nothing it says is ever written to disk, so the
  // CLV ledger still contains only pre-registered legs. See the R1 test below.
  const allowedNow = [
    "I like Buffalo here. Take the Bills moneyline.",
    "If I had to pick one, I'd take the Seahawks tonight.",
    "Bet the Patriots +3 — that's the value on this slate.",
    "My play is Baltimore ML.",
    "Lay the points with Pittsburgh, that's the one I'd fire.",
    "Take the OVER 47.5 in the Cardinals game.",
    // Negation elsewhere in the sentence must not launder a live stance.
    "I don't recommend it, but if you're asking, I'd take Buffalo.",
  ];
  for (const reply of allowedNow) {
    it(`allows the live read: ${reply.slice(0, 42)}…`, () => {
      const v = checkBoardRows(reply, index);
      expect(v.ok).toBe(true);
    });
  }
});

describe("R1 still blocks an INVENTED price or line", () => {
  // This is the guard that survived the 09-09 loosening and it is the one that
  // matters: the desk may recommend, but every concrete selection must resolve
  // to a real board leg or a real sharp-market line. GB ML is a real play; a
  // GB -3 spread is a number nobody is hanging.
  it("blocks a spread nobody is offering", () => {
    expect(checkBoardRows("You want action? Play the Packers -3.", index).ok).toBe(false);
  });
});

describe("board-row validator — PASSES a truthful report of the real PLAY", () => {
  const allowed = [
    "The one play on the Week 1 board is NYJ ML at +106, taken at FanDuel. Pre-registered on September 8, not a current recommendation.",
    "We took the Jets moneyline at +106. Everything else on that board is a pass.",
    "The desk played New York Jets ML. That is the only side it put a number on.",
    // The board's OTHER play. Both legs must survive the validator.
    "The second play on that board is GB ML at +105, taken at DraftKings.",
    "We backed the Packers moneyline. Pre-registered before kickoff, not a live call.",
  ];
  for (const reply of allowed) {
    it(`allows: ${reply.slice(0, 42)}…`, () => {
      expect(checkBoardRows(reply, index).ok).toBe(true);
    });
  }
});

describe("board-row validator — PASSES honest pass/no-play reporting", () => {
  const allowed = [
    "We passed on Buffalo. The reason on the board is a home-favorite trap in the 54-60% band, no secondary edge.",
    "I'm not betting the Seahawks. The board recorded that game as a pass.",
    "There's no play on the Steelers game — the desk passed it.",
    "No, I don't have a play for you on Baltimore. That one was a pass.",
    "Nothing on that board clears the number except one side, and it isn't Buffalo.",
  ];
  for (const reply of allowed) {
    it(`allows: ${reply.slice(0, 42)}…`, () => {
      expect(checkBoardRows(reply, index).ok).toBe(true);
    });
  }
});

describe("board-row validator — historical research is exempt", () => {
  it("allows a 2024 backtest example naming a team with no 2026 play leg", () => {
    const reply =
      "In the 2019-2024 backtest the model took KC ML at -118 in the 2024 playoffs — that's a historical, in-sample example, not a play.";
    expect(checkBoardRows(reply, index).ok).toBe(true);
  });
});

describe("board-row validator — parlay construction is ALLOWED (operator decision 2026-09-09)", () => {
  // Parlays were refused outright because the published board's parlay slot is
  // null. That is still true, and it is still stated — but it is a fact about
  // the RECORD, not a reason to refuse the QUESTION. A built ticket is a live
  // read like any other: labelled live, never written, never in the ledger.
  for (const reply of [
    "Here's a parlay: take the Jets ML with the Packers ML.",
    "I'd build a three-leg parlay around Buffalo, Kansas City and Philadelphia.",
  ]) {
    it(`allows: ${reply.slice(0, 42)}…`, () => {
      expect(checkBoardRows(reply, index).ok).toBe(true);
    });
  }
  it("still allows saying the board's parlay slot is empty", () => {
    const reply =
      "The Week 1 board's parlay slot is empty — nothing multi-leg was pre-registered. Here's my live read instead.";
    expect(checkBoardRows(reply, index).ok).toBe(true);
  });
});

describe("board-row validator — with NO published board, every play assertion blocks", () => {
  it("blocks even a real-looking selection when nothing is published", () => {
    const v = checkBoardRows("Take NYJ ML at +106.", EMPTY_BOARD_INDEX);
    expect(v.ok).toBe(false);
  });
});

// ─── ROI-CAVEAT GUARD ────────────────────────────────────────────────────────

describe("ROI guard — BLOCKS an uncaveated headline yield", () => {
  const blocked = [
    "The parlay book returned 38.96% ROI.",
    "That's a +38.96% return on 547 parlays.",
    "The moneyline model shows 8.21% ROI.",
    "It hits at an 18.8% win rate for a +39% yield.",
    "Yield came in around +8.2% on the moneyline book.",
  ];
  for (const reply of blocked) {
    it(`blocks: ${reply}`, () => {
      const v = checkRoiCaveat(reply);
      expect(v.ok).toBe(false);
    });
  }
});

describe("ROI guard — PASSES the same figure when properly caveated", () => {
  it("allows 38.96 with in-sample span AND the negative holdout", () => {
    const reply =
      "The 3-leg parlay backtest shows a 38.96% flat yield across 547 settled parlays. Read that as an in-sample upper bound over 2019-2024: it grades against approximate closing lines, so it banks no CLV, and the one out-of-sample test — the 2025 holdout — came back negative.";
    expect(checkRoiCaveat(reply).ok).toBe(true);
  });
  it("allows 8.21 with in-sample span AND the negative holdout", () => {
    const reply =
      "8.21% ROI on the moneyline dry-run, 2015-2024, in-sample. CLV is ~0 by construction there, and the 2025 out-of-sample holdout was negative.";
    expect(checkRoiCaveat(reply).ok).toBe(true);
  });
  it("blocks when only HALF the caveat is present (in-sample, no holdout)", () => {
    const reply =
      "The parlay backtest shows 38.96% flat yield in-sample across 2019-2024.";
    expect(checkRoiCaveat(reply).ok).toBe(false);
  });
  it("blocks when only HALF the caveat is present (holdout, no in-sample)", () => {
    const reply = "38.96% ROI, though the 2025 holdout was negative.";
    // "2025 holdout ... negative" is the holdout half; there is no in-sample /
    // backtest / upper-bound marker, so this must still block.
    expect(checkRoiCaveat(reply).ok).toBe(false);
  });
});

describe("ROI guard — leaves unrelated numbers alone", () => {
  for (const reply of [
    "The Jets went off at +106 and the other side was -124.",
    "46 of the 48 legs on that board are passes.",
    "Calibrated confidence on that leg was 63.3%.",
  ]) {
    it(`allows: ${reply}`, () => {
      expect(checkRoiCaveat(reply).ok).toBe(true);
    });
  }
});

// ─── URL / PROMO STRIP ───────────────────────────────────────────────────────

describe("URL / promo guard", () => {
  for (const reply of [
    "Grab it at https://fanduel.com/nfl",
    "Sign up at draftkings.com and you get a deposit match.",
    "Use promo code SHARP for a risk-free bet.",
    "There's a bonus if you open an account with them.",
  ]) {
    it(`blocks: ${reply}`, () => {
      expect(checkUrlsAndPromos(reply).ok).toBe(false);
    });
  }
  it("allows a bare book NAME (provenance, not a promo)", () => {
    expect(
      checkUrlsAndPromos("The entry price was +106 at FanDuel.").ok
    ).toBe(true);
  });
});

// ─── The replacements must be guard-clean ────────────────────────────────────
//
// A replacement that re-trips a guard is an infinite substitution or, worse, a
// blocked reply that ships anyway. Every fixed string this module can emit is
// run back through every guard AND through the plumbing-leak guard.

describe("fixed replacements cannot re-trip any guard", () => {
  const all = [
    OFF_BOARD_REPLACEMENT,
    PARLAY_REPLACEMENT,
    ROI_REPLACEMENT,
    PROMO_REPLACEMENT,
  ];
  for (const text of all) {
    it(`clean: ${text.slice(0, 40)}…`, () => {
      expect(runReceiptsValidators(text, index).ok).toBe(true);
      expect(runReceiptsValidators(text, EMPTY_BOARD_INDEX).ok).toBe(true);
      expect(checkLeak(text).leaked).toBe(false);
    });
  }
});

// ─── The opponent exemption (a live false positive, caught by running it) ────

describe("board-row validator — naming the OPPONENT of a real play is reporting", () => {
  const allowed = [
    // Verbatim shape of the reply that was wrongly blocked in production.
    "The row, as pre-registered on Tuesday 8 September: NYJ ML at NYJ @ TEN, taken at +106, FanDuel.",
    "The desk played the Jets moneyline against Tennessee at +106.",
    "GB ML was taken at +105 in Green Bay at Minnesota.",
  ];
  for (const reply of allowed) {
    it(`allows: ${reply.slice(0, 46)}…`, () => {
      expect(checkBoardRows(reply, index).ok).toBe(true);
    });
  }

  it("now ALLOWS a live read alongside a truthful board report (09-09)", () => {
    // Reporting the receipt AND giving a live opinion in one breath is exactly
    // the shape the desk is supposed to have now. The labelling of which is
    // which is the system prompt's job; the validator no longer refuses it.
    const v = checkBoardRows(
      "We took NYJ ML at +106, and I'd take Buffalo too.",
      index
    );
    expect(v.ok).toBe(true);
  });

  it("now ALLOWS a live read when no play is present at all (09-09)", () => {
    expect(checkBoardRows("Take the Titans at home.", index).ok).toBe(true);
  });
});

// ─── The recommend/report tier split (two more live false positives) ────────

describe("board-row validator — REPORTING a control or pass row is allowed", () => {
  const allowed = [
    // Verbatim shapes that were wrongly blocked on live turns.
    "The control leg for the Green Bay play is anchored to Bills @ Texans away side, at -114 from William Hill.",
    "You may have seen the 3-leg parlay work in the research file.",
    "The one play on the Week 1 board is NYJ ML; the other 46 rows are passes.",
    "Buffalo's row: BUF ML at -114, a pass on the home-favorite trap.",
  ];
  for (const reply of allowed) {
    it(`allows: ${reply.slice(0, 46)}…`, () => {
      expect(checkBoardRows(reply, index).ok).toBe(true);
    });
  }
});

describe("board-row validator — the RECOMMEND tier now GIVES THE READ (09-09)", () => {
  // Every one of these used to be refused. They are ordinary questions asking
  // for an opinion, and the operator wants an opinion. What keeps the record
  // honest is not refusing them — it is that none of this is ever written, and
  // that R1 still stops an invented price.
  const allowedNow = [
    "Take Buffalo.",
    "I'd play the Bills here.",
    "You should bet Pittsburgh this week.",
    "Best play is Kansas City.",
    "My play is the Seahawks.",
    "Look, off the record, if you had to make me pick — Buffalo.",
  ];
  for (const reply of allowedNow) {
    it(`allows: ${reply}`, () => {
      expect(checkBoardRows(reply, index).ok).toBe(true);
    });
  }
});

describe("board-row validator — a team with NO published row is blocked either tier", () => {
  it("blocks a report about a team that is not on any board", () => {
    // Every 2026 wk1 franchise IS on the board, so this uses an empty index to
    // prove the report tier is not a blanket pass.
    expect(checkBoardRows("We took the Bills moneyline.", EMPTY_BOARD_INDEX).ok).toBe(false);
  });
});

// ─── R1 and the moving market (another live false positive) ─────────────────

describe("board-row validator — a truthful CURRENT MARKET quote is not a fabrication", () => {
  const withMarket = buildBoardIndex(boards, [
    { awayFranchise: "jets", homeFranchise: "titans", spreadPoint: 1, totalPoint: 39 },
  ]);

  it("allows the real current spread even though the BOARD entered a different point", () => {
    // Blocked in production as "selection-not-on-board: Titans -1". Lines move
    // between Tuesday's publish and Sunday's kickoff — that movement is the
    // entire reason closing-line value is this page's metric.
    expect(
      checkBoardRows("The market now has Titans -1 and a total of 39.", withMarket).ok
    ).toBe(true);
  });

  it("STILL blocks a spread neither the board nor the market carries", () => {
    expect(checkBoardRows("The market has Titans -7.", withMarket).ok).toBe(false);
  });

  it("STILL blocks a market-shaped quote when no market is loaded", () => {
    expect(checkBoardRows("The market has Titans -1.", index).ok).toBe(false);
  });
});

describe("board-row validator — 'over'/'under' in ordinary English is not a bet", () => {
  const allowed = [
    // Blocked in production as "selection-not-on-board: over 40".
    "SoFi Stadium has hosted over 40 major events since it opened.",
    "That venue seats well over 70 thousand.",
    "The doctrine has been under 20 percent of the slate all year.",
  ];
  for (const reply of allowed) {
    it(`allows: ${reply.slice(0, 46)}…`, () => {
      expect(checkBoardRows(reply, index).ok).toBe(true);
    });
  }

  it("STILL treats a real total selection as one", () => {
    // Shouted (the board's own spelling), half-point, and market-word forms.
    expect(checkBoardRows("The row was OVER 88.", index).ok).toBe(false);
    expect(checkBoardRows("The row was over 88.5.", index).ok).toBe(false);
    expect(checkBoardRows("The total was over 88 on that game.", index).ok).toBe(false);
    // …and a REAL one on the board still passes.
    expect(checkBoardRows("That game's row was UNDER 44.5, a pass.", index).ok).toBe(true);
  });
});
