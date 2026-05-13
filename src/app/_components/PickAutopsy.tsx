"use client";

import { useEffect } from "react";
import type { SlatePick } from "../_data/dashboard";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
function fmtPct(n: number, d = 1): string {
  return `${(n * 100).toFixed(d)}%`;
}

type StageKey = "detected" | "modeled" | "graded" | "critic" | "shipped" | "clv" | "result" | "memory";

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
        ? `Closed at ${fmtAmerican(pick.closingOddsAmerican ?? 0)} → CLV ${pick.clvCents! > 0 ? "+" : ""}${pick.clvCents}¢.`
        : "Awaiting closing line capture (12h pre-game to 30min post-start window).",
    },
    {
      key: "result",
      label: "RESULT GRADED",
      status: resultDone ? (pick.outcome?.result === "win" ? "done" : pick.outcome?.result === "loss" ? "killed" : "done") : "future",
      detail: resultDone
        ? `${pick.outcome!.result.toUpperCase()} — ${pick.outcome!.unitsPnl ? (pick.outcome!.unitsPnl > 0 ? "+" : "") + pick.outcome!.unitsPnl.toFixed(2) + "u" : ""}`
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

export function PickAutopsy({
  pick,
  onClose,
}: {
  pick: SlatePick | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!pick) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Autopsy: ${pick.matchup}`}
      className="fixed inset-0 z-[9999] flex items-stretch sm:items-center justify-end sm:justify-center"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />

      <div
        className="relative w-full sm:max-w-2xl h-full sm:h-auto sm:max-h-[92vh] overflow-y-auto surface-elev"
        style={{ animation: "modal-rise 0.25s ease-out" }}
      >
        {/* Header */}
        <header className="sticky top-0 z-10 backdrop-blur-md bg-[var(--surface-elev)]/95 border-b border-[var(--border)] px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="eyebrow text-[var(--muted)]">PICK #{pick.id} · AUTOPSY</span>
              <span
                className="pill"
                style={{
                  color: pick.outcome?.result === "win" ? "var(--edge)" : pick.outcome?.result === "loss" ? "var(--kill)" : "var(--signal)",
                  borderColor: pick.outcome?.result === "win" ? "var(--edge)" : pick.outcome?.result === "loss" ? "var(--kill)" : "var(--signal)",
                }}
              >
                {pick.outcome?.result?.toUpperCase() ?? "PENDING"}
              </span>
            </div>
            <h2 className="font-display text-2xl sm:text-3xl leading-tight truncate">
              {pick.matchup}
            </h2>
            <p className="font-mono text-sm text-[var(--edge)]">
              {pick.selection} @ {fmtAmerican(pick.oddsAmerican)} · {fmtPct(pick.edge, 2)} EDGE
            </p>
          </div>
          <button
            type="button"
            aria-label="Close autopsy"
            onClick={onClose}
            className="shrink-0 w-9 h-9 surface flex items-center justify-center hover:border-[var(--kill)] hover:text-[var(--kill)]"
          >
            ×
          </button>
        </header>

        <div className="p-5 space-y-6">
          {/* Top numeric brief */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border border-[var(--border)]">
            <Mini label="MODEL" value={fmtPct(pick.modelProb)} color="signal" />
            <Mini label="MARKET" value={fmtPct(pick.marketProb)} color="muted" />
            <Mini label="STAKE" value={`${pick.kellyStakeUnits.toFixed(2)}U`} />
            <Mini
              label="CLV"
              value={
                pick.market === "prop"
                  ? "N/A"
                  : pick.clvCents !== null ? `${pick.clvCents > 0 ? "+" : ""}${pick.clvCents}¢` : "PEND"
              }
              color={
                pick.market === "prop"
                  ? "muted"
                  : pick.clvCents !== null && pick.clvCents > 0 ? "edge"
                  : pick.clvCents !== null && pick.clvCents < 0 ? "kill"
                  : "muted"
              }
            />
          </div>

          {/* Lifecycle stages */}
          <section>
            <p className="eyebrow text-[var(--muted)] mb-2">LIFECYCLE</p>
            <ol className="space-y-0">
              {stages.map((s, i) => (
                <li
                  key={s.key}
                  className={`flex items-start gap-3 py-2.5 ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
                >
                  <StageGlyph status={s.status} index={i} />
                  <div className="flex-1 min-w-0">
                    <p
                      className="eyebrow"
                      style={{
                        color:
                          s.status === "killed"
                            ? "var(--kill)"
                            : s.status === "active"
                            ? "var(--warn)"
                            : s.status === "future"
                            ? "var(--muted)"
                            : "var(--edge)",
                      }}
                    >
                      {s.label}
                    </p>
                    <p className="text-sm text-[var(--text)] leading-snug mt-0.5">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* Thesis + invalidation */}
          <section>
            <p className="eyebrow text-[var(--edge)] mb-1.5">WHY IT SHIPPED</p>
            <p className="text-sm text-[var(--text)] leading-relaxed">{pick.thesis}</p>
          </section>
          {pick.invalidation && (
            <section>
              <p className="eyebrow text-[var(--warn)] mb-1.5">WHAT WOULD KILL IT</p>
              <p className="text-sm text-[var(--text)] leading-relaxed">{pick.invalidation}</p>
            </section>
          )}

          {/* Line journey */}
          <section>
            <p className="eyebrow text-[var(--signal)] mb-1.5">LINE JOURNEY</p>
            <div className="surface p-4 flex items-center justify-between gap-4">
              <div>
                <p className="eyebrow text-[var(--muted)]">PICKED AT</p>
                <p className="numeric text-xl mt-0.5">{fmtAmerican(pick.oddsAmerican)}</p>
              </div>
              <div className="flex-1 h-px bg-[var(--border)]" />
              <div className="text-right">
                <p className="eyebrow text-[var(--muted)]">CLOSED AT</p>
                <p
                  className="numeric text-xl mt-0.5"
                  style={{ color: pick.closingOddsAmerican !== null ? "var(--text)" : "var(--muted)" }}
                >
                  {pick.closingOddsAmerican !== null ? fmtAmerican(pick.closingOddsAmerican) : "PEND"}
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
  color = "text",
}: {
  label: string;
  value: string;
  color?: "edge" | "warn" | "kill" | "signal" | "muted" | "text";
}) {
  return (
    <div className="px-3 py-2.5 border-r border-[var(--border)] last:border-r-0">
      <p className="eyebrow text-[var(--muted)]">{label}</p>
      <p className="numeric text-lg mt-0.5" style={{ color: `var(--${color})` }}>{value}</p>
    </div>
  );
}

function StageGlyph({ status, index }: { status: Stage["status"]; index: number }) {
  const color =
    status === "killed"
      ? "var(--kill)"
      : status === "active"
      ? "var(--warn)"
      : status === "future"
      ? "var(--muted)"
      : "var(--edge)";
  const glyph = status === "killed" ? "×" : status === "future" ? "○" : status === "active" ? "◐" : "●";
  return (
    <span
      aria-hidden="true"
      className="shrink-0 w-7 h-7 font-mono text-sm flex items-center justify-center border"
      style={{ color, borderColor: color, opacity: status === "future" ? 0.5 : 1 }}
    >
      {glyph}
    </span>
  );
}
