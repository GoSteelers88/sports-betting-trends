import { getDashboardData } from "./_data/dashboard";
import { CommandHeader } from "./_components/CommandHeader";
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
      <CommandHeader data={data} />
      <main className="relative">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-10 space-y-12 sm:space-y-16">
          <DeploymentGate data={data.paperTrial} />
          <OverallLedger data={data.overallRecord.games} kind="games" />
          <EdgeReactor data={data.pipelineStatus} />
          <SurvivorBrief picks={data.picks.games} kind="games" />
          <LastNightLedger data={data.lastNight.games} kind="games" />
          <KillRoom data={data.killStats} />
          <PropSignals props={data.playerProps} />
          <MarketFeed games={data.slate} />
          {/* Player-prop track lives below — completely separate from the
              game track so a 6-0 ML record doesn't get diluted by prop noise. */}
          <SurvivorBrief picks={data.picks.props} kind="props" />
          <LastNightLedger data={data.lastNight.props} kind="props" />
          <OverallLedger data={data.overallRecord.props} kind="props" />
          <SystemMemory data={data.agentMemory} />
          <VolatilityInputs injuries={data.injuries} />
          <Footer generatedAt={data.generatedAt} />
        </div>
      </main>
    </>
  );
}
