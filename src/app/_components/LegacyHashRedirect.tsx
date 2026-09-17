"use client";

// Old X posts link /#props, /#experiments, /#operations, /#the-desk,
// /#tonight and /#nfl-week — the homepage's retired hash tabs. A fragment
// never reaches the server, so the only place it can be honored is here,
// after "/" has loaded. Mounted on "/" ONLY; renders nothing.
//
// Three rules:
//  1. The hash is read in an effect, after mount — never during render, so
//     the client's first paint agrees with the server's HTML.
//  2. The target comes from a literal table (site-nav.ts). The fragment is
//     looked up, never concatenated into a URL. Unknown → no-op: the page is
//     "/", which is a sane landing.
//  3. REPLACE, never push. A push would make Back return to /#props, which
//     redirects forward again — a trap. Same-route targets ("/", "/#today")
//     rewrite the URL in place and let the browser's own anchor scroll work.

import { useEffect } from "react";
import { legacyHashTarget, splitTarget } from "@/lib/site-nav";

export function LegacyHashRedirect() {
  useEffect(() => {
    if (window.location.pathname !== "/") return;
    const target = legacyHashTarget(window.location.hash);
    if (target === null) return;
    const { path, hash } = splitTarget(target);
    if (path === "/") {
      try {
        window.history.replaceState(null, "", target);
      } catch {
        /* an opaque-origin embed may refuse; the page is still "/" */
      }
      if (hash) document.getElementById(hash)?.scrollIntoView();
      return;
    }
    window.location.replace(target);
  }, []);
  return null;
}
