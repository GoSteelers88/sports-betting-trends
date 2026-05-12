import { getDashboardData } from "./_data/dashboard";
import { Hero } from "./_components/Hero";
import { HotPicks } from "./_components/HotPicks";
import { PaperTrial } from "./_components/PaperTrial";
import { PipelineStatus } from "./_components/PipelineStatus";
import { AgentMemoryPanel } from "./_components/AgentMemoryPanel";
import { MarketPicks } from "./_components/MarketPicks";
import { PlayerProps } from "./_components/PlayerProps";
import { Slate } from "./_components/Slate";
import { Injuries } from "./_components/Injuries";
import { Footer } from "./_components/Footer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  const data = await getDashboardData();

  return (
    <main className="grain-live relative bg-[#0a0c0d]">
      {/* ░░░ KINETIC AXIS — bets dominate ░░░ */}
      <Hero data={data} />
      <HotPicks picks={data.picks} />

      {/* ░░░ OPERATOR CONSOLE — telemetry ░░░ */}
      <div className="relative px-4 sm:px-8 py-12 space-y-10 max-w-6xl mx-auto">
        <PaperTrial data={data.paperTrial} />
        <PipelineStatus data={data.pipelineStatus} />
        <AgentMemoryPanel data={data.agentMemory} />
        <MarketPicks picks={data.marketPicks} />
        <PlayerProps props={data.playerProps} />
      </div>

      {/* ░░░ FEEDS — ticker tape ░░░ */}
      <div className="relative px-4 sm:px-8 py-6 space-y-6 max-w-6xl mx-auto">
        <Slate games={data.slate} />
        <Injuries injuries={data.injuries} />
      </div>

      <div className="relative max-w-6xl mx-auto px-4 sm:px-8">
        <Footer generatedAt={data.generatedAt} />
      </div>
    </main>
  );
}
