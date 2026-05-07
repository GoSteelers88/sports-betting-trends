import { SlashCommandBuilder } from "discord.js";
import { prisma } from "@/lib/prisma";
import type { Command } from "./index";

function unitsPnl(american: number, stake: number, result: string): number | null {
  if (result === "win") {
    const decimal = american > 0 ? american / 100 : 100 / -american;
    return +(stake * decimal).toFixed(4);
  }
  if (result === "loss") return -stake;
  if (result === "push" || result === "void") return 0;
  return null;
}

const data = new SlashCommandBuilder()
  .setName("grade")
  .setDescription("Manually grade a pick")
  .addIntegerOption(opt => opt.setName("pickid").setDescription("Pick ID").setRequired(true))
  .addStringOption(opt =>
    opt
      .setName("result")
      .setDescription("Outcome")
      .setRequired(true)
      .addChoices(
        { name: "win", value: "win" },
        { name: "loss", value: "loss" },
        { name: "push", value: "push" },
        { name: "void", value: "void" }
      )
  )
  .addStringOption(opt => opt.setName("notes").setDescription("Optional notes"));

export const gradeCommand: Command = {
  data,
  async handler(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const pickId = interaction.options.getInteger("pickid", true);
    const result = interaction.options.getString("result", true);
    const notes = interaction.options.getString("notes") ?? undefined;

    const pick = await prisma.agentPick.findUnique({ where: { id: pickId } });
    if (!pick) {
      await interaction.editReply(`❌ Pick #${pickId} not found.`);
      return;
    }

    const pnl = unitsPnl(pick.oddsAmerican, pick.kellyStakeUnits, result);

    await prisma.agentOutcome.upsert({
      where: { pickId },
      create: {
        pickId,
        result,
        unitsPnl: pnl,
        notes,
      },
      update: {
        result,
        unitsPnl: pnl,
        notes,
        gradedAt: new Date(),
      },
    });

    const emoji = result === "win" ? "✅" : result === "loss" ? "❌" : "➖";
    await interaction.editReply(
      `${emoji} Pick #${pickId} (${pick.matchup} · ${pick.selection}) graded **${result}** · P&L ${pnl !== null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}u` : "—"}`
    );
  },
};
