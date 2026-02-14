export type AtsOutcome = "W" | "L" | "P" | null;

function parseNumberFromText(value: string): number | null {
  const cleaned = value.replace(/[^0-9+\-.]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function normalizeSpread(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;

  if (/^pk$/i.test(text) || /^pick/i.test(text) || /^even$/i.test(text)) return 0;

  const direct = parseNumberFromText(text);
  if (direct != null) return direct;

  return null;
}

export function normalizeAtsResult(
  value: unknown,
  points?: number | null,
  opponentPoints?: number | null,
  spread?: number | null,
): AtsOutcome {
  if (typeof value === "string") {
    const text = value.trim().toUpperCase();
    if (text) {
      if (["W", "WIN", "COVER", "C", "YES"].includes(text)) return "W";
      if (["L", "LOSS", "NO COVER", "NC", "NO"].includes(text)) return "L";
      if (["P", "PUSH", "T", "TIE"].includes(text)) return "P";

      if (/\b(W|L|P)\b/.test(text)) {
        const m = text.match(/\b(W|L|P)\b/);
        if (m?.[1] === "W" || m?.[1] === "L" || m?.[1] === "P") return m[1];
      }

      if (text.includes("COVER")) return text.includes("NO") ? "L" : "W";
    }
  }

  if (
    typeof points === "number" &&
    Number.isFinite(points) &&
    typeof opponentPoints === "number" &&
    Number.isFinite(opponentPoints) &&
    typeof spread === "number" &&
    Number.isFinite(spread)
  ) {
    const marginVsSpread = points + spread - opponentPoints;
    if (Math.abs(marginVsSpread) < 1e-9) return "P";
    return marginVsSpread > 0 ? "W" : "L";
  }

  return null;
}
