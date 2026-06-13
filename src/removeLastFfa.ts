/**
 * One-off: remove the most recent FFA game from the records.
 *
 * Finds the newest match that classifies as FFA (teams off, 2+ rated players),
 * prints it, and — only with --confirm — deletes it (cascading to its players)
 * and refreshes the live #leaderboard message so the FFA standings drop it.
 *
 *   npm run remove-last-ffa            # dry run: show what would be deleted
 *   npm run remove-last-ffa -- --confirm
 */

import { config } from "./config.ts";
import { openDb, matchesChrono, matchCount } from "./db.ts";
import { categorize } from "./category.ts";
import { displayName } from "./aliases.ts";
import { upsertLeaderboard } from "./discord.ts";

const confirm = process.argv.includes("--confirm");

const db = await openDb(config.dbUrl, config.dbAuthToken);

const matches = await matchesChrono(db); // oldest first
const ffa = matches.filter((m) => categorize(m) === "ffa");

if (!ffa.length) {
  console.log("No FFA matches recorded — nothing to remove.");
  db.close();
  process.exit(0);
}

const target = ffa[ffa.length - 1]; // most recent FFA game
const when = new Date(target.playedAt).toISOString();
const roster = [...target.players]
  .sort((a, b) => a.standing - b.standing)
  .map((p) => `${displayName(p.gamertag)} (${p.kills}/${p.deaths}/${p.assists})`)
  .join(", ");

console.log(`Most recent FFA game (of ${ffa.length} FFA / ${matches.length} total):`);
console.log(`  match_id : ${target.matchId}`);
console.log(`  gametype : ${target.gameTypeName}`);
console.log(`  played   : ${when}`);
console.log(`  map      : ${[target.mapName, target.mapVariant].filter(Boolean).join(" — ") || "—"}`);
console.log(`  players  : ${roster}`);

if (!confirm) {
  console.log("\nDry run. Re-run with --confirm to delete this game and refresh the leaderboard.");
  db.close();
  process.exit(0);
}

// match_players cascades via ON DELETE CASCADE (foreign_keys is ON).
const res = await db.execute({ sql: "DELETE FROM matches WHERE match_id = ?", args: [target.matchId] });
console.log(`\nDeleted ${res.rowsAffected} match row. ${await matchCount(db)} matches remain.`);

if (config.discordLeaderboardWebhookUrl) {
  await upsertLeaderboard(config.discordLeaderboardWebhookUrl, db, { start: config.eloStart, k: config.eloK });
  console.log("[discord] leaderboard message refreshed.");
}

db.close();
