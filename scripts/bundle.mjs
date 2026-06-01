/**
 * Build a self-contained Windows distribution: portable node.exe + bundled
 * JS + native sqlite binary + double-clickable launcher + plain-English
 * README, zipped for end users.
 *
 *   npm run bundle
 *
 * Output: dist/             (the unzipped layout)
 *         h3-tracker-windows.zip   (what you actually ship)
 *
 * End-user flow: extract the zip, double-click Start.bat, paste two Discord
 * webhook URLs the first time.
 */

import { rm, mkdir, readFile, writeFile, cp, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import * as esbuild from "esbuild";
import AdmZip from "adm-zip";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const ZIP_OUT = join(ROOT, "h3-tracker-windows.zip");
// Match the dev machine's Node. better-sqlite3's .node binary was compiled
// against this version's ABI; shipping a different runtime breaks dlopen.
const NODE_VERSION = `v${process.versions.node}`;
const NODE_ZIP_NAME = `node-${NODE_VERSION}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP_NAME}`;
const NODE_CACHE = join(tmpdir(), `h3-tracker-${NODE_ZIP_NAME}`);

const ENTRIES = ["setup", "watch", "backfill", "board", "announce"];
// better-sqlite3 is a native module; stays external and ships as a real
// node_modules entry that node.exe resolves at runtime.
const EXTERNALS = ["better-sqlite3", "bindings", "file-uri-to-path"];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function downloadNode() {
  if (await exists(NODE_CACHE)) {
    console.log(`[node] using cached ${NODE_CACHE}`);
    return;
  }
  console.log(`[node] downloading ${NODE_URL}`);
  const res = await fetch(NODE_URL);
  if (!res.ok) throw new Error(`node download failed: HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(NODE_CACHE));
  console.log(`[node] cached at ${NODE_CACHE}`);
}

async function extractNodeExe() {
  const zip = new AdmZip(NODE_CACHE);
  const entry = zip.getEntries().find((e) => e.entryName.endsWith("/node.exe"));
  if (!entry) throw new Error("node.exe not found in downloaded zip");
  await writeFile(join(DIST, "node.exe"), entry.getData());
  console.log(`[node] extracted node.exe (${entry.getData().length} bytes)`);
}

async function bundleEntries() {
  await esbuild.build({
    entryPoints: ENTRIES.map((e) => ({ in: `src/${e}.ts`, out: e })),
    outdir: DIST,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outExtension: { ".js": ".mjs" }, // .mjs so Node treats them as ESM unconditionally
    external: EXTERNALS,
    // CJS deps (dotenv etc.) internally call require('fs') etc. ESM has no
    // module-scope `require`, so esbuild emits a __require helper that
    // checks `typeof require !== "undefined"` and falls through. Providing a
    // real createRequire-backed `require` lets that fall-through succeed.
    banner: {
      js: `import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);`,
    },
    minify: false, // keep readable in case end users open a file
    legalComments: "none",
    logLevel: "info",
  });
}

async function copyNativeDeps() {
  // Copy just enough of each external package to satisfy `require()`.
  // For better-sqlite3 that's lib/ + the compiled .node + package.json;
  // for bindings/file-uri-to-path it's the whole (tiny) package.
  const out = join(DIST, "node_modules");
  await mkdir(out, { recursive: true });

  // better-sqlite3: skip build/ junk except the .node binary
  const bsRoot = join(ROOT, "node_modules", "better-sqlite3");
  const bsOut = join(out, "better-sqlite3");
  await cp(join(bsRoot, "lib"), join(bsOut, "lib"), { recursive: true });
  await cp(join(bsRoot, "package.json"), join(bsOut, "package.json"));
  await mkdir(join(bsOut, "build", "Release"), { recursive: true });
  await cp(
    join(bsRoot, "build", "Release", "better_sqlite3.node"),
    join(bsOut, "build", "Release", "better_sqlite3.node"),
  );

  // The two pure-JS resolution helpers.
  for (const pkg of ["bindings", "file-uri-to-path"]) {
    await cp(join(ROOT, "node_modules", pkg), join(out, pkg), { recursive: true });
  }
}

const START_BAT = `@echo off
cd /d "%~dp0"
title Halo 3 Customs Tracker
node.exe setup.mjs
if errorlevel 1 (
  echo.
  echo Setup did not finish. Press any key to close.
  pause >nul
  exit /b 1
)
node.exe watch.mjs
echo.
echo Tracker stopped. Press any key to close.
pause >nul
`;

const SETUP_BAT = `@echo off
cd /d "%~dp0"
title Halo 3 Customs Tracker - Reconfigure
node.exe setup.mjs --force
echo.
echo Done. Press any key to close.
pause >nul
`;

const README_TXT = `============================================
 Halo 3 Customs Tracker
============================================

Tracks Halo 3 (MCC) custom games on your gaming PC and posts results
plus a live ELO leaderboard to Discord. Reads the post-match XML files
MCC writes locally - no Microsoft sign-in, no web API.

--------------------------------------------
 Quick start
--------------------------------------------
  1. Double-click "Start.bat".
  2. First time only: it will ask for two Discord webhook URLs.
     The on-screen instructions explain how to create them.
  3. Leave the window open while you play.

  Match results appear in your #game-results channel,
  the leaderboard updates in #leaderboard.

--------------------------------------------
 Reconfigure Discord
--------------------------------------------
  Double-click "Setup.bat" to re-enter the webhook URLs (for example
  if you changed channels or rotated the URLs).

--------------------------------------------
 Where is my data?
--------------------------------------------
  - Settings:       .env             (next to Start.bat)
  - Match history:  data\\h3.db       (next to Start.bat)

  Delete either to reset that piece. Delete both for a full fresh
  start.

--------------------------------------------
 Important - only one PC should run this
--------------------------------------------
  Only the PC hosting the custom game has the match data, and each
  install has its own local history. Pick one "tracker PC" (whoever
  hosts most often) and only run Start.bat there. If two people run
  it during the same game you will get duplicate Discord posts and
  out-of-sync leaderboards.

--------------------------------------------
 Troubleshooting
--------------------------------------------
  * "Cannot read MCC folder" on start:
    The tracker looks at
       %USERPROFILE%\\AppData\\LocalLow\\MCC\\Temporary
    If your MCC stores reports elsewhere, open .env in Notepad and
    add a line:
       MCC_CARNAGE_DIR=C:\\path\\to\\your\\mcc\\temporary

  * Nothing happens after a match:
    - Only CUSTOM games are tracked, not matchmaking.
    - Only the HOST's PC sees the XML, so the tracker must be running
      on whoever hosted that lobby.
    - Wait ~10 seconds after the post-game screen for MCC to write
      the XML.

  * Window closes immediately when I double-click Start.bat:
    It probably crashed. Right-click Start.bat -> Edit and remove
    the "@echo off" line to see what went wrong, then re-add it.
`;

async function writeUserFiles() {
  await writeFile(join(DIST, "Start.bat"), START_BAT, "utf8");
  await writeFile(join(DIST, "Setup.bat"), SETUP_BAT, "utf8");
  await writeFile(join(DIST, "README.txt"), README_TXT, "utf8");
}

// Ship the display-name aliases next to the launcher. The runtime resolves
// aliasesPath as cwd/aliases.json and Start.bat cd's into the extract folder,
// so without this the leaderboard renders raw Gamertags (e.g. "HystericaIly"
// instead of "Hysterically"). Optional: skip silently if there's no file.
async function copyAliases() {
  const src = join(ROOT, "aliases.json");
  if (await exists(src)) {
    await cp(src, join(DIST, "aliases.json"));
    console.log("[aliases] bundled aliases.json");
  } else {
    console.log("[aliases] no aliases.json at repo root; skipping");
  }
}

async function makeZip() {
  console.log(`[zip] building ${ZIP_OUT}`);
  const zip = new AdmZip();
  // Flat layout — Start.bat sits at the root of the zip so that on
  // extraction Windows' default "extract to folder named after the zip"
  // produces <folder>/Start.bat instead of <folder>/h3-tracker/Start.bat.
  zip.addLocalFolder(DIST);
  zip.writeZip(ZIP_OUT);
  const size = (await stat(ZIP_OUT)).size;
  console.log(`[zip] ${ZIP_OUT} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

// --- main -----------------------------------------------------------------
console.log("[bundle] cleaning dist/");
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await mkdir(join(DIST, "data"), { recursive: true }); // db lives here at runtime

await downloadNode();
await extractNodeExe();
await bundleEntries();
await copyNativeDeps();
await writeUserFiles();
await copyAliases();
await makeZip();

console.log("\n[bundle] done.");
console.log(`        dist/  -> unzipped tree`);
console.log(`        ${ZIP_OUT}`);
console.log("        Ship the .zip. End-user: extract -> double-click Start.bat.");
