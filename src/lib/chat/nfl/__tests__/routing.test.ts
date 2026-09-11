// League pinning — the BLOCKER that ships with the mount.
//
// Every query below was REPRODUCED misrouting against the real committed
// September slate before the scope pin existed:
//   "Seattle Patriots Thursday night"  → lane B, league MLB (entity: seattle)
//   "what should I bet this week?"     → lane B, league MLB (slate-level)
//   "Houston moneyline this weekend"   → lane B, league MLB
//   "Baltimore -6.5 thoughts"          → lane B, league MLB
//   "is NYJ a good bet?"               → lane A persona (no grounding guard)
//   "give me a parlay"                 → lane A
// About 20 of the 32 NFL cities collide with a September MLB/NBA board, so an
// NFL asker on the receipts page could be handed a real MLB edge at a real
// price. Each one must now resolve to the receipts lane and NOTHING else.
//
// The slate fixture here is deliberately LOADED with the colliding teams: if
// the pin ever stops being checked first, entity matching will find them and
// these tests go red.

import { describe, it, expect } from "vitest";
import {
  buildSlateEntities,
  classifyDeterministic,
  detectOutOfScope,
  parseChatScope,
  type SlateEntities,
} from "../../router";

function collidingSlate(): SlateEntities {
  const ent: SlateEntities = { teams: new Map(), tokens: new Map(), players: new Map() };
  const mlb = [
    "seattle mariners",
    "houston astros",
    "baltimore orioles",
    "new york yankees",
    "philadelphia phillies",
    "kansas city royals",
    "detroit tigers",
    "cleveland guardians",
  ];
  for (const t of mlb) {
    ent.teams.set(t, "MLB");
    for (const tok of t.split(" ")) if (tok.length >= 4) ent.tokens.set(tok, "MLB");
  }
  ent.teams.set("los angeles lakers", "NBA");
  ent.tokens.set("lakers", "NBA");
  return ent;
}

const MISROUTED = [
  "what do you think about tonights football game",
  "Seattle Patriots Thursday night",
  "what should I bet this week?",
  "Houston moneyline this weekend",
  "Baltimore -6.5 thoughts",
  "is NYJ a good bet?",
  "give me a parlay",
  "is the +38.96% parlay ROI real?",
  "who's playing Sunday?",
  "why did you pass on Buffalo?",
];

describe("scope pin — every previously-misrouted query lands on the receipts lane", () => {
  const slate = collidingSlate();
  for (const q of MISROUTED) {
    it(`"${q}" → lane R under scope nfl`, () => {
      const d = classifyDeterministic(q, slate, "nfl");
      expect(d.lane).toBe("R");
      expect(d.reason).toBe("scope-pin:nfl");
      // Never a bettable league, never bets mode, never the stats lane.
      expect("league" in d).toBe(false);
      expect("mode" in d).toBe(false);
      expect("statsLeague" in d).toBe(false);
    });
  }
});

describe("scope pin — NEGATIVE CONTROL: without the pin these still misroute", () => {
  // This is the measurement, kept executable. If someone deletes the scope
  // check, the block above starts producing these results instead — and this
  // block is what proves the results above are caused by the pin and not by
  // some accident of the fixture.
  const slate = collidingSlate();
  it("MLB entity match still wins on the default scope", () => {
    const d = classifyDeterministic("Houston moneyline this weekend", slate, "default");
    expect(d.lane).toBe("B");
    expect("league" in d && d.league).toBe("MLB");
  });
  it("a bare NFL city still resolves to the MLB slate on the default scope", () => {
    const d = classifyDeterministic("Baltimore -6.5 thoughts", slate, "default");
    expect(d.lane).toBe("B");
    expect("league" in d && d.league).toBe("MLB");
  });
});

describe("scope pin — the homepage lane is untouched", () => {
  const slate = collidingSlate();
  it("default scope is the default argument (no call site changes required)", () => {
    expect(classifyDeterministic("what's CLV?", slate)).toEqual(
      classifyDeterministic("what's CLV?", slate, "default")
    );
  });
  it("an NFL question on the DEFAULT scope routes to the receipts lane (NFL in scope 2026-09-10)", () => {
    // Before 2026-09-10 this landed in Lane B stats mode. NFL is bettable now and
    // is answered on the same receipts lane /nfl mounts — from every page.
    const d = classifyDeterministic("what are the Chiefs standings", slate, "default");
    expect(d.lane).toBe("R");
    expect(d.reason).toBe("nfl-receipts");
  });
});

describe("parseChatScope — validated, never cast", () => {
  it("accepts the one known scope", () => {
    expect(parseChatScope("nfl")).toBe("nfl");
  });
  it("falls back to default for everything else", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "NFL",
      "mlb",
      "nfl ",
      0,
      1,
      true,
      {},
      [],
      ["nfl"],
      { scope: "nfl" },
    ]) {
      expect(parseChatScope(bad)).toBe("default");
    }
  });
});

// ── 2026-09-10: NFL joins IN_SCOPE_LEAGUES ──────────────────────────────────
//
// Making NFL bettable must NOT re-open the collision above. The homepage
// (default scope) now answers NFL on the SAME receipts lane /nfl mounts — via
// the scope class (detectOutOfScope → "receipts"), never via the slate index.
// Two invariants: (1) an NFL ask on the default scope lands on lane R; (2) NFL
// team names never enter the slate-entity index, so "Seattle" on a September
// board still means the Mariners to Lane B and an NFL question never reaches it.
describe("default scope — NFL is answered on the receipts lane, not the slate index", () => {
  it("an explicit NFL ask on the default scope routes to lane R", () => {
    for (const q of [
      "who do you like in the Chiefs game?",
      "NFL best bets this week",
      "Cowboys moneyline Sunday",
    ]) {
      const d = classifyDeterministic(q, collidingSlate(), "default");
      expect(d.lane, q).toBe("R");
    }
    expect(detectOutOfScope("Cowboys moneyline Sunday")?.kind).toBe("receipts");
  });

  it("an MLB full-name hit still wins over an NFL nickname (entity-first precedence preserved)", () => {
    const d = classifyDeterministic(
      "parlay the Yankees ML with the Chiefs tonight",
      collidingSlate(),
      "default",
    );
    expect(d.lane).toBe("B");
    if (d.lane === "B" && !("mode" in d)) expect(d.league).toBe("MLB");
  });

  it("NFL teams are never indexed as Lane-B entities even though NFL is in scope", () => {
    const ent = buildSlateEntities({
      odds: ((lg: string) => ({
        fetchedAt: null,
        events:
          lg === "NFL"
            ? [{ homeTeam: "Seattle Seahawks", awayTeam: "New England Patriots" }]
            : lg === "MLB"
              ? [{ homeTeam: "Seattle Mariners", awayTeam: "Houston Astros" }]
              : [],
      })) as never,
      props: (() => ({ available: false, topProps: [] })) as never,
      hrLikes: (() => []) as never,
    });
    expect(ent.teams.has("seattle seahawks")).toBe(false);
    expect(ent.tokens.get("seattle")).toBe("MLB");
    expect(ent.tokens.has("seahawks")).toBe(false);
    expect(ent.tokens.has("patriots")).toBe(false);
  });
});
