// Reaction handler for picks posted in the channel.
// ✅ → mark "I placed this bet" (writes a note on AgentPick)
// ❌ → mark "skipped" (writes a note)
// 💯 → mark "high confidence" (logs but no behavior change yet)
//
// We can't auto-discover which message → which pick reliably, so we look up
// by pick id mentioned in the message text (e.g., "#42 Detroit Tigers ML…").

import { MessageReaction, User, PartialMessageReaction, PartialUser } from "discord.js";
import { prisma } from "@/lib/prisma";

const PICK_ID_REGEX = /#(\d{1,9})\b/;

export async function handleReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
): Promise<void> {
  if (user.bot) return;

  // Resolve partials
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (reaction.message.partial) {
    try { await reaction.message.fetch(); } catch { return; }
  }

  const content = reaction.message.content ?? "";
  // Try embed fields too — picks-today posts as embeds
  const embedText = (reaction.message.embeds ?? [])
    .flatMap(e => [e.title ?? "", e.description ?? "", ...(e.fields ?? []).map(f => f.name + " " + f.value)])
    .join(" ");
  const fullText = content + " " + embedText;

  const match = fullText.match(PICK_ID_REGEX);
  if (!match) return;

  const pickId = parseInt(match[1], 10);
  if (!Number.isFinite(pickId)) return;

  const pick = await prisma.agentPick.findUnique({ where: { id: pickId } });
  if (!pick) return;

  const emoji = reaction.emoji.name;
  let actionNote: string | null = null;
  if (emoji === "✅") actionNote = `placed by ${user.username ?? user.id} at ${new Date().toISOString()}`;
  else if (emoji === "❌") actionNote = `skipped by ${user.username ?? user.id} at ${new Date().toISOString()}`;
  else if (emoji === "💯") actionNote = `confidence-up flag from ${user.username ?? user.id}`;
  else return;

  // Append to existing outcome notes (or create a placeholder pending outcome)
  const existing = await prisma.agentOutcome.findUnique({ where: { pickId } });
  const newNotes = existing?.notes ? `${existing.notes}\n${actionNote}` : actionNote;
  await prisma.agentOutcome.upsert({
    where: { pickId },
    create: { pickId, result: "pending", notes: newNotes },
    update: { notes: newNotes },
  });

  try {
    await reaction.message.react(emoji); // confirm receipt
  } catch {
    // best effort
  }
}
