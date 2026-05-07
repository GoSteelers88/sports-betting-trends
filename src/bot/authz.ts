// Slash-command access control. Mutating commands (workflow dispatches,
// pick grading, dream consolidation) are restricted to:
//   1. User IDs in `AGENT_OPERATOR_IDS` env (comma-separated), if set
//   2. Guild Administrator permission, as a fallback
//
// If neither matches, the command is rejected with a friendly message.

import { PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";

export function isOperator(interaction: ChatInputCommandInteraction): boolean {
  const raw = process.env.AGENT_OPERATOR_IDS?.trim();
  if (raw) {
    const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (ids.includes(interaction.user.id)) return true;
  }
  // Fallback: guild administrators are always operators.
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  return false;
}

export async function requireOperator(
  interaction: ChatInputCommandInteraction
): Promise<boolean> {
  if (isOperator(interaction)) return true;
  await interaction.reply({
    content:
      "🔒 This command is restricted to authorized operators (server admins, or users in the AGENT_OPERATOR_IDS allowlist).",
    ephemeral: true,
  });
  return false;
}
