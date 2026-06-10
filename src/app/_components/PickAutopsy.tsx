"use client";

// The autopsy sheet — a pulled case file for one pick. Full lifecycle from
// detection through CLV capture, grading, and memory feedback, on a raised
// sheet of paper over an ink scrim.

import { useEffect } from "react";
import type { SlatePick } from "../_data/dashboard";
import { fmtAmerican } from "./format";

function fmtPct(n: number, d = 1): string {
  return `${(n * 100).toFixed(d)}%`;
}

type StageKey =
  | "detected"
  | "modeled"
  | "graded"
  | "critic"
  | "shipped"
  | "clv"
  | "result"
  | "memory";

type Stage = {
  key: StageKey;
  label: string;
  status: "done" | "active" | "future" | "killed";
  detail: string;
};

function buildLifecycle(pick: SlatePick): Stage[] {
  const shipped = true; // it's in AgentPick so it was shipped
  const isProp = pick.market === "prop";
  const clvDone = pick.clvCents !== null;
  const resultDone = pick.outcome !== null;
  return [
    {
      key: "detected",
      label: "DETECTED",
      status: "done",
      detail: isProp
        ? `Analyst surfaced this prop via get_player_props.`
        : `Analyst surfaced this market via get_odds + get_model_probabilities tools.`,
    },
    {
      key: "modeled",
      label: "MODELED",
      status: "done",
      detail: isProp
        ? `Projection via get_prop_projection → model ${fmtPct(pick.modelProb)} vs market ${fmtPct(pick.marketProb)} → edge ${fmtPct(pick.edge, 2)}.`
        : `Model ${fmtPct(pick.modelProb)} vs market ${fmtPct(pick.marketProb)} → edge ${fmtPct(pick.edge, 2)}.`,
    },
    {
      key: "graded",
      label: "GRADED",
      status: "done",
      detail: `Local grader passed: edge ≥ 6%, stake ≤ 2u, thesis ≥ 80 chars${isProp ? ", structured prop fields present" : ""}.`,
    },
    {
      key: "critic",
      label: "CRITIC CHALLENGED",
      status: "done",
      detail: `Devil's-advocate Sonnet pass with full reasoning trace. Verdict: KEEP.`,
    },
    {
      key: "shipped",
      label: shipped ? "SHIPPED" : "KILLED",
      status: shipped ? "done" : "killed",
      detail: shipped
        ? `Persisted to AgentPick #${pick.id} (idempotent via @@unique) + posted to Discord.`
        : "Dropped before persistence.",
    },
    {
      key: "clv",
      label: "CLV CAPTURED",
      status: isProp ? "future" : clvDone ? "done" : shipped ? "active" : "future",
      detail: isProp
        ? "CLV not tracked for props — prop markets lack the market-making liquidity for closing line to be a reliable edge signal."
        : clvDone
        ? `Closed at ${fmtAmerican(pick.closingOddsAmerican)} → CLV ${pick.clvCents! > 0 ? "+" : ""}${pick.clvCents}¢.`
        : "Awaiting closing line capture (12h pre-game to 30min post-start window).",
    },
    {
      key: "result",
      label: "RESULT GRADED",
      status: resultDone
        ? pick.outcome?.result === "loss"
          ? "killed"
          : "done"
        : "future",
      detail: resultDone
        ? `${pick.outcome!.result.toUpperCase()} — ${
            pick.outcome!.unitsPnl
              ? (pick.outcome!.unitsPnl > 0 ? "+" : "") + pick.outcome!.unitsPnl.toFixed(2) + "u"
              : ""
          }`
        : "Awaiting ESPN final.",
    },
    {
      key: "memory",
      label: "MEMORY UPDATE",
      status: resultDone ? "active" : "future",
      detail: resultDone
        ? "Outcome feeds next Dream consolidation (Mondays 06:00 UTC)."
        : "Will inform Dream after grading completes.",
    },
  ];
}

const STAGE_TONE: Record<Stage["status"], string> = {
  done: "var(--win)",
  active: "var(--hold)",
  future: "var(--ink-3)",
  killed: "var(--loss)",
};

export function PickAutopsy({
  pick,
  onClose,
}: {
  pick: SlatePick | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!pick) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [pick, onClose]);

  if (!pick) return null;
  const stages = buildLifecycle(pick);
  const result = pick.outcome?.result ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Autopsy: ${pick.matchup}`}
      className="fixed inset-0 z-[9999] flex items-stretch sm:items-center justify-center"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0"
        style={{ background: "rgba(31, 27, 22, 0.55)" }}
      />

      <div
        className="relative w-full sm:max-w-2xl h-full sm:h-auto sm:max-h-[92vh] overflow-y-auto bg-paper border border-rule-strong"
        style={{ animation: "sheet-rise 0.25s ease-out", boxShadow: "8px 8px 0 rgba(31,27,22,0.25)" }}
      >
        {/* Sheet header */}
        <header className="sticky top-0 z-10 bg-paper border-b border-rule-strong px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-1.5">
              <span className="folio">Case file · Pick #{pick.id}</span>
              <span
                className={result === "win" || result === "loss" ? "stamp-row" : "tag"}
                style={{
                  color:
                    result === "win"
                      ? "var(--win)"
                      : result === "loss"
                      ? "var(--loss)"
                      : "var(--hold)",
                }}
              >
                {result ?? "pending"}
              </span>
            </div>
            <h2 className="headline text-2xl sm:text-3xl text-ink truncate">{pick.matchup}</h2>
            <p className="num text-sm mt-1" style={{ color: "var(--win)" }}>
              {pick.selection} @ {fmtAmerican(pick.oddsAmerican)} · {fmtPct(pick.edge, 2)} edge
            </p>
          </div>
          <button
            type="button"
            aria-label="Close autopsy"
            onClick={onClose}
            className="shrink-0 w-9 h-9 border border-rule flex items-center justify-center num text-lg text-ink-2 hover:border-loss hover:text-loss transition-colors"
          >
            ×
          </button>
        </header>

        <div className="p-5 space-y-7">
          {/* Numeric brief */}
          <div className="grid grid-cols-2 sm:grid-cols-4 border border-rule divide-x divide-y sm:divide-y-0 divide-rule bg-paper-2">
            <Mini label="Model" value={fmtPct(pick.modelProb)} tone="var(--blue)" />
            <Mini label="Market" value={fmtPct(pick.marketProb)} tone="var(--ink-2)" />
            <Mini label="Stake" value={`${pick.kellyStakeUnits.toFixed(2)}u`} tone="var(--ink)" />
            <Mini
              label="CLV"
              value={
                pick.market === "prop"
                  ? "n/a"
                  : pick.clvCents !== null
                  ? `${pick.clvCents > 0 ? "+" : ""}${pick.clvCents}¢`
                  : "pend"
              }
              tone={
                pick.market === "prop"
                  ? "var(--ink-3)"
                  : pick.clvCents !== null && pick.clvCents > 0
                  ? "var(--win)"
                  : pick.clvCents !== null && pick.clvCents < 0
                  ? "var(--loss)"
                  : "var(--hold)"
              }
            />
          </div>

          {/* Lifecycle */}
          <section>
            <p className="eyebrow mb-2">Lifecycle</p>
            <ol className="border-t border-rule">
              {stages.map(s => (
                <li key={s.key} className="flex items-start gap-3 py-2.5 border-b border-rule">
                  <StageGlyph status={s.status} />
                  <div className="flex-1 min-w-0">
                    <p className="eyebrow" style={{ color: STAGE_TONE[s.status] }}>
                      {s.label}
                    </p>
                    <p className="text-sm text-ink leading-snug mt-0.5">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* Thesis + invalidation */}
          <section>
            <p className="eyebrow mb-1.5" style={{ color: "var(--win)" }}>
              Why it shipped
            </p>
            <p className="deck text-base text-ink leading-relaxed">{pick.thesis}</p>
          </section>
          {pick.invalidation && (
            <section>
              <p className="eyebrow mb-1.5" style={{ color: "var(--loss)" }}>
                What would kill it
              </p>
              <p className="text-sm text-ink leading-relaxed">{pick.invalidation}</p>
            </section>
          )}

          {/* Line journey */}
          <section>
            <p className="eyebrow mb-1.5" style={{ color: "var(--blue)" }}>
              Line journey
            </p>
            <div className="panel p-4 flex items-center justify-between gap-4">
              <div>
                <p className="eyebrow text-ink-3">Picked at</p>
                <p className="num-display text-xl mt-1 text-ink">
                  {fmtAmerican(pick.oddsAmerican)}
                </p>
              </div>
              <div className="flex-1 border-t border-dashed border-rule-strong" aria-hidden />
              <div className="text-right">
                <p className="eyebrow text-ink-3">Closed at</p>
                <p
                  className="num-display text-xl mt-1"
                  style={{ color: pick.closingOddsAmerican !== null ? "var(--ink)" : "var(--ink-3)" }}
                >
                  {pick.closingOddsAmerican !== null
                    ? fmtAmerican(pick.closingOddsAmerican)
                    : "pend"}
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Mini({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="px-3 py-2.5">
      <p className="eyebrow text-ink-3">{label}</p>
      <p className="num-display text-lg mt-1" style={{ color: tone }}>
        {value}
      </p>
    </div>
  );
}

function StageGlyph({ status }: { status: Stage["status"] }) {
  const tone = STAGE_TONE[status];
  const glyph =
    status === "killed" ? "×" : status === "future" ? "○" : status === "active" ? "◐" : "●";
  return (
    <span
      aria-hidden="true"
      className="shrink-0 w-7 h-7 num text-sm flex items-center justify-center border"
      style={{ color: tone, borderColor: tone, opacity: status === "future" ? 0.5 : 1 }}
    >
      {glyph}
    </span>
  );
}
