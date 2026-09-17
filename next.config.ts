import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // /picks ("The screen") retired 2026-09-12: it rendered data dated
  // 2026-05-06 with no nav. A config redirect answers 308 before the
  // filesystem — no function invocation, and the page file is gone.
  async redirects() {
    return [{ source: "/picks", destination: "/", permanent: true }];
  },
  // Turso backups (~12MB/day, 200MB+ total) live in the repo but are never
  // read by the app — without this exclude the file tracer drags them into
  // serverless bundles and blows Vercel's 250MB function limit.
  outputFileTracingExcludes: {
    "*": ["./data/backups/**", "./data/raw/**"],
  },
  outputFileTracingIncludes: {
    // /nfl discovers boards via readdirSync, which the tracer cannot follow —
    // without this include the prod function sees an empty nfl-live dir and
    // renders "no board published" over a published board. Boards + ledger
    // only; closes/ + snapshots/ archives are audit data nothing renders.
    //
    // EVERY file the route reads must be listed here. The page builds its
    // paths at runtime (path.join(process.cwd(), …)), so the tracer sees none
    // of them and a missing entry ships an EMPTY SECTION over perfectly good
    // committed data — silently, with a green build. That has already happened
    // once on this route. nfl-slate.json feeds THE MARKET NOW; nfl-exp5.json
    // feeds the whole research appendix.
    "/nfl": [
      "./data/processed/nfl-live/*.json",
      "./data/processed/nfl-slate.json",
      "./data/processed/nfl-exp5.json",
    ],
    // "/" — getDashboardData reads the odds/model/injury/props snapshots under
    // data/processed at runtime-built paths, and live-actions.ts reads the
    // latest published board (readdirSync over nfl-live/), nfl-slate.json and
    // the three agent-league odds files' fetchedAt. All of data/processed is
    // ~35MB, well inside the 250MB function limit.
    "/": [
      "./data/processed/*.json",
      "./data/processed/nfl-slate.json",
      "./data/processed/nfl-live/*.json",
    ],
    // /desk — the same dashboard loader plus QuantDesk's book
    // (quant-desk-mlb-book.json) and the props board log.
    "/desk": [
      "./data/processed/*.json",
      "./data/processed/quant-desk-mlb-book.json",
      "./data/processed/props-board-log.json",
      "./data/processed/nfl-live/*.json",
    ],
    // /experiments — the four books' files and the two file-only dashboard
    // loaders. The parlay book reads props-board-log.json (11MB) as its leg
    // source; parlay-retro.json feeds the quarantined retrospective panel.
    "/experiments": [
      "./data/processed/*.json",
      "./data/processed/devig-paper-book.json",
      "./data/processed/parlay-paper-book.json",
      "./data/processed/props-board-log.json",
      "./data/processed/parlay-retro.json",
      "./data/processed/nfl-exp5.json",
    ],
    "/api/free-stats/summary": ["./data/processed/**/*"],
    "/api/player-props": ["./data/processed/**/*"],
    "/api/debug-odds": ["./data/processed/**/*"],
    "/api/assistant/query": ["./data/processed/**/*"],
    "/api/chat": ["./data/processed/**/*"],
    "/api/cron/refresh": [],
    "/api/cron/ingest": [],
    "/api/picks/today": ["./data/processed/**/*"],
    "/api/props/today": ["./data/processed/**/*"],
    "/api/moneyline": ["./data/processed/**/*"],
    "/api/health": ["./data/processed/**/*"],
  },
};

export default nextConfig;
