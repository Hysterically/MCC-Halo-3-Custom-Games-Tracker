/**
 * H3 customs watcher — the tiny script friends run (the whole friend install).
 *
 *   node watcher.mjs        (or double-click Run-Tracker.bat)
 *
 * Watches the MCC carnage folder and uploads each completed Halo 3 custom's
 * mpcarnagereport*.xml to the group's private #carnage-inbox channel through a
 * write-only Discord webhook. The bot on the host side does everything else
 * (parse, record, rate, post) — this script never touches the database.
 *
 * The bot's receipt reactions double as a liveness signal: every upload it
 * processes gets a mark within seconds, and a webhook can GET its own messages
 * back. No mark = the tracker is offline; the watcher says so (see receipts).
 *
 * The watcher↔tracker contract (any server rewrite must preserve it):
 *   → upload: webhook POST with the XML attached and a message body ending in
 *     an inline-code line `h3meta {"v":1,"matchId":…,"playedAtMs":…,
 *     "mapName":…,"mapVariant":…,"watcher":"x.y.z"}`.
 *   ← receipts: the bot reacts ✅ recorded / 🔁 duplicate / ⚠️ unusable on the
 *     upload, and adds 🆙 when `watcher` is older than the bot's own copy of
 *     this file (which triggers the self-update offer below).
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
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Bumped with every shipped watcher change. Travels in each upload's h3meta
 * line; the bot compares it against the copy in its own checkout and reacts 🆙
 * when this one is older, which makes the watcher offer a self-update.
 */
const WATCHER_VERSION = "1.1.0";

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

// Friends paste webhook URLs with a trailing slash or a stray ?query tacked on;
// both quietly break the `?wait=true` upload and `/messages/<id>` receipt
// endpoints built from this base. Normalize once, before validation.
cfg.webhookUrl = cfg.webhookUrl.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");

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

const TAG_PAINT = { sent: cyan, ok: green, rate: yellow, retry: yellow, warn: yellow, fail: red, error: red };
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
  const centered = " ".repeat(Math.max(0, Math.floor((innerW - visibleLen(title)) / 2))) + title;
  const body = rows.map(([l, v, light]) =>
    line(padVis(`${l.padEnd(labelW)}  ${v}`, innerW - 2) + " " + light),
  );
  return [
    `┌─${"─".repeat(innerW)}─┐`,
    line(centered),
    `├─${"─".repeat(innerW)}─┤`,
    ...body,
    `└─${"─".repeat(innerW)}─┘`,
  ].join("\n");
}

const WORKING_TEXT = "THE WATCHER IS WORKING — GAMES WILL UPLOAD AUTOMATICALLY ONCE A GAME FINISHES";
const WAITING_TEXT = "GAMES ARE UPLOADING — WAITING FOR THE TRACKER TO CONFIRM (RESULTS MAY POST LATE)";
let trackerOverdue = false; // flips the pinned light yellow while a receipt is overdue
// Plain bold text — a whole line of color is too loud; the ⬤ carries the state.
const workingLine = () =>
  trackerOverdue
    ? `${bold(WAITING_TEXT)}  ${yellow("⬤")}`
    : `${bold(WORKING_TEXT)}  ${green("⬤")}`;

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
    return this.entries.length - 1;
  },
  update(i, entry) {
    if (i < 0 || i >= this.entries.length) return;
    this.entries[i] = entry;
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
    watcher: WATCHER_VERSION,
  }).replaceAll("`", "'"); // a backtick would break the inline-code fence
  return `${human}\n\`h3meta ${json}\``;
}

/**
 * POST the XML + metadata to the webhook. Retries 429/5xx/network; not 4xx.
 * `?wait=true` makes Discord return the created message, whose id feeds the
 * receipt verification below. Returns { ok, msgId } — msgId "" when the upload
 * landed but the id couldn't be read (receipt tracking is then skipped).
 */
async function upload(filePath, xml, meta) {
  const payload = { content: uploadContent(meta), allowed_mentions: { parse: [] } };
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const form = new FormData();
      form.append("payload_json", JSON.stringify(payload));
      form.append("files[0]", new Blob([xml], { type: "application/xml" }), basename(filePath));
      const res = await fetch(`${cfg.webhookUrl}?wait=true`, { method: "POST", body: form });
      if (res.ok) {
        const msg = await res.json().catch(() => null);
        return { ok: true, msgId: typeof msg?.id === "string" ? msg.id : "" };
      }
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
      return { ok: false };
    } catch (e) {
      logLine("retry", `upload failed (${attempt}/5): ${e.message}`);
      await sleep(2 ** attempt * 1000);
    }
  }
  return { ok: false };
}

// --- tracker receipts ------------------------------------------------------------
// The bot stamps every upload it processes with a reaction within seconds
// (✅ recorded, 🔁 duplicate, ⚠️ unusable), and a webhook may GET its own
// messages back with the same token it posts with. That receipt is the only
// tracker-liveness signal visible from a write-only webhook, and it drives the
// offline warning: no mark two minutes after an upload means the tracker isn't
// reading its mail (stopped VM, crashed bot). Marks can land hours late — the
// tracker clears its backlog when it comes back — so overdue games keep
// re-checking slowly and flip to confirmed whenever that happens.

const STATE_PATH = join(HERE, "last-upload.json");
const RECEIPT_MARKS = new Set(["✅", "🔁", "⚠️", "⚠"]);
const UPDATE_MARK = "🆙"; // the bot's "a newer watcher exists" hint
const QUICK_CHECKS_MS = [10_000, 25_000, 45_000, 75_000, 120_000];
const OVERDUE_MS = 115_000; // warn once the ~2-minute check comes back empty
const RECHECK_MS = 5 * 60_000;
const MAX_TRACKED = 5; // newest games that keep polling through a long outage

/**
 * What the bot left on our upload: `receipt` (dealt with) and `update` (newer
 * watcher available) marks, or `gone` when the message was deleted from the
 * inbox. Null when we can't tell (network trouble, any other error).
 */
async function receiptMarks(msgId) {
  try {
    const res = await fetch(`${cfg.webhookUrl}/messages/${msgId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return { receipt: false, update: false, gone: true };
    if (!res.ok) return null;
    const msg = await res.json();
    const names = new Set((msg.reactions ?? []).map((r) => r.emoji?.name));
    return {
      receipt: [...RECEIPT_MARKS].some((m) => names.has(m)),
      update: names.has(UPDATE_MARK),
      gone: false,
    };
  } catch {
    return null;
  }
}

const sentEntry = (item, posted) =>
  `${item.time} ${paintTag("sent")} ${item.label}${
    posted ? ` → posted to game results ${green("✓")}` : " — waiting for the tracker…"
  }`;

const receipts = {
  outstanding: [], // { msgId, label, time, boxIndex } newest-last
  warned: false, // one offline warning per outage, not per game

  /** Verify a fresh upload: pinned-box entry, state file, quick check schedule. */
  track(msgId, label) {
    const item = { msgId, label, time: hhmmss(), boxIndex: -1 };
    item.boxIndex = gamesBox.add(sentEntry(item, false));
    this.outstanding.push(item);
    while (this.outstanding.length > MAX_TRACKED) this.outstanding.shift();
    writeFile(STATE_PATH, JSON.stringify({ msgId, label })).catch(() => {});
    void this.verify(item, QUICK_CHECKS_MS);
  },

  /** Adopt the previous session's last upload, found still unmarked at startup. */
  adopt(msgId, label) {
    const item = { msgId, label, time: hhmmss(), boxIndex: -1 };
    this.outstanding.push(item);
    logLine("warn", `your last game (${label}) was uploaded but its results never posted.`);
    this.overdue();
    void this.verify(item, []);
  },

  /** Re-check `item` on the quick schedule, then every RECHECK_MS forever. */
  async verify(item, quick) {
    const started = Date.now();
    for (let i = 0; ; i++) {
      const at =
        i < quick.length ? quick[i] : (quick.at(-1) ?? 0) + (i - quick.length + 1) * RECHECK_MS;
      await sleep(Math.max(0, started + at - Date.now()));
      if (!this.outstanding.includes(item)) return; // rotated out by MAX_TRACKED — stop
      const marks = await receiptMarks(item.msgId);
      if (marks?.update) void offerUpdate(); // long-running watchers learn of updates here
      if (marks?.receipt) {
        this.confirm(item);
        return;
      }
      if (marks?.gone) {
        // The upload was deleted from the inbox — no receipt will ever come.
        this.outstanding.splice(this.outstanding.indexOf(item), 1);
        gamesBox.update(
          item.boxIndex,
          `${item.time} ${paintTag("sent")} ${item.label} — can't confirm (the upload was removed)`,
        );
        return;
      }
      if (Date.now() - started >= OVERDUE_MS) this.overdue();
    }
  },

  confirm(item) {
    this.outstanding.splice(this.outstanding.indexOf(item), 1);
    gamesBox.update(item.boxIndex, sentEntry(item, true));
    if (this.warned) {
      this.warned = false;
      trackerOverdue = false;
      logLine("ok", `${bold(green("the tracker is back"))} — results posted.`);
    }
  },

  overdue() {
    if (this.warned) return;
    this.warned = true;
    trackerOverdue = true; // logLine below redraws the pinned box, now yellow
    logLine(
      "warn",
      `${bold(yellow("THE TRACKER LOOKS OFFLINE"))} — your game was uploaded safely and results will post automatically when it's back.`,
    );
    logLine(
      "warn",
      `to confirm: check if "Halo 3 Custom Games Tracker" shows online in Discord, and let your host know.`,
    );
  },
};

// --- self-update -----------------------------------------------------------------
// The newest watcher.mjs is published as a GitHub release asset. On startup —
// and whenever the bot stamps an upload with 🆙 — the watcher fetches it and,
// if it's newer, offers to install: the friend types U + Enter, the file swaps
// itself and exits with code 42, which Run-Tracker.bat treats as "relaunch
// now". Every failure path is silent by design (no asset published yet, no
// internet): an update hint must never get in the way of uploading games.

const UPDATE_URL =
  process.env.H3_UPDATE_URL ??
  "https://github.com/Hysterically/MCC-Halo-3-Custom-Games-Tracker/releases/latest/download/watcher.mjs";
const RESTART_EXIT_CODE = 42; // Run-Tracker.bat relaunches immediately on this

const versionIn = (source) => source.match(/^const WATCHER_VERSION = "([0-9.]+)"/m)?.[1];

/** True when version `a` is newer than `b` (numeric, part by part). */
function newerVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** The published watcher, when it's newer than this one; null otherwise. */
async function checkForUpdate() {
  try {
    const res = await fetch(UPDATE_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const content = await res.text();
    const version = versionIn(content);
    if (!version || !newerVersion(version, WATCHER_VERSION)) return null;
    // Paranoia before ever treating the download as runnable: it must look
    // like this file (header marker) and have a sane size.
    if (!content.includes("H3 customs watcher") || content.length < 10_000 || content.length > 1_000_000) {
      return null;
    }
    return { version, content };
  } catch {
    return null;
  }
}

/** Swap this file for `update.content` and restart via the launcher. */
async function applyUpdate(update) {
  while (inFlight.size) await sleep(1000); // never restart mid-upload
  const self = fileURLToPath(import.meta.url);
  const staged = `${self}.new`;
  await writeFile(staged, update.content);
  await rename(staged, self);
  gamesBox.clear();
  console.log(`${hhmmss()} ${paintTag("ok")} updated to v${update.version} — restarting…`);
  process.exit(RESTART_EXIT_CODE);
}

let updateOffer = null; // the update waiting on the friend's U, if any
let lastUpdateCheckMs = 0;

/** Check for a newer release (throttled) and put the offer on the console. */
async function offerUpdate() {
  if (updateOffer) return; // already offered — waiting on the friend
  if (Date.now() - lastUpdateCheckMs < 60_000) return;
  lastUpdateCheckMs = Date.now();
  const update = await checkForUpdate();
  if (!update) return;
  updateOffer = update;
  logLine(
    "warn",
    `${bold(yellow(`A NEW WATCHER VERSION IS READY (v${update.version})`))} — type U and press Enter to update. It takes a few seconds, then the watcher starts again by itself.`,
  );
}

// The console doubles as the UI: a plain line listener (no raw mode, so Ctrl+C
// still works) turns "U + Enter" into accepting the pending update offer.
process.stdin.on("data", (chunk) => {
  if (!updateOffer || String(chunk).trim().toLowerCase() !== "u") return;
  const update = updateOffer;
  updateOffer = null;
  logLine("ok", `updating to v${update.version}…`);
  applyUpdate(update).catch((e) =>
    logLine("error", `the update failed (${e.message}) — still running v${WATCHER_VERSION}, everything keeps working.`),
  );
});

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

  const { ok, msgId } = await upload(path, xml, {
    matchId: screened.matchId,
    gameTypeName: screened.gameTypeName,
    playedAtMs,
    mapName,
    mapVariant,
  });
  if (ok) {
    seenMatches.add(screened.matchId);
    const label = `${screened.gameTypeName || "Custom game"}${mapName ? ` on ${mapName}` : ""}`;
    if (msgId) {
      receipts.track(msgId, label);
    } else {
      gamesBox.add(`${hhmmss()} ${paintTag("sent")} ${label} → game results`);
    }
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
  statusBox(bold(cyan(`H3 Customs Tracker v${WATCHER_VERSION}`)), [
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

// A newer release may be waiting — the offer prints above the box if so.
void offerUpdate();

// Did the previous session's last game ever post? The state file remembers its
// upload; if that message is still unmarked the tracker was down then and very
// likely still is — say so now, before the friend plays into a void. Missing /
// corrupt file, deleted message, or unreachable Discord all just stay quiet.
void (async () => {
  let saved;
  try {
    saved = JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return;
  }
  if (typeof saved?.msgId !== "string" || !saved.msgId) return;
  const marks = await receiptMarks(saved.msgId);
  if (marks && !marks.receipt && !marks.gone) {
    receipts.adopt(saved.msgId, typeof saved.label === "string" && saved.label ? saved.label : "custom game");
  }
})();

const shutdown = () => {
  gamesBox.clear();
  console.log(`${hhmmss()} [exit] closing…`);
  watcher.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
