/**
 * Schema-discovery tool. Point it at a real mpcarnagereport*.xml (a sample
 * synced here, OR run it on the gaming PC against the live folder) and it
 * prints the XML's structure so we can build an exact parser. No guessing.
 *
 *   npm run inspect                       # newest *.xml in ./samples
 *   npm run inspect -- "C:\path\file.xml" # a specific file
 *   npm run inspect -- "C:\Users\<you>\AppData\LocalLow\MCC\Temporary"  # a folder
 *
 * It does NOT need any auth/network — it just reads a local file.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { XMLParser } from "fast-xml-parser";

/** Where MCC (Steam) writes carnage reports on the gaming PC. */
export const MCC_CARNAGE_DIR = join(homedir(), "AppData", "LocalLow", "MCC", "Temporary");

const SAMPLES_DIR = new URL("../samples", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Priority: explicit arg > ./samples (if it has files) > live MCC folder.
async function defaultTarget(): Promise<string> {
  try {
    const hasSample = (await readdir(SAMPLES_DIR)).some((f) => extname(f).toLowerCase() === ".xml");
    if (hasSample) return SAMPLES_DIR;
  } catch {
    /* samples dir missing */
  }
  return MCC_CARNAGE_DIR;
}

const arg = process.argv[2] ?? (await defaultTarget());

async function pickFile(p: string): Promise<string> {
  const s = await stat(p).catch(() => null);
  if (s?.isFile()) return p;
  if (!s?.isDirectory()) throw new Error(`Not found: ${p}`);
  const xmls = (await readdir(p))
    .filter((f) => /carnage/i.test(f) || extname(f).toLowerCase() === ".xml")
    .map((f) => join(p, f));
  if (!xmls.length) throw new Error(`No carnage/.xml files in ${p}. Drop a sample there or pass a file path.`);
  const withTimes = await Promise.all(xmls.map(async (f) => ({ f, t: (await stat(f)).mtimeMs })));
  return withTimes.sort((a, b) => b.t - a.t)[0].f;
}

/** Collapse a parsed object into a schema skeleton: keys kept, arrays -> [n x firstItem]. */
function skeleton(v: unknown, depth = 0): unknown {
  if (depth > 8) return "…";
  if (Array.isArray(v)) return v.length ? [`${v.length} ×`, skeleton(v[0], depth + 1)] : [];
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = skeleton(val, depth + 1);
    return o;
  }
  return typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : v;
}

const file = await pickFile(arg);
console.log("Inspecting:", file, "\n");

const xml = await readFile(file, "utf8");
const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml);

console.log("=== SCHEMA SKELETON (structure only) ===");
console.log(JSON.stringify(skeleton(parsed), null, 2));

console.log("\n=== RAW HEAD (first 1500 chars of XML) ===");
console.log(xml.slice(0, 1500));

console.log(
  "\nPaste the SCHEMA SKELETON back and I'll write the exact parser " +
    "(player list, gamertags/XUIDs, teams, scores, winner, map, mode, time).",
);
