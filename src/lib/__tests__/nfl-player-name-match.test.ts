// Sportsbook names vs nflverse names must match for grading. 2026 week 2 graded
// Deebo Samuel / Brian Thomas Jr / Chris Godwin "no-data" because nflverse
// writes "Deebo Samuel Sr." / "Brian Thomas Jr." / "Chris Godwin Jr.".
import { describe, it, expect } from "vitest";
import { actualStatKey, normalizePlayerName } from "../nfl-loop";

describe("player name matching", () => {
  it.each([
    ["Deebo Samuel", "Deebo Samuel Sr."],
    ["Brian Thomas Jr", "Brian Thomas Jr."],
    ["Chris Godwin", "Chris Godwin Jr."],
    ["Kenneth Walker", "Kenneth Walker III"],
    ["Ja\u2019Marr Chase", "Ja'Marr Chase"],
    ["Amon-Ra St Brown", "Amon-Ra St. Brown"],
  ])("book %j matches box score %j", (book, box) => {
    expect(actualStatKey(book, "sf")).toBe(actualStatKey(box, "SF"));
  });

  it("negative control: different players and teams do not collide", () => {
    expect(normalizePlayerName("Mike Williams")).not.toBe(normalizePlayerName("Mike Evans"));
    expect(actualStatKey("Deebo Samuel", "SF")).not.toBe(actualStatKey("Deebo Samuel", "WAS"));
    // a surname that merely ENDS in a suffix-like token is left alone
    expect(normalizePlayerName("Van Jefferson")).toBe("van jefferson");
  });
});
