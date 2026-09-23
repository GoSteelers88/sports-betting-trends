// A re-grade must never delete the model's published prop picks.
// 2026-09-23: re-grading week 2 rebuilt props-2026-wk02.json from the capture
// and dropped all 20 picks that nfl:props-picks had written into it.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writePublicPropBoard, publicPropBoardPath } from "../nfl-props-public";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "props-public-"));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const priv = path.join(root, "private");
  fs.mkdirSync(path.join(priv, "live-props"), { recursive: true });
  fs.writeFileSync(
    path.join(priv, "live-props", "2026-REG-wk2.json"),
    JSON.stringify({
      generatedAt: "2026-09-17T13:49:20.817Z",
      games: 1,
      rows: [{ gameId: "2026_02_DET_BUF", matchup: "DET @ BUF", player: "A", team: "DET", position: "WR", stat: "recYds", side: "over", point: 60.5, priceAmerican: -110, book: "x", booksOffering: 3 }],
    }),
  );
  return priv;
}

describe("writePublicPropBoard", () => {
  it("keeps picks written by nfl:props-picks across a re-grade", () => {
    const priv = setup();
    writePublicPropBoard(priv, 2026, 2);
    const out = publicPropBoardPath(2026, 2);
    const withPicks = { ...JSON.parse(fs.readFileSync(out, "utf8")), picks: [{ player: "A", verdict: "play" }], picksGeneratedAt: "2026-09-17T14:00:00Z" };
    fs.writeFileSync(out, JSON.stringify(withPicks));

    const regraded = writePublicPropBoard(priv, 2026, 2);
    const onDisk = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(onDisk.picks).toEqual([{ player: "A", verdict: "play" }]);
    expect(onDisk.picksGeneratedAt).toBe("2026-09-17T14:00:00Z");
    expect(regraded?.picks).toHaveLength(1);
    expect(onDisk.lines).toHaveLength(1);
  });

  it("writes no picks field when none were ever generated", () => {
    const priv = setup();
    writePublicPropBoard(priv, 2026, 2);
    expect(JSON.parse(fs.readFileSync(publicPropBoardPath(2026, 2), "utf8")).picks).toBeUndefined();
  });
});
