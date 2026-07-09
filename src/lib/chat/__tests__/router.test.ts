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
  buildSlateEntities,
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
  // WNBA matchup tonight (bettable tier)
  for (const t of ["las vegas aces", "new york liberty"]) {
    ent.teams.set(t, "WNBA");
    for (const tok of t.split(" ")) if (tok.length >= 4) ent.tokens.set(tok, "WNBA");
  }
  ent.players.set("aaron judge", "MLB");
  ent.players.set("anthony davis", "NBA");
  ent.players.set("a'ja wilson", "WNBA");
  return ent;
}

describe("scope gate — three-tier league model", () => {
  it("classifies NFL as STATS-ONLY (standings-nfl exists, not bettable)", () => {
    const oos = detectOutOfScope("who do you like in the Chiefs game?");
    expect(oos?.kind).toBe("stats-only");
    if (oos?.kind === "stats-only") {
      expect(oos.sport).toBe("NFL");
      expect(oos.statsLeague).toBe("NFL");
    }
  });
  it("classifies NHL / college-basketball as STATS-ONLY with the right StatsLeague", () => {
    const nhl = detectOutOfScope("what about the Stanley Cup final");
    expect(nhl?.kind).toBe("stats-only");
    if (nhl?.kind === "stats-only") expect(nhl.statsLeague).toBe("NHL");

    const ncaab = detectOutOfScope("give me a March Madness pick");
    expect(ncaab?.kind).toBe("stats-only");
    if (ncaab?.kind === "stats-only") expect(ncaab.statsLeague).toBe("NCAAB");

    // Explicit "college basketball" and bare "college"/"ncaa" → NCAAB.
    const cbb = detectOutOfScope("how's this college basketball team?");
    expect(cbb?.kind).toBe("stats-only");
    if (cbb?.kind === "stats-only") expect(cbb.statsLeague).toBe("NCAAB");
  });
  it("classifies SOCCER as REFUSE (data exists but drops draws → false records)", () => {
    // Every soccer flavor now refuses — no more EPL/MLS/UCL stats-only tier.
    for (const q of [
      "any value in the Premier League today?",
      "what's the MLS standings look like?",
      "show me the Champions League table",
      "who wins in La Liga?",
      "any soccer picks?",
    ]) {
      const d = detectOutOfScope(q);
      expect(d?.kind).toBe("refuse");
      if (d?.kind === "refuse") expect(d.sport).toBe("soccer");
    }
  });
  it("classifies NCAAF / college football as REFUSE (no data), NOT NCAAB basketball", () => {
    for (const q of ["give me a college football pick", "any NCAAF plays?", "cfb best bet"]) {
      const d = detectOutOfScope(q);
      expect(d?.kind).toBe("refuse");
      if (d?.kind === "refuse") expect(d.sport).toBe("college football");
    }
  });
  it("classifies golf / tennis / UFC as REFUSE (no data at all)", () => {
    expect(detectOutOfScope("who wins the Masters?")?.kind).toBe("refuse");
    expect(detectOutOfScope("any Wimbledon picks?")?.kind).toBe("refuse");
    expect(detectOutOfScope("give me a UFC parlay")?.kind).toBe("refuse");
    const golf = detectOutOfScope("who wins the Masters?");
    expect(golf?.kind).toBe("refuse");
    if (golf?.kind === "refuse") expect(golf.sport).toBe("golf");
  });
  it("does NOT flag a bettable-league question (NBA/MLB/WNBA)", () => {
    expect(detectOutOfScope("what do you think of the Lakers?")).toBeNull();
    expect(detectOutOfScope("what's CLV?")).toBeNull();
    // WNBA is bettable now — must NOT be flagged out of scope.
    expect(detectOutOfScope("any WNBA plays tonight?")).toBeNull();
  });
  it("routes a REFUSED sport to Lane A with the out-of-scope marker, no analysis", () => {
    const d = classifyDeterministic("who wins the Masters this weekend?", slate());
    expect(d.lane).toBe("A");
    expect("outOfScope" in d && d.outOfScope).toBe(true);
  });
  it("routes a STATS-ONLY league to Lane B in stats mode (NOT a refusal)", () => {
    const d = classifyDeterministic("what are the Chiefs' standings?", slate());
    expect(d.lane).toBe("B");
    expect("mode" in d && d.mode).toBe("stats");
    if (d.lane === "B" && "mode" in d) {
      expect(d.statsLeague).toBe("NFL");
      expect(d.reason).toBe("stats-only:NFL");
    }
    // NHL / soccer likewise reach Lane B stats mode.
    const nhl = classifyDeterministic("how do the Bruins look this year in hockey?", slate());
    expect(nhl.lane).toBe("B");
    expect("mode" in nhl && nhl.mode).toBe("stats");
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
    if (d.lane === "B" && !("mode" in d)) expect(d.league).toBe("MLB");
  });
  it("does not match a team that is NOT on tonight's slate", () => {
    expect(matchSlateEntity("what about the Miami Heat?", slate())).toBeNull();
  });
  it("matches a WNBA team on the slate and routes to Lane B (WNBA is bettable)", () => {
    const m = matchSlateEntity("what's your read on the Aces tonight?", slate());
    expect(m?.league).toBe("WNBA");
    const d = classifyDeterministic("do you like the Liberty moneyline tonight?", slate());
    expect(d.lane).toBe("B");
    if (d.lane === "B" && !("mode" in d)) expect(d.league).toBe("WNBA");
  });
  it("matches a WNBA player on the slate", () => {
    const m = matchSlateEntity("is A'ja Wilson a good over tonight?", slate());
    expect(m?.league).toBe("WNBA");
  });
});

describe("mixed-league message → bettable entity wins (SHOULD-FIX 3)", () => {
  it("'parlay the Yankees ML with the Chiefs' routes to bets Lane B (MLB), not NFL stats", () => {
    // Names a bettable entity (Yankees, on the board) AND a stats-only scope word
    // (Chiefs → NFL). The bettable read must take precedence.
    const d = classifyDeterministic(
      "parlay the Yankees ML with the Chiefs tonight",
      slate()
    );
    expect(d.lane).toBe("B");
    // It is the BETS-mode variant (no `mode` discriminant), on MLB.
    expect("mode" in d).toBe(false);
    if (d.lane === "B" && !("mode" in d)) {
      expect(d.league).toBe("MLB");
      expect(d.matchedEntities).toContain("yankees");
    }
  });
  it("a PURE stats-only ask (no bettable entity) still routes to stats mode", () => {
    const d = classifyDeterministic("what are the Chiefs' standings?", slate());
    expect(d.lane).toBe("B");
    expect("mode" in d && d.mode).toBe("stats");
    if (d.lane === "B" && "mode" in d) expect(d.statsLeague).toBe("NFL");
  });
});

describe("FIX 4 — shared-nickname collision yields to the scope class", () => {
  // Put the Texas Rangers (MLB) on tonight's board so "rangers" is a token hit.
  // "Rangers" is ALSO the NY Rangers (NHL) nickname → SHARED_OOS_NICKNAMES.
  function rangersSlate(): SlateEntities {
    const ent: SlateEntities = { teams: new Map(), tokens: new Map(), players: new Map() };
    for (const t of ["texas rangers", "houston astros"]) {
      ent.teams.set(t, "MLB");
      for (const tok of t.split(" ")) if (tok.length >= 4) ent.tokens.set(tok, "MLB");
    }
    for (const t of ["los angeles lakers", "boston celtics"]) {
      ent.teams.set(t, "NBA");
      for (const tok of t.split(" ")) if (tok.length >= 4) ent.tokens.set(tok, "NBA");
    }
    return ent;
  }

  it("'Rangers puck line tonight?' → NHL stats mode, NOT MLB bets mode", () => {
    // "rangers" is a token hit for MLB, but "puck line" trips the NHL scope gate
    // and "rangers" is a shared OOS nickname → the scope class wins.
    const d = classifyDeterministic("Rangers puck line tonight?", rangersSlate());
    expect(d.lane).toBe("B");
    expect("mode" in d && d.mode).toBe("stats");
    if (d.lane === "B" && "mode" in d) expect(d.statsLeague).toBe("NHL");
  });

  it("'...Rangers in the NHL playoffs?' → NHL stats mode, not MLB bets", () => {
    const d = classifyDeterministic(
      "how do the Rangers look in the NHL playoffs?",
      rangersSlate()
    );
    expect(d.lane).toBe("B");
    expect("mode" in d && d.mode).toBe("stats");
    if (d.lane === "B" && "mode" in d) expect(d.statsLeague).toBe("NHL");
  });

  it("matchSlateEntity flags a shared-nickname token-only hit", () => {
    const m = matchSlateEntity("Rangers puck line tonight?", rangersSlate());
    expect(m?.tier).toBe("token");
    expect(m?.sharedOosToken).toBe(true);
  });

  it("full-name/player precedence preserved: 'parlay the Yankees ML with the Chiefs' → MLB bets", () => {
    // "yankees" is token-tier but NOT a shared OOS nickname, so even though
    // "Chiefs" trips the NFL gate, the bettable MLB read wins.
    const d = classifyDeterministic(
      "parlay the Yankees ML with the Chiefs tonight",
      slate()
    );
    expect(d.lane).toBe("B");
    expect("mode" in d).toBe(false);
    if (d.lane === "B" && !("mode" in d)) {
      expect(d.league).toBe("MLB");
      expect(d.matchedEntities).toContain("yankees");
    }
  });

  it("a non-shared token hit is NOT flagged sharedOosToken", () => {
    const m = matchSlateEntity("parlay the Yankees ML with the Chiefs", slate());
    expect(m?.tier).toBe("token");
    expect(m?.sharedOosToken).toBe(false);
  });
});

describe("shared-city token precedence: MLB(3) > NBA(2) > WNBA(1) (SHOULD-FIX 4)", () => {
  // Build the slate via buildSlateEntities with injected odds so addTeam/setRanked
  // actually run. "chicago" is a token shared by the MLB Cubs and the WNBA Sky;
  // indexing order is NBA, MLB, WNBA — the naive last-writer-wins would leave
  // "chicago" as WNBA. setRanked must keep it MLB.
  function collisionSlate(): SlateEntities {
    const byLeague: Record<string, Array<{ homeTeam: string; awayTeam: string }>> = {
      NBA: [{ homeTeam: "Golden State Warriors", awayTeam: "Phoenix Suns" }],
      MLB: [{ homeTeam: "Chicago Cubs", awayTeam: "Milwaukee Brewers" }],
      WNBA: [{ homeTeam: "Chicago Sky", awayTeam: "Atlanta Dream" }],
    };
    return buildSlateEntities({
      odds: ((lg: string) => ({
        fetchedAt: null,
        events: byLeague[lg] ?? [],
      })) as never,
      props: (() => ({ available: false, topProps: [] })) as never,
      hrLikes: (() => []) as never,
    });
  }

  it("'chicago' resolves to MLB (Cubs), not clobbered to WNBA (Sky)", () => {
    const ent = collisionSlate();
    expect(ent.tokens.get("chicago")).toBe("MLB");
    const m = matchSlateEntity("what's your read on chicago tonight?", ent);
    expect(m?.league).toBe("MLB");
  });

  it("a WNBA-only token is still WNBA (no false promotion)", () => {
    const ent = collisionSlate();
    // "dream" is a WNBA-only nickname token here → stays WNBA.
    expect(ent.tokens.get("dream")).toBe("WNBA");
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
    if (d.lane === "B" && !("mode" in d)) {
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
