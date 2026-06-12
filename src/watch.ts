/**
 * The watcher — the thing you actually run on the gaming PC.
 *
 *   npm run watch
 *
 * Watches the MCC carnage folder. Every time MCC drops a new
 * mpcarnagereport*.xml it is parsed; if it's a completed Halo 3 custom we
 * record it (deduped on GameUniqueId), recompute ELO from full history, post
 * a per-match summary to #game-results, and edit the live leaderboard
 * message in #leaderboard.
 *
 * On startup we intentionally do NOT auto-ingest historic reports — the
 * MCC folder accumulates years of XMLs and silently importing them would
 * resurrect dead matches every time the watcher restarts (especially after
 * a wipe). Use `npm run backfill` to opt in to historic ingest.
 */

import { stat } from "node:fs/promises";
import { extname } from "node:path";
import chokidar from "chokidar";
import { config } from "./config.ts";
import { openDb, recordMatch, matchCount, matchesChrono } from "./db.ts";
import { matchEloChanges, type EloChange } from "./elo.ts";
import { parseCarnageFile, type CarnageReport } from "./parseCarnage.ts";
import { findMapInfo } from "./mapInfo.ts";
import { postMatchResult, upsertLeaderboard, startBot } from "./discord.ts";

const elo = { start: config.eloStart, k: config.eloK };
const isCarnage = (f: string): boolean =>
  /carnage/i.test(f) && extname(f).toLowerCase() === ".xml";

const db = await openDb(config.dbUrl, config.dbAuthToken);
console.log(`[db] ${config.dbUrl} — ${await matchCount(db)} matches before this run`);

/** Parse one file and record it if it's a tracked match. Returns it on success. */
async function ingest(path: string): Promise<CarnageReport | null> {
  let report: CarnageReport;
  try {
    report = await parseCarnageFile(path);
  } catch (e) {
    console.warn(`[skip] ${path}: ${(e as Error).message}`);
    return null;
  }
  if (!report.tracked) return null;
  // Best-effort map lookup: the theater film lands a few seconds after the
  // XML, so poll for it briefly before recording.
  try {
    const map = await findMapInfo(config.carnageDir, report.playedAt.getTime(), 45_000);
    report.mapName = map.mapName;
    report.mapVariant = map.mapVariant;
  } catch {
    // no map info — the post and the DB row just omit it
  }
  try {
    if (!(await recordMatch(db, report))) return null; // dupe — already recorded (here or another instance)
  } catch (e) {
    // A transient DB error (e.g. the shared remote DB hiccuped) shouldn't kill
    // the watcher — skip this file; the next event or a restart re-ingests it.
    console.error(`[db] record failed for ${path}: ${(e as Error).message}`);
    return null;
  }
  return report;
}

const label = (r: CarnageReport): string =>
  `${r.gameTypeName}${r.mapName ? ` on ${r.mapName}` : ""} · ${r.players.length}p · winner: ${
    r.winners.join(", ") || "—"
  }`;

// --- startup -------------------------------------------------------------
// No auto-backfill: historic reports already in the folder are ignored.
// Run `npm run backfill` for intentional historic ingest.
console.log(`[watch] tracking new matches in ${config.carnageDir}`);

// --- optional bot ----------------------------------------------------------
if (config.discordBotToken) {
  startBot(config.discordBotToken, config.discordGuildId, db, elo).catch((e) =>
    console.error("[discord] bot failed to start:", e),
  );
} else {
  console.log("[discord] no DISCORD_BOT_TOKEN — slash commands disabled");
}

if (!config.discordResultsWebhookUrl) {
  console.log("[discord] no DISCORD_RESULTS_WEBHOOK_URL — per-match posts disabled");
}
if (!config.discordLeaderboardWebhookUrl) {
  console.log("[discord] no DISCORD_LEADERBOARD_WEBHOOK_URL — live leaderboard disabled");
}

// Refresh the leaderboard once on startup so it survives DB edits (e.g. a
// manual wipe) or a manually-deleted leaderboard message.
if (config.discordLeaderboardWebhookUrl) {
  try {
    await upsertLeaderboard(config.discordLeaderboardWebhookUrl, db, elo);
  } catch (e) {
    console.error("[discord] startup leaderboard refresh failed:", (e as Error).message);
  }
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

  const report = await ingest(path);
  if (!report) return;
  console.log(`[match] ${label(report)}`);

  // Per-player ELO rating + change for the result post — replayed from the
  // recorded history, so it matches exactly what the leaderboard will apply.
  // Best effort: a DB hiccup just posts the result without the ratings.
  let eloChanges: Map<string, EloChange> | null = null;
  try {
    eloChanges = matchEloChanges(await matchesChrono(db), report.matchId, elo);
  } catch (e) {
    console.error("[elo] change computation failed:", (e as Error).message);
  }

  try {
    await postMatchResult(config.discordResultsWebhookUrl, report, eloChanges ?? undefined);
  } catch (e) {
    console.error("[discord] result post failed:", (e as Error).message);
  }
  try {
    await upsertLeaderboard(config.discordLeaderboardWebhookUrl, db, elo);
  } catch (e) {
    console.error("[discord] leaderboard upsert failed:", (e as Error).message);
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
