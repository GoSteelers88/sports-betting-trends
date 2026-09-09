import { describe, it, expect } from "vitest";
import {
  DEFAULT_TAB,
  TABS,
  isTab,
  parseTabHash,
  tabHref,
} from "../site-tabs";

describe("parseTabHash", () => {
  it("resolves every tab id from its own href", () => {
    for (const t of TABS) {
      expect(parseTabHash(tabHref(t.id))).toBe(t.id);
    }
  });

  it("accepts a bare id, a leading slash, and mixed case", () => {
    expect(parseTabHash("props")).toBe("props");
    expect(parseTabHash("#/props")).toBe("props");
    expect(parseTabHash("#PROPS")).toBe("props");
    expect(parseTabHash("#The-Desk")).toBe("the-desk");
  });

  it("takes the hash out of a full URL", () => {
    expect(parseTabHash("https://example.com/?a=1#operations")).toBe("operations");
  });

  it("stops at a query or a nested fragment", () => {
    expect(parseTabHash("#props?ref=nfl")).toBe("props");
    expect(parseTabHash("#experiments&x=1")).toBe("experiments");
  });

  // NEGATIVE CONTROL — the whole point of returning null is that an unknown
  // fragment must NOT be answered with the default tab. If this ever returns
  // "tonight", a section deep link like /#nfl-week silently resets the view
  // and the check above stops proving anything.
  it("returns null — never the default — for a section anchor or junk", () => {
    for (const junk of [
      "#nfl-week",
      "#quant-desk-section",
      "#back-of-book",
      "#",
      "",
      "   ",
      null,
      undefined,
      "#tonight-ish",
      "#the desk",
    ]) {
      expect(parseTabHash(junk)).toBeNull();
    }
    expect(parseTabHash("#nfl-week")).not.toBe(DEFAULT_TAB);
  });

  it("does not throw on a malformed percent-escape", () => {
    expect(() => parseTabHash("#%E0%A4%A")).not.toThrow();
  });
});

describe("isTab", () => {
  it("accepts exactly the five ids and nothing else", () => {
    expect(TABS).toHaveLength(5);
    for (const t of TABS) expect(isTab(t.id)).toBe(true);
    for (const x of ["", "Tonight", "desk", 1, null, undefined, {}]) {
      expect(isTab(x)).toBe(false);
    }
  });

  it("keeps the default inside the set", () => {
    expect(isTab(DEFAULT_TAB)).toBe(true);
  });
});

describe("tabHref", () => {
  it("builds a same-page fragment link to the homepage", () => {
    expect(tabHref("props")).toBe("/#props");
    expect(tabHref("the-desk")).toBe("/#the-desk");
  });

  it("has one entry per unique id and no duplicate labels", () => {
    expect(new Set(TABS.map((t) => t.id)).size).toBe(TABS.length);
    expect(new Set(TABS.map((t) => t.num)).size).toBe(TABS.length);
  });
});
