const store = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, limit = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true; // allowed
  }
  if (entry.count >= limit) return false; // blocked
  entry.count++;
  return true;
}
