// site-nav.ts — the site's four routes, as data, plus the legacy-hash map.
//
// Replaces site-tabs.ts. The homepage used to be five hash tabs (`/#props`
// opened the props desk); those are real routes now, and the old fragments
// still live in X posts. This module is the ONE place that knows where an
// old fragment lands. It is pure — no DOM, no window — so it is tested
// without a browser and shared by the server (link builders) and the client
// (the redirect shim mounted on "/").
//
// The map is a literal allowlist. A fragment is never concatenated into a
// URL: it is looked up, and anything not in the table is a no-op.

export type RoutePath = "/" | "/nfl" | "/experiments" | "/desk";

export interface NavEntry {
  readonly href: RoutePath;
  readonly label: string;
}

/** The header's four links, in order. Labels and order are the spec's. */
export const NAV: ReadonlyArray<NavEntry> = [
  { href: "/", label: "Today" },
  { href: "/nfl", label: "Receipts" },
  { href: "/experiments", label: "Experiments" },
  { href: "/desk", label: "Desk" },
];

export const ROUTES: ReadonlySet<string> = new Set(NAV.map((n) => n.href));

/** Old `/#fragment` → new location. Every target id exists today under the
 *  same name (no anchor renames). Keys are lowercase fragment ids. */
export const LEGACY_HASH_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  tonight: "/",
  "tonights-play": "/#today",
  "front-page": "/",
  "the-desk": "/desk",
  props: "/desk#props-desk",
  experiments: "/experiments",
  operations: "/desk#market-feed",
  "nfl-week": "/nfl#market",
  "quant-desk-section": "/desk#quant-desk-section",
  "back-of-book": "/desk#system-memory",
});

/** Anything longer than this is not a fragment anyone typed; it is abuse. */
const MAX_FRAGMENT_LENGTH = 128;

/** A location fragment → a lowercase id, or null for anything that is not
 *  one. Accepts "#props", "props", "#/props" and a full URL's hash, ignores
 *  a trailing query or nested fragment, and treats a malformed
 *  percent-escape as "not a fragment" rather than an error. */
export function normalizeFragment(hash: string | null | undefined): string | null {
  if (typeof hash !== "string") return null;
  let raw = hash.trim();
  if (raw.length === 0) return null;
  const hashAt = raw.indexOf("#");
  if (hashAt >= 0) raw = raw.slice(hashAt + 1);
  raw = raw.replace(/^\/+/, "").split(/[?&#]/)[0] ?? "";
  if (raw.length === 0 || raw.length > MAX_FRAGMENT_LENGTH) return null;
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return null;
  }
}

/** Where an old fragment lands, or null when it is not a legacy fragment.
 *  Null means "do nothing": the page is "/", which is a sane landing. */
export function legacyHashTarget(hash: string | null | undefined): string | null {
  const id = normalizeFragment(hash);
  if (id === null) return null;
  return Object.prototype.hasOwnProperty.call(LEGACY_HASH_TARGETS, id)
    ? LEGACY_HASH_TARGETS[id]
    : null;
}

/** "/desk#props-desk" → { path: "/desk", hash: "props-desk" }. */
export function splitTarget(target: string): { path: string; hash: string } {
  const at = target.indexOf("#");
  if (at < 0) return { path: target, hash: "" };
  return { path: target.slice(0, at), hash: target.slice(at + 1) };
}

/** Exact-match route activity for aria-current. "/" is active only on "/". */
export function isActiveRoute(pathname: string | null | undefined, href: RoutePath): boolean {
  if (!pathname) return false;
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return p === href;
}
