// team-colors.ts — one ink per franchise, for ONE use on /nfl: the 4px left
// rule of a published PLAY card, colored to the SELECTED team.
//
// Never a fill, never behind type, never on the opponent, never in the pass
// grid. Colors alone carry no trademark; this map is never paired with a
// shape, shield, or wordmark that would reconstruct a logo.
//
// Each `ink` is the franchise primary darkened (uniform RGB scaling, hue
// preserved) until it clears WCAG AA 4.5:1 against the page ground --paper
// (#f2ede3). Values were generated, not eyeballed: the derivation is
// `contrastOnPaper()` below, and `__tests__/team-colors.test.ts` re-runs it
// over all 32 entries. `sourcePrimary` is kept so the derivation stays
// auditable — a color that drifts can be re-derived from it.
//
// Keys are exactly `Franchise.key` from ./teams.ts (all 32, lowercase
// nickname). Missing keys are a join failure, never a silent default.

export interface TeamInk {
  /** Franchise primary as published by the club. */
  sourcePrimary: string;
  /** Primary darkened to >= 4.5:1 on #f2ede3. The only value rendered. */
  ink: string;
  /** Measured contrast ratio of `ink` on #f2ede3, to 2dp. */
  ratioOnPaper: number;
}

/** The page ground these inks are measured against (--paper in globals.css). */
export const PAPER_HEX = "#f2ede3";

/** WCAG AA normal-text threshold — the gate every entry must clear. */
export const MIN_CONTRAST = 4.5;

export const TEAM_INK: Record<string, TeamInk> = {
  // ratio comments are the measured value; the test recomputes them.
  "49ers":      { sourcePrimary: "#AA0000", ink: "#AA0000", ratioOnPaper: 6.64 },
  bears:        { sourcePrimary: "#0B162A", ink: "#0B162A", ratioOnPaper: 15.48 },
  bengals:      { sourcePrimary: "#FB4F14", ink: "#C03C0F", ratioOnPaper: 4.62 },
  bills:        { sourcePrimary: "#00338D", ink: "#00338D", ratioOnPaper: 9.69 },
  broncos:      { sourcePrimary: "#FB4F14", ink: "#C03C0F", ratioOnPaper: 4.62 },
  browns:       { sourcePrimary: "#311D00", ink: "#311D00", ratioOnPaper: 13.78 },
  buccaneers:   { sourcePrimary: "#D50A0A", ink: "#D50A0A", ratioOnPaper: 4.64 },
  cardinals:    { sourcePrimary: "#97233F", ink: "#97233F", ratioOnPaper: 6.85 },
  chargers:     { sourcePrimary: "#0080C6", ink: "#006FAC", ratioOnPaper: 4.65 },
  chiefs:       { sourcePrimary: "#E31837", ink: "#D21633", ratioOnPaper: 4.61 },
  colts:        { sourcePrimary: "#002C5F", ink: "#002C5F", ratioOnPaper: 11.8 },
  commanders:   { sourcePrimary: "#5A1414", ink: "#5A1414", ratioOnPaper: 11.65 },
  cowboys:      { sourcePrimary: "#003594", ink: "#003594", ratioOnPaper: 9.29 },
  dolphins:     { sourcePrimary: "#008E97", ink: "#00767D", ratioOnPaper: 4.63 },
  eagles:       { sourcePrimary: "#004C54", ink: "#004C54", ratioOnPaper: 8.33 },
  falcons:      { sourcePrimary: "#A71930", ink: "#A71930", ratioOnPaper: 6.37 },
  giants:       { sourcePrimary: "#0B2265", ink: "#0B2265", ratioOnPaper: 12.58 },
  jaguars:      { sourcePrimary: "#006778", ink: "#006778", ratioOnPaper: 5.6 },
  jets:         { sourcePrimary: "#125740", ink: "#125740", ratioOnPaper: 7.31 },
  lions:        { sourcePrimary: "#0076B6", ink: "#0070AC", ratioOnPaper: 4.6 },
  packers:      { sourcePrimary: "#203731", ink: "#203731", ratioOnPaper: 10.89 },
  panthers:     { sourcePrimary: "#0085CA", ink: "#0070AA", ratioOnPaper: 4.62 },
  patriots:     { sourcePrimary: "#002244", ink: "#002244", ratioOnPaper: 13.72 },
  raiders:      { sourcePrimary: "#0A0A0A", ink: "#0A0A0A", ratioOnPaper: 16.97 },
  rams:         { sourcePrimary: "#003594", ink: "#003594", ratioOnPaper: 9.29 },
  ravens:       { sourcePrimary: "#241773", ink: "#241773", ratioOnPaper: 12.45 },
  saints:       { sourcePrimary: "#D3BC8D", ink: "#75684E", ratioOnPaper: 4.68 },
  seahawks:     { sourcePrimary: "#002244", ink: "#002244", ratioOnPaper: 13.72 },
  steelers:     { sourcePrimary: "#FFB612", ink: "#8B630A", ratioOnPaper: 4.63 },
  texans:       { sourcePrimary: "#03202F", ink: "#03202F", ratioOnPaper: 14.38 },
  titans:       { sourcePrimary: "#0C2340", ink: "#0C2340", ratioOnPaper: 13.53 },
  vikings:      { sourcePrimary: "#4F2683", ink: "#4F2683", ratioOnPaper: 9.29 },
};

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`bad hex: ${hex}`);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a #rrggbb color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** WCAG contrast ratio of `hex` against the page ground (#f2ede3). */
export function contrastOnPaper(hex: string): number {
  const a = relativeLuminance(hex);
  const b = relativeLuminance(PAPER_HEX);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** The ink for a franchise key, or null. Callers must handle null rather
 *  than fall back to a house color — a missing key means the abbreviation
 *  did not resolve, which is a data problem worth seeing. */
export function teamInk(franchiseKey: string | null | undefined): string | null {
  if (!franchiseKey) return null;
  return TEAM_INK[franchiseKey]?.ink ?? null;
}
