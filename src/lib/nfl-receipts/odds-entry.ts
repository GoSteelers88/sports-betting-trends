// odds-entry.ts — the Odds API client for the receipts pipeline.
//
// Unlike ingest-odds-api.ts (which swallows every HTTP error and exits 0 —
// fine for a dashboard cache, fatal for a notarized board: threat T4), every
// failure here THROWS with the discriminated error_code, so a publish with no
// prices can never masquerade as the intended empty board.
//
//   429 OUT_OF_USAGE_CREDITS  → quota exhausted (resets the 1st)
//   429 EXCEEDED_FREQ_LIMIT   → slow down, retryable
//   401 MISSING_KEY / invalid → configuration, not market conditions
//
// /v4/sports/{sport}/events is FREE — slate, kickoffs and event ids never
// spend credits. Credits are spent only on /odds.

export interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Array<{
    key: string;
    title: string;
    markets?: Array<{
      key: "h2h" | "spreads" | "totals" | string;
      outcomes?: Array<{ name: string; price?: number; point?: number }>;
    }>;
  }>;
}

export class OddsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorCode: string | null,
  ) {
    super(message);
    this.name = "OddsApiError";
  }
}

const BASE = "https://api.the-odds-api.com/v4";

async function fetchJson(url: URL): Promise<{ data: unknown; remaining: string; used: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "sports-betting-trends/nfl-receipts" },
    signal: AbortSignal.timeout(25000),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    let errorCode: string | null = null;
    try {
      const parsed = JSON.parse(bodyText) as { error_code?: string };
      errorCode = parsed.error_code ?? null;
    } catch {
      /* non-JSON error body */
    }
    throw new OddsApiError(
      `Odds API ${url.pathname} → HTTP ${res.status} (${errorCode ?? "no error_code"}): ${bodyText.slice(0, 300)}`,
      res.status,
      errorCode,
    );
  }
  return {
    data: JSON.parse(bodyText),
    remaining: res.headers.get("x-requests-remaining") ?? "unknown",
    used: res.headers.get("x-requests-used") ?? "unknown",
  };
}

/** FREE: the week's slate with kickoffs + event ids. */
export async function fetchNflEvents(apiKey: string): Promise<OddsApiEvent[]> {
  const url = new URL(`${BASE}/sports/americanfootball_nfl/events`);
  url.searchParams.set("apiKey", apiKey);
  const { data } = await fetchJson(url);
  if (!Array.isArray(data)) throw new OddsApiError("events: non-array response", 200, null);
  return data as OddsApiEvent[];
}

export interface OddsSnapshot {
  fetchedAt: string;
  regions: string;
  markets: string;
  quotaRemaining: string;
  quotaUsed: string;
  events: OddsApiEvent[];
}

/** PAID (markets × regions credits): full odds snapshot. Throws on any error. */
export async function fetchNflOdds(
  apiKey: string,
  opts: { regions?: string; markets?: string } = {},
): Promise<OddsSnapshot> {
  const regions = opts.regions ?? "us";
  const markets = opts.markets ?? "h2h,spreads,totals";
  const url = new URL(`${BASE}/sports/americanfootball_nfl/odds`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", regions);
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", "american");
  const { data, remaining, used } = await fetchJson(url);
  if (!Array.isArray(data)) throw new OddsApiError("odds: non-array response", 200, null);
  if (data.length === 0)
    throw new OddsApiError(
      "odds: 0 events — an empty market feed during the season is a broken pull, not an empty board",
      200,
      null,
    );
  return {
    fetchedAt: new Date().toISOString(),
    regions,
    markets,
    quotaRemaining: remaining,
    quotaUsed: used,
    events: data as OddsApiEvent[],
  };
}

// ─── Price extraction (exact-point discipline, threat T12) ───────────────────

export interface ExtractedPrice {
  book: string;
  american: number;
  otherAmerican: number;
  point: number | null;
  oddsApiEventId: string;
}

/** Best price for a selection at EXACTLY the requested point (spread/total),
 *  scanning the given books in the given order of preference when `best` is
 *  false, or across all listed books for the numerically best price when
 *  true. The other side must exist at the SAME book (devig needs a coherent
 *  two-way). A moved point is skipped, never substituted. */
export function extractPrice(
  event: OddsApiEvent,
  market: "moneyline" | "ats" | "total",
  side: "home" | "away" | "over" | "under",
  point: number | null,
  books: string[] | "all",
): ExtractedPrice | null {
  const marketKey = market === "moneyline" ? "h2h" : market === "ats" ? "spreads" : "totals";
  const sideName =
    market === "total"
      ? side === "over"
        ? "Over"
        : "Under"
      : side === "home"
        ? event.home_team
        : event.away_team;
  const otherName =
    market === "total"
      ? side === "over"
        ? "Under"
        : "Over"
      : side === "home"
        ? event.away_team
        : event.home_team;

  // Priority mode must honor the CALLER's book order, not the API's response
  // order (review finding 7 — the tier-2 chain is pre-registered as
  // lowvig → betonlineag and has to actually mean that).
  const bookmakers = event.bookmakers ?? [];
  const scanOrder =
    books === "all"
      ? bookmakers
      : books
          .map((key) => bookmakers.find((bm) => bm.key === key))
          .filter((bm): bm is NonNullable<typeof bm> => bm != null);

  let best: ExtractedPrice | null = null;
  for (const bm of scanOrder) {
    const mk = bm.markets?.find((m) => m.key === marketKey);
    if (!mk?.outcomes) continue;
    const ours = mk.outcomes.find(
      (o) =>
        o.name === sideName &&
        typeof o.price === "number" &&
        (point == null || o.point === point),
    );
    if (!ours) continue;
    // Opposite side at the same book; spreads mirror the point, totals share it.
    const wantOtherPoint =
      point == null ? null : market === "ats" ? -point : point;
    const other = mk.outcomes.find(
      (o) =>
        o.name === otherName &&
        typeof o.price === "number" &&
        (wantOtherPoint == null || o.point === wantOtherPoint),
    );
    if (!other) continue;
    const cand: ExtractedPrice = {
      book: bm.key,
      american: ours.price!,
      otherAmerican: other.price!,
      point,
      oddsApiEventId: event.id,
    };
    if (books !== "all") return cand; // priority order: first listed book wins
    if (!best || cand.american > best.american) best = cand;
  }
  return best;
}

/** The market's main line for a game: the most common point across books
 *  (mode; ties break toward the smaller absolute point). Deterministic given
 *  the snapshot — used by the control arm, never for play legs. */
export function mainPoint(
  event: OddsApiEvent,
  market: "ats" | "total",
  side: "home" | "over",
): number | null {
  const marketKey = market === "ats" ? "spreads" : "totals";
  const sideName = market === "ats" ? event.home_team : "Over";
  const counts = new Map<number, number>();
  for (const bm of event.bookmakers ?? []) {
    const mk = bm.markets?.find((m) => m.key === marketKey);
    for (const o of mk?.outcomes ?? []) {
      if (o.name === sideName && typeof o.point === "number") {
        counts.set(o.point, (counts.get(o.point) ?? 0) + 1);
      }
    }
  }
  let bestPoint: number | null = null;
  let bestCount = 0;
  for (const [pt, ct] of counts) {
    if (
      ct > bestCount ||
      (ct === bestCount && bestPoint != null && Math.abs(pt) < Math.abs(bestPoint))
    ) {
      bestPoint = pt;
      bestCount = ct;
    }
  }
  return bestPoint;
}
