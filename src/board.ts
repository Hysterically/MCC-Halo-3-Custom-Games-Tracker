/**
 * Print the current leaderboard from the DB to the console. No file scanning,
 * no Discord — just "what do the standings look like right now".
 *
 *   npm run board
 */

import { config } from "./config.ts";
import { openDb, matchesChrono, matchCount } from "./db.ts";
import { formatCsrLeaderboard } from "./discord.ts";

const db = await openDb(config.dbUrl, config.dbAuthToken);
console.log(`${await matchCount(db)} tracked matches in ${config.dbUrl}\n`);
console.log(formatCsrLeaderboard(await matchesChrono(db)));
db.close();
