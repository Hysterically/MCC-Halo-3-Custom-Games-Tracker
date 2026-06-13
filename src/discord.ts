/**
 * Discord delivery. Three independent, optional channels:
 *
 *  - results webhook  : posts a rich per-match summary after every new match
 *                       (gametype, teams, K/D/A, winner). Goes to e.g.
 *                       #game-results.
 *  - leaderboard hook : maintains one persistent standings message (the
 *                       rendered leaderboard PNG; text table as fallback),
 *                       edited in place after each update. Goes to e.g.
 *                       #leaderboard.
 *  - bot              : answers /leaderboard and /stats [player] on demand.
 *
 * Each works without the others; all are no-ops if not configured.
 */

import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { DB, StoredMatch } from "./db.ts";
import {
  matchCount,
  matchesChrono,
  matchIdByResultsMsg,
  deleteMatch,
  kvGet,
  kvClaim,
  kvCas,
} from "./db.ts";
import { computeRatings, type EloChange, type EloOptions, type Rating } from "./elo.ts";
import type { CarnageReport, CarnagePlayer } from "./parseCarnage.ts";
import {
  boardCategory,
  categorize,
  CATEGORY_LABEL,
  BOARD_CATEGORIES,
  type Category,
} from "./category.ts";
import { displayName } from "./aliases.ts";
import { renderCarnagePng } from "./renderCarnage.ts";
import { renderLeaderboardPng, type BoardSection } from "./renderLeaderboard.ts";

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
 * independent of their FFA ELO. Text form — the fallback when the PNG
 * renderer fails, and the console `board` output.
 */
export function formatLeaderboard(matches: StoredMatch[], elo: EloOptions): string {
  const byCat = groupByCategory(matches);
  const sections = BOARD_CATEGORIES.map((c) =>
    formatSection(`🏆 ${CATEGORY_LABEL[c]} Leaderboard`, computeRatings(byCat.get(c) ?? [], elo)),
  );
  return ["**Halo 3 Customs — ELO Standings**", ...sections].join("\n\n");
}

/** Per-category rating tables in display order, as the PNG renderer wants them. */
export function buildBoardSections(matches: StoredMatch[], elo: EloOptions): BoardSection[] {
  const byCat = groupByCategory(matches);
  return BOARD_CATEGORIES.map((c) => ({
    title: `${CATEGORY_LABEL[c].toUpperCase()} LEADERBOARD`,
    ratings: computeRatings(byCat.get(c) ?? [], elo),
  }));
}

/**
 * The leaderboard PNG, or undefined if rendering fails (callers fall back to
 * the text table).
 */
async function tryRenderLeaderboard(
  matches: StoredMatch[],
  elo: EloOptions,
): Promise<Buffer | undefined> {
  try {
    return await renderLeaderboardPng(buildBoardSections(matches, elo));
  } catch (e) {
    console.warn(
      "[discord] leaderboard render failed, falling back to text:",
      (e as Error).message,
    );
    return undefined;
  }
}

/** Group matches by leaderboard category (shared by board + per-player stats). */
function groupByCategory(matches: StoredMatch[]): Map<Category, StoredMatch[]> {
  const byCat = new Map<Category, StoredMatch[]>();
  for (const m of matches) {
    const cat = boardCategory(m);
    const arr = byCat.get(cat) ?? [];
    arr.push(m);
    byCat.set(cat, arr);
  }
  return byCat;
}

/**
 * Resolve a free-text query (a Gamertag or display alias, possibly partial) to
 * a single player. Matches case-insensitively against both the in-game
 * Gamertag and its display alias; prefers an exact hit, then a prefix, then a
 * substring. Returns the XUID and the display label, or null if nothing matches.
 */
function resolvePlayer(
  matches: StoredMatch[],
  query: string,
): { xuid: string; label: string } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  // XUID -> most-recent Gamertag (matches are chronological, so last wins).
  const names = new Map<string, string>();
  for (const m of matches) for (const p of m.players) if (p.xuid) names.set(p.xuid, p.gamertag);

  const candidates = [...names.entries()].map(([xuid, gamertag]) => ({
    xuid,
    label: displayName(gamertag),
    keys: [gamertag.toLowerCase(), displayName(gamertag).toLowerCase()],
  }));

  const find = (pred: (k: string) => boolean) =>
    candidates.find((c) => c.keys.some(pred));

  const hit =
    find((k) => k === q) ?? find((k) => k.startsWith(q)) ?? find((k) => k.includes(q));
  return hit ? { xuid: hit.xuid, label: hit.label } : null;
}

/**
 * Per-player stats card: ELO, rank, W-L-D, Win% and K/D in each board category
 * (2v2 / 4v4 / FFA), plus an overall line. Categories the player hasn't played
 * are omitted. `query` is a Gamertag or display alias (partial accepted).
 */
export function formatPlayerStats(
  matches: StoredMatch[],
  elo: EloOptions,
  query: string,
): string {
  const who = resolvePlayer(matches, query);
  if (!who) return `🔍 No player matching **${query}** found.`;

  const byCat = groupByCategory(matches);
  const rows: { mode: string; rank: string; elo: string; wld: string; win: string; kd: string }[] =
    [];
  let games = 0,
    wins = 0,
    losses = 0,
    draws = 0,
    kills = 0,
    deaths = 0;

  for (const c of BOARD_CATEGORIES) {
    const ratings = computeRatings(byCat.get(c) ?? [], elo);
    const idx = ratings.findIndex((r) => r.xuid === who.xuid);
    if (idx === -1) continue;
    const r = ratings[idx];
    games += r.games;
    wins += r.wins;
    losses += r.losses;
    draws += r.draws;
    kills += r.kills;
    deaths += r.deaths;
    rows.push({
      mode: CATEGORY_LABEL[c],
      rank: `#${idx + 1}/${ratings.length}`,
      elo: String(Math.round(r.rating)),
      wld: `${r.wins}-${r.losses}-${r.draws}`,
      win: r.games ? `${Math.round((r.wins / r.games) * 100)}%` : "—",
      kd: r.deaths ? (r.kills / r.deaths).toFixed(2) : r.kills.toFixed(2),
    });
  }

  if (!rows.length) {
    return `📊 **${who.label}** hasn't played any ranked (2v2 / 4v4 / FFA) matches yet.`;
  }

  const w = {
    mode: Math.max(4, ...rows.map((r) => r.mode.length)),
    rank: Math.max(4, ...rows.map((r) => r.rank.length)),
    elo: Math.max(3, ...rows.map((r) => r.elo.length)),
    wld: Math.max(5, ...rows.map((r) => r.wld.length)),
    win: Math.max(4, ...rows.map((r) => r.win.length)),
  };
  const head =
    `${"Mode".padEnd(w.mode)}  ${"Rank".padEnd(w.rank)}  ${"Elo".padStart(w.elo)}  ` +
    `${"W-L-D".padEnd(w.wld)}  ${"Win%".padStart(w.win)}   K/D`;
  const lines = rows.map(
    (r) =>
      `${r.mode.padEnd(w.mode)}  ${r.rank.padEnd(w.rank)}  ${r.elo.padStart(w.elo)}  ` +
      `${r.wld.padEnd(w.wld)}  ${r.win.padStart(w.win)}  ${r.kd}`,
  );

  const overallKd = deaths ? (kills / deaths).toFixed(2) : kills.toFixed(2);
  const overallWin = games ? `${Math.round((wins / games) * 100)}%` : "—";
  const overall = `Overall: ${games} games · ${wins}-${losses}-${draws} (${overallWin}) · K/D ${overallKd}`;

  return [`📊 **${who.label}** — Halo 3 Customs stats`, "```", head, ...lines, "", overall, "```"].join(
    "\n",
  );
}

/** Short caption posted above the rendered carnage image. */
export function formatMatchCaption(r: CarnageReport): string {
  const cat = boardCategory(r);
  const tag =
    cat === "other"
      ? "_Off-format — not counted toward a leaderboard._"
      : `_Counted toward **${CATEGORY_LABEL[cat]}** leaderboard._`;
  const map = [r.mapName, r.mapVariant].filter(Boolean).join(" — ");
  return `${map ? `🗺️ **${map}**\n` : ""}${tag}`;
}

/**
 * One line of per-player ELO ratings + changes appended under the scoreboard
 * table, biggest gain first. Empty string when there are no changes
 * (off-format match, or the computation failed upstream).
 */
function formatEloLine(r: CarnageReport, changes?: Map<string, EloChange>): string {
  if (!changes?.size) return "";
  const rated = r.players.filter((p) => changes.has(p.xuid));
  if (!rated.length) return "";
  const sorted = [...rated].sort(
    (a, b) => changes.get(b.xuid)!.delta - changes.get(a.xuid)!.delta,
  );
  const parts = sorted.map((p) => {
    const c = changes.get(p.xuid)!;
    const d = Math.round(c.delta);
    return `${displayName(p.gamertag)} ${Math.round(c.rating)} (${d >= 0 ? "+" : ""}${d})`;
  });
  return `\n📈 **Elo:** ${parts.join(" · ")}`;
}

/** Detailed per-match summary: gametype, teams or FFA, K/D/A, winner. */
export function formatMatchResult(r: CarnageReport, eloChanges?: Map<string, EloChange>): string {
  const cat = boardCategory(r);
  const tag =
    cat === "other"
      ? "_Off-format — not counted toward a leaderboard._"
      : `_Counted toward **${CATEGORY_LABEL[cat]}** leaderboard._`;
  const map = [r.mapName, r.mapVariant].filter(Boolean).join(" — ");
  const header =
    `🎮 **${r.gameTypeName || "Custom Game"}** · ${r.players.length} ${
      r.players.length === 1 ? "player" : "players"
    }${map ? `\n🗺️ ${map}` : ""}\n${tag}`;

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
    return [header, "```", head, ...lines, "```"].join("\n") + formatEloLine(r, eloChanges);
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
  return [header, "```", ...blocks, "```"].join("\n").trimEnd() + formatEloLine(r, eloChanges);
}

const TEAM_NAMES = ["Red", "Blue", "Green", "Orange", "Purple", "Gold", "Brown", "Pink"];
function teamName(id: number): string {
  return TEAM_NAMES[id] ? `${TEAM_NAMES[id]} Team` : `Team ${id}`;
}

// --- webhook plumbing ------------------------------------------------------

/** Multipart body: a payload_json part plus one PNG part, as Discord expects. */
function imageForm(payload: object, png: Buffer, filename: string): FormData {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  form.append("files[0]", new Blob([new Uint8Array(png)], { type: "image/png" }), filename);
  return form;
}

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

/**
 * POST with ?wait=true so Discord returns the created message (incl. id).
 * With `png` the message is the attachment instead of text content.
 */
async function postAndReturnId(
  url: string,
  content: string,
  png?: Buffer,
  filename = "leaderboard.png",
): Promise<string> {
  const u = new URL(url);
  u.searchParams.set("wait", "true");
  const payload = { content, allowed_mentions: { parse: [] } };
  const res = await fetch(
    u,
    png
      ? { method: "POST", body: imageForm(payload, png, filename) }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
  );
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

/**
 * PATCH an existing webhook message in place. Returns false if it's gone (404)
 * so the caller can recreate it; throws on other errors. With `png` the new
 * attachment replaces the old one (`attachments: []` drops it either way, so
 * a text fallback also clears a stale image).
 */
async function editMessage(
  url: string,
  messageId: string,
  content: string,
  png?: Buffer,
): Promise<boolean> {
  const payload = { content, allowed_mentions: { parse: [] }, attachments: [] };
  const res = await fetch(
    `${url}/messages/${messageId}`,
    png
      ? { method: "PATCH", body: imageForm(payload, png, "leaderboard.png") }
      : {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`Discord webhook edit ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return true;
}

/** Stable per-webhook key so changing the URL implicitly resets stored state. */
function webhookId(url: string): string {
  const m = url.match(/\/webhooks\/(\d+)\//);
  return m ? m[1] : url;
}

// --- high-level helpers used by the watcher --------------------------------

/**
 * Post a per-match summary to the results channel (no-op if no URL).
 * Primary form is the rendered carnage-screen PNG with a short caption;
 * if rendering fails for any reason we fall back to the old text table.
 */
export async function postMatchResult(
  url: string | undefined,
  report: CarnageReport,
  eloChanges?: Map<string, EloChange>,
): Promise<string | undefined> {
  if (!url) return undefined;
  let png: Buffer | undefined;
  try {
    png = renderCarnagePng(report, eloChanges);
  } catch (e) {
    console.warn("[discord] carnage render failed, falling back to text:", (e as Error).message);
  }
  // ?wait=true so we capture the created message id — that's the handle the
  // `/delete` command uses to void a game from Discord later.
  return png
    ? postAndReturnId(url, formatMatchCaption(report), png, "carnage.png")
    : postAndReturnId(url, formatMatchResult(report, eloChanges));
}

/**
 * Refresh the live leaderboard by editing a single persistent message in place.
 *
 * The message id is held in the shared DB (kv `lb_msg:<webhook>`), so every
 * instance edits the SAME message instead of each posting its own — that's what
 * keeps two watchers from producing duplicate / diverging boards. Editing in
 * place (rather than post-new + delete-old) is also what makes concurrent
 * refreshes safe: both compute identical content from the one canonical DB, so
 * a last-writer-wins PATCH is harmless. Only the first-ever creation races, and
 * that's resolved with an atomic kv claim (the loser deletes its extra message).
 */
export async function upsertLeaderboard(
  url: string | undefined,
  db: DB,
  elo: EloOptions,
): Promise<void> {
  if (!url) return;
  const matches = await matchesChrono(db);
  // Primary form is the rendered standings PNG; if rendering fails for any
  // reason we fall back to the old text table.
  const png = await tryRenderLeaderboard(matches, elo);
  const content = png ? "" : formatLeaderboard(matches, elo);
  const key = `lb_msg:${webhookId(url)}`;
  const existing = await kvGet(db, key);

  // Happy path: edit the message we already track.
  if (existing) {
    if (await editMessage(url, existing, content, png)) return;
    // Tracked message is gone (e.g. deleted by hand). Recreate and CAS the id.
    const replacement = await postAndReturnId(url, content, png);
    if (await kvCas(db, key, existing, replacement)) return;
    // Another instance already replaced it — drop ours, edit the survivor.
    await deleteMessage(url, replacement);
    const winner = await kvGet(db, key);
    if (winner) await editMessage(url, winner, content, png);
    return;
  }

  // No message yet: create one and atomically claim the slot.
  const created = await postAndReturnId(url, content, png);
  if (await kvClaim(db, key, created)) return;
  // Lost the create race — delete our duplicate, edit the one that won.
  await deleteMessage(url, created);
  const winner = await kvGet(db, key);
  if (winner) await editMessage(url, winner, content, png);
}

// --- slash-command bot ------------------------------------------------------

/** One-line description of a match for the void confirmation / lookup. */
function matchSummary(m: StoredMatch): string {
  const when = new Date(m.playedAt).toISOString().slice(0, 16).replace("T", " ");
  const roster = [...m.players]
    .sort((a, b) => a.teamId - b.teamId || a.standing - b.standing)
    .map((p) => displayName(p.gamertag))
    .join(", ");
  return `**${m.gameTypeName}** (${categorize(m)}) — ${roster} — played ${when}Z`;
}

/** Pull the trailing message id out of a raw id or a "Copy Message Link" URL. */
function extractMessageId(raw: string): string | undefined {
  const ids = raw.match(/\d{5,}/g);
  return ids ? ids[ids.length - 1] : undefined;
}

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the Halo 3 customs ELO leaderboard"),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Per-player ELO, rank, W-L-D and K/D — or the match count if no player given")
    .addStringOption((o) =>
      o
        .setName("player")
        .setDescription("Gamertag or display name (partial works)")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("delete")
    .setDescription("Void a game so it stops counting — give its #game-results message id or link")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName("game")
        .setDescription("The #game-results message id (or its Copy Message Link URL)")
        .setRequired(true),
    ),
].map((c) => c.toJSON());

export async function startBot(
  token: string,
  guildId: string | undefined,
  db: DB,
  elo: EloOptions,
  resultsWebhookUrl?: string,
  leaderboardWebhookUrl?: string,
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
        const matches = await matchesChrono(db);
        const png = await tryRenderLeaderboard(matches, elo);
        if (png) {
          await ix.reply({ files: [{ attachment: png, name: "leaderboard.png" }] });
        } else {
          await ix.reply(formatLeaderboard(matches, elo));
        }
      } else if (ix.commandName === "stats") {
        const query = ix.options.getString("player");
        if (query) {
          await ix.reply(formatPlayerStats(await matchesChrono(db), elo, query));
        } else {
          await ix.reply(`📊 ${await matchCount(db)} tracked Halo 3 custom matches recorded.`);
        }
      } else if (ix.commandName === "delete") {
        await handleDelete(ix, db, elo, resultsWebhookUrl, leaderboardWebhookUrl);
      }
    } catch (e) {
      console.error("[discord] command error:", e);
      if (!ix.replied) await ix.reply("Something went wrong.").catch(() => {});
    }
  });

  await client.login(token);
  return client;
}

/**
 * Void a game referenced by its #game-results message: drop it from the DB
 * (ELO/leaderboard recompute from history), delete the original post, and refresh
 * the live leaderboard. Replies publicly. Gated to Manage Server at registration.
 */
async function handleDelete(
  ix: ChatInputCommandInteraction,
  db: DB,
  elo: EloOptions,
  resultsWebhookUrl?: string,
  leaderboardWebhookUrl?: string,
): Promise<void> {
  const msgId = extractMessageId(ix.options.getString("game", true));
  if (!msgId) {
    await ix.reply("That doesn't look like a message id or link.");
    return;
  }

  const matchId = await matchIdByResultsMsg(db, msgId);
  if (!matchId) {
    await ix.reply(
      "No tracked game found for that post — it may predate message tracking. " +
        "Use the `remove-match` CLI on the host for older games.",
    );
    return;
  }

  const target = (await matchesChrono(db)).find((m) => m.matchId === matchId);
  const summary = target ? matchSummary(target) : `match \`${matchId}\``;

  await deleteMatch(db, matchId);
  if (resultsWebhookUrl) await deleteMessage(resultsWebhookUrl, msgId);
  try {
    await upsertLeaderboard(leaderboardWebhookUrl, db, elo);
  } catch (e) {
    console.error("[discord] leaderboard refresh after delete failed:", (e as Error).message);
  }

  await ix.reply(`🗑️ Voided ${summary}. ${await matchCount(db)} matches remain.`);
}
