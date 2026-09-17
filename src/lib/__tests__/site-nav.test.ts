import { describe, it, expect } from "vitest";
import {
  LEGACY_HASH_TARGETS,
  NAV,
  ROUTES,
  isActiveRoute,
  legacyHashTarget,
  normalizeFragment,
  splitTarget,
} from "../site-nav";

const TARGET_VALUES = new Set(Object.values(LEGACY_HASH_TARGETS));

describe("NAV", () => {
  it("is exactly the four routes, in the spec's order, with the spec's labels", () => {
    expect(NAV.map((n) => n.href)).toEqual(["/", "/nfl", "/experiments", "/desk"]);
    expect(NAV.map((n) => n.label)).toEqual(["Today", "NFL", "Experiments", "Desk"]);
  });

  it("has no duplicate hrefs or labels", () => {
    expect(new Set(NAV.map((n) => n.href)).size).toBe(NAV.length);
    expect(new Set(NAV.map((n) => n.label)).size).toBe(NAV.length);
  });
});

describe("LEGACY_HASH_TARGETS", () => {
  it("every target starts with / and its path is one of the four routes", () => {
    for (const target of Object.values(LEGACY_HASH_TARGETS)) {
      expect(target.startsWith("/")).toBe(true);
      expect(ROUTES.has(splitTarget(target).path)).toBe(true);
    }
  });

  it("has no key that is a route path — keys are bare fragment ids", () => {
    for (const key of Object.keys(LEGACY_HASH_TARGETS)) {
      expect(ROUTES.has(key)).toBe(false);
      expect(key.startsWith("/")).toBe(false);
      expect(key.includes("#")).toBe(false);
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("covers the six fragments in old X posts and the four spec extras", () => {
    expect(legacyHashTarget("#tonight")).toBe("/");
    expect(legacyHashTarget("#the-desk")).toBe("/desk");
    expect(legacyHashTarget("#props")).toBe("/desk#props-desk");
    expect(legacyHashTarget("#experiments")).toBe("/experiments");
    expect(legacyHashTarget("#operations")).toBe("/desk#market-feed");
    expect(legacyHashTarget("#nfl-week")).toBe("/nfl#market");
    expect(legacyHashTarget("#tonights-play")).toBe("/#today");
    expect(legacyHashTarget("#front-page")).toBe("/");
    expect(legacyHashTarget("#quant-desk-section")).toBe("/desk#quant-desk-section");
    expect(legacyHashTarget("#back-of-book")).toBe("/desk#system-memory");
  });
});

describe("legacyHashTarget", () => {
  it("accepts a bare id, a leading slash, mixed case, a full URL and a trailing query", () => {
    expect(legacyHashTarget("props")).toBe("/desk#props-desk");
    expect(legacyHashTarget("#/props")).toBe("/desk#props-desk");
    expect(legacyHashTarget("#PROPS")).toBe("/desk#props-desk");
    expect(legacyHashTarget("#The-Desk")).toBe("/desk");
    expect(legacyHashTarget("https://example.com/?a=1#operations")).toBe("/desk#market-feed");
    expect(legacyHashTarget("#props?ref=nfl")).toBe("/desk#props-desk");
    expect(legacyHashTarget("#experiments&x=1")).toBe("/experiments");
  });

  // NEGATIVE CONTROL — a fragment that exists in no table must return null,
  // never the home target. If junk ever resolved to a route, a crafted link
  // could steer a reader. Shown red once by adding `nope: "/"` to the table
  // (2026-09-12), then restored.
  it("returns null — never a route — for fragments that exist nowhere, empty, null, a script, or prototype keys", () => {
    for (const junk of [
      "#nope",
      "#nothing-here",
      "#",
      "",
      "   ",
      null,
      undefined,
      "#tonight-ish",
      "#the desk",
      "#javascript:alert(1)",
      "javascript:alert(1)",
      "#__proto__",
      "#constructor",
      "#hasOwnProperty",
      "#toString",
      "#%2Fdesk",
    ]) {
      const out = legacyHashTarget(junk);
      expect(out).toBeNull();
      expect(out === "/").toBe(false);
    }
  });

  // The NEW section ids on "/" are not legacy fragments: the shim must leave
  // /#today alone so the browser's own anchor scroll works.
  it("leaves the new section ids on / alone", () => {
    for (const id of ["#today", "#settled", "#account", "#ask", "#front-page-x"]) {
      expect(legacyHashTarget(id)).toBeNull();
    }
  });

  it("does not throw on a malformed percent-escape, and returns null", () => {
    expect(() => legacyHashTarget("#%E0%A4%A")).not.toThrow();
    expect(legacyHashTarget("#%E0%A4%A")).toBeNull();
  });

  it("rejects an oversized fragment without scanning it", () => {
    const huge = "#" + "props".padEnd(10_240, "x");
    expect(legacyHashTarget(huge)).toBeNull();
    expect(normalizeFragment("#" + "a".repeat(129))).toBeNull();
  });

  it("only ever returns a value from the literal table", () => {
    for (const input of ["#props", "#tonight", "#nfl-week", "#OPERATIONS", "#/experiments"]) {
      const out = legacyHashTarget(input);
      expect(out).not.toBeNull();
      expect(TARGET_VALUES.has(out as string)).toBe(true);
    }
  });
});

describe("splitTarget", () => {
  it("separates path and fragment, with an empty fragment when there is none", () => {
    expect(splitTarget("/desk#props-desk")).toEqual({ path: "/desk", hash: "props-desk" });
    expect(splitTarget("/")).toEqual({ path: "/", hash: "" });
    expect(splitTarget("/#today")).toEqual({ path: "/", hash: "today" });
  });
});

describe("isActiveRoute", () => {
  it("matches exactly, tolerates a trailing slash, and never marks / active elsewhere", () => {
    expect(isActiveRoute("/", "/")).toBe(true);
    expect(isActiveRoute("/nfl", "/nfl")).toBe(true);
    expect(isActiveRoute("/nfl/", "/nfl")).toBe(true);
    expect(isActiveRoute("/nfl", "/")).toBe(false);
    expect(isActiveRoute("/desk", "/experiments")).toBe(false);
    expect(isActiveRoute(null, "/")).toBe(false);
  });
});
