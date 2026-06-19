/**
 * One-off: exclude (or, with --restore, re-include) a match by match_id.
 *
 * Unlike `remove-match`, this keeps the match and its #game-results post — it
 * just flips the `excluded` flag so the game drops off every leaderboard
 * (forced off-format; CSR recomputes from history). With --confirm it also
 * re-styles the post in place (caption flips to/from "Off-format") and refreshes
 * the live #leaderboard.
 *
 *   npm run exclude-match -- <match_id>                       # dry run (exclude)
 *   npm run exclude-match -- <match_id> --confirm             # exclude
 *   npm run exclude-match -- <match_id> --restore --confirm   # undo
 */

import { config } from "./config.ts";
import {
  openDb,
  matchesChrono,
  matchCount,
  setMatchExcluded,
  resultsRestyleTargets,
} from "./db.ts";
import { boardCategory } from "./category.ts";
import { categorize } from "./category.ts";
import { displayName } from "./aliases.ts";
import { restyleResultPost } from "./heal.ts";
import { upsertCsrLeaderboard } from "./discord.ts";

const confirm = process.argv.includes("--confirm");
const restore = process.argv.includes("--restore");
const matchId = process.argv.slice(2).find((a) => !a.startsWith("--"));

if (!matchId) {
  console.error("Usage: npm run exclude-match -- <match_id> [--restore] [--confirm]");
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
console.log(`  gametype : ${target.gameTypeName} (structural ${categorize(target)})`);
console.log(`  played   : ${when}`);
console.log(`  excluded : ${target.excluded} -> ${!restore}`);
console.log(`  board    : ${boardCategory(target)} -> ${boardCategory({ ...target, excluded: !restore })}`);
console.log(`  players  : ${roster}`);

if (!confirm) {
  console.log(
    `\nDry run. Re-run with --confirm to ${restore ? "re-include" : "exclude"} this game ` +
      `and refresh the leaderboard.`,
  );
  db.close();
  process.exit(0);
}

await setMatchExcluded(db, matchId, !restore);
console.log(`\n${restore ? "Re-included" : "Excluded"} match. ${await matchCount(db)} matches recorded.`);

// Re-style the #game-results post in place if its message id is tracked.
const msgId = (await resultsRestyleTargets(db, 0, true)).find((t) => t.matchId === matchId)?.msgId;
if (msgId) {
  const r = await restyleResultPost(db, matchId, msgId);
  console.log(`[discord] result post ${r}.`);
} else {
  console.log("[discord] no tracked #game-results post id — re-style its post by hand if needed.");
}

if (config.discordLeaderboardWebhookUrl) {
  await upsertCsrLeaderboard(config.discordLeaderboardWebhookUrl, db);
  console.log("[discord] leaderboard message refreshed.");
}

db.close();
