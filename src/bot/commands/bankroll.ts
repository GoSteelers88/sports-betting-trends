import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { prisma } from "@/lib/prisma";
import type { Command } from "./index";

const data = new SlashCommandBuilder()
  .setName("bankroll")
  .setDescription("Show recent W/L and unit P&L")
  .addIntegerOption(opt =>
    opt.setName("days").setDescription("Lookback window (default 30)").setMinValue(1).setMaxValue(365)
  );

export const bankrollCommand: Command = {
  data,
  async handler(interaction) {
    await interaction.deferReply();

    const days = interaction.options.getInteger("days") ?? 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const outcomes = await prisma.agentOutcome.findMany({
      where: { gradedAt: { gte: since } },
      include: { pick: true },
    });

    if (outcomes.length === 0) {
      await interaction.editReply(`📊 No graded picks in the last ${days} days.`);
      return;
    }

    const stats = {
      total: outcomes.length,
      wins: 0,
      losses: 0,
      pushes: 0,
      voids: 0,
      pnl: 0,
      byLeague: {} as Record<string, { wins: number; losses: number; pushes: number; pnl: number }>,
    };

    for (const o of outcomes) {
      if (o.result === "win") stats.wins++;
      else if (o.result === "loss") stats.losses++;
      else if (o.result === "push") stats.pushes++;
      else if (o.result === "void") stats.voids++;
      stats.pnl += o.unitsPnl ?? 0;

      const lg = (stats.byLeague[o.pick.league] ??= { wins: 0, losses: 0, pushes: 0, pnl: 0 });
      if (o.result === "win") lg.wins++;
      else if (o.result === "loss") lg.losses++;
      else if (o.result === "push") lg.pushes++;
      lg.pnl += o.unitsPnl ?? 0;
    }

    const decided = stats.wins + stats.losses;
    const winRate = decided > 0 ? ((stats.wins / decided) * 100).toFixed(1) : "—";
    const roi = decided > 0
      ? ((stats.pnl / outcomes.reduce((s, o) => s + o.pick.kellyStakeUnits, 0)) * 100).toFixed(1)
      : "—";

    const embed = new EmbedBuilder()
      .setTitle(`📊 Bankroll — last ${days} days`)
      .setColor(stats.pnl >= 0 ? 0x10b981 : 0xef4444)
      .addFields(
        {
          name: "Overall",
          value: `**${stats.wins}-${stats.losses}-${stats.pushes}** · P&L **${stats.pnl >= 0 ? "+" : ""}${stats.pnl.toFixed(2)}u** · Win rate **${winRate}%** · ROI **${roi}%**`,
          inline: false,
        }
      );

    for (const [league, lg] of Object.entries(stats.byLeague)) {
      embed.addFields({
        name: league,
        value: `${lg.wins}-${lg.losses}-${lg.pushes} · ${lg.pnl >= 0 ? "+" : ""}${lg.pnl.toFixed(2)}u`,
        inline: true,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
