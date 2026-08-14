// Today's picks — a single ledger page: MLB then NBA, ranked by edge over
// the de-vigged market. Same data plumbing as before; set in the Paper
// Trial system (Fraunces words, Plex Mono numbers, stamps for status).

import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

// Own identity: without this the page inherits the root title verbatim and the
// site's two indexable pages are duplicates. The description matches what the
// page SAYS it is (the heuristic screen), not the agent's book.
export const metadata: Metadata = {
  title: "The Screen — daily market scan",
  description:
    "Heuristic MLB + NBA moneyline scan ranked by edge over the de-vigged market. Not the agent's book — that lives on the front page.",
  alternates: { canonical: "/picks" },
};

type Pick = {
  rank: number;
  pickTeam: string;
  homeTeam: string;
  awayTeam: string;
  side: "home" | "away";
  modelProb: number;
  marketImpliedProb: number | null;
  marketML: number | null;
  edge: number | null;
  matchup: string;
  homePitcher?: string;
  awayPitcher?: string;
  expectedMargin?: number;
  calibrated?: boolean;
};

type Health = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
  staleSources: string[];
  criticalErrors: string[];
};

const PROCESSED_DIR = path.join(process.cwd(), "data", "processed");

function readJson<T>(file: string): T | null {
  const p = path.join(PROCESSED_DIR, file);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function fmtML(n: number | null | undefined): string {
  // Render guard — an American price must be finite with |value| ≥ 100;
  // anything else from the feed prints as an em-dash.
  if (n === null || n === undefined || !Number.isFinite(n) || Math.abs(n) < 100) return "—";
  return n > 0 ? `+${n}` : String(n);
}

function fmtPct(p: number | null | undefined, dec = 1): string {
  if (p === null || p === undefined) return "—";
  return (p * 100).toFixed(dec) + "%";
}

function fmtEdge(e: number | null | undefined): string {
  if (e === null || e === undefined) return "—";
  const sign = e >= 0 ? "+" : "";
  return `${sign}${(e * 100).toFixed(1)}%`;
}

function healthTone(s: string | undefined): string {
  if (s === "ok") return "var(--win)";
  if (s === "degraded") return "var(--hold)";
  if (s === "error") return "var(--loss)";
  return "var(--ink-3)";
}

export default function PicksPage() {
  const mlbEnv = readJson<{ data?: { picks?: Pick[]; dateEt?: string } }>("picks-today.json");
  const nbaEnv = readJson<{ data?: { picks?: Pick[]; dateEt?: string } }>("picks-nba-today.json");
  const healthEnv = readJson<{ data?: Health }>("sports-ingest-health.json");

  const mlbPicks = mlbEnv?.data?.picks ?? [];
  const nbaPicks = nbaEnv?.data?.picks ?? [];
  const health = healthEnv?.data;
  const dateEt = mlbEnv?.data?.dateEt ?? new Date().toISOString().slice(0, 10);

  return (
    <main className="min-h-screen px-5 sm:px-10 py-10 max-w-4xl mx-auto">
      {/* Page head */}
      <header>
        <div className="flex items-baseline justify-between flex-wrap gap-2 pb-2">
          <p className="eyebrow">NATESTACKS · The Paper Trial</p>
          <p className="folio">The screen · daily sheet</p>
        </div>
        <div className="rule-double" />
        <div className="mt-6 flex items-end justify-between flex-wrap gap-4">
          <div>
            <h1 className="headline text-4xl sm:text-6xl text-ink">
              The screen
            </h1>
            <p className="deck text-base sm:text-lg text-ink-2 mt-2 max-w-xl">
              A heuristic market scan — <em>not</em> the agent&rsquo;s book. The agent&rsquo;s
              actual picks live on the <a href="/" className="underline underline-offset-4 hover:text-loss transition-colors">front page</a>.
            </p>
            <p className="num text-sm text-ink-2 mt-2">
              {dateEt} · ranked by edge over de-vigged market
            </p>
          </div>
          {health && (
            <div className="text-right">
              <span className="tag" style={{ color: healthTone(health.status) }}>
                Ingest · {health.status}
              </span>
              {(health.staleSources?.length > 0 || health.criticalErrors?.length > 0) && (
                <p className="num text-xs text-ink-2 mt-2 max-w-[280px]">
                  {health.staleSources?.length > 0 && <>stale: {health.staleSources.join(", ")}</>}
                  {health.criticalErrors?.length > 0 && (
                    <>
                      {health.staleSources?.length > 0 && " · "}
                      critical: {health.criticalErrors.join(", ")}
                    </>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      </header>

      <LeagueSheet
        title="MLB"
        method="calibrated · isotonic CV · LightGBM"
        methodTone="var(--blue)"
        picks={mlbPicks}
        emptyBody="No MLB picks today — model edge below threshold for all games."
        kind="mlb"
      />

      <LeagueSheet
        title="NBA"
        method="heuristic · uncalibrated · net-rating"
        methodTone="var(--hold)"
        picks={nbaPicks}
        emptyBody="No NBA picks today — model edge below threshold for all games."
        kind="nba"
      />

      <footer className="mt-14">
        <div className="rule-double" />
        <p className="num text-xs text-ink-2 pt-4 leading-relaxed">
          MLB calibrated via isotonic regression with cross-validation; NBA is a net-rating +
          home-court heuristic (training pipeline in progress). Picks shown only when model edge
          clears threshold (MLB +2%, NBA +5%). Bankroll discipline applies.
        </p>
      </footer>
    </main>
  );
}

function LeagueSheet({
  title,
  method,
  methodTone,
  picks,
  emptyBody,
  kind,
}: {
  title: string;
  method: string;
  methodTone: string;
  picks: Pick[];
  emptyBody: string;
  kind: "mlb" | "nba";
}) {
  return (
    <section className="mt-12">
      <div className="flex items-baseline gap-4 pb-2 border-b border-rule-strong">
        <h2 className="headline text-2xl sm:text-3xl text-ink">{title}</h2>
        <span className="eyebrow" style={{ color: methodTone }}>
          {method}
        </span>
      </div>

      {picks.length === 0 ? (
        <div className="panel-dim p-6 mt-4 text-center">
          <p className="num text-sm text-ink-2">— {emptyBody} —</p>
        </div>
      ) : (
        <ol className="mt-2">
          {picks.map(p => (
            <li
              key={p.rank}
              className="py-4 border-b border-rule grid grid-cols-[auto_1fr_auto] gap-x-4 gap-y-1 items-baseline"
            >
              <span className="folio">No. {String(p.rank).padStart(2, "0")}</span>
              <div className="min-w-0">
                <p className="font-display font-semibold text-lg text-ink leading-snug">
                  {p.pickTeam}{" "}
                  <span className="num text-base text-ink-2 font-normal">
                    {fmtML(p.marketML)}
                  </span>
                </p>
                <p className="num text-xs text-ink-2 mt-1">
                  model {fmtPct(p.modelProb)} vs market {fmtPct(p.marketImpliedProb)} ·{" "}
                  {p.awayTeam} @ {p.homeTeam}
                  {kind === "nba" && p.expectedMargin !== undefined && (
                    <>
                      {" "}· margin {p.expectedMargin > 0 ? "+" : ""}
                      {p.expectedMargin.toFixed(1)}
                    </>
                  )}
                </p>
                {kind === "mlb" && p.homePitcher && p.awayPitcher && (
                  <p className="num text-xs text-ink-3 mt-0.5">
                    {p.awayPitcher} vs {p.homePitcher}
                  </p>
                )}
              </div>
              <span
                className="num text-base font-semibold text-right"
                style={{ color: "var(--win)" }}
              >
                {fmtEdge(p.edge)}
                <span className="block eyebrow text-ink-3 font-normal mt-0.5">edge</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
