"use client";

// Folio 02 — Tonight's play. The merged hero/survivor brief: the top game
// pick runs ONCE as the full story (headline, thesis pull-quote, autopsy
// stats, what-kills-it); additional surviving picks sit in a ledger table
// below and the table disappears entirely when there's just one. When
// nothing survived, the folio compresses to a single honest line — no
// empty-state theater.

import { useState } from "react";
import type { SlatePick } from "../_data/dashboard";
import { SectionHeader } from "./SectionHeader";
import { PickAutopsy } from "./PickAutopsy";
import { fmtAmerican, fmtPct, propLabel } from "./format";

export function TonightsPlay({ picks }: { picks: SlatePick[] }) {
  const [openId, setOpenId] = useState<number | null>(null);

  const sorted = [...picks].sort((a, b) => b.edge - a.edge);
  const headline = sorted[0] ?? null;
  const others = sorted.slice(1);

  if (!headline) {
    return (
      <section>
        <SectionHeader
          id="tonights-play"
          index="02"
          label="TONIGHT'S PLAY"
          title="No edge found."
          status="Capital held"
          statusTone="loss"
        />
        <p className="num text-sm text-ink-2 mt-4 max-w-2xl leading-relaxed">
          Nothing cleared the 6% edge floor plus the critic pass tonight. Discipline
          beats action — the bankroll stays on the bench.
        </p>
      </section>
    );
  }

  const open = openId !== null ? picks.find(p => p.id === openId) ?? null : null;
  const isProp = headline.market === "prop" && headline.player;
  const result = headline.outcome?.result ?? null;

  return (
    <section className="space-y-10">
      <SectionHeader
        id="tonights-play"
        index="02"
        label="TONIGHT'S PLAY"
        title={picks.length === 1 ? "The play" : `${picks.length} survivors tonight`}
        subtitle="Picks that lived through analyst, grader, devil's-advocate critic, and bankroll guard."
        status={`${picks.length} shipped`}
        statusTone="win"
      />

      {/* The story — 8/4 */}
      <article className="grid grid-cols-1 lg:grid-cols-12 gap-10">
        <div className="lg:col-span-8">
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <span className="tag" style={{ color: "var(--blue)" }}>
              Survived the critic
            </span>
            <span className="eyebrow">{headline.league}</span>
            {result && (
              <span
                className="tag"
                style={{
                  color:
                    result === "win" ? "var(--win)" : result === "loss" ? "var(--loss)" : "var(--ink-2)",
                }}
              >
                {result}
              </span>
            )}
          </div>

          <h3
            className="headline text-ink"
            style={{ fontSize: "clamp(2.25rem, 5.5vw, 4.5rem)" }}
          >
            {isProp ? headline.player : headline.matchup}
          </h3>
          {isProp && <p className="mt-2 num text-xs text-ink-2">{headline.matchup}</p>}
          <p className="mt-4 num text-xl sm:text-2xl font-semibold">
            <span style={{ color: "var(--win)" }}>
              {isProp
                ? `${headline.side?.toUpperCase()} ${headline.line} ${propLabel(headline.propType)}`
                : headline.selection}
            </span>{" "}
            <span className="text-ink">@ {fmtAmerican(headline.oddsAmerican)}</span>
          </p>

          {/* Thesis pull-quote */}
          <blockquote className="deck mt-8 pl-6 border-l-2 border-rule-strong text-xl sm:text-2xl text-ink max-w-2xl italic font-display">
            {headline.thesis}
          </blockquote>

          <p className="mt-6 max-w-2xl text-sm text-ink-2 leading-relaxed">
            <span className="eyebrow mr-2" style={{ color: "var(--loss)" }}>
              What kills it
            </span>
            {headline.invalidation || "—"}
          </p>

          <button
            type="button"
            onClick={() => setOpenId(headline.id)}
            className="mt-8 eyebrow inline-flex items-center gap-3 text-ink hover:text-loss transition-colors group"
          >
            <span className="w-10 h-px bg-current group-hover:w-16 transition-all duration-300" />
            Open autopsy
          </button>
        </div>

        {/* Data rail — the autopsy stats */}
        <dl className="lg:col-span-4 lg:border-l lg:border-rule lg:pl-10 self-start">
          <RailFigure label="Edge" value={fmtPct(headline.edge, 2)} tone="var(--win)" big />
          <RailFigure label="Stake" value={`${headline.kellyStakeUnits.toFixed(2)}u`} tone="var(--ink)" />
          <RailFigure label="Model probability" value={fmtPct(headline.modelProb)} tone="var(--blue)" />
          <RailFigure label="Market probability" value={fmtPct(headline.marketProb)} tone="var(--ink-2)" />
          <RailFigure label="Confidence" value={`${headline.confidence}`} tone="var(--ink)" />
          <RailFigure
            label="CLV"
            value={
              headline.market === "prop"
                ? "n/a"
                : headline.clvCents !== null
                ? `${headline.clvCents > 0 ? "+" : ""}${headline.clvCents}¢`
                : "pending"
            }
            tone={
              headline.market === "prop"
                ? "var(--ink-3)"
                : headline.clvCents !== null && headline.clvCents > 0
                ? "var(--win)"
                : headline.clvCents !== null && headline.clvCents < 0
                ? "var(--loss)"
                : "var(--hold)"
            }
            last
          />
        </dl>
      </article>

      {/* Additional survivors — only when there are any */}
      {others.length > 0 && (
        <div>
          <p className="eyebrow mb-2">Additional plays</p>
          <div className="panel overflow-x-auto">
            <table className="ledger-table">
              <caption className="sr-only">Additional surviving picks</caption>
              <thead>
                <tr>
                  <th scope="col" className="hidden sm:table-cell">Lg</th>
                  <th scope="col">Pick</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Odds</th>
                  <th scope="col" className="text-right">Edge</th>
                  <th scope="col" className="text-right hidden sm:table-cell">Stake</th>
                  <th scope="col" className="text-right">
                    <span className="sr-only">Autopsy</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {others.map(p => (
                  <tr key={p.id}>
                    <td className="hidden sm:table-cell">
                      <span className="tag">{p.league}</span>
                    </td>
                    <td className="min-w-0 max-w-[320px]">
                      {p.market === "prop" && p.player ? (
                        <>
                          <p className="text-sm text-ink font-medium leading-snug break-words">{p.player}</p>
                          <p className="num text-xs text-ink-2 leading-snug break-words">
                            {p.side?.toUpperCase()} {p.line} {propLabel(p.propType)} · {p.matchup}
                            <span className="sm:hidden"> · {fmtAmerican(p.oddsAmerican)} · {p.kellyStakeUnits.toFixed(2)}u</span>
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm text-ink font-medium leading-snug break-words">{p.matchup}</p>
                          <p className="num text-xs text-ink-2 leading-snug break-words">
                            {p.selection}
                            <span className="sm:hidden"> · {fmtAmerican(p.oddsAmerican)} · {p.kellyStakeUnits.toFixed(2)}u</span>
                          </p>
                        </>
                      )}
                    </td>
                    <td className="num text-sm text-ink text-right hidden sm:table-cell">
                      {fmtAmerican(p.oddsAmerican)}
                    </td>
                    <td className="num text-sm text-right font-medium" style={{ color: "var(--win)" }}>
                      {fmtPct(p.edge, 1)}
                    </td>
                    <td className="num text-xs text-ink-2 text-right hidden sm:table-cell">
                      {p.kellyStakeUnits.toFixed(2)}u
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        onClick={() => setOpenId(p.id)}
                        className="eyebrow px-2 py-1 border border-rule text-ink-2 hover:text-loss hover:border-loss transition-colors"
                      >
                        Autopsy
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <PickAutopsy pick={open} onClose={() => setOpenId(null)} />
    </section>
  );
}

function RailFigure({
  label,
  value,
  tone,
  big = false,
  last = false,
}: {
  label: string;
  value: string;
  tone: string;
  big?: boolean;
  last?: boolean;
}) {
  return (
    <div className={`py-3 ${last ? "" : "border-b border-rule"}`}>
      <dt className="eyebrow mb-1.5">{label}</dt>
      <dd
        className="num-display"
        style={{
          fontSize: big ? "clamp(2.25rem, 4.5vw, 3.5rem)" : "clamp(1.25rem, 2vw, 1.75rem)",
          color: tone,
        }}
      >
        {value}
      </dd>
    </div>
  );
}
