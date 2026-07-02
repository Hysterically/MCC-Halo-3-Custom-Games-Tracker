/**
 * Central config. Everything is overridable via environment variables (a
 * local `.env` is loaded automatically). Sensible defaults mean you can run
 * the watcher with zero config on the gaming PC; Discord is opt-in.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true }); // no "injected env … // tip:" banner in the console

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};

export interface Config {
  /** Folder MCC writes mpcarnagereport*.xml to (or a folder of samples). */
  carnageDir: string;
  /** SQLite database file. Created on first run (used when DB_URL is unset). */
  dbPath: string;
  /**
   * libSQL connection URL. Defaults to a `file:` URL pointing at dbPath, so
   * solo users need no config. Point two or more PCs at the SAME remote
   * libSQL/Turso URL (libsql://…) to share one canonical history — the DB then
   * acts as the cross-instance guard: a match is recorded (and posted) by
   * exactly one instance, via an atomic insert on its GameUniqueId.
   */
  dbUrl: string;
  /** Auth token for a remote libSQL/Turso DB (ignored for local file URLs). */
  dbAuthToken?: string;
  /** JSON map of Gamertag -> preferred display name on the leaderboard. */
  aliasesPath: string;
  /**
   * Legacy ELO tuning. ELO is retired from the live tracker (CSR / TrueSkill 2
   * is the only ladder now), but the dormant `elo.ts` analysis CLIs still read
   * these, so they stay in config.
   */
  eloStart: number;
  eloK: number;
  /** #game-results webhook — per-match CSR summary posts. */
  discordResultsWebhookUrl?: string;
  /** #leaderboard webhook — the live CSR standings, edited in place. */
  discordLeaderboardWebhookUrl?: string;
  /** Discord bot token — enables the on-demand /leaderboard command. */
  discordBotToken?: string;
  /** Guild to register slash commands in (instant; global takes ~1h). */
  discordGuildId?: string;
}

// Back-compat: an older single DISCORD_WEBHOOK_URL falls through to results.
const legacyWebhook = env("DISCORD_WEBHOOK_URL");

const dbPath = env("DB_PATH") ?? join(process.cwd(), "data", "h3.db");

export const config: Config = {
  carnageDir: env("MCC_CARNAGE_DIR") ?? join(homedir(), "AppData", "LocalLow", "MCC", "Temporary"),
  dbPath,
  dbUrl: env("DB_URL") ?? pathToFileURL(dbPath).href,
  dbAuthToken: env("DB_AUTH_TOKEN"),
  aliasesPath: env("ALIASES_PATH") ?? join(process.cwd(), "aliases.json"),
  eloStart: Number(env("ELO_START") ?? 1200),
  eloK: Number(env("ELO_K") ?? 32),
  discordResultsWebhookUrl: env("DISCORD_RESULTS_WEBHOOK_URL") ?? legacyWebhook,
  discordLeaderboardWebhookUrl: env("DISCORD_LEADERBOARD_WEBHOOK_URL"),
  discordBotToken: env("DISCORD_BOT_TOKEN"),
  discordGuildId: env("DISCORD_GUILD_ID"),
};
