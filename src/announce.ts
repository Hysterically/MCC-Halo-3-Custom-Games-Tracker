/**
 * Force-refresh the live leaderboard message in #leaderboard. Useful after
 * manual DB edits, a backfill, or just as a smoke test that the leaderboard
 * webhook is wired up correctly.
 *
 *   npm run announce
 */

import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { upsertLeaderboard } from "./discord.ts";

if (!config.discordLeaderboardWebhookUrl) {
  console.error("No DISCORD_LEADERBOARD_WEBHOOK_URL configured — set it in .env first.");
  process.exit(1);
}

const db = openDb(config.dbPath);
await upsertLeaderboard(config.discordLeaderboardWebhookUrl, db, {
  start: config.eloStart,
  k: config.eloK,
});
db.close();
console.log("[discord] leaderboard message refreshed.");
