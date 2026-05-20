import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./index";
import { requireOperator } from "../authz";

// Triggers the GitHub Actions agent-run workflow via REST API.
// The bot itself doesn't run the orchestrator — too heavy for Railway and
// orchestrator uses spawnSync which only works in real Linux runners.

const REPO = "GoSteelers88/sports-betting-trends";
const WORKFLOW = "agent-run.yml";

const data = new SlashCommandBuilder()
  .setName("agent")
  .setDescription("Trigger an agent action")
  .addSubcommand(sub =>
    sub
      .setName("run")
      .setDescription("Trigger an analyze run on GitHub Actions")
      .addStringOption(opt =>
        opt
          .setName("league")
          .setDescription("Which league(s) to analyze")
          .addChoices(
            { name: "BOTH (NBA + MLB)", value: "BOTH" },
            { name: "NBA", value: "NBA" },
            { name: "MLB", value: "MLB" }
          )
          .setRequired(true)
      )
  )
  .addSubcommand(sub => sub.setName("dream").setDescription("Trigger weekly memory consolidation"));

export const agentRunCommand: Command = {
  data,
  async handler(interaction) {
    if (!(await requireOperator(interaction))) return;
    const sub = interaction.options.getSubcommand();
    const token = process.env.GH_PAT?.trim();
    if (!token) {
      await interaction.reply({
        content: "❌ `GH_PAT` not set on the bot. Add a fine-grained PAT with Actions:write to env.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    const workflow = sub === "dream" ? "agent-dream.yml" : WORKFLOW;
    const inputs: Record<string, string> = {};
    if (sub === "run") {
      inputs.league = interaction.options.getString("league") ?? "BOTH";
    }

    try {
      const res = await fetch(
        `https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "master", inputs }),
        }
      );
      if (!res.ok) {
        const body = await res.text();
        await interaction.editReply(`❌ GitHub returned ${res.status}: ${body.slice(0, 300)}`);
        return;
      }
      await interaction.editReply(
        `🚀 Triggered \`${workflow}\` ${sub === "run" ? `for **${inputs.league}**` : ""}\nWatch: https://github.com/${REPO}/actions/workflows/${workflow}\nResults will post here when the run finishes.`
      );
    } catch (err) {
      await interaction.editReply(`❌ Failed to trigger workflow: ${err instanceof Error ? err.message : err}`);
    }
  },
};
