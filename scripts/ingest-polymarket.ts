import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  category?: string;
  startDate?: string;
  endDate?: string;
  outcomes: string; // JSON-encoded string[]
  outcomePrices: string; // JSON-encoded string[]
  liquidity?: number | string;
  volume?: number | string;
  clobTokenIds?: string; // JSON-encoded {yes: string, no: string} or string[]
  active?: boolean;
  closed?: boolean;
}

interface ClobBook {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

interface CrossEdge {
  pickTeam: string;
  modelConfidence: number; // 0–100
  polymarketImplied: number; // 0–100 (from ask)
  gap: number; // modelConfidence - polymarketImplied
  direction: "model-higher" | "model-lower" | "aligned";
  vigRemovedNote: string;
  matchedVia: string;
  gameDate: string;
  tMinusMinutes?: number;
}

interface ProcessedMarket {
  id: string;
  conditionId: string;
  question: string;
  category: string;
  endDate: string;
  startDate?: string;
  yesTokenId: string;
  yesPrice: number; // midpoint
  yesBid: number;
  yesAsk: number;
  noPrice: number;
  impliedProbYes: number;
  spread: number;
  topBidDepth: number;
  actionability: "High" | "Med" | "Low";
  liquidity: number;
  volume: number;
  volumeRank: number;
  liquidityRank: number;
  resolutionRisk: "Objective" | "Subjective" | "Time-sensitive";
  crossEdge?: CrossEdge;
  eventStartTimeEt?: string; // ISO timestamp in ET
  eventDateEt?: string; // YYYY-MM-DD in ET
  status?: "open" | "starting_soon" | "in_play" | "closed";
  minutesUntilStart?: number; // minutes until event start, negative = in progress/past
}

interface PolymarketOutput {
  fetchedAt: string;
  totalFetched: number;
  markets: ProcessedMarket[];
  sportsMarkets: ProcessedMarket[];
  crossEdgeMarkets: ProcessedMarket[];
  stats: {
    apiCallsMade: number;
    excludedNoYesOutcome: number;
    excludedNoBook: number;
  };
}

interface BestBet {
  league: string;
  matchup: string;
  pickTeam: string;
  opponent: string;
  confidence: number; // 0–100 model probability
  gameDate: string;
  spread?: number;
  line?: string;
}

// ---------------------------------------------------------------------------
// Team aliases for entity matching
// ---------------------------------------------------------------------------

const TEAM_ALIASES: Record<string, string[]> = {
  // NBA
  "Atlanta Hawks": ["Hawks", "ATL"],
  "Boston Celtics": ["Celtics", "BOS", "Boston"],
  "Brooklyn Nets": ["Nets", "BKN", "Brooklyn"],
  "Charlotte Hornets": ["Hornets", "CHA", "Charlotte"],
  "Chicago Bulls": ["Bulls", "CHI", "Chicago"],
  "Cleveland Cavaliers": ["Cavaliers", "Cavs", "CLE", "Cleveland"],
  "Dallas Mavericks": ["Mavericks", "Mavs", "DAL", "Dallas"],
  "Denver Nuggets": ["Nuggets", "DEN", "Denver"],
  "Detroit Pistons": ["Pistons", "DET", "Detroit"],
  "Golden State Warriors": ["Warriors", "GSW", "Golden State"],
  "Houston Rockets": ["Rockets", "HOU", "Houston"],
  "Indiana Pacers": ["Pacers", "IND", "Indiana"],
  "LA Clippers": ["Clippers", "LAC", "Los Angeles Clippers"],
  "Los Angeles Lakers": ["Lakers", "LAL", "LA Lakers"],
  "Memphis Grizzlies": ["Grizzlies", "MEM", "Memphis"],
  "Miami Heat": ["Heat", "MIA", "Miami"],
  "Milwaukee Bucks": ["Bucks", "MIL", "Milwaukee"],
  "Minnesota Timberwolves": ["Timberwolves", "Wolves", "MIN", "Minnesota"],
  "New Orleans Pelicans": ["Pelicans", "NOP", "New Orleans"],
  "New York Knicks": ["Knicks", "NYK", "NY Knicks", "New York"],
  "Oklahoma City Thunder": ["Thunder", "OKC", "Oklahoma City"],
  "Orlando Magic": ["Magic", "ORL", "Orlando"],
  "Philadelphia 76ers": ["76ers", "Sixers", "PHI", "Philadelphia"],
  "Phoenix Suns": ["Suns", "PHX", "Phoenix"],
  "Portland Trail Blazers": ["Trail Blazers", "Blazers", "POR", "Portland"],
  "Sacramento Kings": ["Kings", "SAC", "Sacramento"],
  "San Antonio Spurs": ["Spurs", "SAS", "San Antonio"],
  "Toronto Raptors": ["Raptors", "TOR", "Toronto"],
  "Utah Jazz": ["Jazz", "UTA", "Utah"],
  "Washington Wizards": ["Wizards", "WAS", "Washington"],
  // NFL
  "Arizona Cardinals": ["Cardinals", "ARI"],
  "Atlanta Falcons": ["Falcons", "ATL Falcons"],
  "Baltimore Ravens": ["Ravens", "BAL"],
  "Buffalo Bills": ["Bills", "BUF"],
  "Carolina Panthers": ["Panthers", "CAR"],
  "Chicago Bears": ["Bears", "CHI Bears"],
  "Cincinnati Bengals": ["Bengals", "CIN"],
  "Cleveland Browns": ["Browns", "CLE Browns"],
  "Dallas Cowboys": ["Cowboys", "DAL Cowboys"],
  "Denver Broncos": ["Broncos", "DEN Broncos"],
  "Detroit Lions": ["Lions", "DET Lions"],
  "Green Bay Packers": ["Packers", "GB"],
  "Houston Texans": ["Texans", "HOU Texans"],
  "Indianapolis Colts": ["Colts", "IND Colts"],
  "Jacksonville Jaguars": ["Jaguars", "Jags", "JAX"],
  "Kansas City Chiefs": ["Chiefs", "KC"],
  "Las Vegas Raiders": ["Raiders", "LV", "Vegas Raiders"],
  "Los Angeles Chargers": ["Chargers", "LAC Chargers"],
  "Los Angeles Rams": ["Rams", "LAR"],
  "Miami Dolphins": ["Dolphins", "MIA Dolphins"],
  "Minnesota Vikings": ["Vikings", "MIN Vikings"],
  "New England Patriots": ["Patriots", "Pats", "NE"],
  "New Orleans Saints": ["Saints", "NO"],
  "New York Giants": ["Giants", "NYG"],
  "New York Jets": ["Jets", "NYJ"],
  "Philadelphia Eagles": ["Eagles", "PHI Eagles"],
  "Pittsburgh Steelers": ["Steelers", "PIT"],
  "San Francisco 49ers": ["49ers", "Niners", "SF"],
  "Seattle Seahawks": ["Seahawks", "SEA"],
  "Tampa Bay Buccaneers": ["Buccaneers", "Bucs", "TB"],
  "Tennessee Titans": ["Titans", "TEN"],
  "Washington Commanders": ["Commanders", "WAS Commanders"],
  // MLB
  "Arizona Diamondbacks": ["Diamondbacks", "D-backs", "ARI"],
  "Atlanta Braves": ["Braves", "ATL Braves"],
  "Baltimore Orioles": ["Orioles", "BAL Orioles"],
  "Boston Red Sox": ["Red Sox", "BOS Red Sox"],
  "Chicago Cubs": ["Cubs", "CHC"],
  "Chicago White Sox": ["White Sox", "CWS"],
  "Cincinnati Reds": ["Reds", "CIN Reds"],
  "Cleveland Guardians": ["Guardians", "CLE Guardians"],
  "Colorado Rockies": ["Rockies", "COL"],
  "Detroit Tigers": ["Tigers", "DET Tigers"],
  "Houston Astros": ["Astros", "HOU Astros"],
  "Kansas City Royals": ["Royals", "KC Royals"],
  "Los Angeles Angels": ["Angels", "LAA"],
  "Los Angeles Dodgers": ["Dodgers", "LAD"],
  "Miami Marlins": ["Marlins", "MIA Marlins"],
  "Milwaukee Brewers": ["Brewers", "MIL Brewers"],
  "Minnesota Twins": ["Twins", "MIN Twins"],
  "New York Mets": ["Mets", "NYM"],
  "New York Yankees": ["Yankees", "NYY"],
  "Oakland Athletics": ["Athletics", "A's", "OAK"],
  "Philadelphia Phillies": ["Phillies", "PHI Phillies"],
  "Pittsburgh Pirates": ["Pirates", "PIT Pirates"],
  "San Diego Padres": ["Padres", "SD"],
  "San Francisco Giants": ["SF Giants", "SFG"],
  "Seattle Mariners": ["Mariners", "SEA Mariners"],
  "St. Louis Cardinals": ["Cardinals", "STL"],
  "Tampa Bay Rays": ["Rays", "TB Rays"],
  "Texas Rangers": ["Rangers", "TEX"],
  "Toronto Blue Jays": ["Blue Jays", "TOR Blue Jays"],
  "Washington Nationals": ["Nationals", "Nats", "WSH"],
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

/** Word-boundary safe match: short tokens (<=4 chars) must appear as whole words */
function tokenMatchesQuestion(normQ: string, normToken: string): boolean {
  if (normToken.length === 0) return false;
  if (normToken.length <= 4) {
    // Require whole-word match to avoid "cha" in "chair", "min" in "nomination", etc.
    const re = new RegExp(`(?:^|\\s)${normToken}(?:\\s|$)`);
    return re.test(normQ);
  }
  return normQ.includes(normToken);
}

/** Returns [canonical name, alias used] or null if no match */
function matchTeamInQuestion(
  question: string,
  pickTeam: string,
): [string, string] | null {
  const normQ = normalize(question);
  const normPick = normalize(pickTeam);

  // Must be a multi-word or long enough token to match directly
  if (tokenMatchesQuestion(normQ, normPick)) {
    return [pickTeam, pickTeam];
  }

  // Find the canonical entry for the pickTeam
  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    const normCanon = normalize(canonical);
    const isPickTeam =
      normPick === normCanon ||
      aliases.some((a) => normalize(a) === normPick);

    if (!isPickTeam) continue;

    // Now check if canonical name or any meaningful alias appears in the question
    if (tokenMatchesQuestion(normQ, normCanon)) {
      return [canonical, canonical];
    }
    for (const alias of aliases) {
      const normAlias = normalize(alias);
      if (tokenMatchesQuestion(normQ, normAlias)) {
        return [canonical, alias];
      }
    }
  }

  return null;
}

function isMoneylineQuestion(question: string): boolean {
  const q = question.toLowerCase();
  const spreadKeywords = ["spread", "cover", "over", "under", "points", "+/-", "ats", "total"];
  return !spreadKeywords.some((kw) => q.includes(kw));
}

// ---------------------------------------------------------------------------
// Actionability scoring
// ---------------------------------------------------------------------------

function actionabilityScore(spread: number, topBidDepth: number, hasRealBook: boolean): "High" | "Med" | "Low" {
  if (!hasRealBook) return "Low";
  if (spread <= 0.01 && topBidDepth >= 1000) return "High";
  if (spread <= 0.03) return "Med";
  return "Low";
}

// ---------------------------------------------------------------------------
// Resolution risk classification
// ---------------------------------------------------------------------------

function classifyResolutionRisk(question: string, endDate: string): "Objective" | "Subjective" | "Time-sensitive" {
  const q = question.toLowerCase();

  // Time-sensitive: sports (auto-cancel at game start)
  const sportsTerms = ["win", "beat", "champion", "nba", "nfl", "mlb", "nhl", "ncaa", "playoff",
    "super bowl", "world series", "finals", "game", "match", "season"];
  if (sportsTerms.some((t) => q.includes(t))) {
    const end = new Date(endDate);
    const now = new Date();
    const daysUntil = (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (daysUntil < 3) return "Time-sensitive";
    return "Objective";
  }

  // Subjective: policy/opinion markets
  const subjectiveTerms = ["sign", "pass", "approve", "veto", "announce", "declare", "major",
    "significant", "notable", "likely", "consider", "attempt"];
  if (subjectiveTerms.some((t) => q.includes(t))) return "Subjective";

  // Objective: price feeds, election results, confirmed facts
  const objectiveTerms = ["price", "above", "below", "reach", "election", "win election",
    "president", "gdp", "rate", "index"];
  if (objectiveTerms.some((t) => q.includes(t))) return "Objective";

  return "Objective";
}

// ---------------------------------------------------------------------------
// Vig removal
// ---------------------------------------------------------------------------

/** Convert American odds to implied probability (raw, with vig) */
function americanToImplied(odds: number): number {
  if (odds > 0) return 100 / (100 + odds);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

/** Remove vig from a two-outcome market, return fair probability for the positive side */
function removeTwoWayVig(oddsPos: number, oddsNeg: number): { fairPos: number; vig: number } {
  const implPos = americanToImplied(oddsPos);
  const implNeg = americanToImplied(oddsNeg);
  const total = implPos + implNeg;
  const vig = total - 1.0;
  return {
    fairPos: implPos / total,
    vig,
  };
}

// ---------------------------------------------------------------------------
// Rate-limit-aware fetch with exponential backoff
// ---------------------------------------------------------------------------

let apiCallCount = 0;

async function fetchWithBackoff(url: string, maxRetries = 4): Promise<Response> {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    apiCallCount++;
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends/1.0 (polymarket-ingest)" },
      signal: AbortSignal.timeout(20000),
    });

    if (res.status === 429) {
      if (attempt === maxRetries) throw new Error(`Rate limited after ${maxRetries} retries: ${url}`);
      console.warn(`  [rate-limit] 429 on ${url} — backoff ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
      continue;
    }

    if (!res.ok) {
      if (attempt === maxRetries) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
      console.warn(`  [warn] HTTP ${res.status} from ${url} — retry ${attempt + 1}/${maxRetries}`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
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
// ET Time helpers
// ---------------------------------------------------------------------------
const ET_DATETIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatEtTimestamp(date: Date): { isoEt: string; dateEt: string } {
  const parts = ET_DATETIME_FORMATTER.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  const dateEt = `${year}-${month}-${day}`;
  const isoEt = `${dateEt}T${hour}:${minute}:${second}`;
  return { isoEt, dateEt };
}

function getEventStatus(eventStartMs: number, nowMs: number): { status: "open" | "starting_soon" | "in_play" | "closed"; minutesUntil: number } {
  const minutesUntil = Math.round((eventStartMs - nowMs) / 60000);
  if (minutesUntil > 60) return { status: "open", minutesUntil };
  if (minutesUntil > 0) return { status: "starting_soon", minutesUntil };
  if (minutesUntil > -180) return { status: "in_play", minutesUntil }; // assume ~3h game window
  return { status: "closed", minutesUntil };
}

// ---------------------------------------------------------------------------
// Gamma API
// ---------------------------------------------------------------------------

async function fetchTopMarkets(limit = 50): Promise<GammaMarket[]> {
  const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&order=liquidityNum&ascending=false&limit=${limit}`;
  console.log(`  [gamma] Fetching top ${limit} markets by liquidity...`);
  const res = await fetchWithBackoff(url);
  const data = await res.json() as GammaMarket[];
  console.log(`  [gamma] Got ${data.length} markets`);
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------------------
// CLOB API — batch order book fetch (concurrent, rate-limit-aware)
// ---------------------------------------------------------------------------

async function fetchAllBooks(
  tokenIds: string[],
  concurrency = 5,
): Promise<Map<string, { bid: number; ask: number; mid: number; topBidDepth: number }>> {
  const result = new Map<string, { bid: number; ask: number; mid: number; topBidDepth: number }>();
  if (tokenIds.length === 0) return result;

  console.log(`  [clob] Fetching order books for ${tokenIds.length} tokens (concurrency=${concurrency})...`);

  // Process in chunks to limit concurrency
  for (let i = 0; i < tokenIds.length; i += concurrency) {
    const chunk = tokenIds.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map((id) => fetchOrderBook(id).then((b) => ({ id, ...b }))),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        const { id, bid, ask, topBidDepth } = r.value;
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
        result.set(id, { bid, ask, mid, topBidDepth });
      }
    }
    // Small pause between chunks
    if (i + concurrency < tokenIds.length) await sleep(300);
  }

  console.log(`  [clob] Books resolved for ${result.size}/${tokenIds.length} tokens`);
  return result;
}

// ---------------------------------------------------------------------------
// CLOB API — individual order book for top-of-book depth
// ---------------------------------------------------------------------------

async function fetchOrderBook(tokenId: string): Promise<{ bid: number; ask: number; topBidDepth: number }> {
  const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`;
  try {
    const res = await fetchWithBackoff(url);
    const book = await res.json() as ClobBook;

    const topBid = book.bids?.[0];
    const topAsk = book.asks?.[0];
    const bid = topBid ? parseFloat(topBid.price) : 0;
    const ask = topAsk ? parseFloat(topAsk.price) : 0;
    const topBidDepth = topBid ? parseFloat(topBid.size) : 0;

    return { bid, ask, topBidDepth };
  } catch (err) {
    console.warn(`  [clob] Order book fetch failed for ${tokenId}: ${(err as Error).message}`);
    return { bid: 0, ask: 0, topBidDepth: 0 };
  }
}

// ---------------------------------------------------------------------------
// Parse Gamma market fields
// ---------------------------------------------------------------------------

function parseYesToken(market: GammaMarket): string | null {
  if (!market.clobTokenIds) return null;
  try {
    const parsed = JSON.parse(market.clobTokenIds);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed.yes ?? null;
    }
    if (Array.isArray(parsed) && parsed.length > 0) {
      // Try to correlate with outcomes array
      const outcomes = JSON.parse(market.outcomes) as string[];
      const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
      return yesIdx >= 0 ? (parsed[yesIdx] as string) : (parsed[0] as string);
    }
  } catch {
    // clobTokenIds might be a plain string
    return typeof market.clobTokenIds === "string" ? market.clobTokenIds : null;
  }
  return null;
}

function parseYesPrice(market: GammaMarket): { yesPrice: number; noPrice: number } {
  try {
    const labels = JSON.parse(market.outcomes) as string[];
    const prices = JSON.parse(market.outcomePrices) as string[];
    // CRITICAL: find YES by label, never assume index 0
    const yesIdx = labels.findIndex((l) => l.toLowerCase() === "yes");
    const noIdx = labels.findIndex((l) => l.toLowerCase() === "no");
    const yesPrice = yesIdx >= 0 ? parseFloat(prices[yesIdx]) : parseFloat(prices[0]);
    const noPrice = noIdx >= 0 ? parseFloat(prices[noIdx]) : (1 - yesPrice);
    return { yesPrice: isNaN(yesPrice) ? 0 : yesPrice, noPrice: isNaN(noPrice) ? 0 : noPrice };
  } catch {
    return { yesPrice: 0, noPrice: 0 };
  }
}

// ---------------------------------------------------------------------------
// Load NateStacks best bets for cross-edge analysis
// ---------------------------------------------------------------------------

function loadBestBets(root: string): BestBet[] {
  const summaryPath = path.join(root, "data", "processed", "latest-summary.json");
  if (!fs.existsSync(summaryPath)) {
    console.warn("  [cross-edge] latest-summary.json not found — skipping cross-edge analysis");
    return [];
  }
  try {
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8")) as { bestBets?: BestBet[] };
    return summary.bestBets ?? [];
  } catch (err) {
    console.warn(`  [cross-edge] Failed to parse latest-summary.json: ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cross-edge matching
// ---------------------------------------------------------------------------

function findCrossEdge(market: ProcessedMarket, bestBets: BestBet[]): CrossEdge | undefined {
  if (!isMoneylineQuestion(market.question)) return undefined;

  for (const bet of bestBets) {
    const matchResult = matchTeamInQuestion(market.question, bet.pickTeam);
    if (!matchResult) continue;

    const [, alias] = matchResult;
    console.log(`  [cross-edge] "${market.question}" matched via alias: '${alias}'`);

    const polyImplied = market.yesAsk > 0 ? market.yesAsk * 100 : market.impliedProbYes;
    const modelConf = bet.confidence; // already a fair probability (no vig)
    const gap = modelConf - polyImplied;
    const abgGap = Math.abs(gap);

    if (abgGap < 5) continue; // only flag divergences >5%

    // Compute game start T-minus
    let tMinusMinutes: number | undefined;
    if (bet.gameDate) {
      const gameMs = new Date(bet.gameDate).getTime();
      const nowMs = Date.now();
      const diffMin = (gameMs - nowMs) / 60000;
      if (diffMin > 0 && diffMin < 1440) tMinusMinutes = Math.round(diffMin);
    }

    return {
      pickTeam: bet.pickTeam,
      modelConfidence: modelConf,
      polymarketImplied: Math.round(polyImplied * 10) / 10,
      gap: Math.round(gap * 10) / 10,
      direction: gap > 0 ? "model-higher" : "model-lower",
      vigRemovedNote: `NateStacks confidence (${modelConf}%) is model probability — no vig removal needed`,
      matchedVia: alias,
      gameDate: bet.gameDate,
      tMinusMinutes,
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Atomic AGENTS.md update
// ---------------------------------------------------------------------------

function updateAgentsMd(filePath: string, block: string): void {
  if (!fs.existsSync(filePath)) {
    console.warn(`  [agents.md] File not found: ${filePath} — skipping update`);
    return;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const startTag = "<!-- MARKETS-START -->";
  const endTag = "<!-- MARKETS-END -->";

  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) {
    console.warn("  [agents.md] Markers not found — skipping update");
    return;
  }

  const updated =
    content.slice(0, startIdx + startTag.length) +
    "\n" +
    block +
    "\n" +
    content.slice(endIdx);

  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, updated, "utf-8");

  // Validate
  if (!updated.includes(startTag) || !updated.includes(endTag) || block.trim().length === 0) {
    fs.unlinkSync(tmpPath);
    throw new Error("AGENTS.md validation failed — temp file removed, original untouched");
  }

  fs.renameSync(tmpPath, filePath); // atomic on same filesystem
  console.log(`  [agents.md] Updated ${filePath}`);
}

// ---------------------------------------------------------------------------
// Format AGENTS.md block
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function formatAgentsMdBlock(
  markets: ProcessedMarket[],
  crossEdgeMarkets: ProcessedMarket[],
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

  const sportsCount = markets.filter((m) => m.category?.toLowerCase() === "sports").length;
  const crossEdgeCount = crossEdgeMarkets.length;

  const top10 = markets.slice(0, 10);

  const lines: string[] = [
    `# Top Markets Snapshot — ${timeStr} ET`,
    `_Last refreshed: ${timeStr.split(", ")[1] ?? timeStr} ET · Data age: 0m · ${markets.length} markets tracked · ${sportsCount} sports · ${crossEdgeCount} cross-edge alerts_`,
    "",
    "## Top 10 by Liquidity",
    "",
  ];

  for (let i = 0; i < top10.length; i++) {
    const m = top10[i];
    const bidCents = Math.round(m.yesBid * 100);
    const askCents = Math.round(m.yesAsk * 100);
    const midCents = Math.round(m.yesPrice * 100);
    const impliedPct = Math.round(m.impliedProbYes * 10) / 10;
    const spreadCents = Math.round(m.spread * 100);
    const resDate = m.endDate ? new Date(m.endDate).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }) : "Unknown";

    lines.push(`**${i + 1}. ${m.question}**`);
    lines.push(`YES bid/ask: ${bidCents}¢ / ${askCents}¢ → Mid: ${midCents}¢ → Implied: ${impliedPct}%`);
    lines.push(`Spread: ${spreadCents}¢ · Actionability: ${m.actionability} · Vol ${formatNumber(m.volume)} · Liq ${formatNumber(m.liquidity)}`);
    lines.push(`Resolves: ${resDate} · Resolution risk: ${m.resolutionRisk}`);
    lines.push("");
  }

  // Cross-edge section
  lines.push("## Cross-Book Edge Alerts");
  lines.push("_Markets where Polymarket implied probability diverges from NateStacks model_");
  lines.push("");

  if (crossEdgeMarkets.length === 0) {
    lines.push("_No significant cross-edge divergences found (>5% threshold)._");
    lines.push("");
  } else {
    for (const m of crossEdgeMarkets) {
      const ce = m.crossEdge!;
      const askCents = Math.round(m.yesAsk * 100);
      const gapStr = ce.gap > 0 ? `+${ce.gap}%` : `${ce.gap}%`;
      const directionNote =
        ce.direction === "model-higher"
          ? `model HIGHER — market may be underpricing ${ce.pickTeam}`
          : `model LOWER — market may be overpricing ${ce.pickTeam}`;

      lines.push(`**${m.question}**`);
      lines.push(`- Polymarket: YES ask ${askCents}¢ → Implied ${ce.polymarketImplied}%`);
      lines.push(`- NateStacks model: ${ce.modelConfidence}% (${ce.vigRemovedNote})`);
      lines.push(`- Edge gap: ${gapStr} (${directionNote})`);
      lines.push(`- Match: "${ce.pickTeam}" matched via alias "${ce.matchedVia}" (moneyline comparable ✓)`);

      if (ce.tMinusMinutes !== undefined) {
        const hours = Math.floor(ce.tMinusMinutes / 60);
        const mins = ce.tMinusMinutes % 60;
        const tMinusStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        const gameTime = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }).format(new Date(ce.gameDate));
        lines.push(`- ⚠️ Game starts ${gameTime} ET — T-minus ${tMinusStr}, book auto-clears at tip-off/kickoff`);
        if (ce.tMinusMinutes < 30) {
          lines.push(`- 🚨 UNDER 30 MIN TO START — Liquidity can change rapidly near tip-off/kickoff`);
        }
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("_Run `npm run ingest:polymarket` to refresh. Full data: data/processed/latest-polymarket.json_");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const root = process.cwd();
  apiCallCount = 0;
  let excludedNoYesOutcome = 0;
  let excludedNoBook = 0;

  console.log("[polymarket] Starting ingest...");

  // 1. Fetch markets from Gamma API
  const rawMarkets = await fetchTopMarkets(50);

  // 2. Extract YES token IDs — sort by liquidity descending
  const tokenIdMap = new Map<string, { market: GammaMarket; yesTokenId: string; yesPrice: number; noPrice: number }>();

  for (const m of rawMarkets) {
    const yesTokenId = parseYesToken(m);
    if (!yesTokenId) {
      excludedNoYesOutcome++;
      continue;
    }
    const { yesPrice, noPrice } = parseYesPrice(m);
    tokenIdMap.set(m.id, { market: m, yesTokenId, yesPrice, noPrice });
  }

  const orderedEntries = [...tokenIdMap.values()].sort((a, b) => {
    const liqA = parseFloat(String(a.market.liquidity ?? "0"));
    const liqB = parseFloat(String(b.market.liquidity ?? "0"));
    return liqB - liqA;
  });

  // 3. Fetch order books for all markets via /book (concurrent, rate-aware)
  const allYesTokenIds = orderedEntries.map((v) => v.yesTokenId);
  const bookCache = await fetchAllBooks(allYesTokenIds, 5);

  // 4. Process markets into final shape
  const processed: ProcessedMarket[] = [];
  const nowMs = Date.now();

  for (let i = 0; i < orderedEntries.length; i++) {
    const { market: m, yesTokenId, yesPrice: gammaMid, noPrice } = orderedEntries[i];

    const book = bookCache.get(yesTokenId);

    // CLOB bid/ask for executability display; Gamma mid for fair implied probability
    const yesBid = book?.bid ?? 0;
    const yesAsk = book?.ask ?? 0;
    // Always use Gamma outcomePrices as the canonical midpoint — CLOB mid is unreliable for thin books
    const yesPrice = gammaMid > 0 ? gammaMid : (book?.mid ?? 0);

    // Skip only if we have absolutely no price data at all
    if (yesPrice === 0 && yesBid === 0 && yesAsk === 0) {
      excludedNoBook++;
      continue;
    }

    // Implied probability uses Gamma midpoint (oracle-based, more stable than CLOB mid for thin books)
    const impliedProbYes = yesPrice * 100;
    // Spread is only meaningful when both sides have real orders (not 0.001 / 0.999 ghost books)
    const hasRealSpread = yesBid > 0.01 && yesAsk < 0.99;
    const spread = hasRealSpread ? (yesAsk - yesBid) : 0;
    const topBidDepth = (book?.topBidDepth ?? 0) > 0 && yesBid > 0.01 ? (book?.topBidDepth ?? 0) : 0;

    const liquidity = parseFloat(String(m.liquidity ?? "0"));
    const volume = parseFloat(String(m.volume ?? "0"));

    let eventStartTimeEt: string | undefined;
    let eventDateEt: string | undefined;
    let status: "open" | "starting_soon" | "in_play" | "closed" | undefined;
    let minutesUntilStart: number | undefined;

    const eventStartIso = m.startDate ?? m.endDate ?? "";
    if (eventStartIso) {
      const eventStart = new Date(eventStartIso);
      if (!Number.isNaN(eventStart.getTime())) {
        const { isoEt, dateEt } = formatEtTimestamp(eventStart);
        const { status: st, minutesUntil } = getEventStatus(eventStart.getTime(), nowMs);
        eventStartTimeEt = `${isoEt} ET`;
        eventDateEt = dateEt;
        status = st;
        minutesUntilStart = minutesUntil;
      }
    }

    const pm: ProcessedMarket = {
      id: m.id,
      conditionId: m.conditionId,
      question: m.question,
      category: m.category ?? "general",
      endDate: m.endDate ?? "",
      startDate: m.startDate,
      yesTokenId,
      yesPrice,
      yesBid,
      yesAsk,
      noPrice,
      impliedProbYes: Math.round(impliedProbYes * 10) / 10,
      spread: Math.round(spread * 1000) / 1000,
      topBidDepth,
      actionability: actionabilityScore(spread, topBidDepth, hasRealSpread),
      liquidity,
      volume,
      volumeRank: 0, // set below
      liquidityRank: i + 1,
      resolutionRisk: classifyResolutionRisk(m.question, m.endDate ?? ""),
      eventStartTimeEt,
      eventDateEt,
      status,
      minutesUntilStart,
    };

    processed.push(pm);
  }

  // Assign volume ranks
  const byVolume = [...processed].sort((a, b) => b.volume - a.volume);
  for (let i = 0; i < byVolume.length; i++) {
    byVolume[i].volumeRank = i + 1;
  }

  // 6. Load best bets and compute cross-edges
  const bestBets = loadBestBets(root);
  const sportsMarkets: ProcessedMarket[] = [];
  const crossEdgeMarkets: ProcessedMarket[] = [];

  for (const m of processed) {
    const isSports = m.category?.toLowerCase() === "sports" ||
      // Heuristic: sports questions often contain team names
      Object.keys(TEAM_ALIASES).some((team) => normalize(m.question).includes(normalize(team)));

    if (isSports) {
      sportsMarkets.push(m);
    }

    if (bestBets.length > 0) {
      const ce = findCrossEdge(m, bestBets);
      if (ce) {
        m.crossEdge = ce;
        crossEdgeMarkets.push(m);
      }
    }
  }

  // 7. Write JSON output
  const outDir = path.join(root, "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });

  const output: PolymarketOutput = {
    fetchedAt: new Date().toISOString(),
    totalFetched: processed.length,
    markets: processed,
    sportsMarkets,
    crossEdgeMarkets,
    stats: {
      apiCallsMade: apiCallCount,
      excludedNoYesOutcome,
      excludedNoBook,
    },
  };

  const outPath = path.join(outDir, "latest-polymarket.json");
  const tmpOutPath = outPath + ".tmp";
  fs.writeFileSync(tmpOutPath, JSON.stringify(output, null, 2), "utf-8");
  fs.renameSync(tmpOutPath, outPath);
  console.log(`[polymarket] Written: ${outPath}`);

  // 8. Update AGENTS.md
  const agentsMdPath = path.join(
    "C:\\Users\\Nate\\.openclaw\\workspace-polymarket",
    "AGENTS.md",
  );
  const block = formatAgentsMdBlock(processed, crossEdgeMarkets, new Date());
  updateAgentsMd(agentsMdPath, block);

  // 9. Print summary
  const summary = `[polymarket] Refresh complete: ${processed.length} markets | ${sportsMarkets.length} sports | ${crossEdgeMarkets.length} cross-edge | ${excludedNoYesOutcome + excludedNoBook} excluded | API calls: ${apiCallCount}`;
  console.log(summary);
}

main().catch((err) => {
  console.error("[polymarket] Fatal error:", err);
  process.exit(1);
});
