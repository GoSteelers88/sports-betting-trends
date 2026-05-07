import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./index";
import { requireOperator } from "../authz";

// Dream is too long to run inside a Discord interaction (3-second initial reply,
// 15-min defer ceiling, plus dream() can take 10+ minutes on Opus). Trigger
// the GitHub Actions agent-dream workflow instead.

const REPO = "GoSteelers88/sports-betting-trends";

const data = new SlashCommandBuilder()
  .setName("dream")
  .setDescription("Trigger weekly memory consolidation (runs on GitHub Actions)");

export const dreamCommand: Command = {
  data,
  async handler(interaction) {
    if (!(await requireOperator(interaction))) return;
    const token = process.env.GH_PAT?.trim();
    if (!token) {
      await interaction.reply({
        content: "❌ `GH_PAT` not set on the bot. Add a fine-grained PAT with Actions:write to env.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      const res = await fetch(
        `https://api.github.com/repos/${REPO}/actions/workflows/agent-dream.yml/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "master" }),
        }
      );
      if (!res.ok) {
        const body = await res.text();
        await interaction.editReply(`❌ GitHub returned ${res.status}: ${body.slice(0, 300)}`);
        return;
      }
      await interaction.editReply(
        `🌙 Dream triggered. Watch: https://github.com/${REPO}/actions/workflows/agent-dream.yml`
      );
    } catch (err) {
      await interaction.editReply(`❌ Failed to trigger: ${err instanceof Error ? err.message : err}`);
    }
  },
};
