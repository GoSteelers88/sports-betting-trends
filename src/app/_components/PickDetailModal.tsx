"use client";

import { useEffect } from "react";
import type { SlatePick } from "../_data/dashboard";

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

export function PickDetailModal({
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

  const modelPct = (pick.modelProb * 100).toFixed(1);
  const marketPct = (pick.marketProb * 100).toFixed(1);
  const edgePct = (pick.edge * 100).toFixed(1);
  const clv = pick.clvCents;
  const hasClosing = pick.closingOddsAmerican !== null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${pick.matchup} pick details`}
      className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center p-0 sm:p-6"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/85"
      />

      <div
        className="relative w-full sm:max-w-2xl bg-black border-[3px] border-[var(--hazard)] max-h-[92vh] overflow-y-auto animate-[slideUp_0.25s_ease-out]"
      >
        {/* header strip */}
        <div className="hazard-tape h-2" aria-hidden="true" />

        <div className="p-5 sm:p-7">
          <div className="flex items-start justify-between gap-3 mb-5 pb-4 border-b-[3px] border-white">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="display-eyebrow bg-white text-black px-2 py-0.5">
                  {leagueTag(pick.league)}
                </span>
                {pick.outcome?.result && (
                  <span
                    className={`display-eyebrow px-2 py-0.5 ${
                      pick.outcome.result === "win"
                        ? "bg-[var(--color-win)] text-black"
                        : pick.outcome.result === "loss"
                        ? "bg-[var(--color-loss)] text-white"
                        : "bg-white text-black"
                    }`}
                  >
                    {pick.outcome.result.toUpperCase()}
                  </span>
                )}
              </div>
              <h3 className="display-tight text-3xl sm:text-4xl text-white">
                {pick.matchup.toUpperCase()}
              </h3>
              <p className="display text-base text-[var(--hazard)] mt-2">
                {pick.selection.toUpperCase()} @ {fmtAmerican(pick.oddsAmerican)}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="shrink-0 w-10 h-10 bg-black border-[3px] border-white text-white display text-xl"
            >
              ×
            </button>
          </div>

          <div className="grid grid-cols-3 gap-0 border-[3px] border-white mb-5">
            <MetricBox label="MODEL" value={`${modelPct}%`} />
            <MetricBox label="MARKET" value={`${marketPct}%`} />
            <MetricBox label="EDGE" value={`${edgePct}%`} hazard />
          </div>

          <div className="mb-5">
            <p className="display-eyebrow text-white mb-2">LINE JOURNEY</p>
            <div className="border-[3px] border-white p-4 flex items-center justify-between gap-4">
              <div className="text-center">
                <p className="display-eyebrow text-white/60 text-[0.6rem]">PICKED AT</p>
                <p className="odds-display text-2xl text-white mt-1">{fmtAmerican(pick.oddsAmerican)}</p>
              </div>
              <div className="flex-1 relative h-[3px] bg-white">
                {hasClosing && (
                  <span
                    className={`absolute -top-3 left-1/2 -translate-x-1/2 mono text-[0.65rem] px-1.5 py-0.5 whitespace-nowrap ${
                      clv === null
                        ? "bg-white text-black"
                        : clv > 0
                        ? "bg-[var(--color-win)] text-black"
                        : clv < 0
                        ? "bg-[var(--color-loss)] text-white"
                        : "bg-white text-black"
                    }`}
                  >
                    {clv !== null ? `${clv > 0 ? "+" : ""}${clv}¢ CLV` : "—"}
                  </span>
                )}
              </div>
              <div className="text-center">
                <p className="display-eyebrow text-white/60 text-[0.6rem]">CLOSED AT</p>
                <p className={`odds-display text-2xl mt-1 ${hasClosing ? "text-white" : "text-white/30"}`}>
                  {hasClosing ? fmtAmerican(pick.closingOddsAmerican!) : "PEND"}
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-0 border-[3px] border-white mb-5">
            <MetricBox label="STAKE" value={`${pick.kellyStakeUnits.toFixed(2)}U`} />
            <MetricBox label="CONFIDENCE" value={`${pick.confidence}`} />
          </div>

          <div className="mb-5">
            <p className="display-eyebrow text-white mb-2">THESIS</p>
            <p className="mono text-sm text-white leading-relaxed">{pick.thesis}</p>
          </div>

          {pick.invalidation && (
            <div className="mb-2">
              <p className="display-eyebrow text-[var(--hazard)] mb-2">INVALIDATION</p>
              <p className="mono text-sm text-white/80 leading-relaxed">{pick.invalidation}</p>
            </div>
          )}

          {pick.outcome?.unitsPnl !== null && pick.outcome?.unitsPnl !== undefined && (
            <div className="mt-5 pt-4 border-t-[3px] border-white flex items-center justify-between">
              <span className="display text-white">RESULT</span>
              <span
                className={`odds-display text-3xl ${
                  pick.outcome.unitsPnl > 0
                    ? "text-[var(--color-win)]"
                    : pick.outcome.unitsPnl < 0
                    ? "text-[var(--color-loss)]"
                    : "text-white"
                }`}
              >
                {pick.outcome.unitsPnl > 0 ? "+" : ""}
                {pick.outcome.unitsPnl.toFixed(2)}U
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricBox({
  label,
  value,
  hazard,
}: {
  label: string;
  value: string;
  hazard?: boolean;
}) {
  return (
    <div className="px-3 py-3 border-r-[3px] border-white last:border-r-0 text-center">
      <p className="display-eyebrow text-white/60 text-[0.6rem]">{label}</p>
      <p className={`odds-display mt-1 text-2xl ${hazard ? "text-[var(--hazard)]" : "text-white"}`}>{value}</p>
    </div>
  );
}
