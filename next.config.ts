import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/free-stats/summary": ["./data/processed/**/*"],
    "/api/player-props": ["./data/processed/**/*"],
  },
};

export default nextConfig;
