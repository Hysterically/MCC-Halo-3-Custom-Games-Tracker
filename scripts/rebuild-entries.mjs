/**
 * Rebuild ONLY the bundled .mjs entries into an existing dist/ in place.
 * Unlike bundle.mjs this does NOT wipe dist/, so a live install's .env and
 * data/h3.db are preserved. Use after a code change that doesn't need a
 * fresh node.exe / native-deps copy.
 */
import { resolve, join } from "node:path";
import * as esbuild from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const ENTRIES = ["setup", "watch", "backfill", "board", "announce"];
const EXTERNALS = ["better-sqlite3", "bindings", "file-uri-to-path"];

await esbuild.build({
  entryPoints: ENTRIES.map((e) => ({ in: `src/${e}.ts`, out: e })),
  outdir: DIST,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outExtension: { ".js": ".mjs" },
  external: EXTERNALS,
  banner: {
    js: `import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);`,
  },
  minify: false,
  legalComments: "none",
  logLevel: "info",
});
console.log("[rebuild-entries] done — .mjs entries refreshed in dist/");
