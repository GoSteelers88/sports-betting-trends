// One-shot: register the bot's slash commands with Discord.
// Run after adding/changing commands. Guild-scoped registration is instant
// (vs global which can take up to an hour).
//
// Usage: npm run bot:register

import { config } from "dotenv";
config();

import { REST, Routes } from "discord.js";
import { COMMANDS } from "../src/bot/commands";

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_APPLICATION_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !appId || !guildId) {
    console.error("Missing env: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const body = COMMANDS.map(c => c.data.toJSON());

  console.log(`Registering ${body.length} commands to guild ${guildId}...`);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
  console.log("✅ Commands registered.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
