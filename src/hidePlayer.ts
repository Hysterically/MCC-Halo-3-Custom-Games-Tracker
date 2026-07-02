/**
 * Hide (or, with --show, un-hide) a player from the leaderboards by gamertag or
 * XUID. The player's matches still count — everyone else's CSR is unchanged —
 * they're just suppressed from every rendered board. The hidden set lives in the
 * shared DB (kv `hidden_players`), so all runners (TS + C++) filter alike.
 *
 *   npm run hide-player -- "<gamertag|xuid>"            # dry run (hide)
 *   npm run hide-player -- "<gamertag|xuid>" --confirm  # hide
 *   npm run hide-player -- "<gamertag|xuid>" --show --confirm   # un-hide
 *
 * (npm eats bare --flags; run via `npx tsx src/hidePlayer.ts ... --confirm`.)
 */

import { config } from "./config.ts";
import { openDb, matchesChrono, hiddenXuids, setPlayerHidden } from "./db.ts";
import { upsertCsrLeaderboard } from "./discord.ts";
import { displayName } from "./aliases.ts";

const confirm = process.argv.includes("--confirm");
const show = process.argv.includes("--show");
const query = process.argv.slice(2).find((a) => !a.startsWith("--"));

if (!query) {
  console.error('Usage: npm run hide-player -- "<gamertag|xuid>" [--show] [--confirm]');
  process.exit(1);
}

const db = await openDb(config.dbUrl, config.dbAuthToken);
const matches = await matchesChrono(db);

// Resolve the query to a single XUID: exact XUID match, else case-insensitive
// gamertag match. Collect every (xuid -> latest gamertag, appearances) seen.
const q = query.toLowerCase();
const found = new Map<string, { gamertag: string; games: number }>();
for (const m of matches) {
  for (const p of m.players) {
    if (p.xuid.toLowerCase() === q || p.gamertag.toLowerCase() === q) {
      const e = found.get(p.xuid) ?? { gamertag: p.gamertag, games: 0 };
      e.gamertag = p.gamertag;
      e.games++;
      found.set(p.xuid, e);
    }
  }
}

if (found.size === 0) {
  console.log(`No player matching "${query}" found in ${matches.length} matches.`);
  db.close();
  process.exit(1);
}
if (found.size > 1) {
  console.log(`"${query}" is ambiguous — matched ${found.size} players. Re-run with one XUID:`);
  for (const [xuid, e] of found) console.log(`  ${xuid}  "${e.gamertag}" (${e.games} games)`);
  db.close();
  process.exit(1);
}

const [xuid, info] = [...found][0];
const already = await hiddenXuids(db);
const isHidden = already.has(xuid);

console.log(`Target player:`);
console.log(`  xuid     : ${xuid}`);
console.log(`  gamertag : ${displayName(info.gamertag)} (raw "${info.gamertag}", ${info.games} games)`);
console.log(`  hidden   : ${isHidden} -> ${!show}`);

if (!confirm) {
  console.log(`\nDry run. Re-run with --confirm to ${show ? "un-hide" : "hide"} this player.`);
  db.close();
  process.exit(0);
}

const changed = await setPlayerHidden(db, xuid, !show);
console.log(`\n${changed ? (show ? "Un-hid" : "Hid") : "No change —"} ${displayName(info.gamertag)}.`);

if (config.discordLeaderboardWebhookUrl) {
  await upsertCsrLeaderboard(config.discordLeaderboardWebhookUrl, db);
  console.log("[discord] leaderboard message refreshed.");
}

db.close();
