/**
 * Scan every mpcarnagereport*.xml and classify it. Lets you see at a glance
 * which reports are Halo 3 customs we'd track.
 *
 *   npm run parse                       # MCC live folder (or ./samples)
 *   npm run parse -- "C:\path\file.xml" # one file (prints full detail)
 *   npm run parse -- "C:\some\folder"   # that folder
 */

import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { parseCarnageFile } from "./parseCarnage.ts";

const MCC_CARNAGE_DIR = join(homedir(), "AppData", "LocalLow", "MCC", "Temporary");
const SAMPLES_DIR = new URL("../samples", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function listXml(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names
    .filter((f) => /carnage/i.test(f) || extname(f).toLowerCase() === ".xml")
    .map((f) => join(dir, f));
}

const arg = process.argv[2];
let files: string[];
let single = false;

if (arg) {
  const s = await stat(arg).catch(() => null);
  if (s?.isFile()) {
    files = [arg];
    single = true;
  } else if (s?.isDirectory()) {
    files = await listXml(arg);
  } else {
    console.error("Not found:", arg);
    process.exit(1);
  }
} else {
  files = await listXml(SAMPLES_DIR).catch(() => [] as string[]);
  if (!files.length) files = await listXml(MCC_CARNAGE_DIR);
}

if (!files.length) {
  console.error("No carnage reports found.");
  process.exit(1);
}

if (single) {
  console.log(JSON.stringify(await parseCarnageFile(files[0]), null, 2));
  process.exit(0);
}

const rows = await Promise.all(
  files.map(async (f) => {
    try {
      const r = await parseCarnageFile(f);
      return {
        file: f.split(/[\\/]/).pop(),
        game: r.isHalo3 ? "H3" : `enum${r.gameEnum}`,
        kind: r.isCustom ? "CUSTOM" : "matchmaking",
        type: r.gameTypeName,
        players: r.players.length,
        winner: r.winners.join(",").slice(0, 24),
        TRACKED: r.tracked ? "YES" : "-",
      };
    } catch (e) {
      return { file: f.split(/[\\/]/).pop(), game: "ERR", kind: (e as Error).message };
    }
  }),
);

console.table(rows);
const tracked = rows.filter((r) => r.TRACKED === "YES").length;
console.log(`\n${rows.length} reports, ${tracked} are Halo 3 customs we'd track.`);
console.log('Detail for one:  npm run parse -- "<full path to that .xml>"');
