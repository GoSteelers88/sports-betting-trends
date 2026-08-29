// /nfl — the receipts page. A public, pre-registered ledger of NFL Experiment
// No. 5's live picks: real entry prices with provenance, devigged CLV vs a
// sharp close, PLAY arm minus a frozen control arm, coverage printed next to
// every rate. No ROI claim appears here — the 2025 holdout was negative and
// this page says so. Set in the Paper Trial system (Fraunces words, Plex Mono
// numbers).

import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import {
  headline,
  VERDICT_MIN_N,
  type Ledger,
  type LedgerRow,
} from "@/lib/nfl-receipts/ledger";
import type { PublishedBoard } from "@/lib/nfl-receipts/board";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "The receipts — NFL live ledger",
  description:
    "Pre-registered NFL picks ledger: real entry prices, devigged closing-line value vs a sharp benchmark, and a control arm. No ROI claims — the pre-registered 2025 holdout was negative and is linked here.",
  alternates: { canonical: "/nfl" },
};

const NFL_DIR = path.join(process.cwd(), "data", "processed", "nfl-live");
const SEASON_WEEKS = 18;

function loadLedgerFile(): Ledger | null {
  const p = path.join(NFL_DIR, "ledger.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Ledger;
  } catch {
    return null;
  }
}

function loadBoards(): PublishedBoard[] {
  if (!fs.existsSync(NFL_DIR)) return [];
  return fs
    .readdirSync(NFL_DIR)
    .filter((f) => /^board-\d{4}-wk\d{2}\.json$/.test(f))
    .sort()
    .reverse()
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(NFL_DIR, f), "utf-8")) as PublishedBoard;
      } catch {
        return null;
      }
    })
    .filter((b): b is PublishedBoard => b !== null);
}

function fmtML(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n > 0 ? `+${n}` : String(n);
}
function fmtPct(x: number | null | undefined, dec = 1): string {
  if (x == null) return "—";
  return (x * 100).toFixed(dec) + "%";
}
function fmtPp(x: number | null | undefined, dec = 1): string {
  if (x == null) return "—";
  return `${x >= 0 ? "+" : ""}${x.toFixed(dec)}pp`;
}
function fmtKick(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  });
}

export default function NflReceiptsPage() {
  const ledger = loadLedgerFile();
  const boards = loadBoards();
  const h = ledger ? headline(ledger) : null;
  const gradedPlay = h?.play.graded ?? 0;
  const weeksPublished = ledger?.boards.length ?? 0;
  const perWeek = weeksPublished > 0 ? gradedPlay / weeksPublished : 0;
  const weeksToVerdict =
    perWeek > 0 ? Math.ceil((VERDICT_MIN_N - gradedPlay) / perWeek) : null;
  const verdictReachable =
    weeksToVerdict != null && weeksPublished + weeksToVerdict <= SEASON_WEEKS;

  return (
    <main className="min-h-screen px-5 sm:px-10 py-10 max-w-4xl mx-auto">
      <header>
        <div className="flex items-baseline justify-between flex-wrap gap-2 pb-2">
          <p className="eyebrow">NATESTACKS · NFL Experiment No. 5</p>
          <p className="folio">the receipts · 2026 season</p>
        </div>
        <div className="rule-double" />
        <div className="mt-6">
          <h1 className="headline text-4xl sm:text-6xl text-ink">The receipts</h1>
          <p className="deck text-base sm:text-lg text-ink-2 mt-3 max-w-2xl">
            Every pick below was published to this repository <em>before kickoff</em> at a real,
            book-attributed entry price, then judged against a sharp closing line — with a
            pre-registered placebo arm entered at the same instant. Boards are immutable once
            published; corrections appear as errata, never edits.
          </p>
        </div>
      </header>

      {/* The honesty block — pre-registered, load-bearing, permanent. */}
      <section className="panel-dim p-5 sm:p-6 mt-8">
        <p className="eyebrow" style={{ color: "var(--loss)" }}>
          Read this first — no ROI claim is made here
        </p>
        <p className="num text-sm text-ink-2 mt-3 leading-relaxed">
          The pre-registered 2025 holdout validation of this model was <strong className="text-ink">negative</strong>:
          every market failed its own gate out-of-sample (ATS −7.2% ROI; the underdog doctrine
          decayed from +9.6% in-walk to −3.6%). Calibration transferred; edge did not. The
          write-up is committed at{" "}
          <span className="text-ink">docs/research/2026-08-18-holdout-validation-2025.md</span>.
          Consequently the ONLY verdict metric on this page is devigged closing-line value at
          real entry prices, PLAY arm minus control arm, with a pre-registered minimum sample of
          n ≥ 150 (rules frozen 2026-08-29 in{" "}
          <span className="text-ink">docs/research/2026-08-29-nfl-receipts-preregistration.md</span>).
          If the season ends under n = 150, <strong className="text-ink">no verdict is issued — permanently</strong>.
        </p>
      </section>

      {/* Headline ledger */}
      <section className="mt-10">
        <div className="flex items-baseline gap-4 pb-2 border-b border-rule-strong">
          <h2 className="headline text-2xl sm:text-3xl text-ink">The ledger</h2>
          <span className="eyebrow" style={{ color: "var(--blue)" }}>
            devigged CLV vs sharp close · power method
          </span>
        </div>

        {!h || h.play.eligible === 0 ? (
          <div className="panel-dim p-6 mt-4 text-center">
            <p className="num text-sm text-ink-2">
              — No graded legs yet. The ledger begins with the first published board. —
            </p>
          </div>
        ) : (
          <>
            <div className="grid sm:grid-cols-3 gap-4 mt-4">
              <div className="panel p-4">
                <p className="eyebrow">PLAY arm</p>
                <p className="num-display text-3xl mt-2 text-ink">
                  {fmtPct(h.play.beatRate)}
                </p>
                <p className="num text-xs text-ink-2 mt-1">
                  beat rate · coverage {fmtPct(h.play.coverage, 0)} ({h.play.graded}/{h.play.eligible} graded)
                </p>
                <p className="num text-xs text-ink-2 mt-1">
                  avg devig CLV {fmtPp(h.play.avgDevigClvPp, 2)}
                  {h.play.tier2Benchmarked > 0 && ` · ${h.play.tier2Benchmarked} tier-2 benchmarked`}
                </p>
              </div>
              <div className="panel p-4">
                <p className="eyebrow">Control arm (placebo)</p>
                <p className="num-display text-3xl mt-2 text-ink">
                  {fmtPct(h.control.beatRate)}
                </p>
                <p className="num text-xs text-ink-2 mt-1">
                  beat rate · coverage {fmtPct(h.control.coverage, 0)} ({h.control.graded}/{h.control.eligible} graded)
                </p>
                <p className="num text-xs text-ink-2 mt-1">
                  drawn from the same snapshot at the same instant
                </p>
              </div>
              <div className="panel p-4">
                <p className="eyebrow" style={{ color: "var(--blue)" }}>
                  The verdict metric
                </p>
                <p className="num-display text-3xl mt-2 text-ink">
                  {h.pairedDifferentialPp == null ? "—" : fmtPp(h.pairedDifferentialPp)}
                </p>
                <p className="num text-xs text-ink-2 mt-1">
                  PLAY minus control, {h.pairedN} paired
                </p>
              </div>
            </div>

            {h.insufficientN && (
              <div className="mt-4 panel-dim p-4">
                <p className="num text-sm" style={{ color: "var(--hold)" }}>
                  INSUFFICIENT_N — {h.play.graded} of the {h.minN} graded PLAY legs required for
                  any verdict.{" "}
                  {weeksToVerdict == null
                    ? "Projection begins once legs grade."
                    : verdictReachable
                      ? `At the current rate (~${perWeek.toFixed(1)}/week), threshold in ~${weeksToVerdict} more weeks.`
                      : `At the current rate (~${perWeek.toFixed(1)}/week) the threshold is NOT reachable this season — the pre-registered outcome is that no verdict will be issued. The doctrine's selectivity is a fact this page reports, not a problem it fixes.`}
                </p>
              </div>
            )}

            <p className="num text-xs text-ink-2 mt-3 leading-relaxed">
              Status ledger (denominators never shrink silently): pending{" "}
              {h.play.byStatus.pending} · graded {h.play.byStatus.graded} · no close captured{" "}
              {h.play.byStatus.no_close} · no entry price {h.play.byStatus.no_entry_price} ·
              non-sharp close {h.play.byStatus.non_sharp_close} · void {h.play.byStatus.void}.
              Benchmark: Pinnacle (tier 1), lowvig/betonlineag fallback (tier 2, flagged). Every
              counted close's source snapshot is committed under{" "}
              <span className="text-ink">data/processed/nfl-live/closes/</span>, so every close
              price is recomputable from committed bytes; automated close re-verification lands
              before the first grading run.
            </p>
          </>
        )}
      </section>

      {/* Boards */}
      <section className="mt-12">
        <div className="flex items-baseline gap-4 pb-2 border-b border-rule-strong">
          <h2 className="headline text-2xl sm:text-3xl text-ink">The boards</h2>
          <span className="eyebrow">immutable · sha256-notarized · published ≥12h pre-kickoff</span>
        </div>

        {boards.length === 0 ? (
          <div className="panel-dim p-6 mt-4">
            <p className="num text-sm text-ink-2 text-center">
              — No board published yet. Week 1 publishes Tuesday, September 8, at least 12 hours
              before the Thursday kickoff. —
            </p>
            <p className="num text-xs text-ink-2 mt-3 text-center">
              Fair warning: the doctrine's floors are strict and the holdout tightened them. If
              nothing clears, the honest board is empty — an empty board that was published on
              time <em>is</em> the product.
            </p>
          </div>
        ) : (
          boards.map((b) => <BoardSheet key={`${b.season}-${b.week}`} board={b} ledger={ledger} />)
        )}
      </section>

      {/* Errata */}
      {ledger && ledger.boards.some((br) => br.errata.length > 0) && (
        <section className="mt-12">
          <div className="flex items-baseline gap-4 pb-2 border-b border-rule-strong">
            <h2 className="headline text-2xl sm:text-3xl text-ink">Errata</h2>
            <span className="eyebrow">corrections live here — boards are never edited</span>
          </div>
          <ul className="mt-3">
            {ledger.boards.flatMap((br) =>
              br.errata.map((e, i) => (
                <li key={`${br.file}-${i}`} className="py-2 border-b border-rule num text-sm text-ink-2">
                  <span className="folio">{br.file}</span> · {e.at.slice(0, 10)} — {e.note}
                </li>
              )),
            )}
          </ul>
        </section>
      )}

      <footer className="mt-14">
        <div className="rule-double" />
        <p className="num text-xs text-ink-2 pt-4 leading-relaxed">
          This is a research lab, not a tout service. Nothing on this page is betting advice;
          no picks are sold, no affiliate links exist, and the parlay block (when it prints) is
          paper-only. Board hashes are recorded at publish and re-verified before every grading
          run; the full pipeline, including the control-arm draw rule, is open in this site&rsquo;s
          repository. If you or someone you know has a gambling problem, call{" "}
          <span className="text-ink">1-800-GAMBLER</span>.
        </p>
      </footer>
    </main>
  );
}

function BoardSheet({ board, ledger }: { board: PublishedBoard; ledger: Ledger | null }) {
  const rec = ledger?.boards.find(
    (b) => b.season === board.season && b.week === board.week,
  );
  const plays = board.legs.filter((l) => l.role === "play");
  const passes = board.legs.filter((l) => l.role === "pass");
  const controls = board.legs.filter((l) => l.role === "control");
  const rowFor = (legId: string): LedgerRow | undefined =>
    ledger?.rows.find((r) => r.legId === legId);

  return (
    <article className="mt-8">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h3 className="headline text-xl text-ink">
          Week {board.week}, {board.season}
        </h3>
        <p className="folio">
          published {board.publishedAt.slice(0, 16).replace("T", " ")}Z
          {rec && <> · sha256 {rec.sha256.slice(0, 12)}…</>}
        </p>
      </div>

      {plays.length === 0 ? (
        <div className="panel-dim p-5 mt-3 text-center">
          <p className="num text-sm text-ink-2">
            — Nothing cleared the doctrine floors this week. The board is empty, on time. —
          </p>
          <p className="num text-xs text-ink-2 mt-2">
            {passes.length} candidate legs evaluated and passed; every pass reason is in the
            committed board file.
          </p>
        </div>
      ) : (
        <ol className="mt-2">
          {plays.map((l) => {
            const row = rowFor(l.legId);
            return (
              <li
                key={l.legId}
                className="py-4 border-b border-rule grid grid-cols-[auto_1fr_auto] gap-x-4 gap-y-1 items-baseline"
              >
                <span className="tag" style={{ color: "var(--win)" }}>
                  PLAY
                </span>
                <div>
                  <p className="num text-sm text-ink">
                    {l.selection} <span className="text-ink-2">[{l.market}]</span> · {l.matchup}
                  </p>
                  <p className="num text-xs text-ink-2 mt-1">
                    entry {fmtML(l.entryPriceAmerican)}
                    {l.priceProvenance && ` @ ${l.priceProvenance.book}`} · kickoff{" "}
                    {fmtKick(l.kickoffUtc)}
                    {!l.clvEligible && " · no two-sided price at this point — excluded from CLV ledger"}
                  </p>
                </div>
                <span className="num text-xs text-ink-2 text-right">
                  {row?.status === "graded" && row.verdict
                    ? `${row.verdict.beatClose ? "beat" : "missed"} close · ${fmtPp(row.verdict.devigClvPp, 2)} devig`
                    : (row?.status ?? "pending")}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <details className="mt-3">
        <summary className="num text-xs text-ink-2 cursor-pointer">
          {passes.length} passed legs · {controls.length} control legs · {board.dropped.length}{" "}
          dropped by the 12h kickoff gate — show
        </summary>
        <ul className="mt-2">
          {passes.map((l) => (
            <li key={l.legId} className="py-1.5 border-b border-rule num text-xs text-ink-2">
              <span style={{ color: "var(--loss)" }}>PASS</span> {l.selection} [{l.market}] ·{" "}
              {l.matchup} — {l.passReason}
            </li>
          ))}
          {controls.map((l) => (
            <li key={l.legId} className="py-1.5 border-b border-rule num text-xs text-ink-2">
              <span style={{ color: "var(--blue)" }}>CONTROL</span> {l.side}
              {l.point != null && ` ${l.point}`} [{l.market}] · {l.matchup} · entry{" "}
              {fmtML(l.entryPriceAmerican)}
              {l.priceProvenance && ` @ ${l.priceProvenance.book}`}
            </li>
          ))}
          {board.dropped.map((d, i) => (
            <li key={i} className="py-1.5 border-b border-rule num text-xs text-ink-2">
              <span style={{ color: "var(--hold)" }}>DROPPED</span> {d.selection} [{d.market}] ·{" "}
              {d.matchup} — {d.reason}
            </li>
          ))}
        </ul>
      </details>

      {board.parlay && (
        <p className="num text-xs text-ink-2 mt-3">
          Paper parlay ({board.parlay.legIds.length} ML legs): combined{" "}
          {fmtPct(board.parlay.combinedProb)} at {board.parlay.combinedDecimal.toFixed(2)}x — EV{" "}
          {board.parlay.evPct >= 0 ? "+" : ""}
          {board.parlay.evPct.toFixed(1)}%. Paper-only; parlays amplify edge, they never create it.
        </p>
      )}
    </article>
  );
}
