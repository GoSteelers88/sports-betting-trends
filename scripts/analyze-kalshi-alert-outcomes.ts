import fs from "node:fs";
import path from "node:path";

type BucketKey = "5-8" | "8-12" | "12+";

interface DriftStats {
  count: number;
  avgBp: number | null;
  medianBp: number | null;
  p10Bp: number | null;
  p90Bp: number | null;
}

interface BucketSummary {
  bucket: BucketKey;
  count: number;
  avgGapPct: number | null;
  medianGapPct: number | null;
  drift30m: DriftStats;
  driftPreClose: DriftStats;
  resolved: {
    count: number;
    hitRate: number | null;
    brier: number | null;
  };
}

interface MarketSeriesPoint {
  ts: number;
  impliedPct: number;
  modelPct: number;
}

interface MarketSeries {
  marketId: string;
  points: MarketSeriesPoint[];
  lastResolution?: boolean;
}

const ROOT = path.resolve(__dirname, "..");
const PROCESSED_DIR = path.join(ROOT, "data", "processed");
const ALERTS_PATH = path.join(PROCESSED_DIR, "kalshi-alerts.jsonl");
const OUT_PATH = path.join(PROCESSED_DIR, "kalshi-edge-review.json");

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function tsFromAny(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(vals: number[]): number | null {
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

function mean(vals: number[]): number | null {
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function bucketForGap(absGapPct: number): BucketKey | null {
  if (absGapPct >= 12) return "12+";
  if (absGapPct >= 8) return "8-12";
  if (absGapPct >= 5) return "5-8";
  return null;
}

function getByPath(obj: any, paths: string[]): unknown {
  for (const p of paths) {
    const parts = p.split(".");
    let cur: any = obj;
    for (const part of parts) cur = cur?.[part];
    if (cur !== undefined && cur !== null) return cur;
  }
  return null;
}

function normalizeRecord(raw: any) {
  const ts = tsFromAny(getByPath(raw, ["ts", "timestamp", "fetchedAtIsoUtc", "at"]));
  const marketId =
    (getByPath(raw, ["marketId", "ticker", "market_id", "id"]) as string | null) ?? null;

  const impliedPct = toNum(
    getByPath(raw, [
      "kalshiImpliedPct",
      "impliedPct",
      "crossEdge.kalshiImpliedPct",
      "crossEdge.kalshiImplied",
      "kalshi.impliedPct",
      "implied",
    ]),
  );

  const modelPct = toNum(
    getByPath(raw, [
      "modelConfidencePct",
      "modelPct",
      "crossEdge.modelConfidence",
      "crossEdge.modelPct",
      "model.confidencePct",
      "model",
    ]),
  );

  const resolutionVal = getByPath(raw, ["resolvedYes", "resolution", "resolved", "resultYes"]);
  const resolvedYes =
    typeof resolutionVal === "boolean"
      ? resolutionVal
      : typeof resolutionVal === "number"
        ? resolutionVal >= 0.5
        : null;

  if (!ts || !marketId || impliedPct === null || modelPct === null) return null;
  return { ts, marketId, impliedPct, modelPct, resolvedYes };
}

function calcDrift(base: MarketSeriesPoint, later: MarketSeriesPoint): number {
  // drift in basis points, positive = market moved toward model from base point
  const baseGap = base.modelPct - base.impliedPct;
  const laterGap = base.modelPct - later.impliedPct;
  return (Math.abs(baseGap) - Math.abs(laterGap)) * 100;
}

function driftStats(values: number[]): DriftStats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    avgBp: mean(values),
    medianBp: percentile(sorted, 0.5),
    p10Bp: percentile(sorted, 0.1),
    p90Bp: percentile(sorted, 0.9),
  };
}

function round(v: number | null, places = 2): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function main() {
  if (!fs.existsSync(ALERTS_PATH)) {
    throw new Error(`Missing ${ALERTS_PATH}`);
  }

  const text = fs.readFileSync(ALERTS_PATH, "utf-8");
  const lines = text.split(/\r?\n/).filter(Boolean);

  const byMarket = new Map<string, MarketSeries>();

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    const n = normalizeRecord(raw);
    if (!n) continue;

    if (!byMarket.has(n.marketId)) {
      byMarket.set(n.marketId, { marketId: n.marketId, points: [] });
    }
    const series = byMarket.get(n.marketId)!;
    series.points.push({ ts: n.ts, impliedPct: n.impliedPct, modelPct: n.modelPct });
    if (n.resolvedYes !== null) series.lastResolution = n.resolvedYes;
  }

  const bucketState: Record<BucketKey, {
    gaps: number[];
    drift30m: number[];
    driftPreClose: number[];
    resolvedPred: number[];
    resolvedActual: number[];
  }> = {
    "5-8": { gaps: [], drift30m: [], driftPreClose: [], resolvedPred: [], resolvedActual: [] },
    "8-12": { gaps: [], drift30m: [], driftPreClose: [], resolvedPred: [], resolvedActual: [] },
    "12+": { gaps: [], drift30m: [], driftPreClose: [], resolvedPred: [], resolvedActual: [] },
  };

  let seriesCount = 0;

  for (const series of byMarket.values()) {
    if (!series.points.length) continue;
    series.points.sort((a, b) => a.ts - b.ts);

    const first = series.points[0];
    const absGap = Math.abs(first.modelPct - first.impliedPct);
    const bucket = bucketForGap(absGap);
    if (!bucket) continue;

    seriesCount += 1;
    bucketState[bucket].gaps.push(absGap);

    const targetTs = first.ts + 30 * 60 * 1000;
    const at30m = series.points.find((p) => p.ts >= targetTs);
    if (at30m) {
      bucketState[bucket].drift30m.push(calcDrift(first, at30m));
    }

    const last = series.points[series.points.length - 1];
    if (last.ts > first.ts) {
      bucketState[bucket].driftPreClose.push(calcDrift(first, last));
    }

    if (series.lastResolution !== undefined) {
      bucketState[bucket].resolvedPred.push(first.modelPct / 100);
      bucketState[bucket].resolvedActual.push(series.lastResolution ? 1 : 0);
    }
  }

  const buckets: BucketSummary[] = (Object.keys(bucketState) as BucketKey[]).map((bucket) => {
    const b = bucketState[bucket];
    const brierVals = b.resolvedPred.map((p, i) => (p - b.resolvedActual[i]) ** 2);

    const hitRate =
      b.resolvedActual.length > 0 ? b.resolvedActual.reduce((a, c) => a + c, 0) / b.resolvedActual.length : null;

    return {
      bucket,
      count: b.gaps.length,
      avgGapPct: round(mean(b.gaps)),
      medianGapPct: round(median(b.gaps)),
      drift30m: {
        ...driftStats(b.drift30m),
        avgBp: round(driftStats(b.drift30m).avgBp),
        medianBp: round(driftStats(b.drift30m).medianBp),
        p10Bp: round(driftStats(b.drift30m).p10Bp),
        p90Bp: round(driftStats(b.drift30m).p90Bp),
      },
      driftPreClose: {
        ...driftStats(b.driftPreClose),
        avgBp: round(driftStats(b.driftPreClose).avgBp),
        medianBp: round(driftStats(b.driftPreClose).medianBp),
        p10Bp: round(driftStats(b.driftPreClose).p10Bp),
        p90Bp: round(driftStats(b.driftPreClose).p90Bp),
      },
      resolved: {
        count: b.resolvedActual.length,
        hitRate: round(hitRate, 4),
        brier: round(mean(brierVals), 4),
      },
    };
  });

  const out = {
    generatedAtIsoUtc: new Date().toISOString(),
    source: path.relative(ROOT, ALERTS_PATH),
    linesRead: lines.length,
    marketSeriesCount: seriesCount,
    buckets,
    notes: [
      "Drift metrics are in basis points of edge compression from first-seen snapshot (positive = moved toward model).",
      "Resolved stats depend on resolution fields present in kalshi-alerts.jsonl records.",
    ],
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf-8");
  console.log(`[kalshi] edge-review written: ${OUT_PATH}`);
  console.log(`[kalshi] lines read: ${lines.length}, market series: ${seriesCount}`);
}

main();
