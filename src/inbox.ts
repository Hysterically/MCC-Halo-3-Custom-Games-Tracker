/**
 * #carnage-inbox listener — the bot half of the new architecture. Friends'
 * watchers upload carnage XMLs to one private channel through a write-only
 * webhook; this client reads that channel and feeds every upload through the
 * shared pipeline (download → parse → record → rate → post).
 *
 * The channel IS the queue. The bot marks each upload it has dealt with by
 * reacting on the message — visible confirmation for the friend, durable state
 * for us:
 *
 *   ✅  recorded (new match, results posted)
 *   🔁  duplicate (already recorded — e.g. two players uploaded the same game)
 *   ⚠️  unusable (not a completed H3 custom, or unparseable)
 *
 * On startup it walks recent channel history and processes any upload without
 * one of those marks, so games uploaded while the bot was offline are picked
 * up. Transient failures (DB down, download failed) deliberately leave the
 * message unmarked — the next startup scan retries it, and recordMatch's
 * atomic insert makes a retry of a half-processed message safe.
 *
 * NOTE: reading message content/attachments requires the "Message Content
 * Intent" toggle in the Discord developer portal (a one-time setup step), and
 * the bot needs View Channel + Read Message History + Add Reactions in the
 * inbox channel.
 */

import { readFile } from "node:fs/promises";
import { Client, GatewayIntentBits, type Message } from "discord.js";
import type { Pipeline, IngestResult, ReportMeta } from "./pipeline.ts";

/** Reaction per outcome; any of them means "this upload is dealt with". */
const MARK = { recorded: "✅", duplicate: "🔁", unusable: "⚠️" } as const;
const ALL_MARKS: ReadonlySet<string> = new Set(Object.values(MARK));

/**
 * Added (alongside the receipt) to uploads from an outdated watcher, which
 * reads it back and offers its self-update. Deliberately NOT in ALL_MARKS —
 * it is not a receipt and must not affect backlog dedupe.
 */
const UPDATE_MARK = "🆙";

/** The watcher's metadata line: `h3meta {"v":1,...}` in inline code. */
const META_RE = /`h3meta (\{[^`]*\})`/;

/** Carnage XMLs are ~50–200 KB; anything huge is not one of ours. */
const MAX_XML_BYTES = 4 * 1024 * 1024;

export interface InboxOpts {
  /** How many recent messages the startup backlog scan walks, newest-first. */
  backlogMessages: number;
  log?: (line: string) => void;
}

/** Best-effort parse of the watcher's h3meta line. Null for a bare upload. */
export function parseMeta(content: string): ReportMeta | null {
  const m = content.match(META_RE);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]) as {
      playedAtMs?: number;
      mapName?: string;
      mapVariant?: string;
      watcher?: string;
    };
    return {
      playedAt: Number.isFinite(raw.playedAtMs) ? new Date(raw.playedAtMs!) : undefined,
      mapName: typeof raw.mapName === "string" ? raw.mapName : undefined,
      mapVariant: typeof raw.mapVariant === "string" ? raw.mapVariant : undefined,
      watcherVersion: typeof raw.watcher === "string" ? raw.watcher : undefined,
    };
  } catch {
    return null;
  }
}

/** True when watcher version `a` is older than `b` (numeric, part by part). */
export function olderVersion(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/**
 * The newest watcher version = the copy in this checkout ("update = git pull
 * + restart" bumps it for free). Undefined turns the 🆙 nudge off entirely.
 */
async function latestWatcherVersion(): Promise<string | undefined> {
  try {
    const src = await readFile(new URL("../watcher/watcher.mjs", import.meta.url), "utf8");
    return /^const WATCHER_VERSION = "([0-9.]+)"/m.exec(src)?.[1];
  } catch {
    return undefined;
  }
}

/** The message's XML attachments (usually exactly one). */
function xmlAttachments(msg: Message): { name: string; url: string; size: number }[] {
  return [...msg.attachments.values()]
    .filter((a) => a.name.toLowerCase().endsWith(".xml") && a.size <= MAX_XML_BYTES)
    .map((a) => ({ name: a.name, url: a.url, size: a.size }));
}

/** True if we already reacted with one of our marks (only on fetched messages). */
function isHandled(msg: Message): boolean {
  return msg.reactions.cache.some((r) => r.me && !!r.emoji.name && ALL_MARKS.has(r.emoji.name));
}

export async function startInbox(
  token: string,
  channelId: string,
  pipeline: Pipeline,
  opts: InboxOpts,
): Promise<Client> {
  const log = opts.log ?? ((m: string) => console.log(`[inbox] ${m}`));
  const latestWatcher = await latestWatcherVersion();

  /**
   * Process one upload message end-to-end and react with the outcome.
   * Throws on transient failures (download/DB) — callers log and leave the
   * message unmarked so the next backlog scan retries it.
   */
  async function handleMessage(msg: Message): Promise<void> {
    const atts = xmlAttachments(msg);
    if (!atts.length) return; // chatter in the channel — not an upload
    const parsed = parseMeta(msg.content);
    const meta = parsed ?? { playedAt: msg.createdAt };

    const outcomes: IngestResult[] = [];
    for (const att of atts) {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`attachment download ${res.status} for ${att.name}`);
      const out = await pipeline.ingestXml(await res.text(), meta);
      outcomes.push(out);
      const label = out.report
        ? `${out.report.gameTypeName || "custom game"}${out.report.mapName ? ` on ${out.report.mapName}` : ""}`
        : att.name;
      if (out.status === "recorded") log(`recorded ${label}`);
      else if (out.status === "duplicate") log(`duplicate ${label} — already recorded`);
      else if (out.status === "untracked") log(`skipped ${att.name}: not a completed H3 custom`);
      else log(`skipped ${att.name}: ${out.reason ?? "unparseable"}`);
    }

    // One mark per message; a rare multi-attachment upload gets its best outcome.
    const statuses = new Set(outcomes.map((o) => o.status));
    const mark = statuses.has("recorded")
      ? MARK.recorded
      : statuses.has("duplicate")
        ? MARK.duplicate
        : MARK.unusable;
    try {
      await msg.react(mark);
    } catch (e) {
      // Missing Add Reactions only costs the visual receipt + backlog dedupe —
      // the match itself is safe in the DB (a re-run just lands on "duplicate").
      log(`couldn't react on ${msg.id}: ${(e as Error).message}`);
    }

    // Nudge outdated watchers: an h3meta line with no version (pre-versioning
    // build) or an older one than our checkout's copy gets 🆙 on top of the
    // receipt; the watcher polls its message back and offers its self-update.
    // Bare uploads without h3meta are not watchers (e.g. the old ELO exe).
    if (
      latestWatcher &&
      parsed &&
      (!parsed.watcherVersion || olderVersion(parsed.watcherVersion, latestWatcher))
    ) {
      try {
        await msg.react(UPDATE_MARK);
      } catch {
        // best-effort, same as the receipt — the nudge just doesn't show
      }
    }
  }

  /** Walk recent history newest-first, then process unhandled uploads in order. */
  async function scanBacklog(client: Client): Promise<void> {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`channel ${channelId} is missing or not a text channel`);
    }

    const pending: Message[] = [];
    let before: string | undefined;
    let walked = 0;
    while (walked < opts.backlogMessages) {
      const batch = await channel.messages.fetch({
        limit: Math.min(100, opts.backlogMessages - walked),
        ...(before ? { before } : {}),
      });
      if (!batch.size) break;
      for (const m of batch.values()) {
        if (xmlAttachments(m).length && !isHandled(m)) pending.push(m);
      }
      walked += batch.size;
      before = batch.last()!.id;
      if (batch.size < 100) break;
    }

    if (!pending.length) {
      log("backlog clear — no unprocessed uploads");
      return;
    }
    log(`processing ${pending.length} backlog upload${pending.length === 1 ? "" : "s"}…`);
    pending.sort((a, b) => a.createdTimestamp - b.createdTimestamp); // oldest first
    for (const m of pending) {
      try {
        await handleMessage(m);
      } catch (e) {
        log(`backlog message ${m.id} failed (will retry next startup): ${(e as Error).message}`);
      }
    }
    log("backlog done");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("clientReady", (c) => {
    log(`listening to #carnage-inbox as ${c.user.tag}`);
    void scanBacklog(client).catch((e) =>
      log(
        `backlog scan failed: ${(e as Error).message} — live uploads still process; ` +
          "check the channel id and the Message Content intent",
      ),
    );
  });

  // Live uploads. The watcher posts via webhook, so author.bot is true — don't
  // filter on it. Our own reactions don't produce messageCreate events.
  client.on("messageCreate", (msg) => {
    if (msg.channelId !== channelId) return;
    void handleMessage(msg).catch((e) =>
      log(`upload ${msg.id} failed (will retry next startup): ${(e as Error).message}`),
    );
  });

  await client.login(token);
  return client;
}
