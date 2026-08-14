import type { MetadataRoute } from "next";

// Keep crawlers on the two real pages and off the raw JSON API surface.
// /api/og/ stays explicitly allowed: it's the social-card image — X's card
// fetcher doesn't strictly obey robots, but there's no reason to dare it.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/picks", "/api/og/"],
        disallow: ["/api/"],
      },
    ],
  };
}
