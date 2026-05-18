/**
 * Discord delivery. Two independent, optional channels:
 *
 *  - webhook  : the watcher posts the updated board after every new match.
 *  - bot      : answers /leaderboard on demand (and /lastmatch).
 *
 * Either works without the other; both are no-ops if not configured.
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { DB } from "./db.ts";
import { matchCount, matchesChrono } from "./db.ts";
import { computeRatings, type EloOptions, type Rating } from "./elo.ts";

const medal = (i: number): string => ["🥇", "🥈", "🥉"][i] ?? `\`${String(i + 1).padStart(2)}\``;

/** Render the top of the table as a Discord code block (monospace aligns). */
export function formatLeaderboard(ratings: Rating[], limit = 20): string {
  if (!ratings.length) return "_No tracked Halo 3 customs yet._";

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
  return ["**🏆 Halo 3 Customs — ELO Leaderboard**", "```", head, ...lines, "```"].join("\n");
}

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

/** Convenience used by the watcher: recompute + post the board, if configured. */
export async function announceBoard(
  db: DB,
  elo: EloOptions,
  webhookUrl: string | undefined,
  header?: string,
): Promise<void> {
  if (!webhookUrl) return;
  const board = formatLeaderboard(computeRatings(matchesChrono(db), elo));
  await postWebhook(webhookUrl, header ? `${header}\n${board}` : board);
}

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the Halo 3 customs ELO leaderboard"),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("How many tracked matches are recorded"),
].map((c) => c.toJSON());

/**
 * Start the slash-command bot. Resolves once it is logged in and listening;
 * keeps running until the process exits.
 */
export async function startBot(
  token: string,
  guildId: string | undefined,
  db: DB,
  elo: EloOptions,
): Promise<Client> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("clientReady", async (c) => {
    const rest = new REST({ version: "10" }).setToken(token);
    // Guild-scoped registration is instant; global can take ~1h to appear.
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
        await ix.reply(formatLeaderboard(computeRatings(matchesChrono(db), elo)));
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
