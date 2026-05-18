/**
 * Print the current leaderboard from the DB to the console. No file scanning,
 * no Discord — just "what do the standings look like right now".
 *
 *   npm run board
 */

import { config } from "./config.ts";
import { openDb, matchesChrono, matchCount } from "./db.ts";
import { computeRatings } from "./elo.ts";
import { formatLeaderboard } from "./discord.ts";

const db = openDb(config.dbPath);
console.log(`${matchCount(db)} tracked matches in ${config.dbPath}\n`);
console.log(formatLeaderboard(computeRatings(matchesChrono(db), { start: config.eloStart, k: config.eloK }), 50));
db.close();
