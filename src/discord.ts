/**
 * Discord delivery. Three independent, optional channels:
 *
 *  - results webhook  : posts a rich per-match summary after every new match
 *                       (gametype, teams, K/D/A, winner). Goes to e.g.
 *                       #game-results.
 *  - leaderboard hook : posts a fresh standings message after each update and
 *                       deletes the previous one, so the channel always holds a
 *                       single, newest leaderboard at the bottom. Goes to e.g.
 *                       #leaderboard.
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
import { matchCount, matchesChrono, kvGet, kvSet } from "./db.ts";
import { computeRatings, type EloOptions, type Rating } from "./elo.ts";
import type { CarnageReport, CarnagePlayer } from "./parseCarnage.ts";
import { categorize, CATEGORY_LABEL, BOARD_CATEGORIES, type Category } from "./category.ts";
import { displayName } from "./aliases.ts";

// --- formatting ------------------------------------------------------------

/** Podium markers for the top three places (gold, silver, bronze). */
const MEDALS = ["🥇", "🥈", "🥉"];

/** One leaderboard section (just the code block, no outer heading). */
function formatSection(title: string, ratings: Rating[], limit = 20): string {
  const heading = `__**${title}**__`;
  if (!ratings.length) return `${heading}\n_No matches yet._`;
  const rows = ratings.slice(0, limit);
  const names = rows.map((r) => displayName(r.gamertag));
  const nameW = Math.max(6, ...names.map((n) => n.length));
  const head = `${"#".padEnd(5)}${"Player".padEnd(nameW)}  Elo   W-L-D    Win%   K/D`;
  const lines = rows.map((r, i) => {
    const kd = r.deaths ? (r.kills / r.deaths).toFixed(2) : r.kills.toFixed(2);
    const wld = `${r.wins}-${r.losses}-${r.draws}`;
    const winPct = r.games ? `${Math.round((r.wins / r.games) * 100)}%` : "—";
    // Gold/silver/bronze on the podium; two spaces keep the rest aligned.
    const marker = MEDALS[i] ?? "  ";
    const rank = `${marker}${String(i + 1).padEnd(2)}`;
    return `${rank} ${names[i].padEnd(nameW)}  ${String(
      Math.round(r.rating),
    ).padStart(4)}  ${wld.padEnd(7)} ${winPct.padStart(4)}  ${kd}`;
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
    const names = ordered.map((p) => displayName(p.gamertag));
    const nameW = Math.max(6, ...names.map((n) => n.length));
    const head = `${"#".padEnd(5)}${"Player".padEnd(nameW)} ${"Kills".padStart(5)} ${"Deaths".padStart(
      6,
    )} ${"Assists".padStart(7)} ${"K/D".padStart(6)}`;
    const lines = ordered.map((p, i) => {
      const marker = i === 0 ? "🏆" : "  ";
      const rank = `${marker}${String(i + 1).padEnd(2)}`;
      return `${rank} ${names[i].padEnd(nameW)} ${String(p.kills).padStart(5)} ${String(
        p.deaths,
      ).padStart(6)} ${String(p.assists).padStart(7)} ${kd(p).padStart(6)}`;
    });
    return [header, "```", head, ...lines, "```"].join("\n");
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

  const nameW = Math.max(6, ...r.players.map((p) => displayName(p.gamertag).length));
  const colHead = `${" ".repeat(2 + nameW + 1)}${"Kills".padStart(5)} ${"Deaths".padStart(
    6,
  )} ${"Assists".padStart(7)} ${"K/D".padStart(6)}`;
  const blocks: string[] = [colHead];
  for (const tid of teamIds) {
    const members = byTeam.get(tid)!.sort((a, b) => b.score - a.score);
    const label = tid === r.winningTeamId ? `🏆 ${teamName(tid)} — Winner` : teamName(tid);
    const totalScore = members.reduce((s, p) => s + p.score, 0);
    blocks.push(`${label}  (score ${totalScore})`);
    for (const p of members) {
      blocks.push(
        `  ${displayName(p.gamertag).padEnd(nameW)} ${String(p.kills).padStart(5)} ${String(
          p.deaths,
        ).padStart(6)} ${String(p.assists).padStart(7)} ${kd(p).padStart(6)}`,
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

/** DELETE an existing message. Swallows 404 (already gone) and never throws. */
async function deleteMessage(url: string, messageId: string): Promise<void> {
  try {
    await fetch(`${url}/messages/${messageId}`, { method: "DELETE" });
  } catch {
    // best-effort cleanup — a failed delete just leaves an old message behind
  }
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
 * Refresh the leaderboard: post a fresh message so the latest standings land
 * at the bottom of the channel, then delete the previous leaderboard message
 * so only the newest one remains.
 */
export async function upsertLeaderboard(
  url: string | undefined,
  db: DB,
  elo: EloOptions,
): Promise<void> {
  if (!url) return;
  const content = formatLeaderboard(matchesChrono(db), elo);
  const key = `lb_msg:${webhookId(url)}`;
  const previous = kvGet(db, key);

  const id = await postAndReturnId(url, content);
  kvSet(db, key, id);

  if (previous) await deleteMessage(url, previous);
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
