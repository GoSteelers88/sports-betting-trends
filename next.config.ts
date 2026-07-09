import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Turso backups (~12MB/day, 200MB+ total) live in the repo but are never
  // read by the app — without this exclude the file tracer drags them into
  // serverless bundles and blows Vercel's 250MB function limit.
  outputFileTracingExcludes: {
    "*": ["./data/backups/**", "./data/raw/**"],
  },
  outputFileTracingIncludes: {
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
