/**
 * One-off: wipe all recorded games and reset the leaderboard. Deletes every
 * match (cascading to match_players) and every player, then edits the live
 * #leaderboard message in place to its now-empty state. The kv row holding the
 * leaderboard message id is kept so the same Discord message is reused.
 *
 * This destroys the whole shared history with no undo, so like every other
 * destructive CLI here it defaults to a dry run.
 *
 *   npm run clear                 # dry run
 *   npm run clear -- --confirm
 */

import { config } from "./config.ts";
import { openDb, matchCount } from "./db.ts";
import { upsertCsrLeaderboard } from "./discord.ts";

const confirm = process.argv.includes("--confirm");

const db = await openDb(config.dbUrl, config.dbAuthToken);

const before = await matchCount(db);

if (!confirm) {
  console.log(`Would clear ${before} matches (and every player) in ${config.dbUrl}.`);
  console.log("\nDry run. Re-run with --confirm to wipe the database — there is NO undo.");
  db.close();
  process.exit(0);
}

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
  await upsertCsrLeaderboard(config.discordLeaderboardWebhookUrl, db);
  console.log("[discord] leaderboard message refreshed (empty).");
}

db.close();
