import { describe, expect, it } from "vitest";
import {
  emptyLedger,
  gradeRows,
  headline,
  reconcileWithBoard,
  recordClose,
  registerBoard,
  seedRowsFromBoard,
  strayRows,
  upsertRow,
  VERDICT_MIN_N,
  type LedgerRow,
} from "../ledger";
import type { PublishedBoard, PublishedLeg } from "../board";

const FUTURE = "2099-01-01T18:00:00Z";
const PAST = "2020-01-01T18:00:00Z";

function row(over: Partial<LedgerRow> & Pick<LedgerRow, "legId">): LedgerRow {
  return {
    role: "play",
    season: 2026,
    week: 1,
    boardFile: "board-2026-wk01.json",
    gameId: "2026_01_KC_PHI",
    matchup: "KC @ PHI",
    kickoffUtc: FUTURE,
    market: "moneyline",
    selection: "PHI ML",
    side: "home",
    point: null,
    entryPriceAmerican: -180,
    entryOtherSideAmerican: 160,
    status: "pending",
    ...over,
  } as LedgerRow;
}

describe("upsertRow idempotence (threat T8: no duplicates, ever)", () => {
  it("applying the same patch twice yields exactly one row", () => {
    const l = emptyLedger();
    upsertRow(l, "abc", row({ legId: "abc" }));
    upsertRow(l, "abc", row({ legId: "abc" }));
    expect(l.rows).toHaveLength(1);
  });

  it("merges patches instead of appending", () => {
    const l = emptyLedger();
    upsertRow(l, "abc", row({ legId: "abc" }));
    upsertRow(l, "abc", { legId: "abc", status: "void" });
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0].status).toBe("void");
    expect(l.rows[0].selection).toBe("PHI ML"); // untouched fields survive
  });

  it("rejects a mismatched key", () => {
    const l = emptyLedger();
    expect(() => upsertRow(l, "abc", row({ legId: "xyz" }))).toThrow();
  });
});

describe("recordClose tier discipline", () => {
  const close = (tier: 1 | 2, capturedAt: string, book = tier === 1 ? "pinnacle" : "lowvig") => ({
    book,
    tier,
    sideAmerican: -190,
    otherAmerican: 170,
    capturedAt,
    minutesBeforeKickoff: 20,
    sourceFile: "closes/x.json",
  });

  it("higher tier always replaces lower; lower never downgrades", () => {
    const l = emptyLedger();
    upsertRow(l, "abc", row({ legId: "abc" }));
    recordClose(l, "abc", close(2, "2026-09-13T16:00:00Z"));
    recordClose(l, "abc", close(1, "2026-09-13T15:00:00Z")); // earlier but sharper
    expect(l.rows[0].close?.tier).toBe(1);
    recordClose(l, "abc", close(2, "2026-09-13T16:59:00Z")); // later but softer
    expect(l.rows[0].close?.tier).toBe(1);
  });

  it("same tier: the LATER capture wins (that is the close)", () => {
    const l = emptyLedger();
    upsertRow(l, "abc", row({ legId: "abc" }));
    recordClose(l, "abc", { ...close(1, "2026-09-13T15:00:00Z"), sideAmerican: -185 });
    recordClose(l, "abc", { ...close(1, "2026-09-13T16:55:00Z"), sideAmerican: -195 });
    expect(l.rows[0].close?.sideAmerican).toBe(-195);
  });
});

describe("gradeRows (denominator never silently shrinks)", () => {
  it("kicked-off leg without a close registers as no_close", () => {
    const l = emptyLedger();
    upsertRow(l, "a", row({ legId: "a", kickoffUtc: PAST }));
    const r = gradeRows(l, Date.now());
    expect(r.noClose).toBe(1);
    expect(l.rows[0].status).toBe("no_close");
  });

  it("grades a sharp close; is idempotent on re-run", () => {
    const l = emptyLedger();
    upsertRow(l, "a", row({ legId: "a", kickoffUtc: PAST }));
    recordClose(l, "a", {
      book: "pinnacle",
      tier: 1,
      sideAmerican: -200,
      otherAmerican: 175,
      capturedAt: "2020-01-01T17:40:00Z",
      minutesBeforeKickoff: 20,
      sourceFile: "closes/x.json",
    });
    gradeRows(l, Date.now());
    expect(l.rows[0].status).toBe("graded");
    const v1 = l.rows[0].verdict;
    gradeRows(l, Date.now());
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0].verdict?.devigClvPp).toBe(v1?.devigClvPp);
  });

  it("never grades a no_entry_price row", () => {
    const l = emptyLedger();
    upsertRow(
      l,
      "a",
      row({ legId: "a", kickoffUtc: PAST, entryPriceAmerican: null, status: "no_entry_price" }),
    );
    gradeRows(l, Date.now());
    expect(l.rows[0].status).toBe("no_entry_price");
  });
});

describe("headline (pre-registered verdict shape)", () => {
  it("coverage sits next to the beat rate and INSUFFICIENT_N is honest", () => {
    const l = emptyLedger();
    // one graded pair: play beats, control does not
    upsertRow(l, "p1", row({ legId: "p1", kickoffUtc: PAST, pairId: "c1" }));
    upsertRow(l, "c1", row({ legId: "c1", kickoffUtc: PAST, role: "control", pairId: "p1" }));
    // one play leg with a missed close
    upsertRow(l, "p2", row({ legId: "p2", kickoffUtc: PAST }));
    recordClose(l, "p1", {
      book: "pinnacle", tier: 1, sideAmerican: -220, otherAmerican: 190,
      capturedAt: "2020-01-01T17:40:00Z", minutesBeforeKickoff: 20, sourceFile: "x",
    });
    recordClose(l, "c1", {
      book: "pinnacle", tier: 1, sideAmerican: -150, otherAmerican: 130,
      capturedAt: "2020-01-01T17:40:00Z", minutesBeforeKickoff: 20, sourceFile: "x",
    });
    gradeRows(l, Date.now());
    const h = headline(l);
    expect(h.play.eligible).toBe(2);
    expect(h.play.graded).toBe(1);
    expect(h.play.coverage).toBeCloseTo(0.5, 6);
    expect(h.play.byStatus.no_close).toBe(1);
    expect(h.pairedN).toBe(1);
    expect(h.insufficientN).toBe(true);
    expect(h.minN).toBe(VERDICT_MIN_N);
  });
});

function boardLeg(over: Partial<PublishedLeg> & Pick<PublishedLeg, "legId">): PublishedLeg {
  return {
    role: "play",
    gameId: "2026_01_KC_PHI",
    matchup: "KC @ PHI",
    kickoffUtc: FUTURE,
    market: "moneyline",
    selection: "PHI ML",
    side: "home",
    point: null,
    entryPriceAmerican: -180,
    entryOtherSideAmerican: 160,
    priceProvenance: {
      book: "fanduel",
      snapshotFile: "snapshots/entry-2026-wk01.json",
      snapshotFetchedAt: "2026-09-08T12:00:00Z",
      oddsApiEventId: "e1",
    },
    clvEligible: true,
    verdict: "PLAY",
    ...over,
  } as PublishedLeg;
}

function makeBoard(legs: PublishedLeg[]): PublishedBoard {
  return {
    schemaVersion: 1,
    season: 2026,
    week: 1,
    publishedAt: "2026-09-08T12:00:00Z",
    entrySnapshotFile: "snapshots/entry-2026-wk01.json",
    entrySnapshotFetchedAt: "2026-09-08T12:00:00Z",
    oddsApiQuotaUsedAtPublish: "42",
    modelBoardSource: "2026-REG-wk1.json",
    legs,
    dropped: [],
    parlay: null,
    note: "",
  };
}

describe("seedRowsFromBoard 1:1 invariant (review finding 3)", () => {
  it("N board legs seed exactly N ledger rows", () => {
    const board = makeBoard([
      boardLeg({ legId: "p1" }),
      boardLeg({ legId: "p2", gameId: "2026_01_DAL_NYG", selection: "DAL ML", side: "away" }),
      boardLeg({ legId: "c1", role: "control", pairId: "p1", verdict: "CONTROL" }),
      boardLeg({ legId: "c2", role: "control", pairId: "p2", verdict: "CONTROL" }),
    ]);
    const l = emptyLedger();
    seedRowsFromBoard(l, board);
    expect(l.rows).toHaveLength(board.legs.length);
    // and re-seeding stays 1:1 (idempotent, no growth)
    seedRowsFromBoard(l, board);
    expect(l.rows).toHaveLength(board.legs.length);
  });
});

describe("gradeRows kickoff discipline (review finding 4)", () => {
  it("a row with a close but a FUTURE kickoff is never graded early", () => {
    const l = emptyLedger();
    upsertRow(l, "a", row({ legId: "a", kickoffUtc: FUTURE }));
    recordClose(l, "a", {
      book: "pinnacle",
      tier: 1,
      sideAmerican: -200,
      otherAmerican: 175,
      capturedAt: "2026-09-13T15:40:00Z",
      minutesBeforeKickoff: 80,
      sourceFile: "closes/x.json",
    });
    gradeRows(l, Date.now());
    expect(l.rows[0].status).toBe("pending"); // still capturable at T−20
  });
});

describe("reconcileWithBoard (review finding 2: rows re-derived from notarized bytes)", () => {
  it("repairs a tampered entry price and preserves mutable state", () => {
    const board = makeBoard([boardLeg({ legId: "p1" })]);
    const l = emptyLedger();
    seedRowsFromBoard(l, board);
    recordClose(l, "p1", {
      book: "pinnacle", tier: 1, sideAmerican: -190, otherAmerican: 170,
      capturedAt: "2026-09-13T16:40:00Z", minutesBeforeKickoff: 20, sourceFile: "closes/x.json",
    });
    // forge: better entry price slipped into a routine ledger commit
    l.rows[0].entryPriceAmerican = -105;
    const { repaired, orphans } = reconcileWithBoard(l, board);
    expect(repaired).toBe(1);
    expect(orphans).toEqual([]);
    expect(l.rows[0].entryPriceAmerican).toBe(-180); // board bytes win
    expect(l.rows[0].close?.book).toBe("pinnacle"); // capture state survives
  });

  it("flags a ledger row that is not on the published board as an orphan", () => {
    const board = makeBoard([boardLeg({ legId: "p1" })]);
    const l = emptyLedger();
    seedRowsFromBoard(l, board);
    upsertRow(l, "ghost", row({ legId: "ghost" })); // same boardFile, not on board
    const { orphans } = reconcileWithBoard(l, board);
    expect(orphans).toEqual(["ghost"]);
  });

  it("repairs an eligible row demoted to no_entry_price (denominator cannot shrink)", () => {
    const board = makeBoard([boardLeg({ legId: "p1" })]); // clvEligible: true
    const l = emptyLedger();
    seedRowsFromBoard(l, board);
    l.rows[0].status = "no_entry_price"; // hand-demoted
    const { repaired } = reconcileWithBoard(l, board);
    expect(repaired).toBe(1);
    expect(l.rows[0].status).toBe("pending");
    // …while void (operator-owned via nfl-errata) survives reconcile
    l.rows[0].status = "void";
    reconcileWithBoard(l, board);
    expect(l.rows[0].status).toBe("void");
  });

  it("strayRows flags rows naming an unregistered board", () => {
    const board = makeBoard([boardLeg({ legId: "p1" })]);
    const l = emptyLedger();
    registerBoard(l, {
      file: "board-2026-wk01.json",
      sha256: "aaa",
      publishedAt: board.publishedAt,
      season: 2026,
      week: 1,
      publishRunId: "local",
      errata: [],
    });
    seedRowsFromBoard(l, board);
    expect(strayRows(l)).toEqual([]);
    upsertRow(l, "ghost9", row({ legId: "ghost9", boardFile: "board-2026-wk09.json" }));
    expect(strayRows(l).map((r) => r.legId)).toEqual(["ghost9"]);
  });

  it("re-seeds a deleted row from the board", () => {
    const board = makeBoard([boardLeg({ legId: "p1" }), boardLeg({ legId: "p2", selection: "KC ML", side: "away" })]);
    const l = emptyLedger();
    seedRowsFromBoard(l, board);
    l.rows = l.rows.filter((r) => r.legId !== "p2"); // hand-deleted
    reconcileWithBoard(l, board);
    expect(l.rows.map((r) => r.legId).sort()).toEqual(["p1", "p2"]);
  });
});

describe("registerBoard immutability", () => {
  const rec = {
    file: "board-2026-wk01.json",
    sha256: "aaa",
    publishedAt: "2026-09-08T12:00:00Z",
    season: 2026,
    week: 1,
    publishRunId: "local",
    errata: [],
  };
  it("same bytes re-register is a no-op; different bytes throw", () => {
    const l = emptyLedger();
    registerBoard(l, rec);
    registerBoard(l, { ...rec });
    expect(l.boards).toHaveLength(1);
    expect(() => registerBoard(l, { ...rec, sha256: "bbb" })).toThrow(/immutable/);
  });
});
