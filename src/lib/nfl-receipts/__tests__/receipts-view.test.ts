// receipts-view.test.ts — the three things /nfl can get silently, visibly
// wrong. Anchored to the COMMITTED week-1 board, not a fixture: the board is
// immutable and notarized, so it is the frozen anchor these assertions need.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { devigTwoWay } from "../../nfl-devig";
import type { PublishedBoard, PublishedLeg } from "../board";
import {
  boardCounts,
  dayBands,
  divergeMagnitude,
  DIVERGE_SCALE_PP,
  etDayLabel,
  etTimeLabel,
  fmtGap,
  fmtPct1,
  gameRows,
  isControl,
  marketProbPct,
  modelProbPct,
  round1,
} from "../receipts-view";

const BOARD_PATH = path.join(
  process.cwd(),
  "data",
  "processed",
  "nfl-live",
  "board-2026-wk01.json",
);

function loadBoard(): PublishedBoard {
  return JSON.parse(fs.readFileSync(BOARD_PATH, "utf8")) as PublishedBoard;
}

describe("gameRows — grouping", () => {
  const board = loadBoard();
  const rows = gameRows(board);

  it("yields exactly 16 groups from the week-1 board", () => {
    expect(rows).toHaveLength(16);
  });

  it("excludes control legs, whose gameId shape would add phantom groups", () => {
    const controls = board.legs.filter(isControl);
    expect(controls.length).toBeGreaterThan(0);
    const controlGameIds = new Set(controls.map((l) => l.gameId));
    for (const row of rows) {
      expect(controlGameIds.has(row.gameId)).toBe(false);
    }
    // Grouping naively on gameId would produce 16 + the control games.
    const naive = new Set(board.legs.map((l) => l.gameId));
    expect(naive.size).toBe(16 + controlGameIds.size);
  });

  it("never surfaces a control selection string anywhere in a row", () => {
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("CONTROL[");
  });

  it("is kickoff-ordered and never gap-ordered", () => {
    const times = rows.map((r) => Date.parse(r.kickoffUtc));
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
  });

  it("heads every group with the moneyline leg", () => {
    const board2 = loadBoard();
    const mlLegIds = new Set(
      board2.legs
        .filter((l) => !isControl(l) && l.market === "moneyline")
        .map((l) => l.legId),
    );
    expect(mlLegIds.size).toBe(16);
    for (const row of rows) expect(mlLegIds.has(row.legId)).toBe(true);
  });

  // MUST 2, round 2: the head used to fall back to `legs[0]`, so a game with
  // no moneyline read handed the card an ATS leg. The page has no spread
  // column, so "NYJ +2.5" rendered as "NYJ at TEN" with a cover probability
  // labelled as a win probability and the line dropped entirely. Cannot fire
  // on wk1 (all 16 games carry an ML leg) — fires the first week one does not.
  it("drops a game with no moneyline leg rather than promoting a spread leg", () => {
    const board2 = loadBoard();
    const victim = "2026_01_NE_SEA";
    const stripped: PublishedBoard = {
      ...board2,
      legs: board2.legs.filter(
        (l) => !(l.gameId === victim && l.market === "moneyline"),
      ),
    };
    // The game still has its ATS and totals legs on the board...
    expect(stripped.legs.filter((l) => l.gameId === victim)).toHaveLength(2);
    // ...and it produces no row at all, rather than a mislabelled one.
    const stripedRows = gameRows(stripped);
    expect(stripedRows).toHaveLength(15);
    expect(stripedRows.some((r) => r.gameId === victim)).toBe(false);
    // Negative control: with the ML leg present the same board yields 16.
    expect(gameRows(board2)).toHaveLength(16);
  });

  it("marks exactly the two published PLAY legs as PLAY", () => {
    expect(rows.filter((r) => r.verdict === "PLAY")).toHaveLength(2);
    expect(rows.filter((r) => r.verdict === "PLAY").map((r) => r.selectedAbbr).sort())
      .toEqual(["GB", "NYJ"]);
  });

  it("resolves the leaned team and its opponent from the published strings", () => {
    const nyj = rows.find((r) => r.selectedAbbr === "NYJ")!;
    expect(nyj.matchup).toBe("NYJ @ TEN");
    expect(nyj.opponentAbbr).toBe("TEN");
    expect(nyj.selectedIsAway).toBe(true);

    const homePick = rows.find((r) => r.matchup === "NE @ SEA")!;
    expect(homePick.selectedAbbr).toBe("SEA");
    expect(homePick.opponentAbbr).toBe("NE");
    expect(homePick.selectedIsAway).toBe(false);
  });
});

describe("model / market / gap derivation", () => {
  const board = loadBoard();
  const rows = gameRows(board);
  const legById = new Map(board.legs.map((l) => [l.legId, l]));

  it("gap equals model minus market on EVERY row, to one decimal", () => {
    for (const row of rows) {
      expect(row.modelPct).not.toBeNull();
      expect(row.marketPct).not.toBeNull();
      expect(row.gapPp).toBe(round1(row.modelPct! - row.marketPct!));
      // and it survives the round trip through what the page actually prints
      const printedModel = Number(fmtPct1(row.modelPct).replace("%", ""));
      const printedMarket = Number(fmtPct1(row.marketPct).replace("%", ""));
      const printedGap = Number(fmtGap(row.gapPp));
      expect(round1(printedModel - printedMarket)).toBe(printedGap);
    }
  });

  it("uses the POWER devig — the same method the CLV grader uses", () => {
    for (const row of rows) {
      const leg = legById.get(row.legId)!;
      const power =
        devigTwoWay(leg.entryPriceAmerican!, leg.entryOtherSideAmerican!).byMethod
          .power * 100;
      expect(row.marketPct).toBe(round1(power));
    }
  });

  it("uses calibratedConfidence, never rawConfidence", () => {
    for (const row of rows) {
      const leg = legById.get(row.legId)!;
      expect(row.modelPct).toBe(round1(leg.calibratedConfidence! * 100));
      // rawConfidence is 0.50-0.55 across this board; calibrated is not.
      expect(row.modelPct).not.toBe(round1(leg.rawConfidence! * 100));
    }
  });

  // MEASURED 2026-09-09 against the committed week-1 board: leg.edge (which
  // was computed with multiplicative devig, against a different question) and
  // model - market (power devig) disagree at one decimal on 15 of the 16
  // moneyline rows. Only MIA @ LV lands on the same number. The brief's "7 of
  // 16" was a smaller count than the data actually shows; the direction of
  // the finding is unchanged and the rule — never render leg.edge — stands.
  it("does NOT reproduce leg.edge — 15 of 16 week-1 rows differ", () => {
    const agree: string[] = [];
    let disagreements = 0;
    for (const row of rows) {
      const leg = legById.get(row.legId)!;
      if (leg.edge == null) continue;
      if (round1(leg.edge * 100) !== row.gapPp) disagreements++;
      else agree.push(row.matchup);
    }
    expect(disagreements).toBe(15);
    expect(agree).toEqual(["MIA @ LV"]);
    // The five rows the brief called out by name all differ.
    for (const [matchup, edgeField] of [
      ["CLE @ JAX", -8.4],
      ["MIA @ LV", 10.0],
      ["DAL @ NYG", 4.0],
      ["DEN @ KC", 6.1],
      ["TB @ CIN", -1.2],
    ] as Array<[string, number]>) {
      const row = rows.find((r) => r.matchup === matchup)!;
      const leg = legById.get(row.legId)!;
      expect(round1(leg.edge! * 100)).toBe(edgeField);
      expect(row.gapPp).not.toBeNull();
    }
  });

  // BLOCKER, round 2: the ban on rendering leg.edge was enforced on the FIELD
  // and defeated by a STRING. Every doctrineNote beginning "2026 gate:"
  // embeds leg.edge verbatim ("calibrated edge 16.6%"), so the NYJ card
  // printed 16.6% three lines under a 16.8pp disagreement — the same
  // quantity, devigged two different ways, on one croppable card.
  //
  // The filter is on the "2026 gate:" prefix, NOT on "%": the floor notes
  // ("non-divisional (raised floor 5%)", "divisional (profit engine, floor
  // 3%)") are gate thresholds, not edge claims, and are worth keeping.
  // Board strings are never rewritten — the whole note is dropped.
  it("never carries an edge claim into a rendered doctrine note", () => {
    const offenders: string[] = [];
    for (const row of rows) {
      for (const note of row.doctrineNotes) {
        if (/edge/i.test(note)) offenders.push(`${row.matchup}: ${note}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("drops only the gate notes, keeping the floor and context notes", () => {
    const board2 = loadBoard();
    const nyj = rows.find((r) => r.selectedAbbr === "NYJ")!;
    const rawNotes = board2.legs.find((l) => l.legId === nyj.legId)!.doctrineNotes!;
    expect(rawNotes.some((n) => n.startsWith("2026 gate:"))).toBe(true);
    expect(nyj.doctrineNotes).toEqual(["non-divisional (raised floor 5%)"]);

    const gb = rows.find((r) => r.selectedAbbr === "GB")!;
    expect(gb.doctrineNotes).toEqual([
      "divisional (profit engine, floor 3%)",
      "dome environment (directional +)",
    ]);
  });

  it("suppresses the market probability when a leg is not CLV-eligible", () => {
    const ineligible: PublishedLeg = {
      ...loadBoard().legs.find((l) => l.role === "play")!,
      clvEligible: false,
    };
    expect(marketProbPct(ineligible)).toBeNull();
    expect(modelProbPct(ineligible)).not.toBeNull();
  });

  it("prints the model's number to one decimal so the gap subtracts on screen", () => {
    expect(fmtPct1(63.3)).toBe("63.3%");
    expect(fmtGap(12.1)).toBe("+12.1");
    expect(fmtGap(-10.4)).toBe("-10.4");
    expect(fmtGap(0)).toBe("0.0");
    expect(fmtGap(null)).toBe("—");
  });
});

describe("board counts and furniture", () => {
  const board = loadBoard();

  it("counts 16 games, 48 legs read, 2 on the board, 2 controls, 0 dropped", () => {
    const c = boardCounts(board);
    expect(c).toEqual({
      games: 16,
      legsRead: 48,
      played: 2,
      controls: 2,
      dropped: 0,
      retiredMarketLegs: 32,
    });
  });

  it("bands the slate by ET kickoff day, in order", () => {
    const bands = dayBands(gameRows(board));
    expect(bands.map((b) => b.label)).toEqual([
      "WED SEP 9",
      "THU SEP 10",
      "SUN SEP 13",
      "MON SEP 14",
    ]);
    expect(bands.reduce((n, b) => n + b.rows.length, 0)).toBe(16);
  });

  it("formats ET kickoff furniture", () => {
    expect(etDayLabel("2026-09-13T17:00:00Z")).toBe("SUN SEP 13");
    expect(etTimeLabel("2026-09-13T17:00:00Z")).toBe("1:00 PM");
    expect(etDayLabel("not-a-date")).toBe("—");
  });
});

describe("divergence scale", () => {
  it("is fixed at 25pp forever — never the week's max", () => {
    expect(DIVERGE_SCALE_PP).toBe(25);
  });

  it("maps magnitude into [0,1] and clamps beyond the scale", () => {
    expect(divergeMagnitude(0)).toBe(0);
    expect(divergeMagnitude(12.5)).toBe(0.5);
    expect(divergeMagnitude(-12.5)).toBe(0.5);
    expect(divergeMagnitude(40)).toBe(1);
  });
});
