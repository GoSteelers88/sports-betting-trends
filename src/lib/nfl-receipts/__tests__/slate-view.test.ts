import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { NflSlate, NflSlateGame } from "../site-slate";
import { etDayLabel } from "../receipts-view";
import {
  fairPairWhole,
  fmtFairPct,
  fmtSlatePrice,
  fmtSlateSpread,
  fmtSlateTotal,
  slateBands,
  slateNickname,
  slateRow,
  slateRows,
} from "../slate-view";

const game = (over: Partial<NflSlateGame> = {}): NflSlateGame => ({
  kickoffUtc: "2026-09-13T17:00:00Z",
  home_team: "Tennessee Titans",
  away_team: "New York Jets",
  moneyline: { home: -117, away: 104 },
  spread: { point: -1.5, home: -110, away: -110 },
  total: { point: 41.5, over: -110, under: -110 },
  fairHomeProb: 0.5248254234596937,
  fairAwayProb: 0.4751745765403062,
  ...over,
});

const slate = (games: NflSlateGame[]): NflSlate => ({
  generatedAt: "2026-09-08T21:59:14.344Z",
  source: "pinnacle",
  windowStartUtc: "2026-09-08T15:59:14.344Z",
  windowEndUtc: "2026-09-16T12:20:00.000Z",
  gameCount: games.length,
  games,
  events: games.map((g) => ({ home_team: g.home_team, away_team: g.away_team })),
});

describe("slateNickname", () => {
  it("takes the final token of a full club name", () => {
    expect(slateNickname("Kansas City Chiefs")).toBe("Chiefs");
    expect(slateNickname("San Francisco 49ers")).toBe("49ers");
    expect(slateNickname("Washington Commanders")).toBe("Commanders");
  });

  it("passes a single-token or empty name through instead of blanking it", () => {
    expect(slateNickname("Chiefs")).toBe("Chiefs");
    expect(slateNickname("  ")).toBe("");
  });
});

describe("slateRow", () => {
  it("carries the file's fair probability to one decimal, both sides", () => {
    const r = slateRow(game());
    expect(r.fairHomePct).toBe(52.5);
    expect(r.fairAwayPct).toBe(47.5);
    // The raw 0..1 fractions do not travel onto the row — a template that
    // prints one of them renders "0.52%" and nobody notices for a week.
    expect(Object.keys(r)).not.toContain("fairHomeProb");
    expect(Object.keys(r)).not.toContain("fairAwayProb");
  });

  it("nulls a missing market instead of zeroing it", () => {
    const r = slateRow(
      game({ moneyline: null, spread: null, total: null, fairHomeProb: null, fairAwayProb: null }),
    );
    expect(r.moneylineHome).toBeNull();
    expect(r.fairHomePct).toBeNull();
    expect(r.spreadPoint).toBeNull();
    expect(r.totalPoint).toBeNull();
  });

  // NEGATIVE CONTROL: a null probability must NOT come back as 0 — "0%" on a
  // win-probability column is a claim that a team cannot win.
  it("never turns an absent probability into 0", () => {
    const r = slateRow(game({ fairHomeProb: null, fairAwayProb: null }));
    expect(r.fairHomePct).not.toBe(0);
    expect(fmtFairPct(r.fairHomePct)).toBe("—");
  });
});

describe("slateRows", () => {
  it("orders by kickoff regardless of file order", () => {
    const late = game({ kickoffUtc: "2026-09-14T00:15:00Z", home_team: "New York Giants" });
    const early = game({ kickoffUtc: "2026-09-10T00:20:00Z", home_team: "Seattle Seahawks" });
    const rows = slateRows(slate([late, early]));
    expect(rows.map((r) => r.homeShort)).toEqual(["Seahawks", "Giants"]);
  });

  it("returns an empty list for a null or gameless slate", () => {
    expect(slateRows(null)).toEqual([]);
    expect(slateRows(slate([]))).toEqual([]);
  });

  it("drops a row with no kickoff rather than sorting it as epoch zero", () => {
    const rows = slateRows(
      slate([game(), { ...game(), kickoffUtc: undefined as unknown as string }]),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("slateBands", () => {
  it("groups consecutive kickoffs under one ET day label", () => {
    const rows = slateRows(
      slate([
        game({ kickoffUtc: "2026-09-13T17:00:00Z", home_team: "Tennessee Titans" }),
        game({ kickoffUtc: "2026-09-13T20:05:00Z", home_team: "Denver Broncos" }),
        game({ kickoffUtc: "2026-09-15T00:20:00Z", home_team: "Chicago Bears" }),
      ]),
    );
    const bands = slateBands(rows, etDayLabel);
    expect(bands).toHaveLength(2);
    expect(bands[0].label).toBe("SUN SEP 13");
    expect(bands[0].rows).toHaveLength(2);
    expect(bands[1].label).toBe("MON SEP 14"); // 00:20Z Tue = Mon 8:20pm ET
  });
});

describe("formatters", () => {
  it("signs American prices and dashes the missing ones", () => {
    expect(fmtSlatePrice(104)).toBe("+104");
    expect(fmtSlatePrice(-117)).toBe("-117");
    expect(fmtSlatePrice(null)).toBe("—");
    expect(fmtSlatePrice(Number.NaN)).toBe("—");
  });

  it("prints the home spread with its price, or the point alone", () => {
    expect(fmtSlateSpread(-1.5, -110)).toBe("-1.5 (-110)");
    expect(fmtSlateSpread(3, 100)).toBe("+3 (+100)");
    expect(fmtSlateSpread(-1.5, null)).toBe("-1.5");
    expect(fmtSlateSpread(null, -110)).toBe("—");
  });

  it("rounds fair probability to a whole percent", () => {
    expect(fmtFairPct(52.5)).toBe("53%");
    expect(fmtFairPct(47.4)).toBe("47%");
    expect(fmtSlateTotal(41.5)).toBe("41.5");
    expect(fmtSlateTotal(null)).toBe("—");
  });
});

describe("fairPairWhole", () => {
  it("prints a pair that sums to 100, not 101", () => {
    // MEASURED on the committed slate: independent rounding printed
    // "19% / 82%" (Cardinals–Chargers) and "48% / 53%" (Jets–Titans).
    expect(fairPairWhole(82.0, 18.0)).toEqual({ home: 82, away: 18 });
    expect(fairPairWhole(52.5, 47.5)).toEqual({ home: 53, away: 47 });
    expect(fairPairWhole(81.5, 18.5)).toEqual({ home: 82, away: 18 });
  });

  it("anchors on whichever side the file actually has", () => {
    expect(fairPairWhole(null, 61.4)).toEqual({ away: 61, home: 39 });
    expect(fairPairWhole(null, null)).toEqual({ away: null, home: null });
  });

  // NEGATIVE CONTROL — prove the naive version this replaced would fail.
  it("catches a pair that independent rounding would break", () => {
    const naive = { home: Math.round(81.5), away: Math.round(18.5) };
    expect(naive.home + naive.away).toBe(101);
    const fixed = fairPairWhole(81.5, 18.5);
    expect((fixed.home ?? 0) + (fixed.away ?? 0)).toBe(100);
  });
});

describe("the committed slate — a frozen anchor on real bytes", () => {
  const file = path.join(process.cwd(), "data", "processed", "nfl-slate.json");
  const raw: NflSlate | null = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf-8")) as NflSlate)
    : null;

  it("renders every committed game as a row", () => {
    if (!raw) return; // cron-written; absent locally is not a failure
    expect(slateRows(raw)).toHaveLength(raw.games.length);
  });

  it("keeps both sides of every priced game summing to 100%", () => {
    if (!raw) return;
    for (const r of slateRows(raw)) {
      if (r.fairHomePct == null || r.fairAwayPct == null) continue;
      expect(r.fairHomePct + r.fairAwayPct).toBeCloseTo(100, 1);
    }
  });

  it("prints no row whose two whole percents miss 100", () => {
    if (!raw) return;
    for (const r of slateRows(raw)) {
      const p = fairPairWhole(r.fairHomePct, r.fairAwayPct);
      if (p.home == null || p.away == null) continue;
      expect(p.home + p.away).toBe(100);
    }
  });

  it("bands the real slate in kickoff order with no repeated day", () => {
    if (!raw) return;
    const labels = slateBands(slateRows(raw), etDayLabel).map((b) => b.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
