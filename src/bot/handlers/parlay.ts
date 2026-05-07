// Parlay handler: when a non-bot user posts a message that looks like a
// parlay (contains "parlay" keyword OR multiple ML-formatted legs), send the
// text to Claude for analysis and reply in-thread with a leg-by-leg verdict.

import { Message, OmitPartialGroupDMChannel } from "discord.js";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, MODELS } from "@/lib/agent/client";

// Heuristic: looks like a parlay if it mentions "parlay" or has 2+ likely-bet
// patterns (team @ odds, +/- 3-4 digit number, "over/under N", etc.)
const PARLAY_KEYWORDS = /\b(parlay|sgp|same.game)\b/i;
const ODDS_PATTERN = /[+\-]\d{2,4}|over\s+\d|under\s+\d/gi;

function looksLikeParlay(text: string): boolean {
  if (PARLAY_KEYWORDS.test(text)) return true;
  const oddsMatches = text.match(ODDS_PATTERN);
  return (oddsMatches?.length ?? 0) >= 2;
}

const PARLAY_SYSTEM = `You are a sharp sports-betting analyst reviewing a parlay someone is about to place.

Parse the message into individual legs. For each leg, return one of three verdicts:
- "strong" — quality bet on its own, would take it as a single
- "marginal" — could go either way, neither obvious smart nor obvious dumb
- "kill" — drop this leg, here's specifically why

Then a 1-2 sentence overall verdict. Be honest, brief, conversational. Don't be preachy about parlay math; the person already knows. Focus on whether each leg has real edge.

Pay special attention to:
- Plus-money longshots with no specific catalyst (likely model overconfidence)
- Heavy favorites in parlays (vig compounds; even with 70%+ legs the parlay loses EV fast)
- Correlated legs (same-game ML + spread = double-counts the same outcome)
- Generic stat-citing reasoning vs specific situational edge

Return ONLY a JSON object, no prose, no markdown:
{
  "legs": [
    { "description": "Tigers ML +110", "verdict": "kill", "reason": "no catalyst cited; model rarely beats 6-book consensus by this much" }
  ],
  "overall": "1-2 sentence summary",
  "actionableAdvice": "concrete suggestion (drop leg N, replay as 2-leg, take as singles, etc.)"
}`;

type ParlayLeg = {
  description: string;
  verdict: "strong" | "marginal" | "kill";
  reason: string;
};

type ParlayAnalysis = {
  legs: ParlayLeg[];
  overall: string;
  actionableAdvice: string;
};

function parseParlayResponse(text: string): ParlayAnalysis | null {
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  try {
    return JSON.parse(cleaned) as ParlayAnalysis;
  } catch {
    return null;
  }
}

function verdictEmoji(v: string): string {
  if (v === "strong") return "✅";
  if (v === "kill") return "❌";
  return "⚠️";
}

function formatReply(analysis: ParlayAnalysis): string {
  const lines = ["**Parlay analysis**", ""];
  for (let i = 0; i < analysis.legs.length; i++) {
    const leg = analysis.legs[i];
    lines.push(`${verdictEmoji(leg.verdict)} **Leg ${i + 1}**: ${leg.description}`);
    lines.push(`   _${leg.reason}_`);
  }
  lines.push("");
  lines.push(`**Verdict**: ${analysis.overall}`);
  lines.push(`**Suggested**: ${analysis.actionableAdvice}`);
  lines.push("");
  lines.push("_Agent's read, not financial advice. Bet responsibly._");
  return lines.join("\n").slice(0, 1900);
}

export async function handleParlayMessage(
  message: OmitPartialGroupDMChannel<Message<boolean>>
): Promise<void> {
  if (message.author.bot) return;
  // Only respond in the configured picks channel (avoid noise everywhere else)
  const allowedChannel = process.env.DISCORD_PICKS_CHANNEL_ID?.trim();
  if (allowedChannel && message.channelId !== allowedChannel) return;
  if (!looksLikeParlay(message.content)) return;

  // Show typing indicator while Claude thinks
  await message.channel.sendTyping().catch(() => {});

  let client: Anthropic;
  try {
    client = getAnthropic();
  } catch {
    await message.reply("⚠️ Anthropic API not configured on the bot. Can't analyze.").catch(() => {});
    return;
  }

  try {
    const response = await client.messages.create({
      model: MODELS.analyst,
      max_tokens: 1500,
      system: PARLAY_SYSTEM,
      messages: [{ role: "user", content: message.content.slice(0, 2000) }],
    });
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    const analysis = parseParlayResponse(text);
    if (!analysis) {
      await message.reply("Couldn't parse a clean parlay structure from that. Try formatting it as `Team1 ML +110, Team2 -3.5, Over 220`.").catch(() => {});
      return;
    }
    await message.reply(formatReply(analysis)).catch(() => {});
  } catch (err) {
    await message.reply(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)).catch(() => {});
  }
}
