import { getDashboardData } from "./_data/dashboard";
import { CommandHeader } from "./_components/CommandHeader";
import { DeploymentGate } from "./_components/DeploymentGate";
import { EdgeReactor } from "./_components/EdgeReactor";
import { SurvivorBrief } from "./_components/SurvivorBrief";
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
          <EdgeReactor data={data.pipelineStatus} />
          <SurvivorBrief picks={data.picks} />
          <KillRoom data={data.killStats} />
          <PropSignals props={data.playerProps} />
          <MarketFeed games={data.slate} />
          <SystemMemory data={data.agentMemory} />
          <VolatilityInputs injuries={data.injuries} />
          <Footer generatedAt={data.generatedAt} />
        </div>
      </main>
    </>
  );
}
