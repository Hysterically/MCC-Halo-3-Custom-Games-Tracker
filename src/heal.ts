/**
 * Self-healing of #game-results posts.
 *
 * Older builds of the tracker (e.g. the retired ELO exe, or any pre-format
 * change) post carnage images in an out-of-date layout. The current watcher
 * fixes them automatically on startup so the channel converges to one style,
 * without anyone running a manual re-style.
 *
 * Two tiers, because the rating data is never the problem (CSR is recomputed
 * from the raw matches table) — only the rendered images are:
 *
 *  - Tier A (everyone): for matches whose results_msg_id is stored and whose
 *    results_fmt is behind RESULTS_FMT_VERSION, re-render and PATCH the post by
 *    id. A webhook can edit its own messages with no auth (the token is in the
 *    URL), so this works on friends' machines that have only the webhook URLs.
 *
 *  - Tier B (needs a bot token): scan the channel history, pair orphan posts
 *    (no stored id — i.e. posts made by an older build) to their match by
 *    timestamp, and backfill results_msg_id. Tier A then renders them. Writing
 *    the id back migrates each legacy post into the id-tracked world once, so
 *    the scan converges to doing nothing.
 *
 * The shared `restyle` CLI is the force variant: re-render every post with a
 * known id regardless of version (heal({ force: true })).
 */

import { config } from "./config.ts";
import {
  type DB,
  type StoredMatch,
  matchesChrono,
  setMatchResultsMsg,
  setMatchResultsFmt,
  clearMatchResultsMsg,
  resultsRestyleTargets,
  recordedAtByMatch,
  kvGet,
  hiddenXuids,
} from "./db.ts";
import { matchCsrChanges, matchWinChances, type CsrChange } from "./trueskill2.ts";
import { renderCarnageCsrPng } from "./renderCarnage.ts";
import { formatMatchCaption } from "./discord.ts";
import { RESULTS_FMT_VERSION } from "./version.ts";
import type { CarnageReport } from "./parseCarnage.ts";

const API = "https://discord.com/api/v10";
/** Max |message time − recorded_at| for a post to count as that match's. */
const PAIR_TOLERANCE_MS = 10 * 60_000;
/** Pause between edits — webhook buckets allow ~5 requests per 2 s. */
const EDIT_DELAY_MS = 450;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Creation time encoded in a Discord snowflake id. */
export const snowflakeMs = (id: string): number =>
  Number((BigInt(id) >> 22n) + 1420070400000n);

// --- Discord plumbing --------------------------------------------------------

export interface ChannelMessage {
  id: string;
  author?: { id: string };
}

/** Bot-authenticated GET with 429 retry. */
async function botGet<T>(path: string, botToken: string): Promise<T> {
  for (;;) {
    const res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bot ${botToken}` },
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
export async function fetchWebhookMessages(
  webhookUrl: string,
  botToken: string,
): Promise<ChannelMessage[]> {
  // The webhook URL itself (GET, no auth beyond its token) yields id + channel.
  const res = await fetch(webhookUrl);
  if (!res.ok) throw new Error(`webhook lookup failed: ${res.status}`);
  const hook = (await res.json()) as { id: string; channel_id: string };

  const ours: ChannelMessage[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await botGet<ChannelMessage[]>(
      `/channels/${hook.channel_id}/messages?limit=100${before ? `&before=${before}` : ""}`,
      botToken,
    );
    if (!page.length) break;
    for (const m of page) if (m.author?.id === hook.id) ours.push(m);
    before = page[page.length - 1].id;
  }
  return ours.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/**
 * Webhook URLs that may have authored a results post, app-owned first. A post
 * predating the app webhook was authored by the user webhook; a post carrying
 * buttons by the app webhook. Trying each (404 → next) edits either correctly.
 */
async function resultsWebhookUrls(db: DB): Promise<string[]> {
  const urls: string[] = [];
  const app = await kvGet(db, "results_app_webhook");
  if (app) urls.push(app);
  const base = config.discordResultsWebhookUrl;
  if (base && base !== app) urls.push(base);
  return urls;
}

/**
 * PATCH one result post: new caption, old attachment replaced by the fresh PNG.
 * Tries each candidate webhook (the post's author is whichever doesn't 404).
 * Returns false if the message vanished (404 on every candidate).
 */
async function editResultMessage(
  webhookUrls: string[],
  messageId: string,
  caption: string,
  png: Buffer,
): Promise<boolean> {
  for (const webhookUrl of webhookUrls) {
    if (await editResultMessageVia(webhookUrl, messageId, caption, png)) return true;
  }
  return false;
}

/** Edit via one specific webhook; true on success, false on 404 (wrong author). */
async function editResultMessageVia(
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
    const res = await fetch(`${webhookUrl}/messages/${messageId}`, { method: "PATCH", body: form });
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
 * Rebuild the report the renderer needs from the stored row. Winners follow the
 * same rule as parseCarnage.decideWinner: the stored winning team, or in FFA
 * whoever holds the best (lowest) standing. Guests (no XUID) were never stored,
 * so a re-rendered image lists rated players only.
 */
export function toReport(m: StoredMatch): CarnageReport {
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
    excluded: m.excluded,
  };
}

// --- heal --------------------------------------------------------------------

export interface HealResult {
  adopted: number; // legacy posts whose id we backfilled (Tier B)
  restyled: number; // posts re-rendered + edited (Tier A)
  gone: number; // posts that had vanished (404)
}

type Logger = (msg: string) => void;

/**
 * Adopt orphan #game-results posts (no stored id) by pairing the webhook's
 * channel history to matches by recorded_at, two-pointer style: pair when within
 * tolerance, else drop whichever side is older (a never-posted match / a post
 * with no match). Backfills results_msg_id on each newly-paired row. Needs the
 * bot token to read history; a no-op without it. Returns how many were adopted.
 */
async function adoptOrphanPosts(db: DB, chrono: StoredMatch[], log: Logger): Promise<number> {
  const webhookUrl = config.discordResultsWebhookUrl;
  const botToken = config.discordBotToken;
  if (!webhookUrl || !botToken) return 0;

  const messages = await fetchWebhookMessages(webhookUrl, botToken);
  const recordedAt = await recordedAtByMatch(db);
  const haveMsg = new Set(
    (await resultsRestyleTargets(db, 0, true)).map((t) => t.matchId),
  );
  const byRecorded = [...chrono].sort(
    (a, b) => (recordedAt.get(a.matchId) ?? 0) - (recordedAt.get(b.matchId) ?? 0),
  );

  let adopted = 0;
  let i = 0;
  let j = 0;
  while (i < messages.length && j < byRecorded.length) {
    const msgMs = snowflakeMs(messages[i].id);
    const match = byRecorded[j];
    const recMs = recordedAt.get(match.matchId) ?? 0;
    if (Math.abs(msgMs - recMs) <= PAIR_TOLERANCE_MS) {
      if (!haveMsg.has(match.matchId)) {
        await setMatchResultsMsg(db, match.matchId, messages[i].id);
        adopted++;
      }
      i++;
      j++;
    } else if (recMs < msgMs) {
      j++;
    } else {
      i++;
    }
  }
  if (adopted) log(`adopted ${adopted} legacy post${adopted === 1 ? "" : "s"} (backfilled message ids)`);
  return adopted;
}

/**
 * Re-style #game-results posts whose layout is behind RESULTS_FMT_VERSION (or,
 * with `force`, every post with a known id). Runs the Tier B adoption first (if a
 * bot token is configured) so freshly-adopted posts are picked up the same run.
 *
 * Best-effort and idempotent: a re-render produces the same bytes as the live
 * post, so a rare double-run from two instances is harmless. Never throws past
 * the caller's expectation — individual edit failures are logged and skipped.
 */
export async function healStaleResults(
  db: DB,
  opts: { force?: boolean; log?: Logger } = {},
): Promise<HealResult> {
  const log = opts.log ?? (() => {});
  const webhookUrl = config.discordResultsWebhookUrl;
  if (!webhookUrl) return { adopted: 0, restyled: 0, gone: 0 };

  const chrono = await matchesChrono(db);
  const hidden = await hiddenXuids(db);
  const byId = new Map(chrono.map((m) => [m.matchId, m]));

  const adopted = await adoptOrphanPosts(db, chrono, log);

  const targets = await resultsRestyleTargets(db, RESULTS_FMT_VERSION, opts.force);
  if (!targets.length) return { adopted, restyled: 0, gone: 0 };
  const editUrls = await resultsWebhookUrls(db);

  log(`re-styling ${targets.length} post${targets.length === 1 ? "" : "s"} to format v${RESULTS_FMT_VERSION}…`);
  let restyled = 0;
  let gone = 0;
  for (const { matchId, msgId } of targets) {
    const match = byId.get(matchId);
    if (!match) continue; // match deleted between query and now
    const changes: Map<string, CsrChange> | undefined =
      matchCsrChanges(chrono, matchId, hidden) ?? undefined;
    const win = matchWinChances(chrono, matchId) ?? undefined;
    try {
      const report = toReport(match);
      const png = await renderCarnageCsrPng(report, changes, win);
      const ok = await editResultMessage(editUrls, msgId, formatMatchCaption(report), png);
      if (ok) {
        await setMatchResultsFmt(db, matchId, RESULTS_FMT_VERSION);
        restyled++;
      } else {
        await clearMatchResultsMsg(db, matchId); // 404 — the post is gone
        gone++;
      }
    } catch (e) {
      log(`failed to re-style ${matchId}: ${(e as Error).message}`);
    }
    await sleep(EDIT_DELAY_MS);
  }
  log(`re-styled ${restyled} post${restyled === 1 ? "" : "s"}${gone ? `, ${gone} had vanished` : ""}.`);
  return { adopted, restyled, gone };
}

/**
 * Re-render and PATCH a single #game-results post to the current layout — used
 * right after toggling a match's excluded flag so its caption flips to/from
 * "Off-format". Returns "restyled", "gone" (the post 404'd — its id is cleared),
 * or "skipped" (no webhook / match not found). Best-effort; never throws past
 * the edit itself.
 */
export async function restyleResultPost(
  db: DB,
  matchId: string,
  msgId: string,
): Promise<"restyled" | "gone" | "skipped"> {
  const webhookUrl = config.discordResultsWebhookUrl;
  if (!webhookUrl) return "skipped";
  const chrono = await matchesChrono(db);
  const hidden = await hiddenXuids(db);
  const match = chrono.find((m) => m.matchId === matchId);
  if (!match) return "skipped";
  const changes: Map<string, CsrChange> | undefined = matchCsrChanges(chrono, matchId, hidden) ?? undefined;
  const win = matchWinChances(chrono, matchId) ?? undefined;
  const report = toReport(match);
  const png = await renderCarnageCsrPng(report, changes, win);
  const ok = await editResultMessage(
    await resultsWebhookUrls(db),
    msgId,
    formatMatchCaption(report),
    png,
  );
  if (ok) {
    await setMatchResultsFmt(db, matchId, RESULTS_FMT_VERSION);
    return "restyled";
  }
  await clearMatchResultsMsg(db, matchId);
  return "gone";
}
