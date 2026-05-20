// Discord bot entry point. Connects to the gateway, dispatches slash commands
// and reaction events. Designed for Railway deployment (long-running).

import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { COMMANDS } from "./commands";
import { handleReaction } from "./handlers/reactions";
import { handleParlayMessage } from "./handlers/parlay";
import { startClvTicker } from "./clv-ticker";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN is required");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

let clvTickerHandle: NodeJS.Timeout | null = null;

client.once(Events.ClientReady, c => {
  console.log(`✅ Discord bot ready as ${c.user.tag}`);
  // Start the per-game CLV capture loop. We do this only after the gateway
  // is up so a bad DISCORD_BOT_TOKEN doesn't leave the ticker running on a
  // dead bot process.
  clvTickerHandle = startClvTicker();
  console.log(`🕐 CLV ticker started (every 5min, 2–12min pre-tip-off window)`);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = COMMANDS.find(c => c.data.name === interaction.commandName);
  if (!command) return;
  try {
    await command.handler(interaction);
  } catch (err) {
    console.error(`error handling /${interaction.commandName}:`, err);
    const msg = `❌ Command failed: ${err instanceof Error ? err.message : String(err)}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    await handleReaction(reaction, user);
  } catch (err) {
    console.error("reaction handler error:", err);
  }
});

client.on(Events.MessageCreate, async message => {
  try {
    await handleParlayMessage(message);
  } catch (err) {
    console.error("parlay handler error:", err);
  }
});

client.login(TOKEN).catch(err => {
  console.error("login failed:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("SIGINT received — shutting down");
  if (clvTickerHandle) clearInterval(clvTickerHandle);
  client.destroy();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("SIGTERM received — shutting down");
  if (clvTickerHandle) clearInterval(clvTickerHandle);
  client.destroy();
  process.exit(0);
});
