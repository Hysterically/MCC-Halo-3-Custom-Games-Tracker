/**
 * One-shot ingest of a folder of carnage reports into the DB, then print the
 * resulting leaderboard. Use it to seed history from old reports (e.g. a
 * OneDrive-synced dump) without running the live watcher.
 *
 *   npm run backfill                       # config.carnageDir
 *   npm run backfill -- "C:\path\to\dump"  # a specific folder
 */

import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { config } from "./config.ts";
import { openDb, recordMatch, matchCount, matchesChrono } from "./db.ts";
import { parseCarnageFile } from "./parseCarnage.ts";
import { formatLeaderboard } from "./discord.ts";

const dir = process.argv[2] ?? config.carnageDir;
const db = openDb(config.dbPath);

const files = (await readdir(dir)).filter(
  (f) => /carnage/i.test(f) && extname(f).toLowerCase() === ".xml",
);

let added = 0;
for (const f of files) {
  try {
    const r = await parseCarnageFile(join(dir, f));
    if (r.tracked && recordMatch(db, r)) added++;
  } catch (e) {
    console.warn(`skip ${f}: ${(e as Error).message}`);
  }
}

console.log(`Scanned ${files.length} reports in ${dir}: +${added} new, ${matchCount(db)} total.\n`);
console.log(formatLeaderboard(matchesChrono(db), { start: config.eloStart, k: config.eloK }));
db.close();
