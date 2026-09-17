// /experiments — the four $10k paper books plus the NFL backtest pointer.
//
// Each book is a server component whose library reads its own file (or, for
// Kalshi and PEAD, its own Prisma tables); they are composed here and never
// imported from a client file. The two dashboard fields this page needs —
// parlayRetro and nflExp5 — are file-only loaders exported from dashboard.ts,
// so this route never pays the full Turso load of getDashboardData().
//
// EVERY data file read on this route is listed in next.config.ts under
// outputFileTracingIncludes["/experiments"]; see the note there.

import type { Metadata } from "next";
import { loadNflExp5, loadParlayRetro } from "../_data/dashboard";
import { JumpList, type JumpItem } from "../_components/JumpList";
import { KalshiPaperTrail } from "../_components/KalshiPaperTrail";
import { DevigPaperBook } from "../_components/DevigPaperBook";
import { StockPaperBook } from "../_components/StockPaperBook";
import { ParlayPaperBook } from "../_components/ParlayPaperBook";
import { NflExp5 } from "../_components/NflExp5";
import { AskSection } from "../_components/AskSection";
import { Footer } from "../_components/Footer";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Experiments",
  description: "Four $10k paper books and the NFL backtest, on paper.",
  alternates: { canonical: "/experiments" },
};

export default function ExperimentsPage() {
  const parlayRetro = loadParlayRetro();
  const nflExp5 = loadNflExp5();
  const generatedAt = new Date().toISOString();

  const jump: JumpItem[] = [
    { href: "#kalshi-paper-trail", label: "Kalshi" },
    { href: "#devig-paper-book", label: "De-vig" },
    { href: "#pead-paper-book", label: "Post-earnings drift" },
    { href: "#parlay-paper-book", label: "Parlays" },
    ...(nflExp5 ? [{ href: "#nfl-exp5", label: "NFL backtest" } as JumpItem] : []),
    { href: "#ask", label: "Ask the desk" },
  ];

  return (
    <div className="receipts">
      <main className="receipts-shell">
        <header className="receipts-head" id="top">
          <p className="eyebrow">NATESTACKS · SIDE BETS, ON PAPER · 4 BOOKS · $10K EACH</p>
          <h1 className="headline receipts-h1">The experiments</h1>
          <p className="standfirst hidden sm:block">
            Four independent $10k paper books testing published market inefficiencies, and
            the NFL backtest. Each compresses to a card; charts print at five settles.
          </p>
          <JumpList items={jump} />
        </header>

        <section className="receipts-section" id="books" aria-label="The paper books">
          <div className="board-stack">
            <KalshiPaperTrail />
            <DevigPaperBook />
            <StockPaperBook />
            <ParlayPaperBook retro={parlayRetro} />
            <NflExp5 data={nflExp5} />
          </div>
        </section>

        {/* The one disclosure per page — the five per-card caps disclaimers
            said these ~40 words five times. Once, in prose, with each book's
            fill assumption kept. */}
        <section className="receipts-section" id="disclosure" aria-label="Disclosure">
          <div className="panel-dim rules-panel">
            <p className="eyebrow rules-warning">SIMULATED · NOT FINANCIAL ADVICE</p>
            <p className="prose">
              No book here places a real order. Fills are assumed — Kalshi at a resting bid,
              de-vig at the best recorded soft price, post-earnings at market on Alpaca paper,
              parlays from the props board&rsquo;s validated legs, the NFL backtest against
              nflverse closes — so every figure is an upper bound, not a forecast.{" "}
              <span className="num">1-800-GAMBLER</span>.
            </p>
          </div>
        </section>

        <AskSection />

        <Footer generatedAt={generatedAt} ask />
      </main>
    </div>
  );
}
