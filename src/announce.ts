/**
 * Post the current leaderboard to Discord on demand. Useful for "post the
 * standings now" (before a session, after manual backfill) and as a smoke
 * test that the webhook is wired up correctly.
 *
 *   npm run announce
 */

import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { announceBoard } from "./discord.ts";

if (!config.discordWebhookUrl) {
  console.error("No DISCORD_WEBHOOK_URL configured — set it in .env first.");
  process.exit(1);
}

const db = openDb(config.dbPath);
await announceBoard(
  db,
  { start: config.eloStart, k: config.eloK },
  config.discordWebhookUrl,
  "📣 Current standings:",
);
db.close();
console.log("[discord] posted current board to webhook.");
