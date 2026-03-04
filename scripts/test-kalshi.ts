// Quick test script — tries both Kalshi APIs and reports which works
import fs from "node:fs";

const API_KEY = process.env.KALSHI_API_KEY || "4d74101b-bf3f-4414-a440-97858cf8d668";
const LOG_FILE = "C:\\Users\\nbber\\.openclaw\\workspace-kalshi\\kalshi-test.log";

const logs: string[] = [];
function log(msg: string) {
  console.log(msg);
  logs.push(msg);
}

async function testEndpoint(name: string, url: string): Promise<{ name: string; ok: boolean; status: number; data: unknown }> {
  log(`\n🔌 Testing: ${name}`);
  log(`   URL: ${url}`);

  try {
    const res = await fetch(url, {
      headers: {
        "Authorization": API_KEY,
        "Accept": "application/json",
        "User-Agent": "kalshi-test/1.0",
      },
      signal: AbortSignal.timeout(15000),
    });

    const bodyText = await res.text();
    let data: unknown;

    try {
      data = JSON.parse(bodyText);
    } catch {
      data = bodyText.slice(0, 500);
    }

    if (res.ok) {
      const marketCount = Array.isArray((data as { markets?: unknown[] })?.markets)
        ? (data as { markets?: unknown[] }).markets?.length
        : "n/a";
      log(`   ✅ OK ${res.status} | Markets: ${marketCount}`);
    } else {
      log(`   ❌ HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    }

    return { name, ok: res.ok, status: res.status, data };
  } catch (err) {
    log(`   ❌ Error: ${(err as Error).message}`);
    return { name, ok: false, status: 0, data: (err as Error).message };
  }
}

async function main() {
  log("═══════════════════════════════════════════════════════");
  log("  Kalshi API Key Test");
  log("  Key: " + API_KEY.slice(0, 8) + "..." + API_KEY.slice(-4));
  log("═══════════════════════════════════════════════════════");

  const results = await Promise.all([
    testEndpoint("Election API (events)", "https://api.elections.kalshi.com/trade-api/v2/events?status=open&limit=10"),
    testEndpoint("Election API (markets)", "https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=10"),
    testEndpoint("Live Markets API", "https://api.kalshi.com/trade-api/v2/markets?status=open&limit=10"),
  ]);

  log("\n═══════════════════════════════════════════════════════");
  log("  Results Summary");
  log("═══════════════════════════════════════════════════════");

  let working = 0;
  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    log(`  ${icon} ${r.name}: HTTP ${r.status}`);
    if (r.ok) working++;
  }

  if (working === 0) {
    log("\n⚠️  No endpoints responded successfully.");
    log("   Possible issues:");
    log("   - API key may be expired/revoked");
    log("   - Key type mismatch (live vs demo)");
    log("   - IP whitelist required");
  } else {
    log(`\n✅ ${working}/${results.length} endpoint(s) working`);
  }

  // Write log file
  fs.writeFileSync(LOG_FILE, logs.join("\n"), "utf-8");
  console.log(`\n📝 Log written to: ${LOG_FILE}`);
}

main();
