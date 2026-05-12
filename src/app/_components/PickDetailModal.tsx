"use client";

import { useEffect } from "react";
import type { SlatePick } from "../_data/dashboard";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function leagueEmoji(league: string): string {
  if (league === "MLB") return "⚾";
  if (league === "NBA") return "🏀";
  return "🎯";
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
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [pick, onClose]);

  if (!pick) return null;

  const opening = pick.oddsAmerican;
  const closing = pick.closingOddsAmerican;
  const clv = pick.clvCents;

  const modelPct = (pick.modelProb * 100).toFixed(1);
  const marketPct = (pick.marketProb * 100).toFixed(1);
  const edgePct = (pick.edge * 100).toFixed(1);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${pick.matchup} pick details`}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />

      <div className="relative w-full sm:max-w-2xl glass-strong rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 max-h-[90vh] overflow-y-auto animate-[slideUp_0.25s_ease-out]">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-lg">{leagueEmoji(pick.league)}</span>
              <span className="display-eyebrow text-slate-400">{pick.league}</span>
              {pick.outcome?.result && (
                <span
                  className={`display-eyebrow px-1.5 py-0.5 rounded text-[0.6rem] ${
                    pick.outcome.result === "win"
                      ? "bg-[#22ff88]/15 text-[#22ff88]"
                      : pick.outcome.result === "loss"
                      ? "bg-[#ff3b3b]/15 text-[#ff3b3b]"
                      : "bg-white/10 text-slate-300"
                  }`}
                >
                  {pick.outcome.result.toUpperCase()}
                </span>
              )}
            </div>
            <h3 className="display text-xl sm:text-2xl text-white leading-tight">
              {pick.matchup}
            </h3>
            <p className="text-sm text-slate-300 mono mt-1">
              {pick.selection} · {fmtAmerican(pick.oddsAmerican)}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center text-slate-300 transition-colors"
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-4">
          <MetricBox label="Model" value={`${modelPct}%`} hint="agent prob" />
          <MetricBox label="Market" value={`${marketPct}%`} hint="implied prob" />
          <MetricBox label="Edge" value={`${edgePct}%`} hint="model − market" accent="#22ff88" />
        </div>

        <div className="mb-4">
          <p className="display-eyebrow text-slate-400 mb-2">Line journey</p>
          <LineJourney opening={opening} closing={closing} clv={clv} />
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4">
          <MetricBox
            label="Stake"
            value={`${pick.kellyStakeUnits.toFixed(2)}u`}
            hint="kelly-sized"
          />
          <MetricBox label="Confidence" value={`${pick.confidence}`} hint="1–5 scale" />
        </div>

        <div className="mb-4">
          <p className="display-eyebrow text-slate-400 mb-1.5">Thesis</p>
          <p className="text-sm text-slate-200 leading-relaxed">{pick.thesis}</p>
        </div>

        {pick.invalidation && (
          <div className="mb-2">
            <p className="display-eyebrow text-amber-300 mb-1.5">Invalidation</p>
            <p className="text-sm text-slate-300 leading-relaxed">{pick.invalidation}</p>
          </div>
        )}

        {pick.outcome?.unitsPnl !== null && pick.outcome?.unitsPnl !== undefined && (
          <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between">
            <span className="display-eyebrow text-slate-400">Result</span>
            <span
              className={`mono text-lg font-semibold ${
                pick.outcome.unitsPnl > 0
                  ? "text-[#22ff88]"
                  : pick.outcome.unitsPnl < 0
                  ? "text-[#ff3b3b]"
                  : "text-slate-300"
              }`}
            >
              {pick.outcome.unitsPnl > 0 ? "+" : ""}
              {pick.outcome.unitsPnl.toFixed(2)}u
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricBox({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2">
      <p className="display-eyebrow text-slate-500 text-[0.6rem]">{label}</p>
      <p
        className="mono mt-0.5 text-base font-semibold"
        style={{ color: accent ?? "#fff" }}
      >
        {value}
      </p>
      {hint && <p className="text-[0.6rem] text-slate-600 mt-0.5">{hint}</p>}
    </div>
  );
}

function LineJourney({
  opening,
  closing,
  clv,
}: {
  opening: number;
  closing: number | null;
  clv: number | null;
}) {
  const hasClosing = closing !== null;
  const clvColor =
    clv === null
      ? "#94a3b8"
      : clv > 0
      ? "#22ff88"
      : clv < 0
      ? "#ff3b3b"
      : "#94a3b8";

  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1 text-center">
          <p className="display-eyebrow text-slate-500 text-[0.6rem]">Picked at</p>
          <p className="mono text-base text-white mt-0.5">{fmtAmerican(opening)}</p>
        </div>

        <div className="flex-[2] relative h-px bg-white/10">
          <div
            className="absolute inset-y-0 left-0 right-0"
            style={{
              background: `linear-gradient(90deg, transparent, ${clvColor}, transparent)`,
              opacity: hasClosing ? 0.8 : 0.2,
            }}
          />
          {hasClosing && (
            <span
              className="absolute -top-2 left-1/2 -translate-x-1/2 mono text-[0.65rem] px-1.5 py-0.5 rounded-full whitespace-nowrap"
              style={{
                color: clvColor,
                background: "rgba(0,0,0,0.6)",
                border: `1px solid ${clvColor}44`,
              }}
            >
              {clv !== null ? `${clv > 0 ? "+" : ""}${clv}¢ CLV` : "—"}
            </span>
          )}
        </div>

        <div className="flex-1 text-center">
          <p className="display-eyebrow text-slate-500 text-[0.6rem]">Closed at</p>
          <p className="mono text-base mt-0.5" style={{ color: hasClosing ? "#fff" : "#475569" }}>
            {hasClosing ? fmtAmerican(closing!) : "pending"}
          </p>
        </div>
      </div>
    </div>
  );
}
