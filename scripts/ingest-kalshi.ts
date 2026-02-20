import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface KalshiMarket {
  ticker: string;
  title: string;
  category: string;
  yes_sub_title: string;
  no_sub_title: string;
  expiration_time: string;
  status: "open" | "closed" | "settled";
  yes_ask: number; // cents
  yes_bid: number; // cents
  no_ask: number; // cents
  no_bid: number; // cents
  volume: number;
  open_interest: number;
  liquidity?: number;
  last_price?: number;
  strike_price?: number;
  option_type?: string; // For event-based contracts
}

interface KalshiEvent {
  ticker: string;
  title: string;
  category: string;
  sub_title: string;
  close_time: string;
  markets: KalshiMarket[];
}

interface KalshiResponse {
  cursor?: string;
  events?: KalshiEvent[];
  markets?: KalshiMarket[];
}

interface ProcessedMarket {
  ticker: string;
  title: string;
  subtitle: string;
  category: string;
  yesBid: number; // 0-1
  yesAsk: number; // 0-1
  yesMid: number; // 0-1
  noBid: number; // 0-1
  noAsk: number; // 0-1
  impliedProbYes: number; // percentage
  spread: number; // cents spread
  volume: number;
  liquidity: number;
  status: "open" | "closed" | "settled";
  closeTime: string;
  actionability: "High" | "Med" | "Low";
}

interface KalshiOutput {
  fetchedAt: string;
  totalFetched: number;
  markets: ProcessedMarket[];
  stats: {
    apiCallsMade: number;
    excludedNoData: number;
  };
}

// ---------------------------------------------------------------------------
// Rate-limit-aware fetch with authentication
// ---------------------------------------------------------------------------
let apiCallCount = 0;

async function fetchWithAuth(url: string, apiKey: string, maxRetries = 4): Promise<Response> {
  const delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    apiCallCount++;
    const res = await fetch(url, {
      headers: {
        "Authorization": apiKey,
        "User-Agent": "sports-betting-trends/1.0 (kalshi-ingest)",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });

    if (res.status === 429) {
      if (attempt === maxRetries) throw new Error(`Rate limited after ${maxRetries} retries: ${url}`);
      console.warn(` [kalshi] 429 on ${url} — backoff ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(delay * Math.pow(2, attempt));
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      console.error(` [kalshi] HTTP ${res.status}: ${body}`);
      if (attempt === maxRetries) throw new Error(`HTTP ${res.status} from ${url}`);
      await sleep(delay * Math.pow(2, attempt));
      continue;
    }

    return res;
  }
  throw new Error("Unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Kalshi API - Get Active Markets
// ---------------------------------------------------------------------------
async function fetchKalshiMarkets(apiKey: string, limit = 100): Promise<KalshiMarket[]> {
  const markets: KalshiMarket[] = [];
  let cursor: string | undefined;
  const baseUrl = "https://api.elections.kalshi.com/trade-api/v2/events";

  console.log(` [kalshi] Fetching markets...`);

  try {
    // Try events endpoint first (structured events)
    let url = `${baseUrl}?status=open&limit=${limit}`;
    if (cursor) url += `&cursor=${cursor}`;

    const res = await fetchWithAuth(url, apiKey);
    const data = await res.json() as KalshiResponse;

    if (data.events) {
      for (const event of data.events) {
        for (const market of event.markets || []) {
          markets.push(market);
        }
      }
    }

    // Fallback: try markets endpoint
    if (markets.length === 0) {
      const marketsUrl = `https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=${limit}`;
      const mRes = await fetchWithAuth(marketsUrl, apiKey);
      const mData = await mRes.json() as KalshiResponse;

      if (mData.markets) {
        markets.push(...mData.markets);
      }
    }

    console.log(` [kalshi] Got ${markets.length} markets`);
    return markets;
  } catch (err) {
    console.error(` [kalshi] Failed to fetch markets: ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Alternative: Legacy API endpoint (api.kalshi.com)
// ---------------------------------------------------------------------------
async function fetchKalshiMarketsLegacy(apiKey: string, limit = 100): Promise<KalshiMarket[]> {
  const markets: KalshiMarket[] = [];
  const baseUrl = "https://api.kalshi.com/trade-api/v2/markets";

  console.log(` [kalshi] Trying legacy API...`);

  try {
    const url = `${baseUrl}?status=open&limit=${limit}`;
    const res = await fetchWithAuth(url, apiKey);
    const data = await res.json() as { markets?: KalshiMarket[] };

    if (data.markets) {
      markets.push(...data.markets);
    }

    console.log(` [kalshi-legacy] Got ${markets.length} markets`);
    return markets;
  } catch (err) {
    console.error(` [kalshi-legacy] Failed: ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Process markets into unified format
// ---------------------------------------------------------------------------
function processMarkets(rawMarkets: KalshiMarket[]): ProcessedMarket[] {
  const processed: ProcessedMarket[] = [];

  for (const m of rawMarkets) {
    // Skip if no pricing data
    if (m.yes_ask === 0 && m.yes_bid === 0 && !m.last_price) {
      continue;
    }

    const yesBid = m.yes_bid / 100; // Convert cents to 0-1
    const yesAsk = m.yes_ask / 100;
    const noBid = m.no_bid / 100;
    const noAsk = m.no_ask / 100;

    // Calculate midpoint / implied probability
    const yesMid = m.last_price ? m.last_price / 100 : (yesBid + yesAsk) / 2;
    const impliedProbYes = yesMid * 100;

    // Spread in cents
    const spread = (yesAsk - yesBid) * 100;

    // Actionability based on spread and data completeness
    const hasRealSpread = yesBid > 0.01 && yesAsk < 0.99 && spread > 0;
    let actionability: "High" | "Med" | "Low";
    if (!hasRealSpread) actionability = "Low";
    else if (spread < 0.015) actionability = "High";
    else if (spread < 0.05) actionability = "Med";
    else actionability = "Low";

    processed.push({
      ticker: m.ticker,
      title: m.title || "",
      subtitle: m.yes_sub_title || "",
      category: m.category || "general",
      yesBid,
      yesAsk,
      yesMid,
      noBid,
      noAsk,
      impliedProbYes,
      spread,
      volume: m.volume || 0,
      liquidity: m.open_interest || m.liquidity || 0,
      status: m.status || "open",
      closeTime: m.expiration_time || "",
      actionability,
    });
  }

  // Sort by liquidity/interest
  return processed.sort((a, b) => b.liquidity - a.liquidity);
}

// ---------------------------------------------------------------------------
// Format AGENTS.md block for Kalshi
// ---------------------------------------------------------------------------
function formatKalshiForAgents(
  markets: ProcessedMarket[],
  fetchedAt: Date,
): string {
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const timeStr = etFormatter.format(fetchedAt);
  const top10 = markets.slice(0, 10);

  const lines: string[] = [
    `# Kalshi Markets Snapshot — ${timeStr} ET`,
    `_Last refreshed: ${timeStr} ET · ${markets.length} markets tracked_`,
    "",
    "## Top 10 by Liquidity",
    "",
  ];

  for (let i = 0; i < top10.length; i++) {
    const m = top10[i];
    const yesBidCents = Math.round(m.yesBid * 100);
    const yesAskCents = Math.round(m.yesAsk * 100);
    const spreadCents = Math.round(m.spread * 100);
    const impliedPct = Math.round(m.impliedProbYes * 10) / 10;

    lines.push(`**${i + 1}. ${m.title}**`);
    lines.push(`YES bid/ask: ${yesBidCents}¢ / ${yesAskCents}¢ → Implied: ${impliedPct}%`);
    lines.push(`Spread: ${spreadCents}¢ · Actionability: ${m.actionability} · Liq: ${m.liquidity.toLocaleString()}`);
    lines.push(`Closes: ${m.closeTime ? new Date(m.closeTime).toLocaleDateString() : "Unknown"} · Status: ${m.status}`);
    lines.push("");
  }

  lines.push("_Run `npm run ingest:kalshi` to refresh._");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const outDir = path.join(process.cwd(), "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });

  const apiKey = process.env.KALSHI_API_KEY ?? "";
  const fetchedAt = new Date();

  console.log("Fetching Kalshi markets...");
  const rawMarkets = await fetchKalshiMarkets(apiKey);
  console.log(`Fetched ${rawMarkets.length} markets`);

  const processed = processMarkets(rawMarkets);
  console.log(`Processed ${processed.length} markets`);

  const outPath = path.join(outDir, "latest-kalshi.json");
  const output = { fetchedAt: fetchedAt.toISOString(), marketCount: processed.length, markets: processed };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Wrote ${outPath}`);

  const agentsBlock = formatKalshiForAgents(processed, fetchedAt);
  const agentsPath = path.join(process.cwd(), "data", "processed", "latest-kalshi-agents.md");
  fs.writeFileSync(agentsPath, agentsBlock, "utf-8");
  console.log(`Wrote ${agentsPath}`);
}

main().catch((err) => {
  console.error("ingest-kalshi failed:", err);
  process.exit(1);
});