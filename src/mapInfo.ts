/**
 * Map detection. The carnage XML has no map field, but MCC leaves two
 * breadcrumbs in sibling folders under the same Temporary dir:
 *
 *  - UserContent\Halo3\Movie\asq_<scenario>_<crc>_<hexts>.mov — the temporary
 *    theater film, written seconds AFTER the game ends, with the base map's
 *    scenario name (truncated to 7 chars) in the filename.
 *  - UserContent\Halo3\Map\<hexts>.mvar — the map variant loaded for the game,
 *    written at game START; the variant's display name (e.g. "MLG CStruct
 *    TS8") is the first UTF-16BE string in the blob.
 *
 * Both are best-effort: films rotate quickly and built-in variants may not
 * write an .mvar, so either field can come back undefined.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface MapInfo {
  mapName?: string;
  mapVariant?: string;
}

/** Halo 3 scenario stems as MCC truncates them in film filenames (7 chars). */
const MAP_NAMES: Record<string, string> = {
  armory: "Rat's Nest",
  bunkerw: "Standoff",
  chill: "Narrows",
  chillou: "Cold Storage",
  constru: "Construct",
  cyberdy: "The Pit",
  deadloc: "High Ground",
  descent: "Assembly",
  docks: "Longshore",
  fortres: "Citadel",
  ghostto: "Ghost Town",
  guardia: "Guardian",
  isolati: "Isolation",
  lockout: "Blackout",
  midship: "Heretic",
  riverwo: "Valhalla",
  salvati: "Epitaph",
  sandbox: "Sandbox",
  shrine: "Sandtrap",
  sidewin: "Avalanche",
  snowbou: "Snowbound",
  spaceca: "Orbital",
  warehou: "Foundry",
  zanziba: "Last Resort",
};

/** Film written within a minute before the report up to this long after it. */
const FILM_BEFORE_MS = 60_000;
const FILM_AFTER_MS = 5 * 60_000;
/** An .mvar older than this is assumed stale (different variant replayed). */
const MVAR_MAX_AGE_MS = 4 * 60 * 60_000;
const POLL_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** mtimeMs of every file with `ext` in `dir` ({} on a missing dir). */
async function mtimes(dir: string, ext: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.toLowerCase().endsWith(ext)) continue;
    const m = await stat(join(dir, n)).then((s) => s.mtimeMs).catch(() => 0);
    if (m) out.set(n, m);
  }
  return out;
}

/** Base map from the film closest in time to the report, or undefined. */
async function filmMapName(movieDir: string, playedAtMs: number): Promise<string | undefined> {
  const films = await mtimes(movieDir, ".mov");
  let best: string | undefined;
  let bestDist = Infinity;
  for (const [name, m] of films) {
    if (m < playedAtMs - FILM_BEFORE_MS || m > playedAtMs + FILM_AFTER_MS) continue;
    const dist = Math.abs(m - playedAtMs);
    if (dist < bestDist) {
      best = name;
      bestDist = dist;
    }
  }
  const stem = best?.match(/^asq_([a-z0-9]+)_/i)?.[1].toLowerCase();
  if (!stem) return undefined;
  return MAP_NAMES[stem] ?? stem[0].toUpperCase() + stem.slice(1);
}

/** Variant name from the newest .mvar written before (or with) the report. */
async function mvarVariant(mapDir: string, playedAtMs: number): Promise<string | undefined> {
  const mvars = await mtimes(mapDir, ".mvar");
  let best: string | undefined;
  let bestM = -Infinity;
  for (const [name, m] of mvars) {
    if (m > playedAtMs + FILM_BEFORE_MS || m < playedAtMs - MVAR_MAX_AGE_MS) continue;
    if (m > bestM) {
      best = name;
      bestM = m;
    }
  }
  if (!best) return undefined;
  try {
    const buf = await readFile(join(mapDir, best));
    return firstUtf16BeString(buf);
  } catch {
    return undefined;
  }
}

/** First printable UTF-16BE run of 4+ chars — the variant's display name. */
function firstUtf16BeString(buf: Buffer): string | undefined {
  let run = "";
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const c = (buf[i] << 8) | buf[i + 1];
    if (c >= 0x20 && c < 0x7f) {
      run += String.fromCharCode(c);
    } else {
      if (run.length >= 4) return run.trim();
      run = "";
    }
  }
  return run.length >= 4 ? run.trim() : undefined;
}

/**
 * Find the map for a report by its mtime. The film lands ~7s after the XML,
 * so the live watcher passes `waitMs` to poll for it; backfill passes 0 and
 * takes whatever survived rotation.
 */
export async function findMapInfo(
  carnageDir: string,
  playedAtMs: number,
  waitMs = 0,
): Promise<MapInfo> {
  const movieDir = join(carnageDir, "UserContent", "Halo3", "Movie");
  const mapDir = join(carnageDir, "UserContent", "Halo3", "Map");

  const deadline = Date.now() + waitMs;
  let mapName = await filmMapName(movieDir, playedAtMs);
  while (!mapName && Date.now() < deadline) {
    await sleep(POLL_MS);
    mapName = await filmMapName(movieDir, playedAtMs);
  }

  return { mapName, mapVariant: await mvarVariant(mapDir, playedAtMs) };
}
