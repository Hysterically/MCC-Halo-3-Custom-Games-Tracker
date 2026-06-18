/**
 * One-off: remove a specific match from the records by match_id.
 *
 * Prints the match it resolved, and — only with --confirm — deletes it
 * (cascading to its players) and refreshes the live #leaderboard message so the
 * standings (CSR is recomputed from history) drop it.
 *
 * Note: the per-match #game-results post is sent fire-and-forget (no stored
 * message id), so it cannot be deleted from here — remove that post by hand.
 *
 *   npm run remove-match -- <match_id>             # dry run
 *   npm run remove-match -- <match_id> --confirm
 */

import { config } from "./config.ts";
import { openDb, matchesChrono, matchCount } from "./db.ts";
import { categorize } from "./category.ts";
import { displayName } from "./aliases.ts";
import { upsertCsrLeaderboard } from "./discord.ts";

const confirm = process.argv.includes("--confirm");
const matchId = process.argv.slice(2).find((a) => !a.startsWith("--"));

if (!matchId) {
  console.error("Usage: npm run remove-match -- <match_id> [--confirm]");
  process.exit(1);
}

const db = await openDb(config.dbUrl, config.dbAuthToken);

const matches = await matchesChrono(db);
const target = matches.find((m) => m.matchId === matchId);

if (!target) {
  console.log(`No match with id ${matchId} found (of ${matches.length} total).`);
  db.close();
  process.exit(1);
}

const when = new Date(target.playedAt).toISOString();
const roster = [...target.players]
  .sort((a, b) => a.teamId - b.teamId || a.standing - b.standing)
  .map((p) => `${displayName(p.gamertag)}[t${p.teamId}] (${p.kills}/${p.deaths}/${p.assists})`)
  .join(", ");

console.log(`Target match (of ${matches.length} total):`);
console.log(`  match_id : ${target.matchId}`);
console.log(`  gametype : ${target.gameTypeName} (${categorize(target)})`);
console.log(`  played   : ${when}`);
console.log(`  map      : ${[target.mapName, target.mapVariant].filter(Boolean).join(" — ") || "—"}`);
console.log(`  winner   : team${target.winningTeamId}`);
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
  await upsertCsrLeaderboard(config.discordLeaderboardWebhookUrl, db);
  console.log("[discord] leaderboard message refreshed.");
}

db.close();
