// Colophon — the back page of the ledger, and the way out. The four site
// links repeat here as text links: a reader who scrolled to the bottom is
// the one who wants the next page. /nfl keeps its own receipts-footer.

import { NAV } from "@/lib/site-nav";

export function Footer({ generatedAt, ask = false }: { generatedAt: string; ask?: boolean }) {
  const stamp = new Date(generatedAt)
    .toLocaleString("en-US", { timeZone: "America/New_York", hour12: false })
    .toUpperCase();
  return (
    <footer className="site-footer">
      <div className="rule-double" />
      <p className="site-footer-links eyebrow">
        {NAV.map((n, i) => (
          <span key={n.href}>
            {i > 0 ? <span className="site-footer-sep">·</span> : null}
            <a href={n.href}>{n.label}</a>
          </span>
        ))}
        {ask ? (
          <span>
            <span className="site-footer-sep">·</span>
            <a href="#ask">Ask the desk</a>
          </span>
        ) : null}
      </p>
      <div className="site-footer-meta">
        <p className="eyebrow text-ink-3">NATESTACKS · The Paper Trial · pressed {stamp} ET</p>
        <p className="eyebrow text-ink-3">Model output · not betting advice · 1-800-GAMBLER</p>
      </div>
      <p className="eyebrow text-ink-3 mt-2">
        Set in Fraunces, Archivo &amp; IBM Plex Mono · red ink reserved for losses
      </p>
    </footer>
  );
}
