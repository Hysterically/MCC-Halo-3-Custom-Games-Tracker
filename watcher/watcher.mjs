/**
 * H3 customs watcher — the tiny script friends run (the whole friend install).
 *
 *   node watcher.mjs        (or double-click Run-Watcher.bat)
 *
 * Watches the MCC carnage folder and uploads each completed Halo 3 custom's
 * mpcarnagereport*.xml to the group's private #carnage-inbox channel through a
 * write-only Discord webhook. The bot on the host side does everything else
 * (parse, record, rate, post) — this script never touches the database.
 *
 * Deliberately zero-dependency: plain Node 18+ (built-in fetch/FormData/watch),
 * nothing to npm-install, no EXE for Defender to flag. Config comes from a
 * `watcher.env` file next to this script (see watcher.env.example).
 *
 * Live-only by choice: games played while this window is closed are NOT
 * scanned for on startup (the MCC folder holds years of XMLs, and silently
 * dredging them up caused problems in the old architecture). The bot dedupes
 * by GameUniqueId anyway, so worst case a re-upload is ignored.
 */

import { watch } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- config ------------------------------------------------------------------

/** KEY=VALUE lines; # comments and blanks ignored. Values keep inner spaces. */
function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

let fileCfg = {};
try {
  fileCfg = parseEnvFile(await readFile(join(HERE, "watcher.env"), "utf8"));
} catch {
  // no watcher.env — env vars may still carry the config
}

const cfg = {
  /** The #carnage-inbox webhook — the only secret friends hold, and it's write-only. */
  webhookUrl: process.env.H3_INBOX_WEBHOOK_URL ?? fileCfg.WEBHOOK_URL ?? "",
  carnageDir:
    process.env.MCC_CARNAGE_DIR ??
    fileCfg.MCC_CARNAGE_DIR ??
    join(homedir(), "AppData", "LocalLow", "MCC", "Temporary"),
};

if (typeof fetch !== "function" || typeof FormData !== "function") {
  console.error(
    "This watcher needs Node.js 18 or newer. Install the LTS from https://nodejs.org and run it again.",
  );
  process.exit(1);
}
if (!/^https?:\/\//.test(cfg.webhookUrl) || cfg.webhookUrl.includes("CHANGE/ME")) {
  console.error(
    "No Discord webhook configured.\n" +
      "Put the group's upload URL in watcher.env next to this script, like:\n" +
      "  WEBHOOK_URL=https://discord.com/api/webhooks/...\n" +
      "Ask your host for the line if you don't have it.",
  );
  process.exit(1);
}
// Not fatal (lets a test server stand in for Discord), but a friend with a
// mangled URL should hear about it before their games silently fail to send.
// Printed below the banner once the console is set up.
const urlWarn = /^https:\/\/(\w+\.)?discord\.com\/api\/webhooks\/\d+\/[\w-]+/.test(cfg.webhookUrl)
  ? ""
  : "WEBHOOK_URL doesn't look like a Discord webhook — uploads may fail.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- console presentation --------------------------------------------------------
// A miniature of src/term.ts's look: boxed panels, colored [tag] lines, HH:MM:SS
// stamps, and a pinned tracked-games box at the bottom. dim/gray are deliberately
// absent — they render unreadably on Windows Terminal dark themes, so hierarchy
// comes from the accent colors only. Everything degrades to plain text off a TTY.

const isTTY = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const sgr = (code, s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => sgr("1", s);
const red = (s) => sgr("31", s);
const green = (s) => sgr("32", s);
const yellow = (s) => sgr("33", s);
const cyan = (s) => sgr("36", s);

const TAG_PAINT = { sent: cyan, rate: yellow, retry: yellow, warn: yellow, fail: red, error: red };
const paintTag = (tag) => (TAG_PAINT[tag] ?? ((s) => s))(`[${tag}]`);

function hhmmss() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Visible width of a string: length with any ANSI color codes stripped. */
const visibleLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const padVis = (s, w) => s + " ".repeat(Math.max(0, w - visibleLen(s)));

const maxBoxInner = () => Math.max(40, (process.stdout.columns ?? 100) - 4);

/**
 * A status panel box: title row, separator, then `label  value  ●` rows with the
 * light right-aligned against the border. Values too long for the terminal keep
 * their tail (the end of a path is the informative part).
 */
function statusBox(title, rows) {
  const labelW = Math.max(...rows.map(([l]) => l.length));
  const budget = maxBoxInner() - labelW - 2 - 2;
  rows = rows.map(([l, v, light]) => [l, v.length > budget ? `…${v.slice(-(budget - 1))}` : v, light]);
  const innerW = Math.min(
    maxBoxInner(),
    Math.max(visibleLen(title), ...rows.map(([, v]) => labelW + 2 + v.length + 2)),
  );
  const line = (s) => `│ ${padVis(s, innerW)} │`;
  const body = rows.map(([l, v, light]) =>
    line(padVis(`${l.padEnd(labelW)}  ${v}`, innerW - 2) + " " + light),
  );
  return [
    `┌─${"─".repeat(innerW)}─┐`,
    line(title),
    `├─${"─".repeat(innerW)}─┤`,
    ...body,
    `└─${"─".repeat(innerW)}─┘`,
  ].join("\n");
}

const WORKING_TEXT = "THE WATCHER IS WORKING — GAMES WILL UPLOAD AUTOMATICALLY ONCE A GAME FINISHES";
const workingLine = () => `${bold(green(WORKING_TEXT))}  ${green("⬤")}`;

/**
 * The pinned tracked-games box: title, one row per uploaded game, then the
 * all-caps working line — always the last thing on the console. On a TTY it's
 * wiped (cursor-up + clear) and redrawn whenever a game lands or another line
 * must print above it; off a TTY it prints plainly, once, with no escapes.
 */
const gamesBox = {
  entries: [],
  drawnHeight: 0,
  active: false,
  lines() {
    const rows = this.entries.length ? this.entries : ["(none yet)"];
    const all = [bold("TRACKED GAMES SO FAR"), ...rows, workingLine()];
    const innerW = Math.min(maxBoxInner(), Math.max(...all.map(visibleLen)));
    const line = (s) => `│ ${padVis(s, innerW)} │`;
    return [
      `┌─${"─".repeat(innerW)}─┐`,
      line(all[0]),
      `├─${"─".repeat(innerW)}─┤`,
      ...rows.map(line),
      `├─${"─".repeat(innerW)}─┤`,
      line(workingLine()),
      `└─${"─".repeat(innerW)}─┘`,
    ];
  },
  draw() {
    if (!isTTY || !this.active) return;
    const ls = this.lines();
    process.stdout.write(ls.join("\n") + "\n");
    this.drawnHeight = ls.length;
  },
  clear() {
    if (!isTTY || !this.drawnHeight) return;
    process.stdout.write(`\x1b[${this.drawnHeight}A\x1b[0J`);
    this.drawnHeight = 0;
  },
  start() {
    this.active = true;
    if (isTTY) {
      this.draw();
    } else {
      console.log("TRACKED GAMES SO FAR:");
      console.log(WORKING_TEXT);
    }
  },
  add(entry) {
    this.entries.push(entry);
    if (isTTY) {
      this.clear();
      this.draw();
    } else {
      console.log(entry);
    }
  },
};

/** Print a timestamped `[tag]` line above the pinned tracked-games box. */
function logLine(tag, msg) {
  gamesBox.clear();
  console.log(`${hhmmss()} ${paintTag(tag)} ${msg}`);
  gamesBox.draw();
}

// --- pre-filter ----------------------------------------------------------------
// A cheap regex screen so only completed Halo 3 customs reach the inbox — the
// same three checks the bot's real parser applies (src/parseCarnage.ts):
// mGameEnum === 2 (Halo 3), IsMatchmaking === false, mLastMatchIncomplete === false.

function screenReport(xml) {
  if (!xml.includes("<MultiplayerCarnageReport")) return { drop: "not a carnage report" };
  const attr = (name) => {
    const m = xml.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : undefined;
  };
  if (attr("mGameEnum") !== "2") return { drop: "not Halo 3" };
  if (attr("IsMatchmaking") !== "false") return { drop: "matchmaking, not a custom" };
  if (attr("mLastMatchIncomplete") !== "false") return { drop: "incomplete game" };
  if (!xml.includes("<Player ")) return { drop: "no players" };
  const matchId = attr("GameUniqueId");
  if (!matchId) return { drop: "no GameUniqueId" };
  return { matchId, gameTypeName: attr("GameTypeName") ?? "" };
}

// --- map detection ---------------------------------------------------------------
// Ported from the tracker's src/mapInfo.ts. The XML has no map field; MCC leaves
// two breadcrumbs in sibling folders on THIS PC — which is exactly why the watcher
// (not the bot) must look them up and send the names along with the upload:
//   Movie\asq_<scenario>_… .mov — theater film, lands seconds AFTER the game, base map
//   Map\<hexts>.mvar           — map variant loaded at game START, display name inside

const MAP_NAMES = {
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

const FILM_BEFORE_MS = 60_000;
const FILM_AFTER_MS = 5 * 60_000;
const MVAR_MAX_AGE_MS = 4 * 60 * 60_000;
const MAP_POLL_MS = 3_000;

/** mtimeMs of every file with `ext` in `dir` (empty map on a missing dir). */
async function mtimes(dir, ext) {
  const out = new Map();
  let names;
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

async function filmMapName(movieDir, playedAtMs) {
  const films = await mtimes(movieDir, ".mov");
  let best;
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

/** First printable UTF-16BE run of 4+ chars — the variant's display name. */
function firstUtf16BeString(buf) {
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

async function mvarVariant(mapDir, playedAtMs) {
  const mvars = await mtimes(mapDir, ".mvar");
  let best;
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
    return firstUtf16BeString(await readFile(join(mapDir, best)));
  } catch {
    return undefined;
  }
}

/** The film lands ~7s after the XML, so poll for it up to `waitMs`. */
async function findMapInfo(playedAtMs, waitMs) {
  const movieDir = join(cfg.carnageDir, "UserContent", "Halo3", "Movie");
  const mapDir = join(cfg.carnageDir, "UserContent", "Halo3", "Map");

  const deadline = Date.now() + waitMs;
  let mapName = await filmMapName(movieDir, playedAtMs);
  while (!mapName && Date.now() < deadline) {
    await sleep(MAP_POLL_MS);
    mapName = await filmMapName(movieDir, playedAtMs);
  }
  return { mapName, mapVariant: await mvarVariant(mapDir, playedAtMs) };
}

// --- upload --------------------------------------------------------------------

/**
 * The upload message the bot parses: a human line for anyone reading the
 * channel, then an `h3meta {...}` inline-code line carrying matchId,
 * played-time (file mtime — the XML has no timestamp) and the map breadcrumbs.
 */
function uploadContent(meta) {
  const map = meta.mapVariant ?? meta.mapName;
  const human = `🎮 **${meta.gameTypeName || "Custom Game"}**` + (map ? ` on ${map}` : "");
  const json = JSON.stringify({
    v: 1,
    matchId: meta.matchId,
    playedAtMs: Math.round(meta.playedAtMs),
    mapName: meta.mapName,
    mapVariant: meta.mapVariant,
  }).replaceAll("`", "'"); // a backtick would break the inline-code fence
  return `${human}\n\`h3meta ${json}\``;
}

/** POST the XML + metadata to the webhook. Retries 429/5xx/network; not 4xx. */
async function upload(filePath, xml, meta) {
  const payload = { content: uploadContent(meta), allowed_mentions: { parse: [] } };
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const form = new FormData();
      form.append("payload_json", JSON.stringify(payload));
      form.append("files[0]", new Blob([xml], { type: "application/xml" }), basename(filePath));
      const res = await fetch(cfg.webhookUrl, { method: "POST", body: form });
      if (res.ok) return true;
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const waitS = Number(body.retry_after) || 2;
        logLine("rate", `Discord asked us to wait ${waitS}s…`);
        await sleep(waitS * 1000 + 250);
        continue;
      }
      if (res.status >= 500) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      // Other 4xx = a config problem (revoked webhook, bad URL) — retrying won't help.
      logLine("fail", `Discord said ${res.status}: ${await res.text().catch(() => "")}`);
      return false;
    } catch (e) {
      logLine("retry", `upload failed (${attempt}/5): ${e.message}`);
      await sleep(2 ** attempt * 1000);
    }
  }
  return false;
}

// --- watch loop ------------------------------------------------------------------

const seenMatches = new Set(); // GameUniqueIds uploaded this session
const inFlight = new Set(); // paths currently queued/processing (dedupe rapid events)
let queue = Promise.resolve(); // uploads run strictly one at a time

const isCarnage = (name) => /carnage/i.test(name) && name.toLowerCase().endsWith(".xml");

/** Poll until size+mtime hold still (MCC is still writing when the event fires). */
async function waitForStableFile(path, { checks = 3, intervalMs = 500, timeoutMs = 30_000 } = {}) {
  let last = null;
  let stable = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let s;
    try {
      s = await stat(path);
    } catch {
      return null; // vanished
    }
    const key = `${s.size}:${s.mtimeMs}`;
    stable = key === last ? stable + 1 : 1;
    last = key;
    if (stable >= checks) return s;
    await sleep(intervalMs);
  }
  return stat(path).catch(() => null);
}

async function processFile(path) {
  const s = await waitForStableFile(path);
  if (!s) return;
  const xml = await readFile(path, "utf8");
  const screened = screenReport(xml);
  if (screened.drop) return; // not a finished Halo 3 custom — nothing worth showing
  if (seenMatches.has(screened.matchId)) return;

  // played-at = file mtime; the film that names the map lands a few seconds later.
  const playedAtMs = s.mtimeMs;
  const { mapName, mapVariant } = await findMapInfo(playedAtMs, 45_000);

  const ok = await upload(path, xml, {
    matchId: screened.matchId,
    gameTypeName: screened.gameTypeName,
    playedAtMs,
    mapName,
    mapVariant,
  });
  if (ok) {
    seenMatches.add(screened.matchId);
    gamesBox.add(
      `${hhmmss()} ${paintTag("sent")} ${screened.gameTypeName || "Custom game"}${
        mapName ? ` on ${mapName}` : ""
      } → game results`,
    );
  } else {
    logLine("fail", `could not upload ${basename(path)} — results for this game won't post.`);
  }
}

function enqueue(path) {
  if (inFlight.has(path)) return;
  inFlight.add(path);
  queue = queue
    .then(() => processFile(path))
    .catch((e) => logLine("error", `${basename(path)}: ${e.message}`))
    .finally(() => inFlight.delete(path));
}

let watcher;
try {
  watcher = watch(cfg.carnageDir, (_event, filename) => {
    if (!filename || !isCarnage(filename)) return;
    enqueue(join(cfg.carnageDir, filename));
  });
} catch (e) {
  console.error(
    `Can't watch ${cfg.carnageDir}: ${e.message}\n` +
      "Is MCC installed? If your folder is somewhere else, set MCC_CARNAGE_DIR in watcher.env.",
  );
  process.exit(1);
}

// The Connected light has to be truthful: GET on a Discord webhook URL returns
// its info without posting anything, so it doubles as a free reachability check.
const webhookOk = await (async () => {
  try {
    const res = await fetch(cfg.webhookUrl, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
})();

console.log(
  statusBox(bold(cyan("H3 Customs Watcher")), [
    ["Connected", "to the database", webhookOk ? green("●") : red("●")],
    ["Watching", cfg.carnageDir, green("●")],
  ]),
);
console.log(" How it works: keep this window open — when a custom ends it's sent to the");
console.log(" tracker, which posts to the leaderboard and game results channels on Discord.");
console.log("");
if (urlWarn) logLine("warn", urlWarn);
if (!webhookOk) {
  logLine(
    "warn",
    "can't reach Discord right now — uploads may fail. If this keeps happening, ask your host for a fresh watcher.env.",
  );
}
gamesBox.start();

const shutdown = () => {
  gamesBox.clear();
  console.log(`${hhmmss()} [exit] closing…`);
  watcher.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
