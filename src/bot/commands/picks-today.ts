import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { prisma } from "@/lib/prisma";
import type { Command } from "./index";

const data = new SlashCommandBuilder()
  .setName("picks")
  .setDescription("Show the agent's most recent picks")
  .addStringOption(opt =>
    opt
      .setName("when")
      .setDescription("today | recent")
      .addChoices({ name: "today", value: "today" }, { name: "recent", value: "recent" })
  )
  .addStringOption(opt =>
    opt
      .setName("league")
      .setDescription("Filter by league")
      .addChoices(
        { name: "ALL", value: "ALL" },
        { name: "NBA", value: "NBA" },
        { name: "MLB", value: "MLB" },
        { name: "WNBA", value: "WNBA" },
        { name: "NHL", value: "NHL" }
      )
  );

export const picksTodayCommand: Command = {
  data,
  async handler(interaction) {
    await interaction.deferReply();

    const when = interaction.options.getString("when") ?? "today";
    const league = interaction.options.getString("league") ?? "ALL";

    const since = new Date();
    if (when === "today") since.setHours(0, 0, 0, 0);
    else since.setDate(since.getDate() - 7);

    const where: Record<string, unknown> = { createdAt: { gte: since } };
    if (league !== "ALL") where.league = league;

    const picks = await prisma.agentPick.findMany({
      where,
      include: { outcome: true },
      orderBy: { createdAt: "desc" },
      take: 25,
    });

    if (picks.length === 0) {
      await interaction.editReply(
        `No picks found ${when === "today" ? "today" : "in the last 7 days"}${league !== "ALL" ? ` for ${league}` : ""}.`
      );
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🎯 Picks — ${when} ${league !== "ALL" ? `· ${league}` : ""}`)
      .setColor(0x10b981)
      .setTimestamp();

    for (const p of picks.slice(0, 10)) {
      const stake = p.kellyStakeUnits.toFixed(2);
      const edge = (p.edge * 100).toFixed(1);
      const odds = p.oddsAmerican > 0 ? `+${p.oddsAmerican}` : `${p.oddsAmerican}`;
      const outcomeTag = p.outcome
        ? p.outcome.result === "win"
          ? " · ✅ WIN"
          : p.outcome.result === "loss"
          ? " · ❌ LOSS"
          : ` · ${p.outcome.result.toUpperCase()}`
        : "";
      const clvTag =
        p.clvCents !== null
          ? ` · CLV ${p.clvCents > 0 ? "+" : ""}${p.clvCents}¢`
          : "";
      embed.addFields({
        name: `#${p.id} ${p.matchup}${outcomeTag}`,
        value: `${p.market} · ${p.selection} @ \`${odds}\` · edge **${edge}%** · stake **${stake}u**${clvTag}\n*${p.thesis.slice(0, 220)}*`,
      });
    }

    if (picks.length > 10) {
      embed.setFooter({ text: `Showing 10 of ${picks.length} — use /picks for full list` });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
