/**
 * Central config. Everything is overridable via environment variables (a
 * local `.env` is loaded automatically). Sensible defaults mean you can run
 * the watcher with zero config on the gaming PC; Discord is opt-in.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { config as loadEnv } from "dotenv";

loadEnv();

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};

export interface Config {
  /** Folder MCC writes mpcarnagereport*.xml to (or a folder of samples). */
  carnageDir: string;
  /** SQLite database file. Created on first run. */
  dbPath: string;
  /** Starting rating every new player is seeded at. */
  eloStart: number;
  /** ELO K-factor (rating swing per game). */
  eloK: number;
  /** #game-results webhook — per-match summary posts. */
  discordResultsWebhookUrl?: string;
  /** #leaderboard webhook — single message edited in place. */
  discordLeaderboardWebhookUrl?: string;
  /** Discord bot token — enables the on-demand /leaderboard command. */
  discordBotToken?: string;
  /** Guild to register slash commands in (instant; global takes ~1h). */
  discordGuildId?: string;
}

// Back-compat: an older single DISCORD_WEBHOOK_URL falls through to results.
const legacyWebhook = env("DISCORD_WEBHOOK_URL");

export const config: Config = {
  carnageDir: env("MCC_CARNAGE_DIR") ?? join(homedir(), "AppData", "LocalLow", "MCC", "Temporary"),
  dbPath: env("DB_PATH") ?? join(process.cwd(), "data", "h3.db"),
  eloStart: Number(env("ELO_START") ?? 1200),
  eloK: Number(env("ELO_K") ?? 32),
  discordResultsWebhookUrl: env("DISCORD_RESULTS_WEBHOOK_URL") ?? legacyWebhook,
  discordLeaderboardWebhookUrl: env("DISCORD_LEADERBOARD_WEBHOOK_URL"),
  discordBotToken: env("DISCORD_BOT_TOKEN"),
  discordGuildId: env("DISCORD_GUILD_ID"),
};
