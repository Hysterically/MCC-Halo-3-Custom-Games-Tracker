/**
 * One-off maintenance: re-render every past #game-results post with the
 * current carnage layout and edit each Discord message in place.
 *
 *   npm run restyle            -- dry run: pair posts to DB matches, report
 *   npm run restyle -- --apply -- actually edit the messages
 *
 * Result posts were fired-and-forgotten (no message ids stored), so the ids
 * are recovered from channel history via the bot token: list the channel the
 * results webhook targets, keep the webhook's own messages, and pair each one
 * to the DB match whose recorded_at sits closest to the message's snowflake
 * timestamp (a result is posted within seconds of being recorded). Pairing is
 * by timestamp, not by position, because the two lists genuinely diverge:
 * backfilled matches were never posted, and test/sample posts or hand-deleted
 * messages have no match. Anything unpaired is reported and left untouched.
 *
 * Edits go through the webhook itself (only a webhook can edit its own
 * messages), replacing both the caption and the PNG. CSR changes are replayed
 * from history exactly like the live watcher does, so the restyled posts show
 * the same ranks the leaderboard applied.
 */

import { config } from "./config.ts";
import { openDb, matchesChrono, type StoredMatch } from "./db.ts";
import { matchCsrChanges, type CsrChange } from "./trueskill2.ts";
import { renderCarnageCsrPng } from "./renderCarnage.ts";
import { formatMatchCaption } from "./discord.ts";
import type { CarnageReport } from "./parseCarnage.ts";

const APPLY = process.argv.includes("--apply");
const API = "https://discord.com/api/v10";

/** Max |message time − recorded_at| for a post to count as that match's. */
const PAIR_TOLERANCE_MS = 10 * 60_000;
/** Pause between edits — webhook buckets allow ~5 requests per 2 s. */
const EDIT_DELAY_MS = 450;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Creation time encoded in a Discord snowflake id. */
const snowflakeMs = (id: string): number => Number((BigInt(id) >> 22n) + 1420070400000n);

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

// --- Discord plumbing --------------------------------------------------------

interface ChannelMessage {
  id: string;
  author?: { id: string };
  attachments?: unknown[];
  content?: string;
}

/** Bot-authenticated GET with 429 retry. */
async function botGet<T>(path: string): Promise<T> {
  for (;;) {
    const res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bot ${config.discordBotToken}` },
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep((body.retry_after ?? 1) * 1000);
      continue;
    }
    if (res.status === 403) {
      throw new Error(
        "bot lacks access to the results channel — give it View Channel + Read Message History there",
      );
    }
    if (!res.ok) {
      throw new Error(`GET ${path} → ${res.status}: ${await res.text().catch(() => "")}`);
    }
    return (await res.json()) as T;
  }
}

/** All messages the results webhook posted in its channel, oldest first. */
async function fetchWebhookMessages(webhookUrl: string): Promise<ChannelMessage[]> {
  // The webhook URL itself (GET, no auth beyond its token) yields id + channel.
  const res = await fetch(webhookUrl);
  if (!res.ok) throw new Error(`webhook lookup failed: ${res.status}`);
  const hook = (await res.json()) as { id: string; channel_id: string };

  const ours: ChannelMessage[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await botGet<ChannelMessage[]>(
      `/channels/${hook.channel_id}/messages?limit=100${before ? `&before=${before}` : ""}`,
    );
    if (!page.length) break;
    for (const m of page) if (m.author?.id === hook.id) ours.push(m);
    before = page[page.length - 1].id;
  }
  return ours.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/**
 * PATCH one result post: new caption, old attachment replaced by the fresh
 * PNG. Returns false if the message vanished since we listed it (404).
 */
async function editResultMessage(
  webhookUrl: string,
  messageId: string,
  caption: string,
  png: Buffer,
): Promise<boolean> {
  for (;;) {
    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({
        content: caption,
        attachments: [{ id: 0 }], // keep ONLY files[0] — drops the old image
        allowed_mentions: { parse: [] },
      }),
    );
    form.append("files[0]", new Blob([new Uint8Array(png)], { type: "image/png" }), "carnage.png");
    const res = await fetch(`${webhookUrl}/messages/${messageId}`, {
      method: "PATCH",
      body: form,
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep((body.retry_after ?? 1) * 1000);
      continue;
    }
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(`edit ${messageId} → ${res.status}: ${await res.text().catch(() => "")}`);
    }
    return true;
  }
}

// --- StoredMatch -> CarnageReport --------------------------------------------

/**
 * Rebuild the report the renderer needs from the stored row. Winners follow
 * the same rule as parseCarnage.decideWinner: the stored winning team, or in
 * FFA whoever holds the best (lowest) standing. Guests (no XUID) were never
 * stored, so a restyled image lists rated players only.
 */
function toReport(m: StoredMatch): CarnageReport {
  const winners = m.teamsEnabled
    ? m.players.filter((p) => p.teamId === m.winningTeamId).map((p) => p.gamertag)
    : (() => {
        const best = Math.min(...m.players.map((p) => p.standing));
        return m.players.filter((p) => p.standing === best).map((p) => p.gamertag);
      })();
  return {
    matchId: m.matchId,
    gameEnum: 2,
    isHalo3: true,
    isMatchmaking: false,
    isCustom: true,
    teamsEnabled: m.teamsEnabled,
    completed: true,
    gameTypeName: m.gameTypeName,
    hopperName: "",
    playedAt: new Date(m.playedAt),
    mapName: m.mapName,
    mapVariant: m.mapVariant,
    durationSeconds: m.durationSeconds,
    players: m.players.map((p) => ({
      ...p,
      betrayals: 0,
      suicides: 0,
      secondsPlayed: 0,
      completedGame: true,
    })),
    winningTeamId: m.teamsEnabled ? m.winningTeamId : null,
    winners,
    tracked: true,
  };
}

const label = (m: StoredMatch): string =>
  `${m.gameTypeName || "Custom Game"}${m.mapName ? ` on ${m.mapName}` : ""} (${m.players.length}p)`;

// --- main ----------------------------------------------------------------------

if (!config.discordResultsWebhookUrl) {
  console.error("No DISCORD_RESULTS_WEBHOOK_URL configured — set it in .env first.");
  process.exit(1);
}
if (!config.discordBotToken) {
  console.error("No DISCORD_BOT_TOKEN configured — it's needed to read channel history.");
  process.exit(1);
}
const webhookUrl = config.discordResultsWebhookUrl;

const db = await openDb(config.dbUrl, config.dbAuthToken);

// Chronological history (played_at order) drives the CSR replay; a second
// recorded_at order drives the pairing, because posts happen at record time —
// a backfilled match's played_at can be months before its post (or no post).
const chrono = await matchesChrono(db);
const recRes = await db.execute("SELECT match_id, recorded_at FROM matches");
const recordedAt = new Map(recRes.rows.map((r) => [String(r.match_id), Number(r.recorded_at)]));
const byRecorded = [...chrono].sort(
  (a, b) => (recordedAt.get(a.matchId) ?? 0) - (recordedAt.get(b.matchId) ?? 0),
);

console.log(`[db] ${chrono.length} matches recorded`);
console.log("[discord] reading channel history…");
const messages = await fetchWebhookMessages(webhookUrl);
console.log(`[discord] ${messages.length} posts by the results webhook`);

// Two-pointer walk over both timelines: pair when within tolerance, otherwise
// drop whichever side is older (a never-posted match / a post with no match).
const pairs: { message: ChannelMessage; match: StoredMatch }[] = [];
const unpostedMatches: StoredMatch[] = [];
const orphanMessages: ChannelMessage[] = [];
{
  let i = 0;
  let j = 0;
  while (i < messages.length && j < byRecorded.length) {
    const msgMs = snowflakeMs(messages[i].id);
    const recMs = recordedAt.get(byRecorded[j].matchId) ?? 0;
    if (Math.abs(msgMs - recMs) <= PAIR_TOLERANCE_MS) {
      pairs.push({ message: messages[i], match: byRecorded[j] });
      i++;
      j++;
    } else if (recMs < msgMs) {
      unpostedMatches.push(byRecorded[j]);
      j++;
    } else {
      orphanMessages.push(messages[i]);
      i++;
    }
  }
  unpostedMatches.push(...byRecorded.slice(j));
  orphanMessages.push(...messages.slice(i));
}

console.log(`\n${pairs.length} posts paired to matches.`);
if (unpostedMatches.length) {
  console.log(`${unpostedMatches.length} matches have no post (backfilled / deleted) — skipped:`);
  for (const m of unpostedMatches) {
    console.log(`  - ${when(recordedAt.get(m.matchId) ?? 0)}  ${label(m)}`);
  }
}
if (orphanMessages.length) {
  console.log(`${orphanMessages.length} posts have no match (test posts / wiped games) — left as-is:`);
  for (const m of orphanMessages) console.log(`  - ${when(snowflakeMs(m.id))}  message ${m.id}`);
}

if (!APPLY) {
  console.log("\nDry run — pairs that WOULD be restyled:");
  for (const { message, match } of pairs) {
    const changes = matchCsrChanges(chrono, match.matchId);
    console.log(
      `  ${when(snowflakeMs(message.id))}  ${label(match)}  csr:${changes ? "yes" : "off-format"}`,
    );
  }
  console.log(`\nRe-run with --apply to edit these ${pairs.length} posts.`);
} else {
  let done = 0;
  let gone = 0;
  for (const { message, match } of pairs) {
    const changes: Map<string, CsrChange> | undefined =
      matchCsrChanges(chrono, match.matchId) ?? undefined;
    const report = toReport(match);
    const png = await renderCarnageCsrPng(report, changes);
    const ok = await editResultMessage(webhookUrl, message.id, formatMatchCaption(report), png);
    done++;
    if (!ok) gone++;
    console.log(`[${done}/${pairs.length}] ${ok ? "edited" : "gone (404)"}  ${label(match)}`);
    await sleep(EDIT_DELAY_MS);
  }
  console.log(`\nDone: ${done - gone} posts restyled${gone ? `, ${gone} had vanished` : ""}.`);
}

db.close();
