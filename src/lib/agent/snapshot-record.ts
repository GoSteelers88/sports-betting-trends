// Structured record of the ModelPickSnapshot corpus for the weekly dream.
//
// WHY THIS EXISTS: dream() used to hand the LLM `{total, wins, losses}` — three
// integers standing in for thousands of graded rows — while 72% of the payload
// was the agent's own existing rules. The dream was therefore reasoning almost
// entirely over its own prior conclusions, with the one input that has real
// statistical power compressed past the point of saying anything.
//
// Everything here is computed in PURE CODE from graded rows. The calibration
// tables in particular are the frozen anchor: predicted edge/confidence against
// realized win rate is arithmetic the LLM cannot talk its way around.
//
// Aggregates only — never raw rows. The corpus is thousands of rows; the point
// is to spend tokens on structure with an n attached, not on volume.

export type SnapshotRow = {
  source: string;
  league: string;
  market: string;
  propType?: string | null;
  selection?: string | null;
  edge?: number | null;
  confidence?: number | null;
  result?: string | null;
  line?: number | null;
  actualValue?: number | null;
};

export type Tally = { n: number; wins: number; losses: number; pushes: number; winRatePct: number | null };

export type CalibrationBucket = {
  bucket: string;
  n: number;
  meanPredictedPct: number | null;
  realizedWinRatePct: number | null;
  gapPp: number | null;
};

export type PropVsActual = {
  propType: string;
  n: number;
  overPicks: number;
  underPicks: number;
  hitRatePct: number | null;
  meanMarginVsLine: number | null;
  meanAbsMarginVsLine: number | null;
};

// A calibration table is only meaningful if the predicted field actually varies.
// The prop logger stamps a constant confidence on every row and never sets edge,
// which would render a spectacular-looking "gap" that is an artifact of the
// constant, not a property of any model. Say so in the payload instead.
export type FieldQuality = {
  field: string;
  usableForCalibration: boolean;
  note: string;
};

export type SnapshotRecord = {
  windowNote: string;
  fieldQuality: FieldQuality[];
  totals: Tally;
  bySourceLeague: Array<{ source: string; league: string } & Tally>;
  byMarket: Array<{ source: string; market: string } & Tally>;
  edgeCalibration: CalibrationBucket[];
  confidenceCalibration: CalibrationBucket[];
  propsVsActual: PropVsActual[];
};

const DECISIVE = new Set(["win", "loss"]);

function tally(rows: SnapshotRow[]): Tally {
  let wins = 0, losses = 0, pushes = 0;
  for (const r of rows) {
    if (r.result === "win") wins++;
    else if (r.result === "loss") losses++;
    else if (r.result === "push" || r.result === "void") pushes++;
  }
  const decisive = wins + losses;
  return {
    n: rows.length,
    wins,
    losses,
    pushes,
    // Win rate is over DECISIVE rows only — counting pushes in the denominator
    // silently drags every rate toward zero and makes buckets incomparable.
    winRatePct: decisive === 0 ? null : round1((wins / decisive) * 100),
  };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const cur = m.get(k);
    if (cur) cur.push(r); else m.set(k, [r]);
  }
  return m;
}

// Edge arrives as a fraction (0.0712 = 7.12%). Buckets straddle the 6% grader
// floor so the dream can see whether the floor is where the edge actually is.
const EDGE_BUCKETS: Array<{ label: string; lo: number; hi: number }> = [
  { label: "<0%", lo: -Infinity, hi: 0 },
  { label: "0-2%", lo: 0, hi: 0.02 },
  { label: "2-4%", lo: 0.02, hi: 0.04 },
  { label: "4-6%", lo: 0.04, hi: 0.06 },
  { label: "6-8%", lo: 0.06, hi: 0.08 },
  { label: "8-10%", lo: 0.08, hi: 0.10 },
  { label: ">=10%", lo: 0.10, hi: Infinity },
];

const CONF_BUCKETS: Array<{ label: string; lo: number; hi: number }> = [
  { label: "<50", lo: -Infinity, hi: 50 },
  { label: "50-59", lo: 50, hi: 60 },
  { label: "60-69", lo: 60, hi: 70 },
  { label: "70-79", lo: 70, hi: 80 },
  { label: "80-89", lo: 80, hi: 90 },
  { label: ">=90", lo: 90, hi: Infinity },
];

function calibrate(
  rows: SnapshotRow[],
  value: (r: SnapshotRow) => number | null | undefined,
  buckets: Array<{ label: string; lo: number; hi: number }>,
  toPct: (v: number) => number
): CalibrationBucket[] {
  const out: CalibrationBucket[] = [];
  for (const b of buckets) {
    const inB = rows.filter(r => {
      const v = value(r);
      return v != null && Number.isFinite(v) && v >= b.lo && v < b.hi;
    });
    const decisive = inB.filter(r => DECISIVE.has(r.result ?? ""));
    if (inB.length === 0) continue;
    const meanPredicted = decisive.length
      ? round1(decisive.reduce((a, r) => a + toPct(value(r) as number), 0) / decisive.length)
      : null;
    const t = tally(inB);
    out.push({
      bucket: b.label,
      n: decisive.length,
      meanPredictedPct: meanPredicted,
      realizedWinRatePct: t.winRatePct,
      // Positive gap = the model was OPTIMISTIC in this bucket. Null when the
      // bucket has no decisive rows to compare against.
      gapPp:
        meanPredicted != null && t.winRatePct != null
          ? round1(t.winRatePct - meanPredicted)
          : null,
    });
  }
  return out;
}

function sideOf(selection: string | null | undefined): "over" | "under" | null {
  if (!selection) return null;
  if (/\bover\b/i.test(selection)) return "over";
  if (/\bunder\b/i.test(selection)) return "under";
  return null;
}

// Props vs what actually happened: the realized value against the line the pick
// was taken at. meanMarginVsLine is signed IN THE DIRECTION OF THE PICK, so a
// negative mean says the picks systematically landed on the wrong side.
function propsVsActual(rows: SnapshotRow[]): PropVsActual[] {
  const props = rows.filter(r => r.actualValue != null && r.line != null);
  const out: PropVsActual[] = [];
  for (const [propType, group] of groupBy(props, r => r.propType || r.market)) {
    let over = 0, under = 0;
    const margins: number[] = [];
    for (const r of group) {
      const side = sideOf(r.selection);
      if (side === "over") over++;
      else if (side === "under") under++;
      const raw = (r.actualValue as number) - (r.line as number);
      margins.push(side === "under" ? -raw : raw);
    }
    const t = tally(group);
    out.push({
      propType,
      n: group.length,
      overPicks: over,
      underPicks: under,
      hitRatePct: t.winRatePct,
      meanMarginVsLine: margins.length ? round2(margins.reduce((a, b) => a + b, 0) / margins.length) : null,
      meanAbsMarginVsLine: margins.length ? round2(margins.reduce((a, b) => a + Math.abs(b), 0) / margins.length) : null,
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

// Is this field varied enough to calibrate against? A field that is null
// everywhere, or pinned to one value on >=95% of rows, carries no signal.
function assessField(
  rows: SnapshotRow[],
  field: string,
  value: (r: SnapshotRow) => number | null | undefined
): FieldQuality {
  const present = rows.map(value).filter(v => v != null && Number.isFinite(v)) as number[];
  if (present.length === 0) {
    return { field, usableForCalibration: false, note: `never set (null on all ${rows.length} graded rows) — no calibration possible` };
  }
  const counts = new Map<number, number>();
  for (const v of present) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [topValue, topCount] = [...counts].sort((a, b) => b[1] - a[1])[0];
  const share = topCount / present.length;
  if (share >= 0.95) {
    return {
      field,
      usableForCalibration: false,
      note:
        `effectively CONSTANT — ${topValue} on ${topCount}/${present.length} rows ` +
        `(${round1(share * 100)}%). Any gap shown against realized results is an ` +
        `artifact of that constant, NOT evidence about a model's confidence. ` +
        `Do not write a calibration rule from it; the finding is that the field is unset.`,
    };
  }
  return { field, usableForCalibration: true, note: `${counts.size} distinct values across ${present.length} rows` };
}

export function buildSnapshotRecord(rows: SnapshotRow[], windowNote: string): SnapshotRecord {
  const graded = rows.filter(r => r.result != null && r.result !== "pending");
  return {
    windowNote,
    fieldQuality: [
      assessField(graded, "edge", r => r.edge),
      assessField(graded, "confidence", r => r.confidence),
    ],
    totals: tally(graded),
    bySourceLeague: [...groupBy(graded, r => `${r.source}|${r.league}`)]
      .map(([k, g]) => {
        const [source, league] = k.split("|");
        return { source, league, ...tally(g) };
      })
      .sort((a, b) => b.n - a.n),
    byMarket: [...groupBy(graded, r => `${r.source}|${r.market}`)]
      .map(([k, g]) => {
        const [source, market] = k.split("|");
        return { source, market, ...tally(g) };
      })
      .sort((a, b) => b.n - a.n),
    edgeCalibration: calibrate(graded, r => r.edge, EDGE_BUCKETS, v => v * 100),
    confidenceCalibration: calibrate(graded, r => r.confidence, CONF_BUCKETS, v => v),
    propsVsActual: propsVsActual(graded),
  };
}
