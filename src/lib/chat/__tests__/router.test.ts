// Router: specific-game question → Lane B; general question → Lane A; scope gate
// → out-of-scope; ambiguity → tiebreaker. The deterministic core takes an
// injected slate, so no I/O and no model calls here.

import { describe, it, expect } from "vitest";
import {
  detectOutOfScope,
  matchSlateEntity,
  looksGameSpecific,
  looksSlateLevel,
  primaryLeagueWithGames,
  classifyDeterministic,
  type SlateEntities,
} from "../router";

function slate(): SlateEntities {
  const ent: SlateEntities = { teams: new Map(), tokens: new Map(), players: new Map() };
  // NBA matchup tonight
  for (const t of ["los angeles lakers", "boston celtics"]) {
    ent.teams.set(t, "NBA");
    for (const tok of t.split(" ")) if (tok.length >= 4) ent.tokens.set(tok, "NBA");
  }
  // MLB matchup tonight
  for (const t of ["new york yankees", "houston astros"]) {
    ent.teams.set(t, "MLB");
    for (const tok of t.split(" ")) if (tok.length >= 4) ent.tokens.set(tok, "MLB");
  }
  ent.players.set("aaron judge", "MLB");
  ent.players.set("anthony davis", "NBA");
  return ent;
}

describe("scope gate", () => {
  it("flags NFL as research (soft)", () => {
    const oos = detectOutOfScope("who do you like in the Chiefs game?");
    expect(oos?.sport).toBe("NFL");
    expect(oos?.nflResearch).toBe(true);
  });
  it("flags soccer / NHL / college as off-desk", () => {
    expect(detectOutOfScope("any value in the Premier League today?")?.sport).toBe("soccer");
    expect(detectOutOfScope("what about the Stanley Cup final")?.sport).toBe("NHL / hockey");
    expect(detectOutOfScope("give me a March Madness pick")?.sport).toBe("college");
  });
  it("does not flag a plain NBA/MLB question", () => {
    expect(detectOutOfScope("what do you think of the Lakers?")).toBeNull();
    expect(detectOutOfScope("what's CLV?")).toBeNull();
  });
  it("routes an out-of-scope question to Lane A with the out-of-scope marker, no analysis", () => {
    const d = classifyDeterministic("who wins the soccer match tonight?", slate());
    expect(d.lane).toBe("A");
    expect("outOfScope" in d && d.outOfScope).toBe(true);
  });
});

describe("entity match → Lane B", () => {
  it("matches a team on tonight's slate and picks the right league", () => {
    const m = matchSlateEntity("what's your read on the Lakers tonight?", slate());
    expect(m?.league).toBe("NBA");
  });
  it("matches an MLB player on the slate", () => {
    const m = matchSlateEntity("should I take Aaron Judge to go yard?", slate());
    expect(m?.league).toBe("MLB");
  });
  it("a specific-game question routes to Lane B", () => {
    const d = classifyDeterministic("do you like the Yankees moneyline tonight?", slate());
    expect(d.lane).toBe("B");
    if (d.lane === "B") expect(d.league).toBe("MLB");
  });
  it("does not match a team that is NOT on tonight's slate", () => {
    expect(matchSlateEntity("what about the Miami Heat?", slate())).toBeNull();
  });
});

describe("general question → Lane A", () => {
  it("'what's CLV?' is Lane A, no entity", () => {
    const d = classifyDeterministic("what's CLV?", slate());
    expect(d.lane).toBe("A");
    expect("outOfScope" in d).toBe(false);
  });
  it("'what's your bankroll rule?' is Lane A", () => {
    const d = classifyDeterministic("what's your bankroll rule?", slate());
    expect(d.lane).toBe("A");
  });
  it("'why do you pass so much?' is Lane A", () => {
    const d = classifyDeterministic("why do you pass on so many games?", slate());
    expect(d.lane).toBe("A");
  });
});

describe("slate-level intent → Lane B (the board survey)", () => {
  it("'what's tonight's best play?' routes to Lane B, NOT a clueless Lane A", () => {
    expect(looksSlateLevel("what's tonight's best play?")).toBe(true);
    const d = classifyDeterministic("what's tonight's best play?", slate());
    expect(d.lane).toBe("B");
    if (d.lane === "B") {
      expect(d.matchedEntities).toEqual([]); // no specific entity → slate survey
      expect(d.reason).toBe("slate-level");
    }
  });
  it("'what do you like tonight?' and 'any plays?' are slate-level Lane B", () => {
    expect(classifyDeterministic("what do you like tonight?", slate()).lane).toBe("B");
    expect(classifyDeterministic("got any plays for me?", slate()).lane).toBe("B");
    expect(classifyDeterministic("give me your best bet tonight", slate()).lane).toBe("B");
    expect(classifyDeterministic("who do you like tonight?", slate()).lane).toBe("B");
  });
  it("picks the league with more games on the board", () => {
    // slate() has 2 NBA + 2 MLB teams → tie → defaults MLB.
    expect(primaryLeagueWithGames(slate())).toBe("MLB");
    const nbaHeavy: SlateEntities = { teams: new Map([["los angeles lakers", "NBA"], ["boston celtics", "NBA"], ["miami heat", "NBA"], ["denver nuggets", "NBA"]]), tokens: new Map(), players: new Map() };
    expect(primaryLeagueWithGames(nbaHeavy)).toBe("NBA");
  });
  it("falls through (not Lane B) when the board is EMPTY", () => {
    const empty: SlateEntities = { teams: new Map(), tokens: new Map(), players: new Map() };
    const d = classifyDeterministic("what's the best play tonight?", empty);
    expect(d.lane).toBe("A"); // no games → honest persona answer, not a survey of nothing
  });
  it("a definition question is NOT slate-level", () => {
    expect(looksSlateLevel("what is expected value?")).toBe(false);
    expect(looksSlateLevel("what's CLV?")).toBe(false);
  });
});

describe("ambiguity fallback", () => {
  it("game-specific phrasing with no entity and not slate-level → ambiguous (defer to Haiku)", () => {
    expect(looksGameSpecific("should I bet the over?")).toBe(true);
    expect(looksSlateLevel("should I bet the over?")).toBe(false);
    const d = classifyDeterministic("should I bet the over?", slate());
    expect("ambiguous" in d && d.ambiguous).toBe(true);
  });
  it("a plain definition question is NOT game-specific", () => {
    expect(looksGameSpecific("what is expected value?")).toBe(false);
  });
});
