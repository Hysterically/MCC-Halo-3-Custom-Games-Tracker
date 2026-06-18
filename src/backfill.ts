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
import { findMapInfo } from "./mapInfo.ts";
import { formatCsrLeaderboard } from "./discord.ts";

const dir = process.argv[2] ?? config.carnageDir;
const db = await openDb(config.dbUrl, config.dbAuthToken);

const files = (await readdir(dir)).filter(
  (f) => /carnage/i.test(f) && extname(f).toLowerCase() === ".xml",
);

let added = 0;
for (const f of files) {
  try {
    const r = await parseCarnageFile(join(dir, f));
    if (!r.tracked) continue;
    // No waiting here — old films have usually rotated away; take what's left.
    const map = await findMapInfo(dir, r.playedAt.getTime());
    r.mapName = map.mapName;
    r.mapVariant = map.mapVariant;
    if (await recordMatch(db, r)) added++;
  } catch (e) {
    console.warn(`skip ${f}: ${(e as Error).message}`);
  }
}

console.log(`Scanned ${files.length} reports in ${dir}: +${added} new, ${await matchCount(db)} total.\n`);
console.log(formatCsrLeaderboard(await matchesChrono(db)));
db.close();
