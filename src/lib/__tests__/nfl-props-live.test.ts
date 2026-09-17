import { describe, it, expect } from "vitest";
import { selectBestLines, toPropPicks, impliedProb, type OddsEvent } from "../nfl-props-live";

const resolve = (p: string) =>
  p === "Jared Goff" ? { team: "DET", position: "QB" } : { team: "BUF", position: "QB" };

function ev(books: Array<{ key: string; point: number; price: number; side?: string }>): OddsEvent {
  return {
    id: "e1", home_team: "Buffalo Bills", away_team: "Detroit Lions",
    bookmakers: books.map((b) => ({
      key: b.key,
      markets: [{ key: "player_pass_yds", outcomes: [{ description: "Jared Goff", name: b.side ?? "Over", point: b.point, price: b.price }] }],
    })),
  };
}

describe("selectBestLines", () => {
  it("takes the LOWEST point for an over", () => {
    const out = selectBestLines(ev([
      { key: "dk", point: 266.5, price: -113 },
      { key: "fd", point: 259.5, price: -115 },
      { key: "mgm", point: 270.5, price: -105 },
    ]), resolve);
    expect(out).toHaveLength(1);
    expect(out[0].point).toBe(259.5);
    expect(out[0].book).toBe("fd");
    expect(out[0].booksOffering).toBe(3);
  });

  it("takes the HIGHEST point for an under", () => {
    const out = selectBestLines(ev([
      { key: "dk", point: 266.5, price: -113, side: "Under" },
      { key: "fd", point: 259.5, price: -115, side: "Under" },
      { key: "mgm", point: 270.5, price: -105, side: "Under" },
    ]), resolve);
    expect(out[0].point).toBe(270.5);
    expect(out[0].book).toBe("mgm");
  });

  // NEGATIVE CONTROL: point must dominate price. A juicier price on a worse
  // number must NOT win, or "best line" silently means "best price".
  it("does not let a better price override a worse number", () => {
    const out = selectBestLines(ev([
      { key: "good", point: 250.5, price: -120 },
      { key: "trap", point: 275.5, price: +150 },
    ]), resolve);
    expect(out[0].point).toBe(250.5);
    expect(out[0].book).toBe("good");
  });

  it("breaks an exact tie on price, American-correct (+150 beats -110)", () => {
    const out = selectBestLines(ev([
      { key: "a", point: 260.5, price: -110 },
      { key: "b", point: 260.5, price: +150 },
    ]), resolve);
    expect(out[0].book).toBe("b");
    expect(out[0].priceAmerican).toBe(150);
  });

  it("prefers -110 over -200 at the same number", () => {
    const out = selectBestLines(ev([
      { key: "a", point: 260.5, price: -200 },
      { key: "b", point: 260.5, price: -110 },
    ]), resolve);
    expect(out[0].book).toBe("b");
  });

  it("ignores unknown markets and malformed outcomes", () => {
    const e: OddsEvent = {
      bookmakers: [{
        key: "dk",
        markets: [
          { key: "h2h", outcomes: [{ description: "Jared Goff", name: "Over", point: 1, price: -110 }] },
          { key: "player_pass_yds", outcomes: [
            { description: "", name: "Over", point: 260.5, price: -110 },
            { description: "Jared Goff", name: "Yes", point: 260.5, price: -110 },
            { description: "Jared Goff", name: "Over", price: -110 },
          ] },
        ],
      }],
    };
    expect(selectBestLines(e, resolve)).toHaveLength(0);
  });

  it("keeps over and under as separate rows", () => {
    const e: OddsEvent = {
      bookmakers: [{ key: "dk", markets: [{ key: "player_pass_yds", outcomes: [
        { description: "Jared Goff", name: "Over", point: 260.5, price: -110 },
        { description: "Jared Goff", name: "Under", point: 260.5, price: -110 },
      ] }] }],
    };
    expect(selectBestLines(e, resolve)).toHaveLength(2);
  });

  it("resolves team and position for grading", () => {
    const out = selectBestLines(ev([{ key: "dk", point: 260.5, price: -110 }]), resolve);
    expect(out[0].team).toBe("DET");
    expect(out[0].position).toBe("QB");
  });
});

describe("impliedProb", () => {
  it("converts American odds correctly", () => {
    expect(impliedProb(+100)).toBeCloseTo(0.5, 6);
    expect(impliedProb(-110)).toBeCloseTo(0.5238, 4);
    expect(impliedProb(+150)).toBeCloseTo(0.4, 6);
    expect(impliedProb(-200)).toBeCloseTo(0.6667, 4);
  });
});

describe("toPropPicks", () => {
  it("carries the market's implied probability as confidence, not a fabricated one", () => {
    const out = toPropPicks(selectBestLines(ev([{ key: "dk", point: 260.5, price: -110 }]), resolve));
    expect(out[0].confidence).toBeCloseTo(0.5238, 4);
    expect(out[0].threshold).toBe(260.5);
    expect(out[0].rationale).toContain("best line");
  });
});
