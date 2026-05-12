"use client";

import { useState } from "react";
import type { SlatePick } from "../_data/dashboard";
import { PickDetailModal } from "./PickDetailModal";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function leagueTag(league: string): string {
  if (league === "MLB") return "MLB";
  if (league === "NBA") return "NBA";
  if (league === "WNBA") return "WNBA";
  if (league === "NHL") return "NHL";
  return league.toUpperCase();
}

function pickStatus(p: SlatePick): { tag: string; cardBorder: string; tagBg: string; tagFg: string } {
  if (p.outcome?.result === "win")
    return { tag: "WIN", cardBorder: "brutal-card-win", tagBg: "bg-[var(--color-win)]", tagFg: "text-black" };
  if (p.outcome?.result === "loss")
    return { tag: "LOSS", cardBorder: "brutal-card-loss", tagBg: "bg-[var(--color-loss)]", tagFg: "text-white" };
  if (p.edge >= 0.10)
    return { tag: "HOT", cardBorder: "brutal-card-hazard", tagBg: "bg-[var(--hazard)]", tagFg: "text-black" };
  if (p.edge >= 0.05)
    return { tag: "EDGE", cardBorder: "", tagBg: "bg-white", tagFg: "text-black" };
  return { tag: "LIVE", cardBorder: "", tagBg: "bg-white", tagFg: "text-black" };
}

export function HotPicks({ picks }: { picks: SlatePick[] }) {
  const [open, setOpen] = useState<SlatePick | null>(null);

  if (picks.length === 0) {
    return (
      <section>
        <SectionHeader title="BOT PICKS" subtitle="0 LIVE" />
        <div className="brutal-card p-10 text-center">
          <p className="display text-4xl sm:text-5xl text-white mb-3">NO EDGE TONIGHT.</p>
          <p className="display-eyebrow text-white/60">
            DISCIPLINE &gt; ACTION — AGENT PASSED ON EVERY GAME
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionHeader title="HOT PICKS" subtitle={`${picks.length} LIVE // TAP FOR DETAIL`} />

      <div className="h-rail flex gap-0 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 pb-2">
        {picks.map(p => {
          const s = pickStatus(p);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setOpen(p)}
              aria-label={`Open details for ${p.matchup}`}
              className={`group shrink-0 w-[320px] sm:w-[360px] text-left brutal-card ${s.cardBorder} -mr-[3px] last:mr-0`}
            >
              {/* Athlete photo slot — drop a real image at /public/athletes/{league}.jpg */}
              <div className="athlete-slot h-32 border-b-[3px] border-inherit relative">
                <div
                  className="absolute inset-0 flex items-end p-3"
                  style={{
                    backgroundImage:
                      "radial-gradient(circle at 70% 30%, rgba(250,255,0,0.15), transparent 55%)",
                  }}
                >
                  <span
                    className="display-tight text-white/15 text-[6rem] leading-none"
                    aria-hidden="true"
                  >
                    {leagueTag(p.league)}
                  </span>
                </div>
                <span className={`absolute top-3 right-3 ${s.tagBg} ${s.tagFg} display px-2 py-0.5 text-xs`}>
                  {s.tag}
                </span>
                <span className="absolute top-3 left-3 display-eyebrow text-white">
                  {leagueTag(p.league)}
                </span>
              </div>

              <div className="p-4">
                <p className="display text-lg leading-tight text-white mb-3">
                  {p.matchup.toUpperCase()}
                </p>

                <div className="flex items-end justify-between gap-3 mb-4 pb-3 border-b-[3px] border-white/20">
                  <span className="display text-sm text-white/80">{p.selection.toUpperCase()}</span>
                  <span className="odds-display text-4xl text-[var(--hazard)]">
                    {fmtAmerican(p.oddsAmerican)}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-0 border-[3px] border-white mb-3">
                  <Field label="EDGE" value={`${(p.edge * 100).toFixed(1)}%`} hazard />
                  <Field label="STAKE" value={`${p.kellyStakeUnits.toFixed(2)}U`} />
                  <Field
                    label="CLV"
                    value={p.clvCents !== null ? `${p.clvCents > 0 ? "+" : ""}${p.clvCents}¢` : "—"}
                    pos={p.clvCents !== null && p.clvCents > 0}
                    neg={p.clvCents !== null && p.clvCents < 0}
                  />
                </div>

                <p className="mono text-[0.7rem] text-white/60 line-clamp-3 leading-relaxed">
                  {p.thesis}
                </p>
                <p className="mono text-[0.6rem] text-[var(--hazard)] mt-3 opacity-0 group-hover:opacity-100">
                  ▶ FULL THESIS + LINE JOURNEY
                </p>
              </div>
            </button>
          );
        })}
      </div>

      <PickDetailModal pick={open} onClose={() => setOpen(null)} />
    </section>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-end justify-between mb-4 pb-3 border-b-[3px] border-white">
      <h2 className="display-tight text-4xl sm:text-5xl text-white">{title}</h2>
      <span className="display-eyebrow text-[var(--hazard)]">{subtitle}</span>
    </div>
  );
}

function Field({
  label,
  value,
  hazard,
  pos,
  neg,
}: {
  label: string;
  value: string;
  hazard?: boolean;
  pos?: boolean;
  neg?: boolean;
}) {
  const color = hazard
    ? "text-[var(--hazard)]"
    : pos
    ? "text-[var(--color-win)]"
    : neg
    ? "text-[var(--color-loss)]"
    : "text-white";
  return (
    <div className="px-2 py-2 border-r-[3px] border-white last:border-r-0 text-center">
      <p className="display-eyebrow text-white/60 text-[0.55rem]">{label}</p>
      <p className={`odds-display mt-0.5 text-base ${color}`}>{value}</p>
    </div>
  );
}
