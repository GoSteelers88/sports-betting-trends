// Search Polymarket for specific keywords / categories
// Run: npx tsx scripts/search-polymarket.ts [keyword]

const keywords = process.argv.slice(2).join(" ") || "tariff trade SCOTUS supreme court legal";

async function searchMarkets(keywords: string) {
  console.log(`🔍 Searching Polymarket for: "${keywords}"\n`);

  // Try the events endpoint with politics-related terms
  const terms = keywords.toLowerCase().split(/\s+/);

  // First, get top 500 markets (broader search)
  const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&order=liquidityNum&ascending=false&limit=500`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "polymarket-search/1.0" },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as any[];

    // Filter for matching keywords
    const matches = data.filter((m) => {
      const q = (m.question || "").toLowerCase();
      const cat = (m.category || "").toLowerCase();
      const desc = (m.description || "").toLowerCase();
      return terms.some((t) => q.includes(t) || cat.includes(t) || desc.includes(t));
    });

    console.log(`📊 Scanned ${data.length} markets`);
    console.log(`✅ Found ${matches.length} matches\n`);

    // Sort by volume (most active first)
    const sorted = matches.sort((a, b) => (b.volumeNum || 0) - (a.volumeNum || 0));

    for (const m of sorted.slice(0, 20)) {
      const outcomes = tryParse(m.outcomes);
      const prices = tryParse(m.outcomePrices);
      const implied = prices?.[0] ? Math.round(parseFloat(prices[0]) * 1000) / 10 : "N/A";

      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`🎯 ${m.question}`);
      console.log(`   Category: ${m.category || "general"}`);
      console.log(`   Volume: $${formatNum(m.volumeNum || m.volume)} | Liquidity: $${formatNum(m.liquidityNum || m.liquidity)}`);
      console.log(`   Implied: ${implied}% | End: ${m.endDate?.slice(0, 10) || "N/A"}`);
      if (outcomes?.length && prices?.length) {
        console.log(`   Outcomes: ${outcomes.map((o: string, i: number) => `${o}: ${Math.round(parseFloat(prices[i] || "0") * 100)}%`).join(" | ")}`);
      }
    }

    if (matches.length === 0) {
      console.log("❌ No matches found. Try different keywords.");
      console.log("\n📋 Sample of recent market questions:");
      const recent = data.slice(0, 10).map((m) => m.question);
      recent.forEach((q, i) => console.log(`   ${i + 1}. ${q.slice(0, 100)}...`));
    }

  } catch (err) {
    console.error(`❌ Failed: ${(err as Error).message}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tryParse(json: string | undefined): any {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function formatNum(n: number | string | undefined): string {
  if (n === undefined || n === null) return "0";
  const num = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(num)) return "0";
  if (num >= 1e9) return (num / 1e9).toFixed(1) + "M";
  if (num >= 1e6) return (num / 1e6).toFixed(1) + "M";
  if (num >= 1e3) return (num / 1e3).toFixed(1) + "k";
  return num.toFixed(0);
}

searchMarkets(keywords);
