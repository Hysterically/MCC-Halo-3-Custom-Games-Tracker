/**
 * The tracker — the thing you actually run on the gaming PC (or the bot host).
 *
 *   npm run watch
 *
 * Two ingest sources, one shared pipeline (see pipeline.ts):
 *  - local:  chokidar on this PC's MCC carnage folder (the host playing);
 *  - inbox:  friends' watcher uploads in #carnage-inbox (see inbox.ts),
 *            enabled when DISCORD_BOT_TOKEN + H3_INBOX_CHANNEL_ID are set.
 *
 * With no inbox channel configured this is a plain local-folder watcher.
 *
 * On startup we intentionally do NOT auto-ingest historic reports — the
 * MCC folder accumulates years of XMLs and silently importing them would
 * resurrect dead matches every time the watcher restarts (especially after
 * a wipe). Use `npm run backfill` to opt in to historic ingest.
 */

import { stat } from "node:fs/promises";
import { extname } from "node:path";
import chokidar from "chokidar";
import { config, inboxConfig } from "./config.ts";
import { openDb, matchCount } from "./db.ts";
import type { CsrChange } from "./trueskill2.ts";
import type { CarnageReport } from "./parseCarnage.ts";
import { upsertCsrLeaderboard, startBot } from "./discord.ts";
import { healStaleResults } from "./heal.ts";
import { checkForUpdate } from "./updateCheck.ts";
import { statusBar, banner, hint, c } from "./term.ts";
import { categorize, CATEGORY_LABEL } from "./category.ts";
import { displayName } from "./aliases.ts";
import { csrText } from "./csr.ts";
import { createPipeline, type IngestSource } from "./pipeline.ts";
import { startInbox } from "./inbox.ts";

const isCarnage = (f: string): boolean =>
  /carnage/i.test(f) && extname(f).toLowerCase() === ".xml";

const inboxEnabled = Boolean(config.discordBotToken && inboxConfig.channelId);

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
  // No-token installs (the friends' zip) don't run the bot on purpose — the
  // host's instance serves /leaderboard for everyone. Omit the row entirely
  // rather than print an "off" that reads like a failure.
  ...(config.discordBotToken ? [["Bot", c.green("on")] as [string, string]] : []),
  ["Inbox", inboxEnabled ? c.green("on") : c.dim("off")],
  ["Matches", `${startCount} recorded`],
]);

const usage = [
  "Leave this window open — local games AND friends' inbox uploads post to Discord automatically. Press Ctrl+C to quit.",
];
if (config.discordBotToken) {
  usage.push("In Discord: /leaderboard · /stats <player>   (admins: Void/Exclude buttons on each result post)");
}
if (inboxConfig.channelId && !config.discordBotToken) {
  usage.push("H3_INBOX_CHANNEL_ID is set but DISCORD_BOT_TOKEN isn't — the inbox listener needs the bot token, so it stays off.");
}
if (!config.discordResultsWebhookUrl && !config.discordLeaderboardWebhookUrl && !config.discordBotToken) {
  usage.push("Discord isn't set up yet — ask your host for the group .env, or run setup.");
}
hint(usage);

statusBar.setState({ totalMatches: startCount });

/** Short footer label for the status bar: gametype on map — winner. */
const footerLabel = (r: CarnageReport): string =>
  `${r.gameTypeName}${r.mapName ? ` on ${r.mapName}` : ""} — ${r.winners[0] ?? "—"}`;

/**
 * The console match block: a colored header line, then a box-drawn table of
 * the rated players (biggest CSR gain first — same data the Discord post
 * shows): name (winners starred), K/D, CSR change, new rank. All cells are
 * padded with PLAIN strings first and colorized after, so the ANSI codes
 * never break the column math; colors are no-ops off a TTY, so a redirected
 * log stays plain text.
 */
function matchBlock(
  r: CarnageReport,
  changes: Map<string, CsrChange> | null,
  source: IngestSource,
): string {
  const cat = CATEGORY_LABEL[categorize(r)];
  const via = source === "inbox" ? c.dim(" · via inbox") : "";
  const head = `[match] ${c.bold(r.gameTypeName)}${r.mapName ? ` on ${r.mapName}` : ""} · ${cat}${c.dim(
    ` · ${r.players.length} players`,
  )}${via}`;
  const winnerNames = r.winners.map(displayName).join(", ") || "—";

  const rated = changes?.size ? r.players.filter((p) => changes.has(p.xuid)) : [];
  if (!rated.length) return [head, `        winner: ${winnerNames}`].join("\n");

  const winners = new Set(r.winners);
  rated.sort((a, b) => changes!.get(b.xuid)!.delta - changes!.get(a.xuid)!.delta);
  const rows = rated.map((p) => {
    const ch = changes!.get(p.xuid)!;
    return {
      name: displayName(p.gamertag) + (winners.has(p.gamertag) ? " ★" : ""),
      won: winners.has(p.gamertag),
      kd: `${p.kills ?? 0}/${p.deaths ?? 0}`,
      delta: `${ch.delta >= 0 ? "+" : ""}${ch.delta}`,
      gain: ch.delta >= 0,
      rank: csrText(ch.csr),
    };
  });

  const HDR = { name: "Player", kd: "K/D", delta: "CSR", rank: "Rank" };
  const w = {
    name: Math.max(HDR.name.length, ...rows.map((x) => x.name.length)),
    kd: Math.max(HDR.kd.length, ...rows.map((x) => x.kd.length)),
    delta: Math.max(HDR.delta.length, ...rows.map((x) => x.delta.length)),
    rank: Math.max(HDR.rank.length, ...rows.map((x) => x.rank.length)),
  };

  const IND = "        ";
  const rule = (l: string, m: string, rgt: string): string =>
    c.gray(
      `${IND}${l}${"─".repeat(w.name + 2)}${m}${"─".repeat(w.kd + 2)}${m}${"─".repeat(
        w.delta + 2,
      )}${m}${"─".repeat(w.rank + 2)}${rgt}`,
    );
  const bar = c.gray("│");
  const row = (name: string, kd: string, delta: string, rank: string): string =>
    `${IND}${bar} ${name} ${bar} ${kd} ${bar} ${delta} ${bar} ${rank} ${bar}`;

  const lines = [head];
  lines.push(rule("┌", "┬", "┐"));
  lines.push(
    row(
      c.gray(HDR.name.padEnd(w.name)),
      c.gray(HDR.kd.padStart(w.kd)),
      c.gray(HDR.delta.padStart(w.delta)),
      c.gray(HDR.rank.padEnd(w.rank)),
    ),
  );
  lines.push(rule("├", "┼", "┤"));
  for (const x of rows) {
    const name = x.name.padEnd(w.name).replace("★", c.yellow("★"));
    const kd = c.dim(x.kd.padStart(w.kd));
    const delta = (x.gain ? c.green : c.red)(x.delta.padStart(w.delta));
    lines.push(row(name, kd, delta, x.rank.padEnd(w.rank)));
  }
  lines.push(rule("└", "┴", "┘"));
  return lines.join("\n");
}

// --- shared pipeline ---------------------------------------------------------
// Both sources (local folder + inbox) flow through here; onRecorded/onPost keep
// the console block and the status bar identical no matter where a game came from.

const pipeline = createPipeline(db, {
  onRecorded: (report, csrChanges, source) => {
    console.log(matchBlock(report, csrChanges, source));
    statusBar.recordMatch(footerLabel(report), CATEGORY_LABEL[categorize(report)]);
  },
  onPost: (ok) => statusBar.setLastPost(ok),
});

// --- optional bot (slash commands, buttons) ----------------------------------
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

// --- inbox listener ------------------------------------------------------------
// A second gateway client — separate from the slash-command client in
// discord.ts, which is built without the MessageContent intent.
if (inboxEnabled) {
  startInbox(config.discordBotToken!, inboxConfig.channelId!, pipeline, {
    backlogMessages: inboxConfig.backlogMessages,
  }).catch((e) => console.error("[inbox] listener failed to start:", e));
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

// --- live local watch -----------------------------------------------------------
const seen = new Map<string, number>(); // path -> last mtimeMs handled (dedupe rapid events)

const watcher = chokidar.watch(config.carnageDir, {
  ignoreInitial: true,
  depth: 0,
  awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
});

// Ingest retry ladder for transient DB errors. Chokidar never re-fires for a
// finished file (its mtime is final) and startup skips historic reports, so a
// dropped ingest would silently lose the game — retry here instead.
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

async function onFile(path: string): Promise<void> {
  if (!isCarnage(path)) return;
  const m = await stat(path).then((s) => s.mtimeMs).catch(() => 0);
  if (seen.get(path) === m) return;
  seen.set(path, m);

  for (let attempt = 0; ; attempt++) {
    try {
      const out = await pipeline.ingestLocalFile(path);
      if (out.status === "invalid") console.warn(`[skip] ${path}: ${out.reason}`);
      return;
    } catch (e) {
      // A transient DB error (e.g. the shared remote DB hiccuped) shouldn't
      // kill the watcher. recordMatch's atomic insert makes retries safe.
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        seen.delete(path); // let a future event for this file try again
        console.error(
          `[db] record failed for ${path} after ${attempt + 1} attempts: ${(e as Error).message}` +
            " — this game was NOT recorded; run `npm run backfill` to recover it",
        );
        return;
      }
      console.error(
        `[db] record failed for ${path}: ${(e as Error).message} — retrying in ${delay / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
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
