// Slash command registry. Each command exports its definition + handler.

import {
  ChatInputCommandInteraction,
  RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";

import { picksTodayCommand } from "./picks-today";
import { agentRunCommand } from "./agent-run";
import { gradeCommand } from "./grade";
import { bankrollCommand } from "./bankroll";
import { dreamCommand } from "./dream";

export type CommandHandler = (
  interaction: ChatInputCommandInteraction
) => Promise<void>;

// Loose type — different command builders (subcommand-only, options-only,
// plain) produce different concrete types but all satisfy `toJSON()`.
export type Command = {
  data: { name: string; toJSON: () => RESTPostAPIApplicationCommandsJSONBody };
  handler: CommandHandler;
};

export const COMMANDS: Command[] = [
  picksTodayCommand,
  agentRunCommand,
  gradeCommand,
  bankrollCommand,
  dreamCommand,
];
