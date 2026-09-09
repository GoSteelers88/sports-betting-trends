// site-tabs.ts — the homepage's five tabs, as data.
//
// This lived inside TabShell.tsx as a `useState` with no URL representation,
// which made every tab unlinkable: /nfl (and any other page, and any bookmark,
// and any share) could only ever point at "tonight". The tab id is now the URL
// fragment, so `/#props` opens the props desk and survives a refresh.
//
// The parsing lives here rather than in the client component so it can be
// tested without a DOM, and so a link builder on the SERVER can produce hrefs
// from the same list the client reads.

export type Tab =
  | "tonight"
  | "the-desk"
  | "props"
  | "experiments"
  | "operations";

export const TABS: ReadonlyArray<{ id: Tab; num: string; label: string }> = [
  { id: "tonight", num: "T1", label: "Tonight" },
  { id: "the-desk", num: "T2", label: "The Desk" },
  { id: "props", num: "T3", label: "Props" },
  { id: "experiments", num: "T4", label: "Experiments" },
  { id: "operations", num: "T5", label: "Operations" },
];

export const DEFAULT_TAB: Tab = "tonight";

const IDS: ReadonlySet<string> = new Set(TABS.map((t) => t.id));

export function isTab(x: unknown): x is Tab {
  return typeof x === "string" && IDS.has(x);
}

/** A location fragment → the tab it selects, or null for anything else.
 *
 *  Null, not DEFAULT_TAB: `/#nfl-week` is a deep link to a SECTION inside the
 *  tonight tab, and answering "tonight" for it would be indistinguishable from
 *  answering "tonight" for `/#tonight`. The caller keeps whatever tab it has
 *  when this returns null, so an unknown anchor never resets the view.
 *
 *  Accepts "#props", "props", "#/props" and a full URL's hash, and ignores a
 *  trailing query or nested fragment. Case-insensitive: a hash typed by hand
 *  is not case-normalized by the browser. */
export function parseTabHash(hash: string | null | undefined): Tab | null {
  if (!hash) return null;
  let raw = hash.trim();
  const hashAt = raw.indexOf("#");
  if (hashAt >= 0) raw = raw.slice(hashAt + 1);
  raw = raw.replace(/^\/+/, "").split(/[?&#]/)[0] ?? "";
  let id: string;
  try {
    id = decodeURIComponent(raw).toLowerCase();
  } catch {
    // A malformed escape ("%E0%A4%A") throws URIError. A bad fragment is not
    // an error condition for a nav rail — it is simply not a tab.
    return null;
  }
  return isTab(id) ? id : null;
}

/** The canonical href for a tab, from any page on the site. */
export function tabHref(id: Tab): string {
  return `/#${id}`;
}
