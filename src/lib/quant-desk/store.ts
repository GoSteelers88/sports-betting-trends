// quant-desk/store.ts — JSON-backed persistence + the read-only dashboard view.
// Mirrors devig-paper's loadBook/saveBook/getLedgerView so the Quant Desk card
// degrades to "hidden" exactly the way the other paper books do.

import fs from "node:fs";
import path from "node:path";
import { computeStats, QUANT_DESK_CONFIG, type QuantDeskConfig } from "./engine";
import { emptyBook, type QuantBook, type Sport } from "./types";

/** Book filename per sport. MLB lives in the shared processed dir (dashboard
 *  reads it); NFL lives quarantined under data/private/nfl-loop/quant/. */
export function bookFileName(sport: Sport): string {
  return `quant-desk-${sport.toLowerCase()}-book.json`;
}

export function mlbBookDir(): string {
  return path.join(process.cwd(), "data", "processed");
}

export function nflBookDir(): string {
  return path.join(process.cwd(), "data", "private", "nfl-loop", "quant");
}

export function loadBook(dir: string, sport: Sport): QuantBook {
  const p = path.join(dir, bookFileName(sport));
  if (!fs.existsSync(p)) return emptyBook();
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as QuantBook;
    return {
      updatedAt: raw.updatedAt ?? "",
      bets: raw.bets ?? [],
      ledger: raw.ledger ?? [],
    };
  } catch {
    return emptyBook();
  }
}

export function saveBook(dir: string, sport: Sport, book: QuantBook, nowIso: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, bookFileName(sport)),
    JSON.stringify({ ...book, updatedAt: nowIso }, null, 2),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only view — what the dashboard + dream consume.
// ─────────────────────────────────────────────────────────────────────────────

export interface QuantDeskView {
  stats: ReturnType<typeof computeStats>;
  config: {
    edgeFloor: number;
    kellyMultiplier: number;
    maxStakePctEquity: number;
    maxDrawdown: number;
    sport: Sport;
  };
  open: QuantBook["bets"];
  settled: QuantBook["bets"];
  equityCurve: QuantBook["ledger"];
  updatedAt: string;
  generatedAt: string;
}

export function getQuantDeskView(
  sport: Sport = "MLB",
  dir: string = mlbBookDir(),
  cfg: QuantDeskConfig = QUANT_DESK_CONFIG,
): QuantDeskView {
  const book = loadBook(dir, sport);
  const stats = computeStats(book, cfg);
  return {
    stats,
    config: {
      edgeFloor: cfg.edgeFloor,
      kellyMultiplier: cfg.kellyMultiplier,
      maxStakePctEquity: cfg.maxStakePctEquity,
      maxDrawdown: cfg.maxDrawdown,
      sport,
    },
    open: book.bets
      .filter((b) => b.status === "open")
      .sort((a, b) => b.edge - a.edge),
    settled: book.bets
      .filter((b) => b.status !== "open")
      .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""))
      .slice(0, 100),
    equityCurve: book.ledger.slice(-200),
    updatedAt: book.updatedAt,
    generatedAt: new Date().toISOString(),
  };
}
