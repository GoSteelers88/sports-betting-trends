import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const line of fs.readFileSync(path.resolve(__dirname, ".env"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  if (k && !(k in process.env)) process.env[k] = v;
}

const pem = fs.readFileSync(process.env.KALSHI_PRIVATE_KEY_PEM_PATH, "utf-8");
const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const PREFIX = "/trade-api/v2";

function sign(m, ep) {
  const ts = Date.now().toString();
  const sig = crypto.createSign("SHA256").update(ts + m.toUpperCase() + PREFIX + ep).sign(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, "base64"
  );
  return { "KALSHI-ACCESS-KEY": process.env.KALSHI_API_KEY_ID, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": sig };
}

const r = await fetch(BASE + "/portfolio/orders?status=resting", {
  headers: { ...sign("GET", "/portfolio/orders"), Accept: "application/json" },
});
const d = await r.json();
const orders = d.orders || [];
console.log("Resting orders:", orders.length);
for (const o of orders) {
  console.log(" ", o.order_id, o.ticker, o.side, o.status);
  const cr = await fetch(BASE + "/portfolio/orders/" + o.order_id, {
    method: "DELETE",
    headers: { ...sign("DELETE", "/portfolio/orders/" + o.order_id), Accept: "application/json" },
  });
  console.log("  Cancel →", cr.status);
}
