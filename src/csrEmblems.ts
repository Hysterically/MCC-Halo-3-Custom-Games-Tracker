/**
 * Loads and caches the Halo 5 CSR division emblems (assets/csr-<tier>.png) used
 * to render the rank as its in-game logo instead of the tier word. Loaded once;
 * keyed by the `emblem` field on a {@link Csr}.
 */
import { loadImage, type Image } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";

// Per sub-rank emblems for the five named tiers (csr-<tier>-1..6.png) plus the
// single Onyx emblem — matching the `emblem` key on a Csr.
const SUB_TIERS = ["bronze", "silver", "gold", "platinum", "diamond"];
const EMBLEM_KEYS = [
  ...SUB_TIERS.flatMap((t) => [1, 2, 3, 4, 5, 6].map((n) => `${t}-${n}`)),
  "onyx",
  "champion", // Halo 5 Champion insignia, used for the #1 player above the CSR floor
];

let cache: Promise<Record<string, Image>> | undefined;

/** The baked CSR rank emblems, keyed by `<tier>-<sub>` (and "onyx"). Loaded once. */
export function csrEmblems(): Promise<Record<string, Image>> {
  cache ??= (async () => {
    const entries = await Promise.all(
      EMBLEM_KEYS.map(
        async (k) =>
          [k, await loadImage(await readFile(new URL(`../assets/csr-${k}.png`, import.meta.url)))] as const,
      ),
    );
    return Object.fromEntries(entries);
  })();
  return cache;
}
