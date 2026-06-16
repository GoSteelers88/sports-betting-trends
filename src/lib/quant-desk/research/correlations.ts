// quant-desk/research/correlations.ts — the Smartodds/Starlizard DATA-FLOOR
// step #2: over the accumulated data, scan for NEW candidate predictors.
//
// We compute the correlation between each available feature and:
//   (a) the OUTCOME (did the bet win? did the home team win?), and
//   (b) the MODEL'S OWN RESIDUAL (modelFairProb − outcome) — where is the model
//       SYSTEMATICALLY WRONG? A feature that correlates with our residual is the
//       most valuable kind of discovery: it points straight at a model bias.
//
// Every candidate is ranked by |correlation| with a significance test (two-sided
// t on r·sqrt((n−2)/(1−r²))). The strongest become model-improvement HYPOTHESES.
//
// QUARANTINE DISCIPLINE (López de Prado): these are HYPOTHESES, never auto-applied.
// Each carries an explicit out-of-sample validation plan and is logged, not wired
// into the live rule. The live model NEVER changes from in-sample mining here.
//
// All math is pure + tested. No I/O in the math; the runner reads the data.

export interface Sample {
  /** Numeric features available at decision time (pre-outcome). */
  features: Record<string, number>;
  /** The realized binary outcome (1 = the modeled side hit, 0 = it didn't). */
  outcome: number;
  /** OUR model's fair probability for that side at decision time, if available.
   *  residual = modelFairProb − outcome (signed model error). */
  modelFairProb?: number;
}

export interface CandidateFeature {
  feature: string;
  n: number;
  /** Pearson r between the feature and the binary outcome. */
  rOutcome: number | null;
  /** Pearson r between the feature and the model residual (model error). */
  rResidual: number | null;
  /** Two-sided p-value for the larger-|r| of the two (the headline). */
  pValue: number | null;
  /** |r| used for ranking (max of the two, by magnitude). */
  absR: number;
  /** Which target the headline r refers to. */
  target: "outcome" | "residual";
  significant: boolean; // p < 0.05 AND n ≥ MIN_N
  /** The pre-registered out-of-sample validation plan for THIS hypothesis. */
  validationPlan: string;
}

export interface CorrelationScan {
  generatedAt: string;
  nSamples: number;
  /** Candidate features ranked by |correlation|, strongest first. */
  candidates: CandidateFeature[];
  /** The subset that cleared significance — the promotable hypotheses. */
  hypotheses: CandidateFeature[];
  note: string;
}

// Below this sample size we don't trust a correlation at all (data-mining noise).
export const MIN_N = 30;
const SIG_P = 0.05;

// ─────────────────────────────────────────────────────────────────────────────
// Pure stats.
// ─────────────────────────────────────────────────────────────────────────────

/** Pearson correlation of two equal-length numeric vectors. null when n<3 or a
 *  vector has zero variance (correlation undefined). */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  const r = cov / Math.sqrt(vx * vy);
  return Math.max(-1, Math.min(1, r));
}

/** Two-sided p-value for a Pearson r at sample size n, via the t-statistic
 *  t = r·sqrt((n−2)/(1−r²)) and a Student-t survival approximation. */
export function correlationPValue(r: number, n: number): number | null {
  if (n < 3) return null;
  if (Math.abs(r) >= 1) return 0;
  const df = n - 2;
  const t = Math.abs(r) * Math.sqrt(df / (1 - r * r));
  return 2 * studentTSf(t, df);
}

// Student-t upper-tail survival function via the regularized incomplete beta.
// Accurate enough for a research significance screen (we only need p<0.05-ish).
function studentTSf(t: number, df: number): number {
  const x = df / (df + t * t);
  // P(T > t) = 0.5 · I_x(df/2, 1/2) for t > 0.
  return 0.5 * regularizedIncompleteBeta(x, df / 2, 0.5);
}

// Regularized incomplete beta I_x(a,b) via Lentz's continued fraction (NR-style).
// The CF for betacf converges only for x < (a+1)/(a+b+2); outside that range we
// use the reflection I_x(a,b) = 1 − I_{1−x}(b,a) so the CF always runs on the
// convergent side.
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(x, a, b)) / a;
  }
  // Reflection: I_x(a,b) = 1 − I_{1−x}(b,a). front is symmetric in (a,b)↔(1−x,x)
  // up to the /b normalization on the reflected call.
  return 1 - (front * betacf(1 - x, b, a)) / b;
}

// Lentz's continued fraction for the incomplete beta (Numerical Recipes betacf).
function betacf(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-10) break;
  }
  return h;
}

const LG_C = [
  76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
];
function lnGamma(x: number): number {
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += LG_C[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// ─────────────────────────────────────────────────────────────────────────────
// The scan.
// ─────────────────────────────────────────────────────────────────────────────

/** Discover candidate predictors across `samples`. For each feature that appears
 *  in ≥MIN_N samples, correlate it with the outcome and the model residual.
 *  Pure given the samples. */
export function scanCorrelations(samples: Sample[]): CorrelationScan {
  const featureNames = new Set<string>();
  for (const s of samples) for (const k of Object.keys(s.features)) featureNames.add(k);

  const candidates: CandidateFeature[] = [];

  for (const feature of featureNames) {
    // Pair feature with outcome (drop samples missing the feature).
    const fOut: number[] = [];
    const out: number[] = [];
    const fRes: number[] = [];
    const res: number[] = [];
    for (const s of samples) {
      const v = s.features[feature];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      fOut.push(v);
      out.push(s.outcome);
      if (typeof s.modelFairProb === "number" && Number.isFinite(s.modelFairProb)) {
        fRes.push(v);
        res.push(s.modelFairProb - s.outcome); // signed model error
      }
    }
    const n = fOut.length;
    if (n < 3) continue;

    const rOutcome = pearson(fOut, out);
    const rResidual = fRes.length >= 3 ? pearson(fRes, res) : null;

    const absOut = rOutcome == null ? 0 : Math.abs(rOutcome);
    const absRes = rResidual == null ? 0 : Math.abs(rResidual);
    const target: "outcome" | "residual" = absRes > absOut ? "residual" : "outcome";
    const headlineR = target === "residual" ? rResidual : rOutcome;
    const headlineN = target === "residual" ? fRes.length : n;
    const absR = Math.max(absOut, absRes);
    const pValue = headlineR != null ? correlationPValue(headlineR, headlineN) : null;
    const significant = pValue != null && pValue < SIG_P && headlineN >= MIN_N;

    candidates.push({
      feature,
      n: headlineN,
      rOutcome: rOutcome == null ? null : +rOutcome.toFixed(4),
      rResidual: rResidual == null ? null : +rResidual.toFixed(4),
      pValue: pValue == null ? null : +pValue.toFixed(5),
      absR: +absR.toFixed(4),
      target,
      significant,
      validationPlan:
        target === "residual"
          ? `HYPOTHESIS (quarantined): '${feature}' correlates with the model RESIDUAL — the model may be systematically wrong as '${feature}' moves. VALIDATE out-of-sample before any use: split the log chronologically, refit/adjust on the EARLIER half only, then test the correlation holds (same sign, p<0.05) on the held-out LATER half. Promote into the model only if it survives; never apply the in-sample fit.`
          : `HYPOTHESIS (quarantined): '${feature}' correlates with OUTCOME but the model may already price it. VALIDATE out-of-sample: confirm the correlation persists on a held-out later window AND that adding '${feature}' improves CLV beat-rate on that window. Promote only on a passing holdout; never auto-apply.`,
    });
  }

  candidates.sort((a, b) => b.absR - a.absR);
  const hypotheses = candidates.filter((c) => c.significant);

  return {
    generatedAt: new Date().toISOString(),
    nSamples: samples.length,
    candidates,
    hypotheses,
    note:
      samples.length < MIN_N
        ? `Only ${samples.length} samples — below the n≥${MIN_N} floor for trusting ANY correlation. Candidates shown are noise until the log grows; no hypothesis is promotable yet.`
        : `${hypotheses.length} candidate(s) cleared p<${SIG_P} at n≥${MIN_N}. All are QUARANTINED hypotheses pending out-of-sample validation — the live model is unchanged.`,
  };
}
