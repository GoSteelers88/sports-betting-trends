export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function midpoint(bid: number, ask: number): number {
  return clamp01((bid + ask) / 2);
}

export function spread(bid: number, ask: number): number {
  return clamp01(ask - bid);
}

export function logNorm(x: number, max: number): number {
  if (x <= 0 || max <= 0) return 0;
  return Math.min(1, Math.log(1 + x) / Math.log(1 + max));
}
