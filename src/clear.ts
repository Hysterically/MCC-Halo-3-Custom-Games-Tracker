/**
 * One-off: wipe all recorded games and reset the leaderboard. Deletes every
 * match (cascading to match_players) and every player, then edits the live
 * #leaderboard message in place to its now-empty state. The kv row holding the
 * leaderboard message id is kept so the same Discord message is reused.
 *
 *   npm run clear
 */

import { config } from "./config.ts";
import { openDb, matchCount } from "./db.ts";
import { upsertLeaderboard } from "./discord.ts";

const db = await openDb(config.dbUrl, config.dbAuthToken);

const before = await matchCount(db);
console.log(`Clearing ${before} matches in ${config.dbUrl} ...`);

await db.batch(
  [
    "DELETE FROM match_players",
    "DELETE FROM matches",
    "DELETE FROM players",
  ],
  "write",
);

console.log(`Done. ${await matchCount(db)} matches remain.`);

if (config.discordLeaderboardWebhookUrl) {
  await upsertLeaderboard(config.discordLeaderboardWebhookUrl, db, {
    start: config.eloStart,
    k: config.eloK,
  });
  console.log("[discord] leaderboard message refreshed (empty).");
}

db.close();
