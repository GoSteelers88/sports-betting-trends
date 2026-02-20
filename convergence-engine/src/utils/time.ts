// Time utilities

export type UnixMs = number;

export function now(): UnixMs {
  return Date.now();
}

export function hoursBetween(a: UnixMs, b: UnixMs): number {
  return Math.abs(a - b) / (60 * 60 * 1000);
}

export function daysBetween(a: UnixMs, b: UnixMs): number {
  return hoursBetween(a, b) / 24;
}

export function isSameDay(a: UnixMs, b: UnixMs): boolean {
  const d1 = new Date(a);
  const d2 = new Date(b);
  return d1.toDateString() === d2.toDateString();
}

export function toISOString(ts: UnixMs): string {
  return new Date(ts).toISOString();
}

export function parseISO(s: string): UnixMs {
  return new Date(s).getTime();
}

// Time of day utilities (ET)
export function nowET(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

export function sameDayET(a: UnixMs, b: UnixMs): boolean {
  const d1 = new Date(a).toLocaleString("en-US", { timeZone: "America/New_York" });
  const d2 = new Date(b).toLocaleString("en-US", { timeZone: "America/New_York" });
  return d1.split(",")[0] === d2.split(",")[0];
}
