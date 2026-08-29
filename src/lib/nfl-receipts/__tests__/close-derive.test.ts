import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  derivePinnacleClose,
  deriveTier2Close,
  verifyCloses,
  type CloseTarget,
} from "../close-derive";
import { emptyLedger, upsertRow, recordClose, type Ledger, type LedgerRow } from "../ledger";
import type { OddsApiEvent } from "../odds-entry";
import type { SharpEventLike } from "../site-slate";

const KICKOFF = "2026-09-13T17:00:00Z";
const CAPTURED = "2026-09-13T16:40:00Z";

const PIN_EVENT: SharpEventLike = {
  commence_time: KICKOFF,
  home_team: "Philadelphia Eagles",
  away_team: "Kansas City Chiefs",
  moneyline: { home: -190, away: 168 },
  spread: { point: -3.5, home: -104, away: -108 },
  total: { point: 47.5, over: -108, under: -112 },
};

const TIER2_EVENT: OddsApiEvent = {
  id: "e1",
  sport_key: "americanfootball_nfl",
  commence_time: KICKOFF,
  home_team: "Philadelphia Eagles",
  away_team: "Kansas City Chiefs",
  bookmakers: [
    {
      key: "betonlineag",
      title: "BetOnline",
      markets: [
        { key: "h2h", outcomes: [
          { name: "Philadelphia Eagles", price: -185 },
          { name: "Kansas City Chiefs", price: 165 },
        ]},
      ],
    },
    {
      key: "lowvig",
      title: "LowVig",
      markets: [
        { key: "h2h", outcomes: [
          { name: "Philadelphia Eagles", price: -188 },
          { name: "Kansas City Chiefs", price: 172 },
        ]},
      ],
    },
  ],
};

const target: CloseTarget = {
  matchup: "KC @ PHI",
  kickoffUtc: KICKOFF,
  market: "moneyline",
  side: "home",
  point: null,
};

describe("derivePinnacleClose", () => {
  it("derives ML/spread/total with exact-point discipline", () => {
    expect(derivePinnacleClose(target, [PIN_EVENT])).toEqual({
      sideAmerican: -190,
      otherAmerican: 168,
    });
    expect(
      derivePinnacleClose({ ...target, market: "ats", side: "away", point: 3.5 }, [PIN_EVENT]),
    ).toEqual({ sideAmerican: -108, otherAmerican: -104 });
    // moved point derives nothing
    expect(
      derivePinnacleClose({ ...target, market: "ats", side: "home", point: -2.5 }, [PIN_EVENT]),
    ).toBeNull();
    expect(
      derivePinnacleClose({ ...target, market: "total", side: "under", point: 47.5 }, [PIN_EVENT]),
    ).toEqual({ sideAmerican: -112, otherAmerican: -108 });
  });
});

describe("deriveTier2Close", () => {
  it("honors the caller's book priority and is book-specific for the verifier", () => {
    expect(deriveTier2Close(target, [TIER2_EVENT], ["lowvig", "betonlineag"])).toEqual({
      book: "lowvig",
      sideAmerican: -188,
      otherAmerican: 172,
    });
    expect(deriveTier2Close(target, [TIER2_EVENT], ["betonlineag"])).toEqual({
      book: "betonlineag",
      sideAmerican: -185,
      otherAmerican: 165,
    });
    expect(deriveTier2Close(target, [TIER2_EVENT], ["draftkings"])).toBeNull();
  });
});

describe("verifyCloses (grader tamper check for closes)", () => {
  let root: string;
  const PIN_REL = "data/processed/nfl-live/closes/pinnacle-americanfootball_nfl-20260913T1640Z.json";
  const T2_REL = "data/processed/nfl-live/closes/oddsapi-tier2-20260913T1640Z.json";

  function row(over: Partial<LedgerRow> & Pick<LedgerRow, "legId">): LedgerRow {
    return {
      role: "play",
      season: 2026,
      week: 1,
      boardFile: "board-2026-wk01.json",
      gameId: "2026_01_KC_PHI",
      matchup: "KC @ PHI",
      kickoffUtc: KICKOFF,
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

  function writeSnapshots(): void {
    fs.mkdirSync(path.join(root, path.dirname(PIN_REL)), { recursive: true });
    fs.writeFileSync(
      path.join(root, PIN_REL),
      JSON.stringify({ fetchedAt: CAPTURED, source: "pinnacle", events: [PIN_EVENT] }),
    );
    fs.writeFileSync(
      path.join(root, T2_REL),
      JSON.stringify({ fetchedAt: CAPTURED, events: [TIER2_EVENT] }),
    );
  }

  function ledgerWithClose(closeOver: Partial<Parameters<typeof recordClose>[2]> = {}): Ledger {
    const l = emptyLedger();
    upsertRow(l, "p1", row({ legId: "p1" }));
    recordClose(l, "p1", {
      book: "pinnacle",
      tier: 1,
      sideAmerican: -190,
      otherAmerican: 168,
      capturedAt: CAPTURED,
      minutesBeforeKickoff: 20,
      sourceFile: PIN_REL,
      ...closeOver,
    });
    return l;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "close-verify-"));
    writeSnapshots();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("round-trip: a genuinely captured close verifies", () => {
    const r = verifyCloses(ledgerWithClose(), root);
    expect(r.failures).toEqual([]);
    expect(r.verified).toBe(1);
  });

  it("a forged close price fails", () => {
    const r = verifyCloses(ledgerWithClose({ sideAmerican: -150 }), root);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toMatch(/mismatch/);
  });

  it("a close naming a missing sourceFile fails", () => {
    const r = verifyCloses(ledgerWithClose({ sourceFile: "data/processed/nfl-live/closes/ghost.json" }), root);
    expect(r.failures[0].reason).toMatch(/missing/);
  });

  it("a close whose capturedAt doesn't match the snapshot instant fails", () => {
    const r = verifyCloses(ledgerWithClose({ capturedAt: "2026-09-13T15:00:00Z" }), root);
    expect(r.failures[0].reason).toMatch(/capturedAt/);
  });

  it("tier-2 closes verify against the STORED book, and a book swap fails", () => {
    const ok = verifyCloses(
      ledgerWithClose({ book: "lowvig", tier: 2, sideAmerican: -188, otherAmerican: 172, sourceFile: T2_REL }),
      root,
    );
    expect(ok.failures).toEqual([]);
    // same prices, wrong book attribution → mismatch (lowvig ≠ betonlineag prices)
    const swapped = verifyCloses(
      ledgerWithClose({ book: "betonlineag", tier: 2, sideAmerican: -188, otherAmerican: 172, sourceFile: T2_REL }),
      root,
    );
    expect(swapped.failures).toHaveLength(1);
  });

  it("rows without a close are ignored", () => {
    const l = emptyLedger();
    upsertRow(l, "p1", row({ legId: "p1" }));
    const r = verifyCloses(l, root);
    expect(r.verified).toBe(0);
    expect(r.failures).toEqual([]);
  });
});
