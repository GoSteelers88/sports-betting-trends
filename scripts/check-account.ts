import { getBalance, getOrders } from "./execute-kalshi.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function loadEnv(): void {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* ignore */ }
}

loadEnv();

async function kalshiFetch(method: string, endpoint: string, queryParams?: Record<string, string>): Promise<unknown> {
  const apiKeyId = process.env.KALSHI_API_KEY_ID!;
  const pemPath  = process.env.KALSHI_PRIVATE_KEY_PEM_PATH!;
  const pem      = fs.readFileSync(pemPath, "utf-8");
  const ts       = Date.now().toString();
  const urlPath  = "/trade-api/v2" + endpoint;
  const msg      = ts + method.toUpperCase() + urlPath;
  const signer   = crypto.createSign("SHA256");
  signer.update(msg);
  const sig = signer.sign({ key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, "base64");

  let url = "https://api.elections.kalshi.com/trade-api/v2" + endpoint;
  if (queryParams) url += "?" + new URLSearchParams(queryParams).toString();

  const res = await fetch(url, {
    method,
    headers: {
      "KALSHI-ACCESS-KEY": apiKeyId,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": sig,
      "Accept": "application/json",
    },
  });
  return res.json();
}

async function main() {
  const [balRaw, ordersResting, ordersFilled, posRaw] = await Promise.all([
    kalshiFetch("GET", "/portfolio/balance"),
    kalshiFetch("GET", "/portfolio/orders", { status: "resting" }),
    kalshiFetch("GET", "/portfolio/orders", { status: "filled" }),
    kalshiFetch("GET", "/portfolio/positions"),
  ]) as any[];

  const cash      = (Number(balRaw.balance ?? 0) / 100).toFixed(2);
  const portfolio = (Number(balRaw.portfolio_value ?? 0) / 100).toFixed(2);
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Balance:   $${cash}   Portfolio: $${portfolio}`);
  console.log(`${"═".repeat(50)}`);

  const resting = (ordersResting.orders ?? []) as any[];
  console.log(`\nResting orders (${resting.length}):`);
  for (const o of resting) {
    const price = o.yes_price ?? o.no_price ?? "?";
    console.log(`  ${o.ticker.padEnd(38)} ${o.side.toUpperCase()} @${price}c  qty=${o.count_fp ?? "?"}`);
  }
  if (resting.length === 0) console.log("  (none)");

  const filled = (ordersFilled.orders ?? []) as any[];
  console.log(`\nFilled orders today (${filled.length}):`);
  for (const o of filled.slice(0, 10)) {
    const price = o.yes_price ?? o.no_price ?? "?";
    console.log(`  ${o.ticker.padEnd(38)} ${o.side.toUpperCase()} @${price}c  qty=${o.count_fp ?? "?"}`);
  }
  if (filled.length === 0) console.log("  (none)");

  // Raw positions — print all keys
  const posKeys = Object.keys(posRaw);
  console.log(`\nPositions raw keys: ${posKeys.join(", ")}`);
  const posArr = posRaw.market_positions ?? posRaw.positions ?? [];
  const openPos = posArr.filter((p: any) => (p.position ?? p.quantity ?? 0) !== 0);
  console.log(`Open positions (${openPos.length}):`);
  for (const p of openPos) {
    console.log(`  ${JSON.stringify(p)}`);
  }
  if (openPos.length === 0) console.log("  (none)");

  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });
