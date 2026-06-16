import { getDashboardData } from "./_data/dashboard";
import { CommandHeader } from "./_components/CommandHeader";
import { VerdictTape } from "./_components/VerdictTape";
import { Hero } from "./_components/Hero";
import { TonightsPlay } from "./_components/SurvivorBrief";
import { DeploymentGate } from "./_components/DeploymentGate";
import { OverallLedger } from "./_components/OverallLedger";
import { KillRoom } from "./_components/KillRoom";
import { KalshiPaperTrail } from "./_components/KalshiPaperTrail";
import { DevigPaperBook } from "./_components/DevigPaperBook";
import { StockPaperBook } from "./_components/StockPaperBook";
import { ParlayPaperBook } from "./_components/ParlayPaperBook";
import { MarketFeed } from "./_components/MarketFeed";
import { PropsDesk } from "./_components/PropsDesk";
import { MlbPropPlays } from "./_components/MlbPropPlays";
import { QuantDesk } from "./_components/QuantDesk";
import { SystemMemory } from "./_components/SystemMemory";
import { VolatilityInputs } from "./_components/VolatilityInputs";
import { SectionHeader } from "./_components/SectionHeader";
import { Footer } from "./_components/Footer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  const data = await getDashboardData();

  return (
    <>
      {/* Desk strip — telemetry + folio index (1:1 with the folios below) */}
      <CommandHeader data={data} />

      {/* The verdict tape — settled picks travel with their results */}
      <VerdictTape data={data} />

      <main className="px-5 sm:px-10 max-w-[1280px] mx-auto">
        {/* FOL. 01 — the front page: last night's verdict, the gate, tonight's teaser */}
        <Hero data={data} />

        <div className="margin-rule space-y-16 sm:space-y-24 pb-20">
          {/* FOL. 02 — tonight's play (the merged hero/survivor brief) */}
          <TonightsPlay picks={data.picks.games} />

          {/* FOL. 03 — the funding gate (canonical trial-to-date numbers) */}
          <DeploymentGate data={data.paperTrial} />

          {/* FOL. 04 — the account */}
          <OverallLedger data={data.overallRecord.games} />

          {/* FOL. 05 — the kill room (pipeline + prosecution, one funnel, 14d) */}
          <KillRoom
            pipeline={data.pipelineStatus}
            kills={data.killStats}
            trialKillRate={data.paperTrial.criticKillRate}
          />

          {/* FOL. 06 — the experiments, compressed to ledger cards until first settle */}
          <section className="space-y-5">
            <SectionHeader
              id="experiments"
              index="06"
              label="THE EXPERIMENTS · FOUR PAPER BOOKS"
              title="Side bets, on paper"
              subtitle="Four independent $10k simulated books testing published market inefficiencies. Each compresses to a card until its first settle — charts print only when there is something to chart."
              status="4 books live"
              statusTone="blue"
            />
            <KalshiPaperTrail />
            <DevigPaperBook />
            <StockPaperBook />
            <ParlayPaperBook />
          </section>

          {/* FOL. 07 — the board (agate) */}
          <MarketFeed games={data.slate} />

          {/* FOL. 08 — the props desk (the entire props track, one folio) */}
          <PropsDesk
            picks={data.picks.props}
            lastNight={data.lastNight.props}
            record={data.overallRecord.props}
            signals={data.playerProps}
            homeRunLikes={data.homeRunLikes}
          />

          {/* FOL. 09 — MLB prop plays, organized by stat (model-first ladders) */}
          <MlbPropPlays board={data.mlbPropPlays} />

          {/* FOL. 10 — THE QUANT DESK (model-edge MLB, $10k paper, CLV-judged) */}
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

          {/* Back of the book — agate */}
          <div id="back-of-book" className="space-y-14 pt-8" style={{ borderTop: "3px double var(--rule-strong)" }}>
            <SystemMemory data={data.agentMemory} />
            <VolatilityInputs wire={data.injuryWire} />
          </div>

          <Footer generatedAt={data.generatedAt} />
        </div>
      </main>
    </>
  );
}
