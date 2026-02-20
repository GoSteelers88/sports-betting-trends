import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/free-stats/summary": ["./data/processed/**/*"],
    "/api/player-props": ["./data/processed/**/*"],
    "/api/debug-odds": ["./data/processed/**/*"],
  },
};

export default nextConfig;
