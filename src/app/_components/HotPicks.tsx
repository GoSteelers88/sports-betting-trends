"use client";

import { useState } from "react";
import type { SlatePick } from "../_data/dashboard";
import { BetBlock } from "./BetBlock";
import { BetBackground } from "./BetBackground";
import { PickDetailModal } from "./PickDetailModal";

export function HotPicks({ picks }: { picks: SlatePick[] }) {
  const [open, setOpen] = useState<SlatePick | null>(null);

  if (picks.length === 0) {
    return (
      <section className="relative min-h-[80svh] flex items-center justify-center px-6 overflow-hidden">
        <BetBackground league="DEFAULT" />
        <div className="text-center relative">
          <p className="var-mono text-xs uppercase tracking-[0.4em] text-[var(--rust)] mb-6">
            // NULL TRANSMISSION
          </p>
          <h2
            className="var-display text-[var(--foreground)] text-[clamp(3rem,12vw,10rem)]"
            style={{ ["--wght" as string]: "300", ["--lsp" as string]: "-0.03em" }}
          >
            NO EDGE
            <br />
            TONIGHT
          </h2>
          <p className="mt-8 var-mono text-xs uppercase tracking-[0.3em] text-[var(--concrete)]">
            AGENT PASSED ON EVERY GAME ▸ DISCIPLINE &gt; ACTION
          </p>
        </div>
      </section>
    );
  }

  return (
    <>
      <div className="space-y-0">
        {picks.map((p, i) => (
          <BetBlock
            key={p.id}
            pick={p}
            index={i}
            total={picks.length}
            onOpen={() => setOpen(p)}
          />
        ))}
      </div>
      <PickDetailModal pick={open} onClose={() => setOpen(null)} />
    </>
  );
}
