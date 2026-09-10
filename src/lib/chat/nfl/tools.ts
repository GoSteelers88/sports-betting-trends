// tools.ts — the receipts desk's ENTIRE tool menu.
//
// This is the load-bearing structural property of receipts mode: nothing on
// this menu can return a fair probability, a model edge, or a stake for a game
// that is not already on a published board. A model that cannot FETCH an
// unregistered fair price cannot COMPUTE an unregistered edge, so it cannot
// invent a pick — not because the prompt asks it not to, but because the
// number it would need does not exist in its context.
//
// Three strip rules, enforced HERE by construction (an explicit field-by-field
// projection, never an object spread), not in the prompt:
//
//   1. get_nfl_board NEVER emits `stakeFraction` or `evPct`. Stake is not a
//      public number on this desk, and evPct on the NFL board is a FRACTION
//      while the props board writes the same key as a PERCENT — two scales,
//      one name, so it is quarantined rather than published.
//   2. get_nfl_market DOES emit `fairHomeProb` / `fairAwayProb` (2026-09-09).
//      Without them the desk could not answer "what do you like" or build a
//      parlay at all. A read off them is LIVE and labelled as such; it never
//      enters the CLV ledger. Nothing the desk says is ever written to disk.
//   3. Nothing emits a URL or a book affiliate anything. `book` is provenance:
//      the name of whoever was hanging the price when it was captured.
//
// Every handler is a pure read of committed JSON via data.ts. Failure is an
// envelope, never a throw: `{available:false, reason}` is an answer the desk
// can speak; a 500 is not.

import type Anthropic from "@anthropic-ai/sdk";
import { headline, VERDICT_MIN_N, type LegStatus } from "@/lib/nfl-receipts/ledger";
import { RESEARCH_SPAN, HOLDOUT_HEADLINE } from "@/lib/nfl-receipts/exp5-view";
import {
  loadPublishedBoards,
  loadLedger,
  loadSlate,
  loadExp5,
  loadInjuries,
  loadStandings,
  standingsSeasonGate,
  type LoadedBoard,
} from "./data";

export const NFL_TOOL_NAMES = [
  "get_nfl_board",
  "get_nfl_ledger",
  "get_nfl_market",
  "get_nfl_research",
  "get_nfl_injuries",
  "get_nfl_standings",
] as const;

export type NflToolName = (typeof NFL_TOOL_NAMES)[number];

/** The moneyline block's span is NOT the props/parlays span. The public JSON
 *  carries no season field for either, so both live as constants: RESEARCH_SPAN
 *  (2019–2024) is imported from the page's read-model so the chat and the page
 *  can never disagree; the moneyline book is a different, wider log. */
export const MONEYLINE_SPAN = "2015–2024";

export const NFL_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "get_nfl_board",
    description:
      "Read a PUBLISHED, immutable NFL receipt board: every leg the desk pre-registered before kickoff, with its role (play / pass / control), verdict, selection, market, the REAL entry price it was taken at, the book that was hanging that price, the pass reason, the doctrine notes, and the calibrated confidence. Omit season/week to get every published board. This is the ONLY source of NFL selections — nothing outside these rows was ever a play. Stake and EV are deliberately not published.",
    input_schema: {
      type: "object",
      properties: {
        season: { type: "number", description: "e.g. 2026. Omit for all." },
        week: { type: "number", description: "e.g. 1. Omit for all." },
      },
      required: [],
    },
  },
  {
    name: "get_nfl_ledger",
    description:
      "Read the CLV ledger for the published boards: how many legs are pending vs graded vs missing a close, grading coverage, the play-arm and control-arm beat rates, the paired differential (the pre-registered verdict metric), and the frozen minimum sample size below which no verdict is issued. Use this for any 'how is it doing / what are the results / has it been graded' question.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_nfl_market",
    description:
      "Read the CURRENT NFL week's sharp market: kickoff time, teams, moneyline / spread / total prices, AND the devigged fair win probability implied by those prices (fairHomeProb / fairAwayProb). Use it to answer 'what is the number on this game', 'when do they play', 'what do you like', and to build parlays. Compare the fair probability against the price on offer to find value, combine legs across DIFFERENT games for a parlay (multiply the fair probabilities, multiply the decimal prices), and say what you like and why. Anything you build from this is a LIVE read generated now — label it as such and never call it pre-registered or part of the CLV ledger.",
    input_schema: {
      type: "object",
      properties: {
        week: { type: "number", description: "Reserved; the slate file holds the current week only." },
      },
      required: [],
    },
  },
  {
    name: "get_nfl_research",
    description:
      "Read the offline NFL research aggregates: the moneyline dry-run, the player-prop backtest, and the 3-leg parlay backtest. EVERY figure arrives with its mandatory caveats attached — the in-sample season span, the fact that CLV is ~0 by construction, and the negative 2025 out-of-sample holdout. You must repeat those caveats whenever you state any of these numbers; a yield stated bare is a lie by omission.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_nfl_injuries",
    description:
      "Read the NFL injury wire: player, team, position, designation, injury type and expected return. Optionally filter by team name or abbreviation.",
    input_schema: {
      type: "object",
      properties: {
        team: { type: "string", description: "Team name or abbreviation, e.g. 'Jets' or 'NYJ'." },
        limit: { type: "number", description: "Max rows (default 40)." },
      },
      required: [],
    },
  },
  {
    name: "get_nfl_standings",
    description:
      "Read NFL standings. This is SEASON-GATED: if the file on disk describes a completed prior season it returns available:false with the reason, and you must then say you do not have current standings rather than quote last season's table as if it were this year's.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

// ─── Projections ─────────────────────────────────────────────────────────────

function selectBoards(boards: LoadedBoard[], season?: number, week?: number): LoadedBoard[] {
  return boards.filter(
    (b) =>
      (season === undefined || b.board.season === season) &&
      (week === undefined || b.board.week === week)
  );
}

function boardLegProjection(leg: LoadedBoard["board"]["legs"][number]) {
  // EXPLICIT field list. Do NOT convert this to a spread-and-delete: a new
  // field added to PublishedLeg would then leak by default, and the two fields
  // that must never leak (stakeFraction, evPct) are exactly the kind a future
  // publisher edit would add back.
  return {
    legId: leg.legId,
    role: leg.role,
    verdict: leg.verdict,
    matchup: leg.matchup,
    gameId: leg.gameId,
    kickoffUtc: leg.kickoffUtc,
    market: leg.market,
    selection: leg.selection,
    side: leg.side,
    point: leg.point,
    entryPriceAmerican: leg.entryPriceAmerican,
    entryOtherSideAmerican: leg.entryOtherSideAmerican,
    book: leg.priceProvenance?.book ?? null,
    priceCapturedAt: leg.priceProvenance?.snapshotFetchedAt ?? null,
    clvEligible: leg.clvEligible,
    passReason: leg.passReason ?? null,
    doctrineNotes: leg.doctrineNotes ?? [],
    calibratedConfidence: leg.calibratedConfidence ?? null,
    edge: leg.edge ?? null,
  };
}

export function nflBoard(input: { season?: number; week?: number }, root?: string) {
  const all = loadPublishedBoards(root);
  if (all.length === 0) {
    return {
      available: false as const,
      reason: "no NFL board has been published to this repo yet",
      boards: [],
    };
  }
  const selected = selectBoards(all, input.season, input.week);
  if (selected.length === 0) {
    return {
      available: false as const,
      reason: `no board published for the requested season/week; published weeks are ${all
        .map((b) => `${b.board.season} wk${b.board.week}`)
        .join(", ")}`,
      publishedWeeks: all.map((b) => ({ season: b.board.season, week: b.board.week })),
      boards: [],
    };
  }
  return {
    available: true as const,
    boards: selected.map(({ board, file }) => ({
      boardFile: file,
      season: board.season,
      week: board.week,
      publishedAt: board.publishedAt,
      entrySnapshotFetchedAt: board.entrySnapshotFetchedAt,
      // The parlay slot is published as null on purpose and is reported as
      // such — "there is no NFL parlay product" is a fact about the data.
      parlay: board.parlay,
      legCount: board.legs.length,
      playCount: board.legs.filter((l) => l.role === "play").length,
      passCount: board.legs.filter((l) => l.role === "pass").length,
      controlCount: board.legs.filter((l) => l.role === "control").length,
      note: board.note,
      legs: board.legs.map(boardLegProjection),
    })),
  };
}

export function nflLedger(root?: string) {
  const ledger = loadLedger(root);
  if (!ledger) {
    return { available: false as const, reason: "the CLV ledger is not readable" };
  }
  const h = headline(ledger);
  const statusCounts: Record<string, number> = {};
  for (const r of ledger.rows) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  }
  const arm = (a: (typeof h)["play"]) => ({
    eligible: a.eligible,
    graded: a.graded,
    coverage: a.coverage,
    beats: a.beats,
    beatRate: a.beatRate,
    avgDevigClvPp: a.avgDevigClvPp,
    tier2Benchmarked: a.tier2Benchmarked,
    byStatus: a.byStatus as Record<LegStatus, number>,
  });
  return {
    available: true as const,
    rowCount: ledger.rows.length,
    statusCounts,
    weeksPublished: ledger.boards.map((b) => ({
      boardFile: b.file,
      season: b.season,
      week: b.week,
      publishedAt: b.publishedAt,
      sha256: b.sha256,
      errata: b.errata,
    })),
    play: arm(h.play),
    control: arm(h.control),
    pairedN: h.pairedN,
    pairedDifferentialPp: h.pairedDifferentialPp,
    verdictMinN: VERDICT_MIN_N,
    insufficientN: h.insufficientN,
    verdictRule: `No verdict is issued until the play arm has ${VERDICT_MIN_N} graded legs. That threshold was pre-registered and is frozen.`,
  };
}

export function nflMarket(_input: { week?: number }, root?: string) {
  const slate = loadSlate(root);
  if (!slate || slate.games.length === 0) {
    return {
      available: false as const,
      reason: "no current NFL market snapshot is on disk",
      games: [],
    };
  }
  return {
    available: true as const,
    capturedAt: slate.generatedAt,
    source: slate.source,
    windowStartUtc: slate.windowStartUtc,
    windowEndUtc: slate.windowEndUtc,
    gameCount: slate.gameCount,
    // Devigged fair probabilities ARE returned (operator decision 2026-09-09).
    // They were withheld so the model could not compute an edge for a game the
    // board never registered — which also meant it could not answer "what do
    // you like" or build a parlay at all. The operator wants the desk to
    // research and give a read. The receipts stay honest a different way: a
    // live read is LABELLED as live and can never enter the CLV ledger (see
    // validators.ts, DESK RESEARCH channel). Nothing here is ever written.
    disclosure:
      "Sharp market prices plus the devigged fair win probability implied by them. A read built off these is a LIVE read, generated now — it is not a pre-registered board leg and it is not in the CLV ledger.",
    games: slate.games.map((g) => ({
      kickoffUtc: g.kickoffUtc,
      awayTeam: g.away_team,
      homeTeam: g.home_team,
      homeMoneylineAmerican: g.moneyline?.home ?? null,
      awayMoneylineAmerican: g.moneyline?.away ?? null,
      spreadPoint: g.spread?.point ?? null,
      homeSpreadAmerican: g.spread?.home ?? null,
      awaySpreadAmerican: g.spread?.away ?? null,
      totalPoint: g.total?.point ?? null,
      overAmerican: g.total?.over ?? null,
      underAmerican: g.total?.under ?? null,
      fairHomeProb: g.fairHomeProb ?? null,
      fairAwayProb: g.fairAwayProb ?? null,
    })),
  };
}

const CLV_ZERO_CAVEAT =
  "Graded against approximate closing lines, so closing-line value is ~0 by construction. This is a research backtest, not a live betting record.";

const HOLDOUT_CAVEAT =
  "The one out-of-sample test this model has taken — the 2025 season holdout — came back NEGATIVE. Calibration transferred; edge did not.";

export function nflResearch(root?: string) {
  const raw = loadExp5(root);
  if (!raw) {
    return { available: false as const, reason: "the NFL research summary is not readable" };
  }
  const mlWins = raw.record?.wins ?? 0;
  const mlLosses = raw.record?.losses ?? 0;
  const pWins = raw.props?.record?.wins ?? 0;
  const pLosses = raw.props?.record?.losses ?? 0;
  const pDecided = pWins + pLosses;
  const parWins = raw.parlays?.record?.wins ?? 0;
  const parLosses = raw.parlays?.record?.losses ?? 0;

  return {
    available: true as const,
    generatedAt: raw.generatedAt ?? null,
    // Every block carries its own span + caveat so a figure cannot be lifted
    // out of the payload without them.
    moneyline: {
      seasonSpan: MONEYLINE_SPAN,
      inSample: true,
      roiPct: raw.roiPct ?? null,
      sampleSize: raw.settled ?? null,
      winsCount: mlWins,
      lossesCount: mlLosses,
      pushesCount: raw.record?.pushes ?? 0,
      clvBeatRatePct: raw.clvBeatRatePct ?? null,
      avgClvProbPoints: raw.avgClvProbPoints ?? null,
      caveat: `In-sample over ${MONEYLINE_SPAN}. ${CLV_ZERO_CAVEAT} ${HOLDOUT_CAVEAT}`,
    },
    props: {
      seasonSpan: RESEARCH_SPAN,
      inSample: true,
      sampleSize: raw.props?.settled ?? null,
      winsCount: pWins,
      lossesCount: pLosses,
      pushesCount: raw.props?.record?.pushes ?? 0,
      noDataCount: raw.props?.noData ?? 0,
      // A HIT RATE against a threshold. There is no price behind it, so it is
      // not a win rate and it is not a return — do not speak of it as one.
      hitRatePct: pDecided > 0 ? +((pWins / pDecided) * 100).toFixed(1) : null,
      caveat: `In-sample over ${RESEARCH_SPAN}. Graded against box scores, never against a market price — there is NO ROI and NO CLV for this block, and there is no live NFL prop board. ${HOLDOUT_CAVEAT}`,
    },
    parlays: {
      seasonSpan: RESEARCH_SPAN,
      inSample: true,
      upperBound: true,
      flatYieldPct: raw.parlays?.roiPct ?? null,
      winRatePct: raw.parlays?.winRatePct ?? null,
      breakEvenPct: raw.parlays?.breakEvenPct ?? null,
      avgLegEdgePct:
        raw.parlays?.avgLegsEdge != null ? +(raw.parlays.avgLegsEdge * 100).toFixed(1) : null,
      sampleSize: raw.parlays?.settled ?? null,
      winsCount: parWins,
      lossesCount: parLosses,
      caveat: `Retrospective 3-leg study, in-sample over ${RESEARCH_SPAN}, flat stake. ${CLV_ZERO_CAVEAT} Treat the yield as an OPTIMISTIC UPPER BOUND, never as a forecast. ${HOLDOUT_CAVEAT} There is no live parlay product on this desk.`,
    },
    holdout: {
      season: 2025,
      result: "negative" as const,
      headline: HOLDOUT_HEADLINE,
    },
    mandatoryCaveats: [
      "Every figure in this payload is IN-SAMPLE over the span named in its own block.",
      CLV_ZERO_CAVEAT,
      HOLDOUT_CAVEAT,
      "No ROI figure here is an expectation. State the caveats in the same breath as the number or do not state the number.",
    ],
  };
}

export function nflInjuries(input: { team?: string; limit?: number }, root?: string) {
  const file = loadInjuries(root);
  if (!file) {
    return { available: false as const, reason: "the NFL injury wire is not readable", players: [] };
  }
  const limit = Number.isFinite(input.limit) ? Math.min(Math.max(1, Number(input.limit)), 120) : 40;
  const needle = input.team?.trim().toLowerCase() ?? "";
  const rows = (file.players ?? []).filter((p) =>
    needle ? p.team?.toLowerCase().includes(needle) : true
  );
  return {
    available: true as const,
    fetchedAt: file.fetchedAt ?? null,
    matched: rows.length,
    truncated: rows.length > limit,
    players: rows.slice(0, limit).map((p) => ({
      player: p.player,
      team: p.team,
      position: p.position ?? null,
      status: p.status ?? null,
      injuryType: p.injuryType ?? null,
      returnDate: p.returnDate ?? null,
    })),
  };
}

export function nflStandings(root?: string) {
  const boards = loadPublishedBoards(root);
  const currentWeek = boards.length > 0 ? boards[boards.length - 1]!.board.week : null;
  const rows = loadStandings(root);
  const gate = standingsSeasonGate(rows, currentWeek);
  if (!gate.current) {
    // available:false, NOT a warning string beside real-looking rows. A warning
    // the model can read past is a warning the model will read past; an absent
    // payload is one it cannot quote.
    return {
      available: false as const,
      reason: `${gate.reason}. Do not quote these standings — say you do not have current-season standings.`,
      teams: [],
    };
  }
  return {
    available: true as const,
    teams: (rows ?? []).map((r) => ({
      team: r.team,
      abbreviation: r.abbreviation ?? null,
      wins: r.wins,
      losses: r.losses,
      winPct: r.winPct ?? null,
      homeRecord: r.homeRecord ?? null,
      awayRecord: r.awayRecord ?? null,
      pointDiff: r.pointDiff ?? null,
      streak: r.streak ?? null,
      conference: r.conference ?? null,
    })),
  };
}

// ─── Handler map ─────────────────────────────────────────────────────────────

export type NflToolHandlers = Record<string, (input: unknown) => unknown>;

export function buildNflToolHandlers(root?: string): NflToolHandlers {
  return {
    get_nfl_board: (input) => nflBoard((input ?? {}) as { season?: number; week?: number }, root),
    get_nfl_ledger: () => nflLedger(root),
    get_nfl_market: (input) => nflMarket((input ?? {}) as { week?: number }, root),
    get_nfl_research: () => nflResearch(root),
    get_nfl_injuries: (input) =>
      nflInjuries((input ?? {}) as { team?: string; limit?: number }, root),
    get_nfl_standings: () => nflStandings(root),
  };
}
