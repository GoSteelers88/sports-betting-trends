"use client";

import { useEffect, useState } from "react";
import type { SlatePick } from "../_data/dashboard";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function pad(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return s + " ".repeat(len - s.length);
}

function rcptDate(iso: string): string {
  const d = new Date(iso);
  return d
    .toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .toUpperCase();
}

export function PickDetailModal({
  pick,
  onClose,
}: {
  pick: SlatePick | null;
  onClose: () => void;
}) {
  // Drive the flash overlay separately from the receipt enter — flash fires
  // immediately on open, fades over ~450ms; receipt slides in beneath it.
  const [flashKey, setFlashKey] = useState(0);

  useEffect(() => {
    if (!pick) return;
    setFlashKey(k => k + 1); // re-fire animation on each open
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

  const W = 42; // column width — same as a typical 80mm thermal printer
  const dashLine = "=".repeat(W);
  const dotLine = "-".repeat(W);

  const stake = pick.kellyStakeUnits;
  const toWin = stake * (pick.oddsAmerican > 0 ? pick.oddsAmerican / 100 : 100 / -pick.oddsAmerican);
  const modelPct = (pick.modelProb * 100).toFixed(1);
  const marketPct = (pick.marketProb * 100).toFixed(1);
  const edgePct = (pick.edge * 100).toFixed(2);
  const clv = pick.clvCents;
  const closing = pick.closingOddsAmerican;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${pick.matchup} receipt`}
      className="fixed inset-0 z-[9999] flex items-start sm:items-center justify-center p-4 sm:p-8 overflow-y-auto"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/85"
      />

      {/* Full-screen color flash — fires on every open via re-keyed div */}
      <div key={flashKey} className="color-flash" aria-hidden="true" />

      {/* The receipt itself — slides down from above like fresh thermal paper */}
      <div
        className="relative receipt receipt-grain max-w-[440px] w-full p-6 sm:p-8 my-12"
        style={{ animation: "receipt-print 0.55s cubic-bezier(0.16, 1, 0.3, 1)" }}
      >
        <button
          type="button"
          aria-label="Close receipt"
          onClick={onClose}
          className="bare absolute -top-6 right-2 text-[#e9e4d8] text-xs uppercase tracking-widest hover:text-[var(--rust-flash)]"
        >
          [TEAR_OFF ×]
        </button>

        <pre className="text-[0.78rem] sm:text-[0.85rem] leading-[1.5] whitespace-pre-wrap break-words font-bold">
{`        NATESTACKS POS
        TRANSMISSION_${rcptDate(pick.createdAt).slice(0, 8)}
${dashLine}
RCPT#  : ${pad(String(pick.id), 12)}
LEAGUE : ${pad(pick.league, 12)}
TIME   : ${rcptDate(pick.createdAt)}
${dotLine}

  ${pick.matchup.toUpperCase()}

${dotLine}
WAGER
  ${pick.selection.toUpperCase()}
  MARKET .......... ${pick.market.toUpperCase()}
  ODDS  ........... ${fmtAmerican(pick.oddsAmerican)}
  STAKE  .......... ${stake.toFixed(2).padStart(8)}U
  TO WIN .......... ${toWin.toFixed(2).padStart(8)}U
${dotLine}
MODEL READOUT
  MODEL PROB ...... ${pad(modelPct + "%", 10)}
  MARKET PROB ..... ${pad(marketPct + "%", 10)}
  EDGE   .......... ${pad("+" + edgePct + "%", 10)}
  CONF (1-100) .... ${pad(String(pick.confidence), 10)}
${dotLine}
LINE JOURNEY
  PICKED AT ....... ${pad(fmtAmerican(pick.oddsAmerican), 8)}
  CLOSED AT ....... ${pad(closing !== null ? fmtAmerican(closing) : "—", 8)}
  CLV  ............ ${pad(
    clv !== null ? `${clv > 0 ? "+" : ""}${clv}¢` : "PENDING",
    8
  )}
${dotLine}

THESIS:
  ${pick.thesis.split("\n").join("\n  ")}

INVALIDATION:
  ${pick.invalidation || "—"}

${pick.outcome
  ? `${dotLine}\nGRADED ${pick.outcome.result.toUpperCase()}\n  ACTUAL ........ ${pick.outcome.actualOutcome ?? "—"}\n  P/L  .......... ${(pick.outcome.unitsPnl ?? 0) > 0 ? "+" : ""}${(pick.outcome.unitsPnl ?? 0).toFixed(2)}U\n`
  : `${dotLine}\nSTATUS: PENDING — AWAITING SETTLEMENT\n`}
${dashLine}
  KEEP THIS RECEIPT FOR YOUR RECORDS
  PICKS ARE MODEL OUTPUT - NOT ADVICE
${dashLine}

      THANK YOU FOR YOUR EDGE.
`}
        </pre>

        {/* Faux barcode — vertical bars row */}
        <div className="mt-2 mb-1">
          <Barcode seed={pick.id} />
          <p className="text-center text-[0.7rem] tracking-[0.3em] mt-1">
            {String(pick.id).padStart(10, "0")}
          </p>
        </div>
      </div>
    </div>
  );
}

// Deterministic faux-barcode generated from the pick id — gives every receipt
// a unique bar pattern without external libs.
function Barcode({ seed }: { seed: number }) {
  const bars: { w: number; black: boolean }[] = [];
  let n = (seed + 1) * 2654435761;
  for (let i = 0; i < 48; i++) {
    n ^= n << 13;
    n ^= n >>> 17;
    n ^= n << 5;
    const w = ((n >>> 0) % 4) + 1;
    bars.push({ w, black: i % 2 === 0 });
  }
  return (
    <div className="flex items-stretch h-12 gap-[1px]">
      {bars.map((b, i) => (
        <span
          key={i}
          style={{
            width: `${b.w}px`,
            background: b.black ? "#1a1a1a" : "transparent",
            flexGrow: b.w / 2,
          }}
        />
      ))}
    </div>
  );
}
