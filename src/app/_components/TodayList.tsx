"use client";

// The today list — every live action across leagues, as play cards.
//
// The row IS the /nfl play card, reused cross-league: head (league · kickoff
// · state) with the PLAY stamp, the asymmetric team stack, the comparison
// rail with the disagreement figure (the site's signature), and a foot that
// says where the row came from. Three kinds read as one list:
//
//   game  — an agent moneyline pick.  ENTRY price · stake.  Tap → autopsy.
//   prop  — an agent prop pick.       Player over the line. Tap → autopsy.
//   nfl   — a PLAY leg from the published board. ENTRY price @ book only —
//           NEVER a stake, a unit, a return or CLV, on any page
//           (pre-registration Amendment 1). The whole card links to the
//           receipts: /nfl#play-{legId}.
//
// The rail's figure is the row's own graded quantity, named by its owner:
//   nfl   — DISAGREEMENT, arithmetic on the two printed percentages (/nfl
//           rule 2): round1(model) − round1(market), in pp, via receipts-view.
//   agent — EDGE, `SlatePick.edge` (= modelProb − marketProb, grader.ts),
//           the quantity the 6% floor is applied to, printed as the old
//           TonightsPlay printed it. Renaming it "pp" would misname it.
//
// Client component: it owns the autopsy modal's state. Its props are plain
// serialisable objects; it imports nothing that reads a file.

import { useState } from "react";
import type { SlatePick } from "../_data/dashboard";
import type { NflLiveLeg, RowState, TodayRow } from "@/lib/today-list";
import {
  etDayLabel,
  etTimeLabel,
  fmtAmerican as fmtNflAmerican,
  fmtGap,
  fmtPct1,
  round1,
} from "@/lib/nfl-receipts/receipts-view";
import { fmtAmerican, propLabel } from "./format";
import { PickAutopsy } from "./PickAutopsy";

type Row = TodayRow<SlatePick>;

export function TodayList({
  rows,
  emptyLede,
  emptySub,
}: {
  rows: Row[];
  emptyLede: string;
  emptySub: string;
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  const openRow = openId === null ? null : rows.find((r) => r.kind !== "nfl" && r.pick.id === openId);
  const openPick = openRow && openRow.kind !== "nfl" ? openRow.pick : null;

  if (rows.length === 0) {
    return (
      <div className="today-empty" data-empty="true">
        <p className="headline today-empty-lede">{emptyLede}</p>
        <p className="prose">{emptySub}</p>
      </div>
    );
  }

  return (
    <>
      <ul className="board-stack today-list">
        {rows.map((row) =>
          row.kind === "nfl" ? (
            <li key={`nfl-${row.leg.legId}`} data-kind="nfl">
              <NflCard leg={row.leg} state={row.state} />
            </li>
          ) : (
            <li key={`${row.kind}-${row.pick.id}`} data-kind={row.kind}>
              <AgentCard
                pick={row.pick}
                kind={row.kind}
                state={row.state}
                onOpen={() => setOpenId(row.pick.id)}
              />
            </li>
          ),
        )}
      </ul>
      <PickAutopsy pick={openPick} onClose={() => setOpenId(null)} />
    </>
  );
}

// ─── Shared pieces ──────────────────────────────────────────────────────────

function StateTag({ state }: { state: RowState }) {
  return (
    <span className={`tag card-state${state === "in play" ? " is-live" : ""}`}>{state.toUpperCase()}</span>
  );
}

/** "2026-09-08 14:09Z" — the same minute-resolution UTC stamp /nfl prints. */
function fmtStampUtc(iso: string | null): string {
  if (!iso) return "—";
  return `${iso.slice(0, 16).replace("T", " ")}Z`;
}

function Rail({
  modelPct,
  marketPct,
  foot,
}: {
  modelPct: number | null;
  marketPct: number | null;
  /** The figure under the rule — label and printed value. */
  foot: { label: string; value: string };
}) {
  const noModel = modelPct == null;
  const noMarket = marketPct == null;
  return (
    <div className="rail">
      {!noModel && (
        <div className="rail-row">
          <span className="eyebrow rail-label">MODEL</span>
          <span className="rail-track">
            <span className="rail-fill is-model" style={{ width: `${modelPct}%` }} />
          </span>
          <span className="num-display rail-val is-model">{fmtPct1(modelPct)}</span>
        </div>
      )}
      {!noMarket && (
        <div className="rail-row">
          <span className="eyebrow rail-label">MARKET</span>
          <span className="rail-track">
            <span className="rail-fill is-market" style={{ width: `${marketPct}%` }} />
          </span>
          <span className="num-display rail-val is-market">{fmtPct1(marketPct)}</span>
        </div>
      )}
      <hr className="rail-rule" />
      {noModel || noMarket ? (
        <p className="prose no-market-note">
          {noMarket
            ? "No two-sided price was recorded at this point, so no market probability — and no disagreement — is claimed."
            : "The board carried no calibrated model read for this leg, so no disagreement is claimed."}
        </p>
      ) : (
        <div className="rail-foot">
          <span className="eyebrow">{foot.label}</span>
          <span className="num-display rail-gap">{foot.value}</span>
        </div>
      )}
    </div>
  );
}

// ─── NFL — a PLAY leg from the published board ──────────────────────────────

function NflCard({ leg, state }: { leg: NflLiveLeg; state: RowState }) {
  const conn = leg.selectedIsAway ? "at" : "vs";
  return (
    <a
      className="play-card-link"
      href={`/nfl#play-${leg.legId}`}
      aria-label={`${leg.selectedAbbr} ${conn} ${leg.opponentAbbr}, NFL — on the receipts`}
    >
      <article className="play-card">
        <div className="play-card-head">
          <p className="num card-kick">
            <span className="card-league">NFL</span> · {etDayLabel(leg.kickoffUtc)} ·{" "}
            {etTimeLabel(leg.kickoffUtc)} ET · <StateTag state={state} />
          </p>
        </div>
        <div className="play-card-stamp">
          <span className="stamp-true play-stamp">PLAY</span>
        </div>
        <div className="team-stack">
          <span className="headline team-sel">{leg.selectedAbbr}</span>
          <span className="eyebrow team-conn">{conn}</span>
          <span className="headline team-opp">{leg.opponentAbbr}</span>
        </div>
        <Rail
          modelPct={leg.modelPct}
          marketPct={leg.marketPct}
          foot={{ label: "DISAGREEMENT", value: `${fmtGap(leg.gapPp)} pp` }}
        />
        <div className="play-card-foot">
          <p className="num entry-line">
            ENTRY {fmtNflAmerican(leg.entryPriceAmerican)}
            {leg.book ? ` @ ${leg.book.toUpperCase()}` : ""} · {fmtStampUtc(leg.snapshotFetchedAt)}
          </p>
          <p className="num card-source">
            BOARD WK {leg.week} · {leg.season} · PUBLISHED {etDayLabel(leg.publishedAt)} ·{" "}
            <span className="card-source-link">RECEIPTS →</span>
          </p>
        </div>
      </article>
    </a>
  );
}

// ─── Agent — a moneyline or prop pick that survived the critic ──────────────

/** "Chicago White Sox" → "White Sox"; "Seattle Mariners" → "Mariners". Every
 *  NBA/MLB/WNBA nickname is the last word except the three two-word ones. */
const TWO_WORD_NICKNAMES = new Set(["Sox", "Jays", "Blazers"]);
function nickname(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  const last = parts[parts.length - 1];
  return TWO_WORD_NICKNAMES.has(last) ? parts.slice(-2).join(" ") : last;
}

/** "Naz Reid" → "N. Reid". */
function initialled(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

function splitMatchup(matchup: string): { away: string; home: string } {
  const [away = "", home = ""] = matchup.split("@").map((s) => s.trim());
  return { away, home };
}

function AgentCard({
  pick,
  kind,
  state,
  onOpen,
}: {
  pick: SlatePick;
  kind: "game" | "prop";
  state: RowState;
  onOpen: () => void;
}) {
  const isProp = kind === "prop" && !!pick.player;
  const { away, home } = splitMatchup(pick.matchup);
  const selectedIsAway = !isProp && away.length > 0 && away === pick.selection;
  const sel = isProp ? initialled(pick.player as string) : nickname(pick.selection);
  const opp = isProp
    ? `${(pick.side ?? "").toUpperCase()} ${pick.line ?? "—"} ${propLabel(pick.propType)}`.trim()
    : nickname(selectedIsAway ? home : away || home);
  const conn = isProp ? null : selectedIsAway ? "at" : "vs";
  const modelPct = round1(pick.modelProb * 100);
  const marketPct = round1(pick.marketProb * 100);
  // The grader's edge, as TonightsPlay printed it — one decimal, signed.
  const edgeText = `${pick.edge > 0 ? "+" : ""}${(pick.edge * 100).toFixed(1)}%`;
  const when = pick.gameDate
    ? `${etDayLabel(pick.gameDate)} · ${etTimeLabel(pick.gameDate)} ET`
    : "TIME TBD";

  return (
    <article className="play-card" aria-label={`${sel}${conn ? ` ${conn} ` : " "}${opp}, ${pick.league}`}>
      <div className="play-card-head">
        <p className="num card-kick">
          <span className="card-league">{pick.league}</span> · {when} · <StateTag state={state} />
        </p>
      </div>
      <div className="play-card-stamp">
        <span className="stamp-true play-stamp">PLAY</span>
      </div>
      <div className="team-stack">
        <span className={`headline team-sel${sel.length > 9 ? " is-long" : ""}`}>{sel}</span>
        {conn ? <span className="eyebrow team-conn">{conn}</span> : null}
        <span className={`headline team-opp${isProp ? " is-prop" : ""}`}>{opp}</span>
      </div>
      <Rail modelPct={modelPct} marketPct={marketPct} foot={{ label: "EDGE", value: edgeText }} />
      <div className="play-card-foot">
        <p className="num entry-line">
          ENTRY {fmtAmerican(pick.oddsAmerican)} · {pick.kellyStakeUnits.toFixed(2)}u
          {isProp ? ` · ${pick.matchup}` : ""}
        </p>
        <p className="num card-source">
          ANALYST RUN {etDayLabel(pick.createdAt)} · SURVIVED THE CRITIC ·{" "}
          <button type="button" className="card-source-link" onClick={onOpen}>
            OPEN AUTOPSY →
          </button>
        </p>
      </div>
    </article>
  );
}
