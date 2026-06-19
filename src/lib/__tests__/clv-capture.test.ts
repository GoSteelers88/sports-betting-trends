// Tests for captureClv's convergence-to-close behavior — the load-bearing
// fix for the funding gate. The original bug: the FIRST pre-tip sweep froze an
// opening-ish line as the "close" and was never revisited. These tests drive a
// pick through several sweeps at decreasing minutes-before-tip and assert that:
//   1. each sweep overwrites only with a reading STRICTLY closer to tip,
//   2. a FARTHER reading can never win (the atomic WHERE-clause distance gate),
//   3. the value is finalized only at in-play, and an in-play price NEVER lands,
//   4. an unmatched pick is finalized at in-play with clvCents left null.
//
// Prisma and the closing-odds file are mocked; time is driven with fake timers.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Row = {
  id: number;
  league: string;
  matchup: string;
  selection: string;
  oddsAmerican: number;
  market: string;
  gameDate: Date;
  clvCents: number | null;
  closingOddsAmerican: number | null;
  clvCapturedAt: Date | null;
  clvReadingMinutesBeforeTip: number | null;
  clvFinal: boolean;
};

// Hoisted mutable state the module mocks read from (vi.mock factories are
// hoisted above imports, so they can only see vi.hoisted state).
const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  oddsJson: null as string | null,
}));

vi.mock("node:fs", () => {
  const api = {
    existsSync: () => h.oddsJson !== null,
    readFileSync: () => h.oddsJson as string,
  };
  return { default: api, ...api };
});

vi.mock("../prisma", () => ({
  prisma: {
    agentPick: {
      // Implements exactly the where-shapes captureClv uses: clvFinal flag,
      // market { not }, and gameDate { lte, gte }. Returns COPIES so the
      // in-loop snapshot semantics match real Prisma (the fetched array does
      // not see concurrent updates).
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const rows = h.rows as Row[];
        return rows
          .filter(p => {
            if (where.clvFinal !== undefined && p.clvFinal !== where.clvFinal) return false;
            const market = where.market as { not?: string } | undefined;
            if (market?.not && p.market === market.not) return false;
            const gd = where.gameDate as { lte?: Date; gte?: Date } | undefined;
            if (gd) {
              const t = p.gameDate.getTime();
              if (gd.lte && t > gd.lte.getTime()) return false;
              if (gd.gte && t < gd.gte.getTime()) return false;
            }
            return true;
          })
          .map(p => ({ ...p }));
      },
      // Implements the id + clvFinal guard plus the optional OR distance gate
      // [{ clvReadingMinutesBeforeTip: null }, { ...: { gt } }]. Mutates the
      // backing store and returns { count } like Prisma.
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const rows = h.rows as Row[];
        let count = 0;
        for (const p of rows) {
          if (p.id !== where.id) continue;
          if (where.clvFinal !== undefined && p.clvFinal !== where.clvFinal) continue;
          const or = where.OR as Array<Record<string, unknown>> | undefined;
          if (or) {
            const ok = or.some(cond => {
              const c = cond.clvReadingMinutesBeforeTip as null | { gt: number } | undefined;
              if (c === null) return p.clvReadingMinutesBeforeTip === null;
              if (c && typeof c === "object" && "gt" in c) {
                return p.clvReadingMinutesBeforeTip !== null && p.clvReadingMinutesBeforeTip > c.gt;
              }
              return false;
            });
            if (!ok) continue;
          }
          Object.assign(p, data);
          count++;
        }
        return { count };
      },
    },
  },
}));

import { captureClv } from "../clv-tracker";

const TIP = new Date("2026-06-11T23:00:00.000Z");

function basePick(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    league: "NBA",
    matchup: "Philadelphia 76ers @ New York Knicks",
    selection: "New York Knicks",
    oddsAmerican: -110,
    market: "ml",
    gameDate: TIP,
    clvCents: null,
    closingOddsAmerican: null,
    clvCapturedAt: null,
    clvReadingMinutesBeforeTip: null,
    clvFinal: false,
    ...overrides,
  };
}

// Set the mocked closing-odds file with a chosen Knicks price, stamped fresh at
// the current (fake) time so loadClosingOdds doesn't flag it stale.
function setOdds(knicksPrice: number) {
  h.oddsJson = JSON.stringify({
    fetchedAt: new Date().toISOString(),
    league: "NBA",
    eventCount: 1,
    events: [
      {
        id: "evt1",
        commence_time: TIP.toISOString(),
        home_team: "New York Knicks",
        away_team: "Philadelphia 76ers",
        bookmakers: [
          {
            key: "fanduel",
            markets: [
              {
                key: "h2h",
                outcomes: [
                  { name: "New York Knicks", price: knicksPrice },
                  { name: "Philadelphia 76ers", price: 100 },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

// Run one sweep "at" minutesBeforeTip relative to TIP (negative = in-play).
async function sweepAt(minutesBeforeTip: number, knicksPrice: number) {
  vi.setSystemTime(new Date(TIP.getTime() - minutesBeforeTip * 60_000));
  setOdds(knicksPrice);
  return captureClv();
}

describe("captureClv convergence-to-close", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.rows = [basePick()];
    h.oddsJson = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the reading closest to tip and finalizes only at in-play", async () => {
    const row = () => (h.rows as Row[])[0];

    // Sweep 1 @ 85 min: Knicks -130 → clv = -110 - (-130) = +20. First lands.
    await sweepAt(85, -130);
    expect(row().clvCents).toBe(20);
    expect(row().clvReadingMinutesBeforeTip).toBe(85);
    expect(row().clvFinal).toBe(false);

    // Sweep 2 @ 50 min: Knicks -120 → clv = +10. Closer → overwrites.
    await sweepAt(50, -120);
    expect(row().clvCents).toBe(10);
    expect(row().clvReadingMinutesBeforeTip).toBe(50);
    expect(row().clvFinal).toBe(false);

    // Sweep 3 @ 12 min: Knicks -105 → clv = -5. Closer → overwrites, still not final.
    await sweepAt(12, -105);
    expect(row().clvCents).toBe(-5);
    expect(row().clvReadingMinutesBeforeTip).toBe(12);
    expect(row().clvFinal).toBe(false);

    // Sweep 4 @ in-play (-5 min): a wild price must NOT land; value freezes.
    await sweepAt(-5, 200);
    expect(row().clvCents).toBe(-5); // unchanged — in-play price never stored
    expect(row().clvReadingMinutesBeforeTip).toBe(12);
    expect(row().clvFinal).toBe(true); // finalized at in-play
  });

  it("never lets a FARTHER reading overwrite a closer one (atomic distance gate)", async () => {
    // Seed an already-captured pick with a 12-min reading.
    h.rows = [basePick({ clvCents: -5, clvReadingMinutesBeforeTip: 12, closingOddsAmerican: -105 })];
    const row = () => (h.rows as Row[])[0];

    // A sweep at 40 min (farther from tip) with a very different price must be
    // rejected by the WHERE-clause distance gate (12 is not > 40, not null).
    await sweepAt(40, -200);
    expect(row().clvCents).toBe(-5);
    expect(row().clvReadingMinutesBeforeTip).toBe(12);
    expect(row().clvFinal).toBe(false);
  });

  it("finalizes an unmatched pick at in-play with clvCents left null", async () => {
    h.rows = [basePick({ matchup: "Los Angeles Lakers @ Boston Celtics", selection: "Boston Celtics" })];
    const row = () => (h.rows as Row[])[0];

    // Pre-tip sweep: the odds file has no Lakers/Celtics event → unmatched.
    const pre = await sweepAt(30, -110);
    expect(pre.unmatched).toBe(1);
    expect(row().clvCents).toBeNull();
    expect(row().clvFinal).toBe(false);

    // In-play sweep: finalize so we stop re-scanning, but never invent a close.
    await sweepAt(-5, -110);
    expect(row().clvCents).toBeNull();
    expect(row().clvFinal).toBe(true);
  });
});
