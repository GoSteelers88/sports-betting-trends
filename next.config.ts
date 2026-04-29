import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/free-stats/summary": ["./data/processed/**/*"],
    "/api/player-props": ["./data/processed/**/*"],
    "/api/debug-odds": ["./data/processed/**/*"],
    "/api/assistant/query": ["./data/processed/**/*"],
    "/api/cron/refresh": [],
    "/api/cron/ingest": [],
    "/api/picks/today": ["./data/processed/**/*"],
    "/api/props/today": ["./data/processed/**/*"],
    "/api/moneyline": ["./data/processed/**/*"],
    "/api/health": ["./data/processed/**/*"],
  },
};

export default nextConfig;
