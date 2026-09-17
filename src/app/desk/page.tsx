// /desk — the operator's floor.
//
// What ran and what died (the kill room), where the gate stands, the quant
// desk's book, the market the desk bets against, props, the standing rules,
// and the injury wire. Everything here is public today; nothing secret
// renders. Denser and longer than "/" by design — the operator pays for
// density with scroll, not with zeros.
//
// Server component; the file-reading panels (QuantDesk) are composed here.
// EVERY data file read on this route is listed in next.config.ts under
// outputFileTracingIncludes["/desk"].

import type { Metadata } from "next";
import { getDashboardData } from "../_data/dashboard";
import { JumpList, type JumpItem } from "../_components/JumpList";
import { RunMeta } from "../_components/RunMeta";
import { SectionHeader } from "../_components/SectionHeader";
import { KillRoom } from "../_components/KillRoom";
import { DeploymentGate } from "../_components/DeploymentGate";
import { QuantDesk } from "../_components/QuantDesk";
import { MarketFeed } from "../_components/MarketFeed";
import { PropsDesk } from "../_components/PropsDesk";
import { MlbPropPlays } from "../_components/MlbPropPlays";
import { SystemMemory } from "../_components/SystemMemory";
import { VolatilityInputs } from "../_components/VolatilityInputs";
import { AskSection } from "../_components/AskSection";
import { Footer } from "../_components/Footer";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "The desk",
  description:
    "Operator view: kill room, funding gate, quant desk, the board, props, house rules, injury wire.",
  alternates: { canonical: "/desk" },
};

export default async function DeskPage() {
  const data = await getDashboardData();
  const wire = data.injuryWire;
  const hasMemory = data.agentMemory.totalActive > 0 || data.agentMemory.lastDreamAt !== null;
  const hasWire = wire.injuries.length > 0 || (wire.watch ?? []).length > 0;

  const jump: JumpItem[] = [
    { href: "#kill-room", label: "Kill room" },
    { href: "#deployment-gate", label: "Funding gate" },
    { href: "#quant-desk-section", label: "Quant desk" },
    { href: "#market-feed", label: "The market" },
    { href: "#props-desk", label: "Props" },
    ...(data.mlbPropPlays.groups.length > 0
      ? [{ href: "#mlb-prop-plays", label: "Prop ladders" } as JumpItem]
      : []),
    ...(hasMemory ? [{ href: "#system-memory", label: "Standing rules" } as JumpItem] : []),
    ...(hasWire ? [{ href: "#volatility-inputs", label: "Injury wire" } as JumpItem] : []),
    { href: "#ask", label: "Ask the desk" },
  ];

  return (
    <div className="receipts">
      <main className="receipts-shell">
        <header className="receipts-head" id="top">
          <p className="eyebrow">NATESTACKS · OPERATOR VIEW</p>
          <h1 className="headline receipts-h1">The desk</h1>
          <p className="standfirst hidden sm:block">
            The agent&rsquo;s operating floor: the critic&rsquo;s record, the funding gate,
            the live model-edge book, the market it bets against, its standing rules, and
            the injury wire.
          </p>
          <JumpList items={jump} />
          <RunMeta
            status={data.status}
            lead={["MODE PAPER"]}
            trail={[`${data.pipelineStatus.totalRunsLast14d} RUNS / 14D`]}
            className="desk-status"
          />
        </header>

        <KillRoom
          pipeline={data.pipelineStatus}
          kills={data.killStats}
          trialKillRate={data.paperTrial.criticKillRate}
        />

        <DeploymentGate data={data.paperTrial} />

        <section className="receipts-section">
          <SectionHeader
            id="quant-desk-section"
            label="MODEL-EDGE MLB · $10K PAPER · JUDGED BY CLV"
            title="THE QUANT DESK"
            subtitle="A proprietary model makes fair probabilities; the desk bets only where the market is mispriced vs the model, sizes quarter-Kelly behind a drawdown rail, and is judged by closing-line value — not wins. Simulated; places nothing real."
          />
          <div className="panel-mount">
            <QuantDesk />
          </div>
        </section>

        <MarketFeed games={data.slate} />

        <PropsDesk
          picks={data.picks.props}
          lastNight={data.lastNight.props}
          record={data.overallRecord.props}
          signals={data.playerProps}
          homeRunLikes={data.homeRunLikes}
        />

        <MlbPropPlays board={data.mlbPropPlays} />

        <SystemMemory data={data.agentMemory} />

        <VolatilityInputs wire={data.injuryWire} />

        <AskSection />

        <Footer generatedAt={data.generatedAt} ask />
      </main>
    </div>
  );
}
