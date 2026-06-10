/**
 * peadWatchdog.ts — post-cycle health checks + entry annotation for the PEAD
 * paper book (Experiment No. 3).
 *
 * Two jobs, both OUTSIDE the trading rule (PEAD_PAPER_SPEC.md stays frozen):
 *  1. Deterministic reconciliation — does our book of record match the actual
 *     Alpaca paper account? Are exits stuck? Are benchmark legs missing?
 *  2. Annotation — a label-only Claude pass over new entries (artifact risk +
 *     note), stored on the row for verdict-time analysis. Never a veto: the
 *     book trades the rule regardless of what the annotator thinks.
 */
import { prisma } from "@/lib/prisma";
import { alpacaConfigured, listPositions } from "@/lib/stocks/alpaca";
import { getAnthropic, MODELS } from "@/lib/agent/client";

export interface BookOpenRow {
  symbol: string;
  qty: number;
  exitDue: string; // ISO
  entrySpy: number | null;
}

export interface BrokerPosition {
  symbol: string;
  qty: number;
}

const QTY_TOLERANCE = 0.01; // 1% relative — fractional fills round
const EXIT_OVERDUE_MS = 24 * 60 * 60 * 1000; // a full day past exitDue = stuck

/**
 * Pure reconciliation of the book of record against the broker's positions.
 * Returns human-readable issue strings; empty array = healthy.
 */
export function reconcile(
  bookOpen: BookOpenRow[],
  broker: BrokerPosition[],
  now: Date,
): string[] {
  const issues: string[] = [];
  const brokerBySymbol = new Map(broker.map((p) => [p.symbol, p.qty]));
  const bookSymbols = new Set(bookOpen.map((r) => r.symbol));

  for (const row of bookOpen) {
    const held = brokerBySymbol.get(row.symbol);
    if (held == null) {
      issues.push(`${row.symbol}: open in book but NOT held in Alpaca`);
    } else if (Math.abs(held - row.qty) > QTY_TOLERANCE * Math.max(row.qty, held)) {
      issues.push(`${row.symbol}: qty mismatch — book ${row.qty}, Alpaca ${held}`);
    }
    if (Number.isFinite(Date.parse(row.exitDue)) && now.getTime() - Date.parse(row.exitDue) > EXIT_OVERDUE_MS) {
      issues.push(`${row.symbol}: exit overdue since ${row.exitDue.slice(0, 10)} — sell not filling?`);
    }
    if (row.entrySpy == null) {
      issues.push(`${row.symbol}: missing SPY benchmark leg at entry`);
    }
  }

  for (const p of broker) {
    if (!bookSymbols.has(p.symbol)) {
      issues.push(`${p.symbol}: held in Alpaca (qty ${p.qty}) but not in the book — orphan`);
    }
  }

  return issues;
}

export interface Annotation {
  artifactRisk: "low" | "medium" | "high";
  revenueConfirmed: boolean | null; // deterministic — computed here, not by the LLM
  note: string;
}

/** Deterministic part of the annotation: did revenue also beat? */
export function revenueConfirmed(revEstimate: number | null, revActual: number | null): boolean | null {
  if (revEstimate == null || revActual == null || revEstimate <= 0) return null;
  return revActual >= revEstimate;
}

const ANNOTATOR_SYSTEM = `You label entries in a pre-registered post-earnings-drift paper-trading experiment. For each entry, assess the risk that the reported EPS "surprise" is a DATA ARTIFACT rather than a real earnings beat. Known artifact causes: GAAP-vs-non-GAAP consensus mismatch (actual on a different basis than the estimate), stale or single-analyst estimates, one-time items (tax benefits, asset sales) inflating EPS, and tiny estimate denominators exaggerating percentages.

Respond with ONLY a JSON object, no prose: {"artifactRisk": "low"|"medium"|"high", "note": "<one sentence>"}.

Be conservative: a large surprise (>100%) on a small estimate, or EPS beating hugely while revenue misses, deserves "medium" or "high". A modest beat confirmed by revenue is "low".`;

/** Annotate up to `limit` un-annotated rows. Fail-soft: errors leave rows null for retry next run. */
export async function annotateNewEntries(limit = 10): Promise<number> {
  const rows = await prisma.stockPaperPosition.findMany({
    where: { annotation: null },
    orderBy: { id: "asc" },
    take: limit,
  });
  if (rows.length === 0) return 0;

  const client = getAnthropic();
  let annotated = 0;
  for (const row of rows) {
    try {
      const facts = {
        symbol: row.symbol,
        reportDate: row.reportDate,
        epsEstimate: row.epsEstimate,
        epsActual: row.epsActual,
        surprisePct: +row.surprisePct.toFixed(1),
        revenueEstimate: row.revEstimate,
        revenueActual: row.revActual,
        entryPrice: row.entryPrice,
      };
      const response = await client.messages.create({
        model: MODELS.annotator,
        max_tokens: 256,
        system: ANNOTATOR_SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(facts) }],
      });
      const text = response.content
        .filter((b): b is { type: "text"; text: string } & typeof b => b.type === "text")
        .map((b) => b.text)
        .join("");
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) continue; // unparseable — retry next run
      const parsed = JSON.parse(match[0]);
      if (!["low", "medium", "high"].includes(parsed.artifactRisk)) continue;
      const annotation: Annotation = {
        artifactRisk: parsed.artifactRisk,
        revenueConfirmed: revenueConfirmed(row.revEstimate, row.revActual),
        note: String(parsed.note ?? "").slice(0, 300),
      };
      await prisma.stockPaperPosition.update({
        where: { id: row.id },
        data: { annotation: JSON.stringify(annotation) },
      });
      annotated++;
    } catch (err) {
      console.warn(`[pead-watchdog] annotate failed for ${row.symbol}: ${(err as Error).message}`);
    }
  }
  return annotated;
}

export interface WatchdogResult {
  issues: string[];
  annotated: number;
  openCount: number;
  reconciled: boolean; // false when Alpaca creds were unavailable
}

export async function runWatchdog(now = new Date()): Promise<WatchdogResult> {
  const open = await prisma.stockPaperPosition.findMany({ where: { status: "open" } });

  let issues: string[] = [];
  let reconciled = false;
  if (alpacaConfigured()) {
    try {
      const broker = await listPositions();
      issues = reconcile(
        open.map((r) => ({ symbol: r.symbol, qty: r.qty, exitDue: r.exitDue, entrySpy: r.entrySpy })),
        broker,
        now,
      );
      reconciled = true;
    } catch (err) {
      issues = [`reconciliation failed: ${(err as Error).message}`];
    }
  }

  const annotated = process.env.ANTHROPIC_API_KEY ? await annotateNewEntries() : 0;

  return { issues, annotated, openCount: open.length, reconciled };
}
