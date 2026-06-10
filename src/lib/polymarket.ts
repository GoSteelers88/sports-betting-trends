/**
 * polymarket.ts — read-only Polymarket Gamma API client for the Kalshi↔PM
 * convergence harness. Public API: no auth, no geo-restriction on DATA
 * (trading access is a separate matter — and irrelevant here; the harness
 * measures, the one-legged execution venue would be Kalshi).
 */

const GAMMA = "https://gamma-api.polymarket.com";

export interface PolymarketMarket {
  id: string;
  question: string;
  slug: string;
  endDate: string | null;
  yesPrice: number | null; // 0..1
  volume: number;
  active: boolean;
}

function parseMarket(m: any): PolymarketMarket | null {
  const question = String(m.question ?? "");
  if (!question) return null;
  // outcomePrices is a JSON-encoded array aligned with outcomes ["Yes","No"].
  let yesPrice: number | null = null;
  try {
    const outcomes: string[] = JSON.parse(m.outcomes ?? "[]");
    const prices: string[] = JSON.parse(m.outcomePrices ?? "[]");
    const yi = outcomes.findIndex((o) => o.toLowerCase() === "yes");
    if (yi >= 0) {
      const p = Number(prices[yi]);
      if (Number.isFinite(p) && p > 0 && p < 1) yesPrice = p;
    }
  } catch {
    /* leave null */
  }
  return {
    id: String(m.id ?? ""),
    question,
    slug: String(m.slug ?? ""),
    endDate: m.endDate ? String(m.endDate) : null,
    yesPrice,
    volume: Number(m.volume ?? 0) || 0,
    active: Boolean(m.active),
  };
}

async function gfetch(endpoint: string): Promise<any> {
  const res = await fetch(`${GAMMA}${endpoint}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Polymarket ${endpoint} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** A market by slug (the stable identifier used in venue-pairs.json). */
export async function fetchMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
  const json = await gfetch(`/markets?slug=${encodeURIComponent(slug)}`);
  const arr: any[] = Array.isArray(json) ? json : [];
  return arr.length > 0 ? parseMarket(arr[0]) : null;
}

/** Fuzzy text search over active markets — for pair discovery, not ticks. */
export async function searchMarkets(query: string, limit = 25): Promise<PolymarketMarket[]> {
  // Gamma supports public-search via /public-search; fall back to a filtered
  // /markets page when unavailable.
  try {
    const json = await gfetch(`/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit}`);
    const events: any[] = json.events ?? [];
    const markets = events.flatMap((e: any) => e.markets ?? []);
    return markets.map(parseMarket).filter((m): m is PolymarketMarket => m != null && m.active);
  } catch {
    const json = await gfetch(`/markets?closed=false&limit=${limit * 4}`);
    const arr: any[] = Array.isArray(json) ? json : [];
    const q = query.toLowerCase();
    return arr
      .map(parseMarket)
      .filter((m): m is PolymarketMarket => m != null && m.active)
      .filter((m) => m.question.toLowerCase().includes(q))
      .slice(0, limit);
  }
}
