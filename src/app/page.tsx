import type { ReactNode } from "react";
import { getDashboardData } from "./_data/dashboard";
import { CommandHeader } from "./_components/CommandHeader";
import { VerdictTape } from "./_components/VerdictTape";
import { buildTapeItems } from "./_components/verdict-tape-items";
import { Hero } from "./_components/Hero";
import { TabShell, type Tab } from "./_components/TabShell";

// Section panels. These are server components — several read files via node:fs
// at render — so they MUST be composed here (server side) and handed to the
// client TabShell as pre-rendered ReactNodes, never imported inside TabShell.
import { TonightsPlay } from "./_components/SurvivorBrief";
import { DeploymentGate } from "./_components/DeploymentGate";
import { OverallLedger } from "./_components/OverallLedger";
import { KillRoom } from "./_components/KillRoom";
import { KalshiPaperTrail } from "./_components/KalshiPaperTrail";
import { DevigPaperBook } from "./_components/DevigPaperBook";
import { StockPaperBook } from "./_components/StockPaperBook";
import { ParlayPaperBook } from "./_components/ParlayPaperBook";
import { NflExp5 } from "./_components/NflExp5";
import { MarketFeed } from "./_components/MarketFeed";
import { PropsDesk } from "./_components/PropsDesk";
import { MlbPropPlays } from "./_components/MlbPropPlays";
import { QuantDesk } from "./_components/QuantDesk";
import { SystemMemory } from "./_components/SystemMemory";
import { VolatilityInputs } from "./_components/VolatilityInputs";
import { SectionHeader } from "./_components/SectionHeader";
import { Footer } from "./_components/Footer";
import { AskTheDesk } from "./_components/AskTheDesk";

// ISR, not force-dynamic: the data behind this page changes on a cron cadence
// (agent runs 14:00/22:30 UTC + daily grading), but the old force-dynamic +
// revalidate=0 made EVERY visitor pay ~25 Turso round-trips and a 1.7MB JSON
// parse before first byte. 300s staleness is invisible against a twice-daily
// data cycle; nothing in the render path reads cookies/headers (verified).
export const revalidate = 300;

export default async function Home() {
  const data = await getDashboardData();

  // Each tab's content is rendered server-side here and passed to TabShell as
  // a ReactNode. TabShell (client) only toggles which one is visible.
  const panels: Record<Tab, ReactNode> = {
    tonight: (
      <>
        {/* FOL. 02 — tonight's play */}
        <TonightsPlay picks={data.picks.games} />
        {/* FOL. 03 — the funding gate */}
        <DeploymentGate data={data.paperTrial} />
        {/* FOL. 04 — the account */}
        <OverallLedger data={data.overallRecord.games} />
        {/* FOL. 09 — MLB prop plays by stat (also lives in the Props tab) */}
        <MlbPropPlays board={data.mlbPropPlays} />
        {/* Exp. 4 — parlay paper book (also lives in the Experiments tab) */}
        <ParlayPaperBook retro={data.parlayRetro} />
        {/* Exp. 5 — NFL backtest (also lives in the Experiments tab) */}
        <NflExp5 data={data.nflExp5} />
      </>
    ),
    "the-desk": (
      <>
        {/* FOL. 10 — the quant desk */}
        <section className="space-y-5">
          <SectionHeader
            id="quant-desk-section"
            index="10"
            label="THE QUANT DESK · MODEL-EDGE BETTING"
            title="Bet the mispricing, measure by CLV"
            subtitle="A proprietary model makes fair probabilities; the desk bets only where the market is mispriced vs the model (edge ≥ 3%, sharp-favored side), sizes quarter-Kelly behind a drawdown rail, and is judged by closing-line value — not wins. In the lineage of Benter, Benham, and Bloom. Places nothing real."
            status="Paper · Live"
            statusTone="blue"
          />
          <QuantDesk />
        </section>
        {/* FOL. 05 — the kill room */}
        <KillRoom
          pipeline={data.pipelineStatus}
          kills={data.killStats}
          trialKillRate={data.paperTrial.criticKillRate}
        />
      </>
    ),
    props: (
      <>
        {/* FOL. 08 — the props desk */}
        <PropsDesk
          picks={data.picks.props}
          lastNight={data.lastNight.props}
          record={data.overallRecord.props}
          signals={data.playerProps}
          homeRunLikes={data.homeRunLikes}
        />
        {/* FOL. 09 — MLB prop plays by stat */}
        <MlbPropPlays board={data.mlbPropPlays} />
      </>
    ),
    experiments: (
      <section className="space-y-5">
        <SectionHeader
          id="experiments"
          index="06"
          label="THE EXPERIMENTS · FOUR PAPER BOOKS + NFL RESEARCH"
          title="Side bets, on paper"
          subtitle="Four independent $10k simulated books testing published market inefficiencies, plus an NFL backtest run as a research dry-run. Each compresses to a card until its first settle — charts print only when there is something to chart."
          status="4 books + NFL research"
          statusTone="blue"
        />
        <KalshiPaperTrail />
        <DevigPaperBook />
        <StockPaperBook />
        <ParlayPaperBook retro={data.parlayRetro} />
        <NflExp5 data={data.nflExp5} />
      </section>
    ),
    operations: (
      <>
        {/* FOL. 07 — the board */}
        <MarketFeed games={data.slate} />
        {/* Back of book — agate */}
        <div
          id="back-of-book"
          className="space-y-14 pt-8"
          style={{ borderTop: "3px double var(--rule-strong)" }}
        >
          <SystemMemory data={data.agentMemory} />
          <VolatilityInputs wire={data.injuryWire} />
        </div>
        <Footer generatedAt={data.generatedAt} />
      </>
    ),
  };

  return (
    <>
      {/* Desk strip — telemetry row (mode, day, last run, next, funding badge) */}
      <CommandHeader data={data} />

      {/* Verdict tape — settled picks travel with their results */}
      <VerdictTape items={buildTapeItems(data)} />

      {/* Hero — permanent masthead above the tab rail; visible on every tab */}
      <div className="px-5 sm:px-10 max-w-[1280px] mx-auto">
        <Hero data={data} />
      </div>

      {/* TabShell — owns the 5-tab rail; content is rendered server-side above */}
      <TabShell panels={panels} />

      {/* The Sharp's desk — a floating chat island mounted on the server page.
          Client component; wires POST /api/chat. Closed by default to a tab. */}
      <AskTheDesk />
    </>
  );
}
