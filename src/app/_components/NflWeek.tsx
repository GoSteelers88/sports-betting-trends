// Folio 11 — the NFL week board. Sharp Pinnacle main lines with de-vigged
// fair probabilities for every game in the coming week, refreshed daily for
// free. DISPLAY ONLY: the NFL quarantine is permanent (no agent picks, no
// Turso, no IN_SCOPE_LEAGUES) — NFL picks live exclusively on /nfl, the
// receipts page, and this section's job includes saying so.

import fs from "node:fs";
import path from "node:path";
import { SectionHeader } from "./SectionHeader";
import type { NflSlate } from "@/lib/nfl-receipts/site-slate";

function loadSlate(): NflSlate | null {
  const p = path.join(process.cwd(), "data", "processed", "nfl-slate.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as NflSlate;
  } catch {
    return null;
  }
}

function fmtML(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n > 0 ? `+${n}` : String(n);
}

function fmtSpread(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function fmtPct(x: number | null): string {
  if (x == null) return "—";
  return (x * 100).toFixed(0) + "%";
}

function fmtKick(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

/** Nickname keeps rows agate-narrow — every NFL nickname is the final word
 *  ("Kansas City Chiefs" → "Chiefs", "San Francisco 49ers" → "49ers"). */
function shortName(full: string): string {
  return full.split(" ").slice(-1)[0] ?? full;
}

export function NflWeek() {
  const slate = loadSlate();

  return (
    <section className="space-y-5">
      <SectionHeader
        id="nfl-week"
        index="11"
        label="THE NFL WEEK · SHARP BOARD"
        title="Football, at the sharp number"
        subtitle="Every game this week at Pinnacle's main lines, with the de-vigged fair win probability — the same devig the receipts ledger grades against. This board is the market, not a pick sheet: NFL picks publish only on the receipts page, pre-registered, at real entry prices, judged by closing-line value against a control arm."
        status="Display only · picks live on /nfl"
        statusTone="blue"
      />

      <p className="num text-sm">
        <a href="/nfl" className="underline underline-offset-4 text-ink hover:text-loss transition-colors">
          → The receipts: the NFL live ledger
        </a>{" "}
        <span className="text-ink-2">
          — immutable boards, real entry prices, CLV vs the sharp close, and the honest
          negative-holdout disclosure.
        </span>
      </p>

      {!slate || slate.games.length === 0 ? (
        <div className="panel-dim p-6 text-center">
          <p className="num text-sm text-ink-2">
            — No NFL games inside the week window. The board refreshes daily from the sharp
            feed. —
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-rule-strong">
                <th className="num text-xs text-ink-2 font-normal py-2 pr-3">KICKOFF (ET)</th>
                <th className="num text-xs text-ink-2 font-normal py-2 pr-3">MATCHUP</th>
                <th className="num text-xs text-ink-2 font-normal py-2 pr-3 text-right">ML</th>
                <th className="num text-xs text-ink-2 font-normal py-2 pr-3 text-right">FAIR</th>
                <th className="num text-xs text-ink-2 font-normal py-2 pr-3 text-right">SPREAD</th>
                <th className="num text-xs text-ink-2 font-normal py-2 text-right">TOTAL</th>
              </tr>
            </thead>
            <tbody>
              {slate.games.map((g) => (
                <tr key={`${g.kickoffUtc}-${g.home_team}`} className="border-b border-rule align-baseline">
                  <td className="num text-xs text-ink-2 py-2.5 pr-3 whitespace-nowrap">
                    {fmtKick(g.kickoffUtc)}
                  </td>
                  <td className="num text-sm text-ink py-2.5 pr-3">
                    {shortName(g.away_team)} <span className="text-ink-2">@</span>{" "}
                    {shortName(g.home_team)}
                  </td>
                  <td className="num text-sm text-ink py-2.5 pr-3 text-right whitespace-nowrap">
                    {g.moneyline ? (
                      <>
                        {fmtML(g.moneyline.away)} <span className="text-ink-2">/</span>{" "}
                        {fmtML(g.moneyline.home)}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num text-sm py-2.5 pr-3 text-right whitespace-nowrap">
                    {g.fairHomeProb != null ? (
                      <>
                        <span className="text-ink-2">{fmtPct(g.fairAwayProb)}</span>{" "}
                        <span className="text-ink-2">/</span>{" "}
                        <span style={{ color: "var(--blue)" }}>{fmtPct(g.fairHomeProb)}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num text-sm text-ink py-2.5 pr-3 text-right whitespace-nowrap">
                    {g.spread ? `${fmtSpread(g.spread.point)} (${fmtML(g.spread.home)})` : "—"}
                  </td>
                  <td className="num text-sm text-ink py-2.5 text-right whitespace-nowrap">
                    {g.total ? `${g.total.point}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="num text-xs text-ink-2 pt-3">
            away / home throughout · spread and price are the home side · fair % = de-vigged
            (power) Pinnacle moneyline · refreshed{" "}
            {slate.generatedAt.slice(0, 16).replace("T", " ")}Z · {slate.gameCount} games in
            window
          </p>
        </div>
      )}
    </section>
  );
}
