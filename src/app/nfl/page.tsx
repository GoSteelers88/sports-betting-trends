// /nfl — the receipts. A public, pre-registered ledger of NFL Experiment
// No. 5: what was published before kickoff, at what real book price, and how
// far the model's number sat from the market's at that instant.
//
// Reading order is fixed and load-bearing: masthead strip → THE BOARD →
// THE GAMES WE PASSED → THE RULES → THE LEDGER → errata → footer.
//
// Three rules this file must never break:
//   1. Market probability is power-devigged from the entry pair by the SAME
//      function the CLV grader uses (receipts-view → nfl-devig). There is one
//      devig implementation in this repo and this page does not add a second.
//   2. The displayed gap is arithmetic on the two numbers printed in the row.
//      `leg.edge` is a different quantity and never renders.
//   3. Nothing here animates, `--win` green appears zero times until a leg
//      settles as beat-close, and `stakeFraction`/`evPct` never render.
//
// Zero writes, zero network. Committed JSON via node:fs, rendered on the
// server, no client component.

import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import {
  headline,
  VERDICT_MIN_N,
  type Ledger,
} from "@/lib/nfl-receipts/ledger";
import type { PublishedBoard } from "@/lib/nfl-receipts/board";
// NOTE: src/lib/nfl-receipts/team-colors.ts is deliberately NOT imported here.
// Week 1's two picks are the Jets (#125740) and the Packers (#203731) — both
// dark greens, 22.5 and 40 RGB units from --win #1d6a45. The token audit
// passed because it compared tokens; a reader compares colors, and two green
// spines beside two PLAY stamps read as two settled wins. The spine takes
// --ink until a week's picks are not green. The map and its contrast tests
// stay in the repo for that week.
import {
  contentHashesOfFile,
  matchesRecordedHash,
  type ContentHashes,
} from "@/lib/nfl-receipts/leg-id";
import { boardFileName } from "@/lib/nfl-receipts/board";
import {
  boardCounts,
  dayBands,
  divergeMagnitude,
  etDayLabel,
  etTimeLabel,
  fmtAmerican,
  fmtGap,
  fmtPct1,
  gameRows,
  modelResolution,
  type GameRow,
} from "@/lib/nfl-receipts/receipts-view";

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
  } catch (err) {
    // Without this, "the file is malformed" renders identically to "no legs
    // have graded yet" — and the malformed case is the one that flatters us.
    console.error("[/nfl] ledger.json present but unparseable", err);
    return null;
  }
}

/** A board plus the SHA256 of the exact bytes this render read. The notary
 *  records a hash at publish; transcribing THAT hash onto the page proves
 *  nothing about what the page is showing. Hashing the bytes we just read
 *  does. (Same convention as notary.ts: raw bytes, no re-serialization.) */
interface LoadedBoard {
  board: PublishedBoard;
  hashes: ContentHashes;
}

function loadBoards(): LoadedBoard[] {
  if (!fs.existsSync(NFL_DIR)) return [];
  return fs
    .readdirSync(NFL_DIR)
    .filter((f) => /^board-\d{4}-wk\d{2}\.json$/.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const abs = path.join(NFL_DIR, f);
      try {
        return {
          board: JSON.parse(fs.readFileSync(abs, "utf-8")) as PublishedBoard,
          hashes: contentHashesOfFile(abs),
        };
      } catch (err) {
        console.error(`[/nfl] board ${f} present but unparseable`, err);
        return null;
      }
    })
    .filter((b): b is LoadedBoard => b !== null);
}

/** The sha256 recorded in the ledger at publish for this board, or null if
 *  the board has no ledger record yet (a board on disk that publish has not
 *  registered). Matched on the FILE NAME, which is the ledger record’s own
 *  primary key. */
function recordedShaFor(
  ledger: Ledger | null,
  board: PublishedBoard,
): string | null {
  const file = boardFileName(board.season, board.week);
  return ledger?.boards.find((b) => b.file === file)?.sha256 ?? null;
}

/** Small counts read as words in prose and as digits in a table; this page
 *  keeps that line. Anything past twenty prints as a numeral. */
const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** "2026-09-08 14:09Z" — snapshot instants print to the minute, in UTC, so
 *  two readers in two timezones quote the same string. */
function fmtStampUtc(iso: string | null): string {
  if (!iso) return "—";
  return `${iso.slice(0, 16).replace("T", " ")}Z`;
}

export default function NflReceiptsPage() {
  const ledger = loadLedgerFile();
  const boards = loadBoards();
  const latest = boards[0]?.board ?? null;
  const h = ledger ? headline(ledger) : null;

  return (
    <div className="receipts">
      <MastheadStrip season={latest?.season ?? null} week={latest?.week ?? null} />

      <main className="receipts-shell">
        <header className="receipts-head">
          <p className="eyebrow">NATESTACKS · NFL EXPERIMENT NO. 5</p>
          <h1 className="headline receipts-h1">The receipts</h1>
          <p className="standfirst">
            Published before kickoff. Real book prices. Judged against a sharp close.
          </p>
        </header>

        {boards.length === 0 ? (
          <section className="receipts-section" id="board">
            <SectionHead
              title="THE BOARD"
              meta="NO BOARD PUBLISHED YET · WEEK 1 PUBLISHES AT LEAST 12H BEFORE THE THURSDAY KICKOFF"
            />
            <div className="panel awaiting-board">
              <p className="prose">
                The doctrine&rsquo;s floors are strict and the 2025 holdout tightened
                them. If nothing clears, the honest board is empty — and an empty
                board published on time is the product.
              </p>
            </div>
          </section>
        ) : (
          boards.map(({ board, hashes }) => (
            <BoardSpread
              key={`${board.season}-${board.week}`}
              board={board}
              hashes={hashes}
              recordedSha={recordedShaFor(ledger, board)}
              multiWeek={boards.length > 1}
            />
          ))
        )}

        <TheRules boards={boards.map((b) => b.board)} headlineData={h} />

        <TheLedger
          ledger={ledger}
          boards={boards.map((b) => b.board)}
          headlineData={h}
        />

        <Errata ledger={ledger} />

        <footer className="receipts-footer">
          <div className="rule-double" />
          <p className="colophon">
            NateStacks · NFL Experiment No. 5 · Boards are immutable once published;
            every correction appears above as errata, never as an edit.
          </p>
        </footer>
      </main>
    </div>
  );
}

/* ─── Masthead strip ────────────────────────────────────────────────────────
   A running head, not a banner: page-colored ground, a double rule for its
   bottom edge, a right-aligned folio, fixed height, and — the tell — it does
   not react to scroll at all. */

function MastheadStrip({ season, week }: { season: number | null; week: number | null }) {
  return (
    <div className="receipts-mast">
      <div className="receipts-mast-inner">
        <p className="receipts-mast-tokens">
          <span className="eyebrow">RESEARCH LAB</span>
          <span className="eyebrow">NO ROI CLAIM</span>
          <span className="eyebrow">NOT BETTING ADVICE</span>
        </p>
        <p className="folio receipts-mast-folio">
          {season ?? "—"} · WK {week ?? "—"}
        </p>
      </div>
    </div>
  );
}

function SectionHead({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="section-head">
      <h2 className="headline section-title">{title}</h2>
      <p className="eyebrow section-meta">{meta}</p>
    </div>
  );
}

/* ─── One published week ───────────────────────────────────────────────── */

function BoardSpread({
  board,
  hashes,
  recordedSha,
  multiWeek,
}: {
  board: PublishedBoard;
  hashes: ContentHashes;
  recordedSha: string | null;
  multiWeek: boolean;
}) {
  const rows = gameRows(board);
  const counts = boardCounts(board);
  const resolution = modelResolution(rows);
  const plays = rows.filter((r) => r.verdict === "PLAY");
  const suffix = multiWeek ? ` — WEEK ${board.week}` : "";
  const idSuffix = `${board.season}-wk${board.week}`;
  // Board identity belongs in ONE place. It used to print five times in a
  // single viewport (week+season in the section meta and on each card, sha on
  // each card); the section head states it once for the whole spread, and the
  // card head is left as a clean one-line kickoff at every width.
  //
  // The hash is of the bytes THIS RENDER read, not the string transcribed
  // from ledger.json — a transcribed hash proves nothing about what is on
  // screen. Printing it is transparency; comparing it to the receipt recorded
  // at publish is the actual check, and the difference is the whole premise
  // of the page. A line-ending-only difference is forgiven exactly the way
  // notary.ts forgives it (shared helper), so a Windows clone with
  // core.autocrlf=true does not cry forgery.
  // 12 hex chars, the same prefix length the notary logs and ledger.json
  // records are quoted at everywhere else in this pipeline. The full 64 is
  // unreadable furniture in a tracked-out eyebrow.
  const sha = hashes.raw.slice(0, 12).toUpperCase();
  const notarized: "verified" | "mismatch" | "unrecorded" =
    recordedSha == null
      ? "unrecorded"
      : matchesRecordedHash(hashes, recordedSha)
        ? "verified"
        : "mismatch";

  return (
    <>
      <section className="receipts-section" id={`board-${idSuffix}`}>
        <SectionHead
          title={`THE BOARD${suffix}`}
          meta={`WEEK ${board.week} · ${board.season} · PUBLISHED ${fmtStampUtc(board.publishedAt)} · ≥12H PRE-KICKOFF · IMMUTABLE · SHA ${sha}`}
        />
        {plays.length === 0 ? (
          <EmptyBoard counts={counts} />
        ) : (
          <div className="board-stack">
            {plays.map((row) => (
              <PlayCard key={row.legId} row={row} />
            ))}
          </div>
        )}
        <p className="prose board-footnote">
          Calibration transferred out of sample; raw edge did not. Every number
          below is the calibrated read, priced against the book that was
          actually offering it.{" "}
          {notarized === "verified" ? (
            <>
              The bytes rendered here hash to the receipt recorded in the ledger
              at publish.
            </>
          ) : notarized === "mismatch" ? (
            <>
              <strong>
                The bytes rendered here do not hash to the receipt recorded in
                the ledger at publish
              </strong>{" "}
              (recorded{" "}
              <span className="num">
                {recordedSha?.slice(0, 12).toUpperCase()}
              </span>
              ). This board is unverified until that is resolved; read it as a
              draft, not a receipt.
            </>
          ) : (
            <>
              This board is not yet registered in the ledger, so there is no
              recorded receipt to check the bytes against.
            </>
          )}
        </p>
      </section>

      <section className="receipts-section" id={`passed-${idSuffix}`}>
        <SectionHead
          title={`THE GAMES WE PASSED${suffix}`}
          meta={`${counts.games} GAMES · ${counts.legsRead} LEGS READ · ${counts.played} ON THE BOARD · ${counts.dropped} DROPPED BY THE 12H GATE`}
        />
        <p className="prose standfirst-block">
          Two different numbers appear below, on purpose.{" "}
          <strong>Model − market</strong> is a disagreement in probability.{" "}
          <strong>The pass reason</strong> quotes the doctrine&rsquo;s edge test{" "}
          <em>at the offered price</em>. A game can disagree by twelve points and
          still fail it — Buffalo did. The model emits {numberWord(resolution.distinct)}{" "}
          distinct {resolution.distinct === 1 ? "probability" : "probabilities"}{" "}
          across this slate; {numberWord(resolution.modalCount)} of the{" "}
          {numberWord(resolution.total)} read {resolution.modalValue?.toFixed(1)}%.
          That is the model&rsquo;s resolution, not a rendering fault — the
          disagreement column is where these games differ.
        </p>
        <PassGrid rows={rows} boardKey={idSuffix} />
        <p className="retired-note">
          Every game also carried an ATS read and a totals read. Both markets were
          retired for 2026 after the negative holdout — {counts.retiredMarketLegs}{" "}
          legs, published in the committed board file, never staked.
        </p>
      </section>
    </>
  );
}

/* ─── The empty board — a publication, not a disabled state ─────────────── */

function EmptyBoard({ counts }: { counts: ReturnType<typeof boardCounts> }) {
  return (
    <div className="panel empty-board">
      <span className="stamp-true empty-stamp">NO PLAY</span>
      <p className="headline empty-lede">
        Nothing cleared the floors. The board is empty, and it was published on
        time.
      </p>
      <p className="empty-sub">
        {counts.games} games evaluated. {counts.legsRead} legs read. 0 staked.
        Every read and every reason is in the grid below and in the committed
        board file.
      </p>
    </div>
  );
}

/* ─── The play card ─────────────────────────────────────────────────────── */

function PlayCard({ row }: { row: GameRow }) {
  return (
    <article className="play-card" id={`play-${row.legId}`}>
      <div className="play-card-head">
        <p className="num card-kick">
          {etDayLabel(row.kickoffUtc)} · {etTimeLabel(row.kickoffUtc)} ET
        </p>
      </div>

      <div className="play-card-stamp">
        <span className="stamp-true play-stamp">PLAY</span>
      </div>

      <div className="team-stack">
        <span className="headline team-sel">{row.selectedAbbr}</span>
        <span className="eyebrow team-conn">{row.selectedIsAway ? "at" : "vs"}</span>
        <span className="headline team-opp">{row.opponentAbbr}</span>
      </div>

      <div className="rail">
        {row.marketPct == null || row.modelPct == null ? (
          <NoMarketRail row={row} />
        ) : (
          <>
            <div className="rail-row">
              <span className="eyebrow rail-label">MODEL</span>
              <span className="rail-track">
                <span
                  className="rail-fill is-model"
                  style={{ width: `${row.modelPct}%` }}
                />
              </span>
              <span className="num-display rail-val is-model">
                {fmtPct1(row.modelPct)}
              </span>
            </div>
            <div className="rail-row">
              <span className="eyebrow rail-label">MARKET</span>
              <span className="rail-track">
                <span
                  className="rail-fill is-market"
                  style={{ width: `${row.marketPct}%` }}
                />
              </span>
              <span className="num-display rail-val is-market">
                {fmtPct1(row.marketPct)}
              </span>
            </div>
            <hr className="rail-rule" />
            <div className="rail-foot">
              <span className="eyebrow">DISAGREEMENT</span>
              <span className="num-display rail-gap">{fmtGap(row.gapPp)} pp</span>
            </div>
          </>
        )}
      </div>

      <div className="play-card-foot">
        <p className="num entry-line">
          ENTRY {fmtAmerican(row.entryPriceAmerican)}
          {row.book && ` @ ${row.book.toUpperCase()}`} ·{" "}
          {fmtStampUtc(row.snapshotFetchedAt)}
        </p>
        {row.doctrineNotes.length > 0 && (
          <>
            <p className="eyebrow notes-label">
              Doctrine notes — the gate&rsquo;s own arithmetic, not the
              disagreement above
            </p>
            <ul className="notes">
              {row.doctrineNotes.slice(0, 3).map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </article>
  );
}

/** The rail with one of its two stops missing. There are two DIFFERENT
 *  reasons that happens and they must not share one sentence:
 *
 *  - no two-sided price (`clvEligible === false`) — the market number cannot
 *    be devigged, and the leg is permanently outside the CLV ledger;
 *  - no model number (`calibratedConfidence` is optional in board.ts) — the
 *    prices are fine, the leg is CLV-eligible, and claiming otherwise is
 *    three false statements in one sentence.
 *
 *  Whichever stop survives is drawn; the note describes only what is
 *  actually missing. */
function NoMarketRail({ row }: { row: GameRow }) {
  const noMarket = row.marketPct == null;
  const noModel = row.modelPct == null;
  return (
    <>
      {!noModel && (
        <div className="rail-row">
          <span className="eyebrow rail-label">MODEL</span>
          <span className="rail-track">
            <span
              className="rail-fill is-model"
              style={{ width: `${row.modelPct}%` }}
            />
          </span>
          <span className="num-display rail-val is-model">
            {fmtPct1(row.modelPct)}
          </span>
        </div>
      )}
      {!noMarket && (
        <div className="rail-row">
          <span className="eyebrow rail-label">MARKET</span>
          <span className="rail-track">
            <span
              className="rail-fill is-market"
              style={{ width: `${row.marketPct}%` }}
            />
          </span>
          <span className="num-display rail-val is-market">
            {fmtPct1(row.marketPct)}
          </span>
        </div>
      )}
      <hr className="rail-rule" />
      <p className="prose no-market-note">
        {noMarket && !row.clvEligible ? (
          <>
            No two-sided price was recorded at this point, so no market
            probability is claimed and this leg is permanently outside the CLV
            ledger. Entry printed raw:{" "}
            <span className="num">{fmtAmerican(row.entryPriceAmerican)}</span>.
          </>
        ) : noMarket ? (
          <>
            The market probability could not be derived from the recorded entry
            pair, so none is claimed. The leg remains in the CLV ledger and will
            grade against its close. Entry printed raw:{" "}
            <span className="num">{fmtAmerican(row.entryPriceAmerican)}</span>.
          </>
        ) : (
          <>
            The board carried no calibrated model read for this leg, so no
            disagreement is claimed. The price and its close are unaffected and
            the leg grades normally. Entry printed raw:{" "}
            <span className="num">{fmtAmerican(row.entryPriceAmerican)}</span>.
          </>
        )}
      </p>
    </>
  );
}

/* ─── The pass grid ─────────────────────────────────────────────────────── */

function PassGrid({ rows, boardKey }: { rows: GameRow[]; boardKey: string }) {
  const bands = dayBands(rows);
  return (
    <table className="ledger-table agate pass-table">
      <colgroup>
        <col className="col-kick" />
        <col className="col-game" />
        <col className="col-model" />
        <col className="col-market" />
        <col className="col-gap" />
        <col className="col-diverge" />
        <col className="col-verdict" />
        <col className="col-why" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Kickoff</th>
          <th scope="col">Game</th>
          <th scope="col" className="th-right">Model</th>
          <th scope="col" className="th-right">Market</th>
          <th scope="col" className="th-right">Model − market</th>
          <th scope="col">
            <span className="sr-only">Disagreement</span>
          </th>
          <th scope="col">Verdict</th>
          <th scope="col">Why passed (price test)</th>
        </tr>
      </thead>
      <tbody>
        {bands.map((band) => (
          <Band key={`${boardKey}-${band.label}`} label={band.label} rows={band.rows} />
        ))}
      </tbody>
    </table>
  );
}

function Band({ label, rows }: { label: string; rows: GameRow[] }) {
  return (
    <>
      <tr className="day-band">
        <td colSpan={8}>
          <span className="eyebrow">{label}</span>
        </td>
      </tr>
      {rows.map((row) => (
        <GameRowCells key={row.legId} row={row} />
      ))}
    </>
  );
}

function GameRowCells({ row }: { row: GameRow }) {
  const isPlay = row.verdict === "PLAY";
  const gap = row.gapPp;
  const dir = gap != null && gap < 0 ? "neg" : "pos";
  return (
    <tr className="game-row">
      <td className="num c-kick">{etTimeLabel(row.kickoffUtc)}</td>
      <td className="num c-game">
        <span className={row.selectedIsAway ? "lean" : "off"}>{row.awayAbbr}</span>
        <span className="at"> @ </span>
        <span className={row.selectedIsAway ? "off" : "lean"}>{row.homeAbbr}</span>
      </td>
      <td className="num c-model">
        <span className="cell-label">{"Model "}</span>
        {fmtPct1(row.modelPct)}
      </td>
      <td className="num c-market">
        <span className="cell-label">{"Market "}</span>
        {fmtPct1(row.marketPct)}
      </td>
      <td className={`num-display c-gap${dir === "neg" ? " is-neg" : ""}`}>
        {fmtGap(gap)}
      </td>
      <td className="c-diverge">
        {gap != null && (
          <span
            className="diverge"
            style={{ ["--m" as string]: divergeMagnitude(gap) } as React.CSSProperties}
            aria-hidden="true"
          >
            <span className="diverge-bar" data-dir={dir} />
          </span>
        )}
      </td>
      {/* .tag carries display:inline-block — putting it on the <td> itself
          pops the cell out of table layout and leaves a visible seam in the
          row wash. It goes on a span inside the cell. */}
      <td className="c-verdict">
        <span className={`tag${isPlay ? " is-play" : ""}`}>
          {isPlay ? "PLAY ↑" : "PASS"}
        </span>
      </td>
      <td className="c-why">
        {isPlay ? (
          <a href={`#play-${row.legId}`}>on the board above</a>
        ) : (
          (row.passReason ?? "—")
        )}
      </td>
    </tr>
  );
}

/* ─── The rules — every disclosure sentence, verbatim ───────────────────── */

function TheRules({
  boards,
  headlineData,
}: {
  boards: PublishedBoard[];
  headlineData: ReturnType<typeof headline> | null;
}) {
  const s = headlineData?.play.byStatus;
  const controls = boards.reduce(
    (n, b) => n + b.legs.filter((l) => l.role === "control").length,
    0,
  );
  const parlayEverPrinted = boards.some((b) => b.parlay != null);

  const statuses: Array<[string, number]> = [
    ["Pending", s?.pending ?? 0],
    ["Graded", s?.graded ?? 0],
    ["No close captured", s?.no_close ?? 0],
    ["No entry price", s?.no_entry_price ?? 0],
    ["Non-sharp close", s?.non_sharp_close ?? 0],
    ["Void", s?.void ?? 0],
  ];

  return (
    <section className="receipts-section" id="rules">
      <SectionHead
        title="THE RULES"
        meta="PRE-REGISTERED 2026-08-29 · FROZEN FOR THE SEASON"
      />
      <div className="panel-dim rules-panel">
        <p className="eyebrow rules-warning">
          READ THIS FIRST — NO ROI CLAIM IS MADE HERE
        </p>

        <p className="prose">
          The pre-registered 2025 holdout validation of this model was{" "}
          <strong className="word-negative">negative</strong>: every market failed
          its own gate out-of-sample (ATS −7.2% ROI; the underdog doctrine decayed
          from +9.6% in-walk to −3.6%). Calibration transferred; edge did not. The
          write-up is committed at{" "}
          <span className="num path">
            docs/research/2026-08-18-holdout-validation-2025.md
          </span>
          .
        </p>

        <p className="prose">
          Consequently the ONLY verdict metric on this page is devigged
          closing-line value at real entry prices, PLAY arm minus control arm,
          with a pre-registered minimum sample of <span className="num">n ≥ 150</span>{" "}
          (rules frozen <span className="num">2026-08-29</span> in{" "}
          <span className="num path">
            docs/research/2026-08-29-nfl-receipts-preregistration.md
          </span>
          ). If the season ends under <span className="num">n = 150</span>,{" "}
          <strong>no verdict is issued — permanently</strong>.
        </p>

        <p className="prose">
          Status ledger — denominators never shrink silently:
        </p>
        <dl className="status-dl">
          {statuses.map(([term, value]) => (
            <div key={term}>
              <dt className="eyebrow">{term}</dt>
              <dd className="num">{value}</dd>
            </div>
          ))}
        </dl>

        <p className="prose">
          Benchmark: Pinnacle (tier 1), lowvig/betonlineag fallback (tier 2,
          flagged). Every counted close&rsquo;s source snapshot is committed under{" "}
          <span className="num path">data/processed/nfl-live/closes/</span>, and
          every grading run re-derives every recorded close from those committed
          bytes before it grades anything — a close that cannot be reproduced stops
          the run.
        </p>

        <p className="prose">
          {controls === 2
            ? "Two control legs were drawn from the same snapshot at the same instant"
            : `${controls} control legs were drawn from the same snapshot at the same instant`}{" "}
          — the placebo arm exists so that structural timing edge cannot be
          mistaken for skill. Control legs are counted here and never shown as
          picks.
        </p>

        <p className="prose">
          {parlayEverPrinted
            ? "The paper parlay is paper-only; parlays amplify edge, they never create it."
            : "If a board ever prints a paper parlay it is paper-only; parlays amplify edge, they never create it."}
        </p>

        <p className="prose">
          This is a research lab, not a tout service. Nothing on this page is
          betting advice; no picks are sold and no affiliate links exist. Board
          hashes are recorded at publish and re-verified before every grading run;
          the full pipeline, including the control-arm draw rule, is open in this
          site&rsquo;s repository. If you or someone you know has a gambling
          problem, call <span className="num">1-800-GAMBLER</span>.
        </p>
      </div>
    </section>
  );
}

/* ─── The ledger — a status line, dormant on purpose ────────────────────── */

function TheLedger({
  ledger,
  boards,
  headlineData,
}: {
  ledger: Ledger | null;
  boards: PublishedBoard[];
  headlineData: ReturnType<typeof headline> | null;
}) {
  const graded = headlineData?.play.graded ?? 0;
  const weeksPublished = ledger?.boards.length ?? 0;
  const playLegsOn = (b: PublishedBoard) =>
    b.legs.filter((l) => l.role === "play").length;
  // The sentence names ONE week, so it must count ONE week. Summing every
  // board into a sentence headed "Week {latest}" reported the season total as
  // that week's output — and read "Week 2 published 2 legs" in a week 2 that
  // published none. The cumulative figure still drives the projection, which
  // is what it is for.
  const latestBoard = boards[0] ?? null;
  const latestWeek = latestBoard?.week ?? null;
  const latestWeekPlayLegs = latestBoard ? playLegsOn(latestBoard) : 0;
  const cumulativePlayLegs = boards.reduce((n, b) => n + playLegsOn(b), 0);
  const projected =
    weeksPublished > 0
      ? Math.round((cumulativePlayLegs / weeksPublished) * SEASON_WEEKS)
      : 0;
  const share = Math.round((projected / VERDICT_MIN_N) * 100);

  return (
    <section className="receipts-section" id="ledger">
      <div className="panel-dim ledger-line">
        <p className="eyebrow">THE LEDGER — DORMANT UNTIL n ≥ {VERDICT_MIN_N}</p>
        <p className="num-display ledger-figure">
          {graded} / {VERDICT_MIN_N}{" "}
          <span className="ledger-figure-caption">graded PLAY legs</span>
        </p>
        <p className="ledger-body">
          {latestWeek != null && weeksPublished > 0 ? (
            <>
              Week {latestWeek} published {latestWeekPlayLegs}{" "}
              {latestWeekPlayLegs === 1 ? "leg" : "legs"};{" "}
              {cumulativePlayLegs} across {weeksPublished}{" "}
              {weeksPublished === 1 ? "week" : "weeks"} so far. At that rate an{" "}
              {SEASON_WEEKS}-week season yields about {projected} — roughly {share}%
              of the pre-registered threshold.{" "}
            </>
          ) : null}
          The pre-registration names this as the likely outcome: under{" "}
          <span className="num">n = {VERDICT_MIN_N}</span>, no verdict is issued,
          permanently. Expect the counter above to sit far short of{" "}
          <span className="num">{VERDICT_MIN_N}</span> all season. That is the
          design, not an outage.
        </p>
      </div>
    </section>
  );
}

/* ─── Errata ────────────────────────────────────────────────────────────── */

function Errata({ ledger }: { ledger: Ledger | null }) {
  const items =
    ledger?.boards.flatMap((br) =>
      br.errata.map((e, i) => ({ key: `${br.file}-${i}`, file: br.file, ...e })),
    ) ?? [];
  if (items.length === 0) return null;
  return (
    <section className="receipts-section" id="errata">
      <SectionHead
        title="ERRATA"
        meta="CORRECTIONS LIVE HERE — BOARDS ARE NEVER EDITED"
      />
      <ul className="errata-list">
        {items.map((e) => (
          <li key={e.key}>
            <span className="folio">{e.file}</span>{" "}
            <span className="num">{e.at.slice(0, 10)}</span> — {e.note}
          </li>
        ))}
      </ul>
    </section>
  );
}
