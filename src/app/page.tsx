import { getDashboardData } from "./_data/dashboard";
import { Sidebar } from "./_components/Sidebar";
import { TickerMarquee } from "./_components/TickerMarquee";
import { Hero } from "./_components/Hero";
import { DevigPaperBook } from "./_components/DevigPaperBook";
import { DeploymentGate } from "./_components/DeploymentGate";
import { OverallLedger } from "./_components/OverallLedger";
import { EdgeReactor } from "./_components/EdgeReactor";
import { SurvivorBrief } from "./_components/SurvivorBrief";
import { LastNightLedger } from "./_components/LastNightLedger";
import { KillRoom } from "./_components/KillRoom";
import { PropSignals } from "./_components/PropSignals";
import { MarketFeed } from "./_components/MarketFeed";
import { SystemMemory } from "./_components/SystemMemory";
import { VolatilityInputs } from "./_components/VolatilityInputs";
import { Footer } from "./_components/Footer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  const data = await getDashboardData();

  return (
    <>
      <TickerMarquee data={data} />
      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr]">
        <Sidebar data={data} />
        <main className="relative min-w-0">
          <div className="px-5 sm:px-10 lg:px-14 max-w-[1400px]">
            {/* Hero — full-viewport editorial moment */}
            <Hero data={data} />

            {/* De-vigged-sharp +EV $10k paper book — flagship live experiment */}
            <div className="pt-8">
              <DevigPaperBook />
            </div>

            {/* Games track — runs first, the agent's main competence */}
            <div className="space-y-24 sm:space-y-32 pb-24">
              <OverallLedger data={data.overallRecord.games} kind="games" />
              <EdgeReactor data={data.pipelineStatus} />
              <SurvivorBrief picks={data.picks.games} kind="games" />
              <LastNightLedger data={data.lastNight.games} kind="games" />
              <DeploymentGate data={data.paperTrial} />
              <MarketFeed games={data.slate} />

              {/* Props track — entirely separate visual band */}
              <div className="border-t border-[var(--border)] pt-24 sm:pt-32 space-y-24 sm:space-y-32">
                <SurvivorBrief picks={data.picks.props} kind="props" />
                <LastNightLedger data={data.lastNight.props} kind="props" />
                <OverallLedger data={data.overallRecord.props} kind="props" />
                <PropSignals props={data.playerProps} />
              </div>

              {/* Back of the book — supporting context */}
              <div className="border-t border-[var(--border)] pt-24 sm:pt-32 grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16">
                <KillRoom data={data.killStats} />
                <SystemMemory data={data.agentMemory} />
              </div>
              <VolatilityInputs injuries={data.injuries} />
              <Footer generatedAt={data.generatedAt} />
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
