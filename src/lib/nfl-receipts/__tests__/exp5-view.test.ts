import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  HOLDOUT_DOC_URL,
  PREREG_DOC_URL,
  RESEARCH_SPAN,
  fmtCount,
  fmtRatePct,
  fmtYieldPct,
  parseExp5Research,
  propPickLabel,
  propProvenance,
  statLabel,
} from "../exp5-view";

const GOOD = {
  generatedAt: "2026-09-08T09:01:33.242Z",
  source: "nfl-quant-dryrun",
  props: {
    record: { wins: 671, losses: 401, pushes: 7 },
    settled: 1079,
    noData: 102,
    examples: [
      {
        player: "Travis Kelce",
        team: "KC",
        stat: "recYds",
        threshold: 50,
        side: "over",
        result: "loss",
        rationale: "Elite target share.",
        season: 2024,
        week: 22,
      },
    ],
  },
  parlays: {
    record: { wins: 103, losses: 444, pushes: 0 },
    settled: 547,
    roiPct: 38.96,
    winRatePct: 18.8,
    breakEvenPct: 13.6,
    avgLegsEdge: 0.112,
  },
};

describe("parseExp5Research — happy path", () => {
  const v = parseExp5Research(GOOD);

  it("derives the decided denominator without pushes", () => {
    expect(v.props?.decided).toBe(1072);
    expect(v.parlays?.decided).toBe(547);
  });

  it("reports the props figure as a hit rate, one decimal", () => {
    expect(v.props?.hitRatePct).toBe(62.6);
  });

  it("converts the leg edge from a fraction to percentage points", () => {
    expect(v.parlays?.avgLegEdgePct).toBe(11.2);
  });

  it("marks the parlay yield an upper bound, unconditionally", () => {
    expect(v.parlays?.upperBound).toBe(true);
  });

  it("keeps the summary's own instant", () => {
    expect(v.generatedAt).toBe("2026-09-08T09:01:33.242Z");
  });

  it("exposes no ROI or CLV field on the props block", () => {
    // The props were graded against nflverse box scores, never against a
    // market price. If a key like this ever appears the page could render a
    // return for picks that never had one.
    const keys = Object.keys(v.props ?? {});
    expect(keys).not.toContain("roiPct");
    expect(keys).not.toContain("clvBeatRatePct");
    expect(keys).not.toContain("flatYieldPct");
  });
});

describe("parseExp5Research — refusal to render junk", () => {
  // NEGATIVE CONTROLS. Each of these must produce an ABSENT block, never a
  // zeroed one: "0 settled" is a claim, a hidden block is an absence.
  it("rejects a wrong source stamp outright", () => {
    const v = parseExp5Research({ ...GOOD, source: "mlb-paper-book" });
    expect(v.props).toBeNull();
    expect(v.parlays).toBeNull();
  });

  it("rejects non-objects", () => {
    for (const junk of [null, undefined, 3, "x", []]) {
      const v = parseExp5Research(junk);
      expect(v.props).toBeNull();
      expect(v.parlays).toBeNull();
    }
  });

  it("drops a block whose record is missing or non-numeric", () => {
    expect(parseExp5Research({ ...GOOD, props: { settled: 10 } }).props).toBeNull();
    expect(
      parseExp5Research({
        ...GOOD,
        props: { ...GOOD.props, record: { wins: "671", losses: 401, pushes: 7 } },
      }).props,
    ).toBeNull();
  });

  it("drops a block with a zero or negative denominator", () => {
    expect(
      parseExp5Research({ ...GOOD, props: { ...GOOD.props, settled: 0 } }).props,
    ).toBeNull();
    expect(
      parseExp5Research({
        ...GOOD,
        parlays: { ...GOOD.parlays, settled: 0 },
      }).parlays,
    ).toBeNull();
  });

  it("drops the parlay block when any headline figure is absent", () => {
    for (const key of ["roiPct", "winRatePct", "breakEvenPct"]) {
      const parlays: Record<string, unknown> = { ...GOOD.parlays };
      delete parlays[key];
      expect(parseExp5Research({ ...GOOD, parlays }).parlays).toBeNull();
    }
  });

  it("keeps one block standing when the other is malformed", () => {
    const v = parseExp5Research({ ...GOOD, parlays: { record: null } });
    expect(v.parlays).toBeNull();
    expect(v.props?.settled).toBe(1079);
  });

  it("discards example rows that are not a settled over/under", () => {
    const v = parseExp5Research({
      ...GOOD,
      props: {
        ...GOOD.props,
        examples: [
          ...GOOD.props.examples,
          { ...GOOD.props.examples[0], result: "no-data" },
          { ...GOOD.props.examples[0], side: "middle" },
          { ...GOOD.props.examples[0], threshold: "50" },
          { ...GOOD.props.examples[0], player: "" },
          "not an object",
        ],
      },
    });
    expect(v.props?.examples).toHaveLength(1);
  });

  it("survives a missing noData count without inventing one", () => {
    const props: Record<string, unknown> = { ...GOOD.props };
    delete props.noData;
    expect(parseExp5Research({ ...GOOD, props }).props?.noData).toBe(0);
  });
});

describe("display furniture", () => {
  it("labels known stat keys and passes unknown ones through", () => {
    expect(statLabel("recYds")).toBe("rec yds");
    expect(statLabel("passTDs")).toBe("pass TDs");
    expect(statLabel("kickingPoints")).toBe("kickingPoints");
  });

  it("prints the pick without its result", () => {
    const e = parseExp5Research(GOOD).props!.examples[0];
    expect(propPickLabel(e)).toBe("OVER 50 rec yds");
    expect(propProvenance(e)).toBe("Wk 22 · 2024");
  });

  it("separates thousands so a denominator is not read as a year", () => {
    expect(fmtCount(1079)).toBe("1,079");
    expect(fmtCount(547)).toBe("547");
  });

  it("signs the yield and keeps both decimals", () => {
    expect(fmtYieldPct(38.96)).toBe("+38.96%");
    expect(fmtYieldPct(-3.6)).toBe("-3.60%");
    expect(fmtYieldPct(0)).toBe("0.00%");
  });

  it("prints rates unsigned, one decimal, and dashes a missing one", () => {
    expect(fmtRatePct(18.8)).toBe("18.8%");
    expect(fmtRatePct(null)).toBe("—");
  });
});

describe("the committed summary — a frozen anchor on real bytes", () => {
  const file = path.join(
    process.cwd(),
    "data",
    "processed",
    "nfl-exp5.json",
  );
  const raw = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf-8"))
    : null;

  it("parses the file the page will actually read", () => {
    if (!raw) return; // the file is cron-written; absent locally is not a failure
    const v = parseExp5Research(raw);
    expect(v.props).not.toBeNull();
    expect(v.parlays).not.toBeNull();
  });

  it("has records that reconcile with their own denominators", () => {
    if (!raw) return;
    const v = parseExp5Research(raw);
    const p = v.props!;
    expect(p.wins + p.losses + p.pushes).toBe(p.settled);
    expect(p.decided).toBe(p.wins + p.losses);
    const q = v.parlays!;
    expect(q.wins + q.losses + q.pushes).toBe(q.settled);
  });

  it("publishes only SETTLED example rows", () => {
    if (!raw) return;
    for (const e of parseExp5Research(raw).props?.examples ?? []) {
      expect(["win", "loss", "push"]).toContain(e.result);
    }
  });

  it("carries no season span of its own — the page's constant is the source", () => {
    if (!raw) return;
    // If this ever fails the writer has started emitting a span; read THAT
    // instead of RESEARCH_SPAN, which is a measurement frozen in a comment.
    expect(raw.props?.spanSeasons).toBeUndefined();
    expect(raw.parlays?.spanSeasons).toBeUndefined();
    expect(RESEARCH_SPAN).toMatch(/^\d{4}–\d{4}$/);
  });
});

describe("document links", () => {
  it("point at committed research files in the public repo", () => {
    expect(HOLDOUT_DOC_URL).toMatch(
      /^https:\/\/github\.com\/.+\/docs\/research\/2026-08-18-holdout-validation-2025\.md$/,
    );
    expect(PREREG_DOC_URL).toMatch(
      /^https:\/\/github\.com\/.+\/docs\/research\/2026-08-29-nfl-receipts-preregistration\.md$/,
    );
  });

  it("names files that exist in this working tree", () => {
    for (const url of [HOLDOUT_DOC_URL, PREREG_DOC_URL]) {
      const name = url.split("/").pop()!;
      expect(
        fs.existsSync(path.join(process.cwd(), "docs", "research", name)),
      ).toBe(true);
    }
  });
});
