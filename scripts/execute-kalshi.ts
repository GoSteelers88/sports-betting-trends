/**
 * execute-kalshi.ts — Kalshi REST client with RSA-PSS authentication
 *
 * Required environment variables:
 *   KALSHI_API_KEY_ID           — RSA key ID from Kalshi dashboard
 *   KALSHI_PRIVATE_KEY_PEM_PATH — path to RSA private key (.pem file)
 *   KALSHI_ENV                  — "prod" (default) or "demo"
 *
 * Authentication: RSA-PSS SHA256, saltLength=DIGEST
 * Signed string: {timestampMs}{METHOD}{/trade-api/v2/path}  (NO query params)
 *
 * Error handling: throws KalshiApiError; callers treat 401/403 as fatal.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// .env loader (no external package required)
// ---------------------------------------------------------------------------
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
  } catch {
    // ignore
  }
}

loadEnv();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export class KalshiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "KalshiApiError";
  }
}

export interface KalshiBalance {
  balance: number;         // cents
  portfolio_value: number; // cents
}

export interface KalshiPosition {
  ticker: string;
  side: "yes" | "no";
  position: number;
  market_exposure: number;
  total_cost: number;
  realized_pnl: number;
}

export interface KalshiOrder {
  order_id: string;
  client_order_id: string;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: "limit" | "market";
  status: string;
  yes_price?: number;
  no_price?: number;
  count_fp?: string;
  remaining_count_fp?: string;
  created_time: string;
}

export interface CreateOrderPayload {
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: "limit";
  yes_price_dollars?: string;
  no_price_dollars?: string;
  count_fp: string;
  client_order_id: string;
  post_only?: boolean;
  time_in_force?: string;
}

// ---------------------------------------------------------------------------
// Credential loading (cached after first call)
// ---------------------------------------------------------------------------

let _cachedApiKeyId: string | null = null;
let _cachedPrivateKeyPem: string | null = null;

function getCredentials(): { apiKeyId: string; privateKeyPem: string } {
  if (_cachedApiKeyId && _cachedPrivateKeyPem) {
    return { apiKeyId: _cachedApiKeyId, privateKeyPem: _cachedPrivateKeyPem };
  }
  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  if (!apiKeyId) throw new Error("KALSHI_API_KEY_ID is not set");

  const pemPath = process.env.KALSHI_PRIVATE_KEY_PEM_PATH;
  if (!pemPath) throw new Error("KALSHI_PRIVATE_KEY_PEM_PATH is not set");

  const privateKeyPem = fs.readFileSync(pemPath, "utf-8");
  _cachedApiKeyId = apiKeyId;
  _cachedPrivateKeyPem = privateKeyPem;
  return { apiKeyId, privateKeyPem };
}

// ---------------------------------------------------------------------------
// RSA-PSS request signing
// ---------------------------------------------------------------------------

function buildAuthHeaders(
  method: string,
  urlPath: string, // e.g. "/trade-api/v2/portfolio/balance" — NO query string
  privateKeyPem: string,
  apiKeyId: string,
): Record<string, string> {
  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + urlPath;

  const signer = crypto.createSign("SHA256");
  signer.update(message);
  const signature = signer.sign(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    "base64",
  );

  return {
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

// ---------------------------------------------------------------------------
// Core fetch helper
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const PATH_PREFIX = "/trade-api/v2";

async function kalshiFetch(
  method: string,
  endpoint: string,        // e.g. "/portfolio/balance"
  body?: unknown,
  queryParams?: Record<string, string>,
): Promise<unknown> {
  const { apiKeyId, privateKeyPem } = getCredentials();

  const urlPath = PATH_PREFIX + endpoint; // signed path — no query string
  let fullUrl = BASE_URL + endpoint;
  if (queryParams && Object.keys(queryParams).length > 0) {
    fullUrl += "?" + new URLSearchParams(queryParams).toString();
  }

  const authHeaders = buildAuthHeaders(method, urlPath, privateKeyPem, apiKeyId);

  const res = await fetch(fullUrl, {
    method,
    headers: {
      ...authHeaders,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    let code = "unknown";
    let message = `HTTP ${res.status} from ${endpoint}`;
    let retryAfterMs: number | null = null;

    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const asNum = Number(retryAfter);
      if (Number.isFinite(asNum) && asNum >= 0) {
        retryAfterMs = Math.floor(asNum * 1000);
      } else {
        const asDate = Date.parse(retryAfter);
        if (Number.isFinite(asDate)) {
          retryAfterMs = Math.max(0, asDate - Date.now());
        }
      }
    }

    try {
      const errBody = (await res.json()) as { code?: string; message?: string };
      console.error(`[kalshi-api] ${res.status} error body:`, JSON.stringify(errBody));
      if (errBody.code) code = errBody.code;
      if (errBody.message) message = errBody.message;
    } catch {
      // ignore JSON parse failure
    }
    throw new KalshiApiError(res.status, code, message, retryAfterMs);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Exported API functions
// ---------------------------------------------------------------------------

export async function getBalance(): Promise<KalshiBalance> {
  return (await kalshiFetch("GET", "/portfolio/balance")) as KalshiBalance;
}

export async function getPositions(): Promise<KalshiPosition[]> {
  const data = (await kalshiFetch("GET", "/portfolio/positions")) as {
    positions: KalshiPosition[];
  };
  return data.positions ?? [];
}

export async function getOrders(status = "resting"): Promise<KalshiOrder[]> {
  const data = (await kalshiFetch("GET", "/portfolio/orders", undefined, {
    status,
  })) as { orders: KalshiOrder[] };
  return data.orders ?? [];
}

export async function createOrder(payload: CreateOrderPayload): Promise<KalshiOrder> {
  const data = (await kalshiFetch("POST", "/portfolio/orders", payload)) as {
    order: KalshiOrder;
  };
  return data.order;
}

export async function cancelOrder(orderId: string): Promise<void> {
  await kalshiFetch("DELETE", `/portfolio/orders/${orderId}`);
}

export async function cancelAllRestingOrders(): Promise<number> {
  const orders = await getOrders("resting");
  let cancelled = 0;
  for (const order of orders) {
    try {
      await cancelOrder(order.order_id);
      cancelled++;
    } catch (err) {
      console.warn(
        `[execute-kalshi] Failed to cancel ${order.order_id}: ${(err as Error).message}`,
      );
    }
  }
  return cancelled;
}
