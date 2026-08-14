// X-ready picks card — 1200x675 PNG rendered with next/og.
//
// Query params (all optional):
//   ?runId=xxx      — render picks from a specific AgentRun
//   ?date=YYYY-MM-DD — render all final picks from gameDate
//   (no params)     — today's picks across all runs
//
// Discord auto-embeds this URL inline when the bot posts a markdown image
// link. Right-click → save → drop into the X composer.

import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // Prisma needs node, not edge
export const dynamic = "force-dynamic";

const W = 1200;
const H = 675;

const COLORS = {
  bg: "#05060f",
  fg: "#f5f7ff",
  muted: "#8a8fb3",
  cyan: "#00d9ff",
  lime: "#22ff88",
  pink: "#ff007a",
  amber: "#ff8c42",
  violet: "#a855f7",
};

const LEAGUE_EMOJI: Record<string, string> = {
  NBA: "🏀",
  MLB: "⚾",
  NFL: "🏈",
  NHL: "🏒",
  WNBA: "🏀",
};

type CardPick = {
  league: string;
  matchup: string;
  selection: string;
  market: string;
  oddsAmerican: number;
  edge: number;
  kellyStakeUnits: number;
  confidence: number;
};

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

// Map edge percent to a 0–100 meter value. 6% = floor (grader cutoff), 12%
// saturates the bar. The floor moved from 3% → 6% in May 2026 to clear vig.
function edgeMeterPct(edge: number): number {
  const pct = edge * 100;
  return Math.max(0, Math.min(100, ((pct - 6) / 6) * 100));
}

function edgeColor(edge: number): string {
  const pct = edge * 100;
  if (pct >= 10) return COLORS.lime;
  if (pct >= 8) return COLORS.cyan;
  if (pct >= 7) return COLORS.violet;
  return COLORS.amber;
}

async function loadPicks(req: NextRequest): Promise<CardPick[]> {
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");
  const dateStr = url.searchParams.get("date");

  let where: Record<string, unknown> = {};
  if (runId) {
    where = { runId };
  } else {
    const start = new Date();
    if (dateStr) {
      const [y, m, d] = dateStr.split("-").map(Number);
      start.setUTCFullYear(y, (m ?? 1) - 1, d ?? 1);
    }
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    where = { gameDate: { gte: start, lt: end } };
  }

  const rows = await prisma.agentPick.findMany({
    where,
    orderBy: [{ edge: "desc" }],
    take: 6, // card fits ~5 cleanly; 6th is a stretch
  });

  return rows.map((r) => ({
    league: r.league,
    matchup: r.matchup,
    selection: r.selection,
    market: r.market,
    oddsAmerican: r.oddsAmerican,
    edge: r.edge,
    kellyStakeUnits: r.kellyStakeUnits,
    confidence: r.confidence,
  }));
}

function paperTrialDay(): { day: number } {
  // Trial started 2026-05-06 UTC. CLV-gated, not calendar-gated: it runs until
  // the sample-size criteria pass, so there is no "/30" — the old clamp
  // rendered a false "Day 30/30" on the public card for months.
  const start = Date.UTC(2026, 4, 6);
  const now = Date.now();
  const day = Math.max(1, Math.floor((now - start) / 86_400_000) + 1);
  return { day };
}

export async function GET(req: NextRequest) {
  let picks: CardPick[] = [];
  try {
    picks = await loadPicks(req);
  } catch (e) {
    console.warn("og/picks: failed to load picks:", e);
  }

  const { day } = paperTrialDay();
  const totalUnits = picks.reduce((s, p) => s + p.kellyStakeUnits, 0);
  const dateLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

  return new ImageResponse(
    (
      <div
        style={{
          width: W,
          height: H,
          display: "flex",
          flexDirection: "column",
          backgroundColor: COLORS.bg,
          backgroundImage: [
            `radial-gradient(900px 600px at 15% -10%, rgba(168, 85, 247, 0.35), transparent 60%)`,
            `radial-gradient(800px 600px at 95% 10%, rgba(0, 217, 255, 0.22), transparent 60%)`,
            `radial-gradient(900px 700px at 50% 110%, rgba(255, 0, 122, 0.22), transparent 65%)`,
          ].join(", "),
          color: COLORS.fg,
          padding: 56,
          fontFamily: "Inter",
          position: "relative",
        }}
      >
        {/* Header strip */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 28,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 99,
                backgroundColor: COLORS.lime,
                boxShadow: `0 0 18px ${COLORS.lime}`,
              }}
            />
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                letterSpacing: 4,
                textTransform: "uppercase",
              }}
            >
              Nate Stacks Data
            </div>
          </div>
          <div
            style={{
              fontSize: 22,
              color: COLORS.muted,
              letterSpacing: 1,
            }}
          >
            {dateLabel}
          </div>
        </div>

        {/* Title block */}
        <div style={{ display: "flex", flexDirection: "column", marginBottom: 24 }}>
          <div
            style={{
              fontSize: 76,
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: -2,
              backgroundImage: `linear-gradient(90deg, ${COLORS.cyan}, ${COLORS.violet}, ${COLORS.pink})`,
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            NIGHTLY LOCKS
          </div>
          <div
            style={{
              display: "flex",
              gap: 18,
              marginTop: 14,
              alignItems: "center",
              fontSize: 22,
              color: COLORS.muted,
            }}
          >
            <span>
              Day <span style={{ color: COLORS.fg, fontWeight: 600 }}>{day}</span> · CLV-gated paper trial
            </span>
            <span style={{ color: COLORS.muted }}>·</span>
            <span>
              <span style={{ color: COLORS.fg, fontWeight: 600 }}>{picks.length}</span> play
              {picks.length === 1 ? "" : "s"}
            </span>
            <span style={{ color: COLORS.muted }}>·</span>
            <span>
              <span style={{ color: COLORS.fg, fontWeight: 600 }}>{totalUnits.toFixed(1)}u</span> total
            </span>
          </div>
        </div>

        {/* Pick rows */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            flex: 1,
          }}
        >
          {picks.length === 0 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: 1,
                fontSize: 36,
                color: COLORS.muted,
              }}
            >
              🚫 No plays cleared the rubric tonight.
            </div>
          ) : (
            picks.slice(0, 5).map((p, i) => {
              const meter = edgeMeterPct(p.edge);
              const color = edgeColor(p.edge);
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 18,
                    padding: "16px 22px",
                    backgroundColor: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 14,
                  }}
                >
                  <div style={{ fontSize: 38, width: 50, display: "flex" }}>
                    {LEAGUE_EMOJI[p.league] ?? "🎯"}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <div style={{ fontSize: 26, fontWeight: 600 }}>
                      {p.selection}
                      {p.market === "moneyline" ? " ML" : ""}{" "}
                      <span style={{ color: COLORS.muted, fontFamily: "Geist Mono", fontSize: 22 }}>
                        {fmtAmerican(p.oddsAmerican)}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        marginTop: 6,
                        height: 6,
                        width: 320,
                        backgroundColor: "rgba(255,255,255,0.08)",
                        borderRadius: 99,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${meter}%`,
                          backgroundColor: color,
                          boxShadow: `0 0 12px ${color}`,
                        }}
                      />
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      gap: 2,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 32,
                        fontWeight: 700,
                        color,
                        fontFamily: "Geist Mono",
                      }}
                    >
                      +{(p.edge * 100).toFixed(1)}%
                    </div>
                    <div style={{ fontSize: 16, color: COLORS.muted }}>
                      {p.kellyStakeUnits.toFixed(1)}u · conf {p.confidence}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 24,
            fontSize: 18,
            color: COLORS.muted,
            letterSpacing: 0.5,
          }}
        >
          <div style={{ display: "flex", gap: 14 }}>
            <span style={{ color: COLORS.cyan }}>● analyst</span>
            <span style={{ color: COLORS.violet }}>● critic</span>
            <span style={{ color: COLORS.pink }}>● bankroll</span>
          </div>
          <div>not financial advice · entertainment only</div>
        </div>
      </div>
    ),
    {
      width: W,
      height: H,
      headers: {
        // Cache for 5 min — picks change at most twice daily.
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    }
  );
}
