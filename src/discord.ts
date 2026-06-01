/**
 * Discord delivery. Three independent, optional channels:
 *
 *  - results webhook  : posts a rich per-match summary after every new match
 *                       (gametype, teams, K/D/A, winner). Goes to e.g.
 *                       #game-results.
 *  - leaderboard hook : maintains a single message edited in place that
 *                       always reflects the current standings. Goes to e.g.
 *                       #leaderboard. No notification spam.
 *  - bot              : answers /leaderboard and /stats on demand.
 *
 * Each works without the others; all are no-ops if not configured.
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { DB, StoredMatch } from "./db.ts";
import { matchCount, matchesChrono, kvGet, kvSet, kvDelete } from "./db.ts";
import { computeRatings, type EloOptions, type Rating } from "./elo.ts";
import type { CarnageReport, CarnagePlayer } from "./parseCarnage.ts";
import { categorize, CATEGORY_LABEL, BOARD_CATEGORIES, type Category } from "./category.ts";

// --- formatting ------------------------------------------------------------

/** One leaderboard section (just the code block, no outer heading). */
function formatSection(title: string, ratings: Rating[], limit = 20): string {
  const heading = `__**${title}**__`;
  if (!ratings.length) return `${heading}\n_No matches yet._`;
  const rows = ratings.slice(0, limit);
  const nameW = Math.max(6, ...rows.map((r) => r.gamertag.length));
  const head = `${"#".padEnd(3)} ${"Player".padEnd(nameW)}  Elo   W-L-D   K/D`;
  const lines = rows.map((r, i) => {
    const kd = r.deaths ? (r.kills / r.deaths).toFixed(2) : r.kills.toFixed(2);
    const wld = `${r.wins}-${r.losses}-${r.draws}`;
    return `${String(i + 1).padEnd(3)} ${r.gamertag.padEnd(nameW)}  ${String(
      Math.round(r.rating),
    ).padStart(4)}  ${wld.padEnd(7)} ${kd}`;
  });
  return [heading, "```", head, ...lines, "```"].join("\n");
}

/**
 * The combined leaderboard message: one section per board category, each
 * computed from only that category's matches so a player's 2v2 ELO is
 * independent of their FFA ELO.
 */
export function formatLeaderboard(matches: StoredMatch[], elo: EloOptions): string {
  const byCat = new Map<Category, StoredMatch[]>();
  for (const m of matches) {
    const cat = categorize(m);
    const arr = byCat.get(cat) ?? [];
    arr.push(m);
    byCat.set(cat, arr);
  }
  const sections = BOARD_CATEGORIES.map((c) =>
    formatSection(`🏆 ${CATEGORY_LABEL[c]} Leaderboard`, computeRatings(byCat.get(c) ?? [], elo)),
  );
  return ["**Halo 3 Customs — ELO Standings**", ...sections].join("\n\n");
}

/** Detailed per-match summary: gametype, teams or FFA, K/D/A, winner. */
export function formatMatchResult(r: CarnageReport): string {
  const cat = categorize(r);
  const tag =
    cat === "other"
      ? "_Off-format — not counted toward a leaderboard._"
      : `_Counted toward **${CATEGORY_LABEL[cat]}** leaderboard._`;
  const header =
    `🎮 **${r.gameTypeName || "Custom Game"}** · ${r.players.length} ${
      r.players.length === 1 ? "player" : "players"
    }\n${tag}`;

  const kd = (p: CarnagePlayer): string =>
    p.deaths ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);

  if (!r.teamsEnabled) {
    // FFA — rank by standing (0 = best).
    const ordered = [...r.players].sort((a, b) => a.standing - b.standing);
    const nameW = Math.max(6, ...ordered.map((p) => p.gamertag.length));
    const lines = ordered.map((p, i) => {
      const marker = i === 0 ? "🏆" : "  ";
      const kda = `${p.kills}/${p.deaths}/${p.assists}`;
      return `${marker} ${String(i + 1).padEnd(2)} ${p.gamertag.padEnd(nameW)}  ${kda.padEnd(
        10,
      )} K/D ${kd(p)}`;
    });
    return [header, "```", ...lines, "```"].join("\n");
  }

  // Team game — group, winning team first, players in each team by score desc.
  const byTeam = new Map<number, CarnagePlayer[]>();
  for (const p of r.players) {
    const arr = byTeam.get(p.teamId) ?? [];
    arr.push(p);
    byTeam.set(p.teamId, arr);
  }
  const teamIds = [...byTeam.keys()].sort((a, b) => {
    if (a === r.winningTeamId) return -1;
    if (b === r.winningTeamId) return 1;
    return a - b;
  });

  const nameW = Math.max(6, ...r.players.map((p) => p.gamertag.length));
  const blocks: string[] = [];
  for (const tid of teamIds) {
    const members = byTeam.get(tid)!.sort((a, b) => b.score - a.score);
    const label = tid === r.winningTeamId ? `🏆 ${teamName(tid)} — Winner` : teamName(tid);
    const totalScore = members.reduce((s, p) => s + p.score, 0);
    blocks.push(`${label}  (score ${totalScore})`);
    for (const p of members) {
      const kda = `${p.kills}/${p.deaths}/${p.assists}`;
      blocks.push(
        `  ${p.gamertag.padEnd(nameW)}  ${kda.padEnd(10)} K/D ${kd(p)}`,
      );
    }
    blocks.push("");
  }
  return [header, "```", ...blocks, "```"].join("\n").trimEnd();
}

const TEAM_NAMES = ["Red", "Blue", "Green", "Orange", "Purple", "Gold", "Brown", "Pink"];
function teamName(id: number): string {
  return TEAM_NAMES[id] ? `${TEAM_NAMES[id]} Team` : `Team ${id}`;
}

// --- webhook plumbing ------------------------------------------------------

/** Plain POST — fire and forget, no message id returned. */
export async function postWebhook(url: string, content: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook ${res.status}: ${await res.text().catch(() => "")}`);
  }
}

/** POST with ?wait=true so Discord returns the created message (incl. id). */
async function postAndReturnId(url: string, content: string): Promise<string> {
  const u = new URL(url);
  u.searchParams.set("wait", "true");
  const res = await fetch(u, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

/** PATCH an existing message. Returns false on 404 so caller can re-create. */
async function patchMessage(url: string, messageId: string, content: string): Promise<boolean> {
  const res = await fetch(`${url}/messages/${messageId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (res.status === 404) return false; // message deleted — fall through to repost
  if (!res.ok) {
    throw new Error(`Discord PATCH ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return true;
}

/** Stable per-webhook key so changing the URL implicitly resets stored state. */
function webhookId(url: string): string {
  const m = url.match(/\/webhooks\/(\d+)\//);
  return m ? m[1] : url;
}

// --- high-level helpers used by the watcher --------------------------------

/** Post a per-match summary to the results channel (no-op if no URL). */
export async function postMatchResult(
  url: string | undefined,
  report: CarnageReport,
): Promise<void> {
  if (!url) return;
  await postWebhook(url, formatMatchResult(report));
}

/**
 * Upsert the leaderboard message: PATCH the existing one if we have its id,
 * otherwise POST a fresh one and remember it. A 404 on PATCH (message was
 * manually deleted) falls through to a fresh post.
 */
export async function upsertLeaderboard(
  url: string | undefined,
  db: DB,
  elo: EloOptions,
): Promise<void> {
  if (!url) return;
  const content = formatLeaderboard(matchesChrono(db), elo);
  const key = `lb_msg:${webhookId(url)}`;
  const existing = kvGet(db, key);

  if (existing) {
    if (await patchMessage(url, existing, content)) return;
    kvDelete(db, key); // message was gone — fall through and repost
  }
  const id = await postAndReturnId(url, content);
  kvSet(db, key, id);
}

// --- slash-command bot (unchanged) -----------------------------------------

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the Halo 3 customs ELO leaderboard"),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("How many tracked matches are recorded"),
].map((c) => c.toJSON());

export async function startBot(
  token: string,
  guildId: string | undefined,
  db: DB,
  elo: EloOptions,
): Promise<Client> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("clientReady", async (c) => {
    const rest = new REST({ version: "10" }).setToken(token);
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), { body: COMMANDS });
    } else {
      await rest.put(Routes.applicationCommands(c.user.id), { body: COMMANDS });
    }
    console.log(`[discord] bot online as ${c.user.tag}; commands registered`);
  });

  client.on("interactionCreate", async (i) => {
    if (!i.isChatInputCommand()) return;
    const ix = i as ChatInputCommandInteraction;
    try {
      if (ix.commandName === "leaderboard") {
        await ix.reply(formatLeaderboard(matchesChrono(db), elo));
      } else if (ix.commandName === "stats") {
        await ix.reply(`📊 ${matchCount(db)} tracked Halo 3 custom matches recorded.`);
      }
    } catch (e) {
      console.error("[discord] command error:", e);
      if (!ix.replied) await ix.reply("Something went wrong.").catch(() => {});
    }
  });

  await client.login(token);
  return client;
}
