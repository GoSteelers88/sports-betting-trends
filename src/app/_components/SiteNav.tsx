"use client";

// The header's four links. A client component only so it can read the
// pathname for aria-current — it imports no data, no node:fs, nothing that
// could pull a server panel into the client bundle. Plain <a href>, not
// next/link: the routes are ISR/dynamic pages behind Turso and a prefetch on
// hover would be a database call nobody asked for.

import { usePathname } from "next/navigation";
import { NAV, isActiveRoute } from "@/lib/site-nav";

export function SiteNav() {
  const pathname = usePathname();
  return (
    <nav className="site-nav" aria-label="Site">
      {NAV.map((entry) => {
        const active = isActiveRoute(pathname, entry.href);
        return (
          <a key={entry.href} href={entry.href} aria-current={active ? "page" : undefined}>
            {entry.label}
          </a>
        );
      })}
    </nav>
  );
}
