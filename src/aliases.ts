/**
 * Display-name aliases. Some Gamertags render badly on the board — e.g. a
 * capital "I" that reads like a lowercase "l" (RingRunnerII7 vs Hysterically).
 * This lets a player choose how their name *displays* without rewriting any
 * match history: matches stay keyed by XUID, only the rendered label changes.
 *
 * The map lives in a JSON file (default ./aliases.json, override ALIASES_PATH)
 * keyed by the in-game Gamertag:
 *
 *   { "RingRunnerII7": "Hysterically" }
 *
 * Matching is case-insensitive; unknown names pass through unchanged. The file
 * is read once and cached, so edits take effect on the next run.
 */

import { readFileSync } from "node:fs";
import { config } from "./config.ts";

let cache: Map<string, string> | null = null;

function load(): Map<string, string> {
  if (cache) return cache;
  cache = new Map();
  try {
    const obj = JSON.parse(readFileSync(config.aliasesPath, "utf8")) as Record<string, string>;
    for (const [gamertag, label] of Object.entries(obj)) {
      if (typeof label === "string" && label.trim()) cache.set(gamertag.toLowerCase(), label);
    }
  } catch {
    // No file (or invalid JSON) → no aliases, everyone shown as-is.
  }
  return cache;
}

/** The preferred display name for a Gamertag, or the Gamertag itself. */
export function displayName(gamertag: string): string {
  return load().get(gamertag.toLowerCase()) ?? gamertag;
}
