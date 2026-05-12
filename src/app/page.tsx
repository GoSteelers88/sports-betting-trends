import { getDashboardData } from "./_data/dashboard";
import { Hero } from "./_components/Hero";
import { PaperTrial } from "./_components/PaperTrial";
import { PipelineStatus } from "./_components/PipelineStatus";
import { AgentMemoryPanel } from "./_components/AgentMemoryPanel";
import { HotPicks } from "./_components/HotPicks";
import { MarketPicks } from "./_components/MarketPicks";
import { PlayerProps } from "./_components/PlayerProps";
import { Slate } from "./_components/Slate";
import { Injuries } from "./_components/Injuries";
import { Footer } from "./_components/Footer";
import { Reveal } from "./_components/Reveal";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  const data = await getDashboardData();

  return (
    <main className="grain relative min-h-screen bg-black">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10 space-y-10">
        <Reveal delay={0}><Hero data={data} /></Reveal>
        <Reveal delay={0.04}><HotPicks picks={data.picks} /></Reveal>
        <Reveal delay={0.08}><PaperTrial data={data.paperTrial} /></Reveal>
        <Reveal delay={0.12}><PipelineStatus data={data.pipelineStatus} /></Reveal>
        <Reveal delay={0.16}><AgentMemoryPanel data={data.agentMemory} /></Reveal>
        <Reveal delay={0.20}><MarketPicks picks={data.marketPicks} /></Reveal>
        <Reveal delay={0.24}><PlayerProps props={data.playerProps} /></Reveal>
        <Reveal delay={0.28}><Slate games={data.slate} /></Reveal>
        <Reveal delay={0.32}><Injuries injuries={data.injuries} /></Reveal>
        <Footer generatedAt={data.generatedAt} />
      </div>
    </main>
  );
}
