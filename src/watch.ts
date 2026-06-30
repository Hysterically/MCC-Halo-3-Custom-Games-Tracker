/**
 * The watcher — the thing you actually run on the gaming PC.
 *
 *   npm run watch
 *
 * Watches the MCC carnage folder. Every time MCC drops a new
 * mpcarnagereport*.xml it is parsed; if it's a completed Halo 3 custom we
 * record it (deduped on GameUniqueId), recompute CSR (TrueSkill 2) from full
 * history, post a per-match summary to #game-results, and edit the live
 * leaderboard message in #leaderboard.
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
import {
  openDb,
  recordMatch,
  matchCount,
  matchesChrono,
  setMatchResultsMsg,
  setMatchResultsFmt,
  hiddenXuids,
} from "./db.ts";
import { matchCsrChanges, matchWinChances, type CsrChange, type MatchWinChances } from "./trueskill2.ts";
import { parseCarnageFile, type CarnageReport } from "./parseCarnage.ts";
import { findMapInfo } from "./mapInfo.ts";
import { postCsrMatchResultWithControls, upsertCsrLeaderboard, startBot } from "./discord.ts";
import { healStaleResults } from "./heal.ts";
import { checkForUpdate } from "./updateCheck.ts";
import { RESULTS_FMT_VERSION } from "./version.ts";
import { statusBar, banner, hint, c } from "./term.ts";
import { categorize, CATEGORY_LABEL } from "./category.ts";
import { displayName } from "./aliases.ts";
import { csrText } from "./csr.ts";

const isCarnage = (f: string): boolean =>
  /carnage/i.test(f) && extname(f).toLowerCase() === ".xml";

// The remote DB lives in AWS and may be cold; opening it + counting matches is
// a couple of network round-trips. Print one line first so the window isn't
// blank while we wait — the banner (which needs the count) follows.
console.log(c.dim("Connecting to the database…"));
const db = await openDb(config.dbUrl, config.dbAuthToken);
const startCount = await matchCount(db);

// Live dashboard: a boxed config summary up top, then a self-updating footer.
statusBar.start();
banner("Halo 3 Customs Tracker", [
  ["Database", config.dbUrl],
  ["Watching", config.carnageDir],
  ["Results", config.discordResultsWebhookUrl ? c.green("on") : c.dim("off")],
  ["Leaderboard", config.discordLeaderboardWebhookUrl ? c.green("on") : c.dim("off")],
  ["Bot", config.discordBotToken ? c.green("on") : c.dim("off")],
  ["Matches", `${startCount} recorded`],
]);

// Short, config-aware "how to use it" note for friends who just ran the exe.
const usage = ["Leave this window open while you play customs — results post to Discord automatically. Press Ctrl+C to quit."];
if (config.discordBotToken) {
  usage.push("In Discord: /leaderboard · /stats <player>   (admins: Void/Exclude buttons on each result post)");
}
if (!config.discordResultsWebhookUrl && !config.discordLeaderboardWebhookUrl && !config.discordBotToken) {
  usage.push("Discord isn't set up yet — ask your host for the group .env, or run setup.");
}
hint(usage);

statusBar.setState({ totalMatches: startCount });

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

/** Short footer label for the status bar: gametype on map — winner. */
const footerLabel = (r: CarnageReport): string =>
  `${r.gameTypeName}${r.mapName ? ` on ${r.mapName}` : ""} — ${r.winners[0] ?? "—"}`;

/**
 * The console match block: a colored header line + winner + per-player CSR
 * changes (gains green, losses red, biggest first — same data the Discord post
 * shows). Colors are no-ops off a TTY, so a redirected log stays plain text.
 */
function matchBlock(r: CarnageReport, changes: Map<string, CsrChange> | null): string {
  const cat = CATEGORY_LABEL[categorize(r)];
  const head = `[match] ${r.gameTypeName}${r.mapName ? ` on ${r.mapName}` : ""} · ${cat} · ${
    r.players.length
  } players`;
  const winners = r.winners.map(displayName).join(", ") || "—";
  const lines = [head, `        winner: ${winners}`];
  if (changes?.size) {
    const rated = r.players.filter((p) => changes.has(p.xuid));
    rated.sort((a, b) => changes.get(b.xuid)!.delta - changes.get(a.xuid)!.delta);
    const parts = rated.map((p) => {
      const ch = changes.get(p.xuid)!;
      const delta = ch.delta >= 0 ? c.green(`+${ch.delta}`) : c.red(`${ch.delta}`);
      return `${displayName(p.gamertag)} ${delta} (${csrText(ch.csr)})`;
    });
    lines.push(`        CSR: ${parts.join(" · ")}`);
  }
  return lines.join("\n");
}

// --- startup -------------------------------------------------------------
// No auto-backfill: historic reports already in the folder are ignored.
// Run `npm run backfill` for intentional historic ingest. The banner above
// already reports which channels/bot are active, so no per-channel preamble.

// --- optional bot ----------------------------------------------------------
if (config.discordBotToken) {
  statusBar.setBot("connecting");
  startBot(
    config.discordBotToken,
    config.discordGuildId,
    db,
    config.discordResultsWebhookUrl,
    config.discordLeaderboardWebhookUrl,
  ).catch((e) => console.error("[discord] bot failed to start:", e));
}

// Tell the user if their build is behind the latest release (best-effort).
checkForUpdate().catch(() => {});

// Refresh the leaderboard once on startup so it survives DB edits (e.g. a
// manual wipe) or a manually-deleted leaderboard message.
if (config.discordLeaderboardWebhookUrl) {
  try {
    await upsertCsrLeaderboard(config.discordLeaderboardWebhookUrl, db);
  } catch (e) {
    console.error("[discord] startup leaderboard refresh failed:", (e as Error).message);
  }
}

// Self-heal: re-style any #game-results posts left in an older layout by an
// outdated build. Runs in the background so the watcher goes live immediately.
if (config.discordResultsWebhookUrl) {
  healStaleResults(db, { log: (m) => console.log(`[heal] ${m}`) }).catch((e) =>
    console.error("[heal] startup re-style failed:", (e as Error).message),
  );
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

  // Per-player CSR changes for the result post — replayed from the recorded
  // history, so they match exactly what the leaderboard will apply.
  // Best effort: a DB hiccup just posts the result without the ratings.
  const history = await matchesChrono(db);
  const hidden = await hiddenXuids(db);
  let csrChanges: Map<string, CsrChange> | null = null;
  let winChances: MatchWinChances | null = null;
  try {
    csrChanges = matchCsrChanges(history, report.matchId, hidden);
    winChances = matchWinChances(history, report.matchId);
  } catch (e) {
    console.error("[ts2] CSR change computation failed:", (e as Error).message);
  }

  console.log(matchBlock(report, csrChanges));
  statusBar.recordMatch(footerLabel(report), CATEGORY_LABEL[categorize(report)]);

  try {
    // Capture the #game-results message id so the game can later be voided via
    // /delete or the Void button. Posts with buttons when the bot's app-owned
    // webhook is available, else a plain post to the configured webhook.
    const msgId = await postCsrMatchResultWithControls(
      db,
      report,
      csrChanges ?? undefined,
      winChances ?? undefined,
    );
    if (msgId) {
      await setMatchResultsMsg(db, report.matchId, msgId);
      // Stamp the layout version so the startup heal never re-styles a fresh post.
      await setMatchResultsFmt(db, report.matchId, RESULTS_FMT_VERSION);
      statusBar.setLastPost(true);
    }
  } catch (e) {
    statusBar.setLastPost(false);
    console.error("[discord] result post failed:", (e as Error).message);
  }
  try {
    await upsertCsrLeaderboard(config.discordLeaderboardWebhookUrl, db);
  } catch (e) {
    statusBar.setLastPost(false);
    console.error("[discord] leaderboard upsert failed:", (e as Error).message);
  }
}

watcher
  .on("add", onFile)
  .on("change", onFile)
  .on("ready", () => {
    statusBar.setState({ watching: true });
    console.log(c.dim("[watch] live — waiting for matches…"));
  })
  .on("error", (e) => console.error("[watch] error:", e));

const shutdown = (): void => {
  statusBar.stop();
  console.log("\n[exit] closing…");
  watcher.close().finally(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
