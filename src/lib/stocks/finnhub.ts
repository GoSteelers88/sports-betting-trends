/**
 * finnhub.ts — earnings-calendar client (free tier) for the PEAD book.
 * One call per cycle covers the whole calendar window.
 */
import fs from "node:fs";
import path from "node:path";
import type { EarningsReport } from "@/lib/stocks/peadLogic";

let _envLoaded = false;
function loadEnvOnce(): void {
  if (_envLoaded) return;
  _envLoaded = true;
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* ignore */
  }
}

export function finnhubConfigured(): boolean {
  loadEnvOnce();
  return Boolean(process.env.FINNHUB_API_KEY);
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Earnings reports in [from, to] (YYYY-MM-DD), with estimates and actuals. */
export async function earningsCalendar(from: string, to: string): Promise<EarningsReport[]> {
  loadEnvOnce();
  const token = process.env.FINNHUB_API_KEY ?? "";
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${token}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Finnhub earnings calendar HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return ((json.earningsCalendar ?? []) as any[]).map((r) => ({
    symbol: String(r.symbol ?? ""),
    date: String(r.date ?? ""),
    epsEstimate: num(r.epsEstimate),
    epsActual: num(r.epsActual),
    revenueEstimate: num(r.revenueEstimate),
    revenueActual: num(r.revenueActual),
  }));
}
