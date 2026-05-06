import fs from "node:fs";
import crypto from "node:crypto";

const keyId = process.env.KALSHI_API_KEY_ID!;
const pemPath = process.env.KALSHI_PRIVATE_KEY_PEM_PATH!;
const pem = fs.readFileSync(pemPath, "utf8");
const BASE = "https://api.elections.kalshi.com/trade-api/v2";

async function signedGet(endpoint: string) {
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const msg = ts + nonce + "GET" + "/trade-api/v2" + endpoint;
  const key = crypto.createPrivateKey(pem);
  const sig = crypto.sign("sha256", Buffer.from(msg), {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  const r = await fetch(BASE + endpoint, {
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-NONCE": nonce,
      "KALSHI-ACCESS-SIGNATURE": sig.toString("base64"),
    },
  });
  return r.json();
}

async function main() {
  const d = await signedGet(`/portfolio/positions`);
  const girath = (d.market_positions ?? d.positions ?? []).filter((p: any) => p.ticker?.includes("GIRATH"));
  console.log(JSON.stringify(girath, null, 2));
}

main().catch(console.error);
