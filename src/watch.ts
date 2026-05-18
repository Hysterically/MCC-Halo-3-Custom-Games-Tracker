/**
 * The watcher — the thing you actually run on the gaming PC.
 *
 *   npm run watch
 *
 * Watches the MCC carnage folder. Every time MCC drops a new
 * mpcarnagereport*.xml it is parsed; if it's a completed Halo 3 custom we
 * record it (deduped on GameUniqueId), recompute ELO from full history, and
 * post the updated leaderboard to Discord.
 *
 * On startup it ingests any reports already in the folder (silently — no
 * Discord spam) so the DB is current before live watching begins.
 */

import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import chokidar from "chokidar";
import { config } from "./config.ts";
import { openDb, recordMatch, matchCount } from "./db.ts";
import { parseCarnageFile } from "./parseCarnage.ts";
import { announceBoard, startBot } from "./discord.ts";

const elo = { start: config.eloStart, k: config.eloK };
const isCarnage = (f: string): boolean =>
  /carnage/i.test(f) && extname(f).toLowerCase() === ".xml";

const db = openDb(config.dbPath);
console.log(`[db] ${config.dbPath} — ${matchCount(db)} matches before this run`);

/** Parse one file and record it if it's a tracked match. Returns a label if new. */
async function ingest(path: string): Promise<string | null> {
  let report;
  try {
    report = await parseCarnageFile(path);
  } catch (e) {
    console.warn(`[skip] ${path}: ${(e as Error).message}`);
    return null;
  }
  if (!report.tracked) return null;
  if (!recordMatch(db, report)) return null; // dupe — already have it
  return `${report.gameTypeName} · ${report.players.length}p · winner: ${
    report.winners.join(", ") || "—"
  }`;
}

// --- startup backfill (silent) ---------------------------------------------
let startupNew = 0;
try {
  const files = (await readdir(config.carnageDir)).filter(isCarnage);
  for (const f of files) if (await ingest(join(config.carnageDir, f))) startupNew++;
  console.log(
    `[startup] scanned ${files.length} reports in ${config.carnageDir}; ` +
      `${startupNew} new, ${matchCount(db)} total`,
  );
} catch (e) {
  console.error(`[startup] cannot read ${config.carnageDir}: ${(e as Error).message}`);
  console.error("Set MCC_CARNAGE_DIR (see .env.example) and try again.");
  process.exit(1);
}

// --- optional bot ----------------------------------------------------------
if (config.discordBotToken) {
  startBot(config.discordBotToken, config.discordGuildId, db, elo).catch((e) =>
    console.error("[discord] bot failed to start:", e),
  );
} else {
  console.log("[discord] no DISCORD_BOT_TOKEN — slash commands disabled");
}

if (config.discordWebhookUrl) {
  if (startupNew > 0) {
    await announceBoard(db, elo, config.discordWebhookUrl, "♻️ Tracker restarted — current standings:");
  }
} else {
  console.log("[discord] no DISCORD_WEBHOOK_URL — auto-posting disabled");
}

// --- live watch ------------------------------------------------------------
const seen = new Map<string, number>(); // path -> last mtimeMs handled (dedupe rapid events)

const watcher = chokidar.watch(config.carnageDir, {
  ignoreInitial: true,
  depth: 0,
  awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
});

async function onFile(path: string): Promise<void> {
  if (!isCarnage(path)) return;
  const m = await stat(path).then((s) => s.mtimeMs).catch(() => 0);
  if (seen.get(path) === m) return;
  seen.set(path, m);

  const label = await ingest(path);
  if (!label) return;
  console.log(`[match] ${label}`);
  try {
    await announceBoard(db, elo, config.discordWebhookUrl, `🎮 New match: **${label}**`);
  } catch (e) {
    console.error("[discord] post failed:", (e as Error).message);
  }
}

watcher
  .on("add", onFile)
  .on("change", onFile)
  .on("ready", () => console.log(`[watch] live on ${config.carnageDir} — waiting for matches…`))
  .on("error", (e) => console.error("[watch] error:", e));

const shutdown = (): void => {
  console.log("\n[exit] closing…");
  watcher.close().finally(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
