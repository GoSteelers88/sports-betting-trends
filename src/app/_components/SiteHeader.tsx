// The one site header. Mounted once in layout.tsx, identical on every route.
//
// It carries NO data and calls nothing: a wordmark, the four real links, and
// the static word PAPER. That is deliberate — /nfl is force-dynamic and makes
// zero DB calls; a header that read the dashboard would drag ~25 Turso
// round-trips onto the page Nate shares. The funding state and the run
// telemetry live in content (the "/" verdict line, RunMeta on "/" and
// "/desk"), not here.
//
// Sticky, solid paper, the double rule as its bottom edge. It does not react
// to scroll: no shadow, no compression, no hide-on-scroll. Its height is the
// --header-h token in globals.css, which every [id]'s scroll-margin derives
// from — one number, one place.

import { SiteNav } from "./SiteNav";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <a className="site-wordmark" href="/">
          NATESTACKS
          <span className="site-wordmark-mark" aria-hidden="true">
            *
          </span>
        </a>
        <SiteNav />
        <span className="site-mode" title="Every bet on this site is on paper">
          PAPER
        </span>
      </div>
    </header>
  );
}
