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
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type APIEmbed,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { config } from "./config.ts";
import { statusBar } from "./term.ts";
import type { DB, StoredMatch } from "./db.ts";
import {
  matchCount,
  matchesChrono,
  matchIdByResultsMsg,
  resultsRestyleTargets,
  deleteMatch,
  setMatchExcluded,
  hiddenXuids,
  kvGet,
  kvClaim,
  kvCas,
  kvDelete,
} from "./db.ts";
import { restyleResultPost } from "./heal.ts";
import { computeRatings, type EloChange, type EloOptions, type Rating } from "./elo.ts";
import type { CarnageReport, CarnagePlayer } from "./parseCarnage.ts";
import {
  boardCategory,
  categorize,
  CATEGORY_LABEL,
  BOARD_CATEGORIES,
  LEADERBOARD_POST_ORDER,
  type Category,
} from "./category.ts";
import { displayName } from "./aliases.ts";
import { renderCarnagePng, renderCarnageCsrPng } from "./renderCarnage.ts";
import { renderLeaderboardPng, type BoardSection } from "./renderLeaderboard.ts";
import { rateCategory, type CsrChange, type MatchWinChances } from "./trueskill2.ts";
import { renderCsrLeaderboardPng, type CsrRow } from "./renderCsrLeaderboard.ts";
import { csrFromSkill, csrText } from "./csr.ts";

// --- formatting ------------------------------------------------------------

/** Podium markers for the top three places (gold, silver, bronze). */
const MEDALS = ["🥇", "🥈", "🥉"];

/** Embed accent colors, shared with the C++ build (cpp/src/format.cpp). */
const EMBED = {
  neutral: 0x5865f2, // blurple — leaderboards, stats, recap
  win: 0x57f287, // green — restored / counted
  danger: 0xed4245, // red — voided / off-format
  gold: 0xfee75c, // recap highlights
};

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
  const mapLabel = r.mapVariant || r.mapName;
  const header = `${r.gameTypeName || "Custom Game"}${mapLabel ? ` on ${mapLabel}` : ""}`;
  return `**${header}**\n${tag}`;
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
    }${map ? `\n${map}` : ""}\n${tag}`;

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
  components?: object[],
): Promise<string> {
  const u = new URL(url);
  u.searchParams.set("wait", "true");
  const payload: Record<string, unknown> = { content, allowed_mentions: { parse: [] } };
  if (components) payload.components = components;
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
export async function deleteMessage(url: string, messageId: string): Promise<void> {
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

/** Render a single board section to PNG, or undefined if rendering fails. */
async function tryRenderSection(section: BoardSection): Promise<Buffer | undefined> {
  try {
    return await renderLeaderboardPng([section]);
  } catch (e) {
    console.warn(
      "[discord] leaderboard render failed, falling back to text:",
      (e as Error).message,
    );
    return undefined;
  }
}

/**
 * Create-or-edit one persistent webhook message tracked under `key`. Same
 * last-writer-wins + atomic-claim race handling the single combined board used:
 * every instance edits the SAME message per key instead of each posting its
 * own, and only the first-ever creation races (resolved with an atomic kv claim,
 * the loser deleting its extra message).
 */
async function upsertOneMessage(
  url: string,
  db: DB,
  key: string,
  content: string,
  png?: Buffer,
): Promise<void> {
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

/**
 * Retire the old single combined-board message (the pre-split layout). One-time
 * cleanup: delete the message and drop its kv slot so a stale all-in-one board
 * doesn't linger above the three per-category boards.
 */
async function retireCombinedLeaderboard(url: string, db: DB): Promise<void> {
  const key = `lb_msg:${webhookId(url)}`;
  const old = await kvGet(db, key);
  if (!old) return;
  await deleteMessage(url, old);
  await kvDelete(db, key);
}

/**
 * Refresh the live leaderboard as THREE persistent messages — one per board
 * category, each its own standings PNG (text section as fallback) edited in
 * place. They're posted 2v2 → FFA → 4v4 ({@link LEADERBOARD_POST_ORDER}) so the
 * 4v4 board lands at the bottom of the channel: the newest / most in-focus one.
 *
 * Each message's id is held in the shared DB under `lb_msg:<webhook>:<cat>`, so
 * every instance edits the SAME three messages instead of each posting its own.
 * See {@link upsertOneMessage} for the per-message race handling.
 */
export async function upsertLeaderboard(
  url: string | undefined,
  db: DB,
  elo: EloOptions,
): Promise<void> {
  if (!url) return;
  const matches = await matchesChrono(db);
  // Drop the old single combined message if this webhook still tracks one.
  await retireCombinedLeaderboard(url, db);

  const byCat = groupByCategory(matches);
  const base = webhookId(url);
  for (const cat of LEADERBOARD_POST_ORDER) {
    const ratings = computeRatings(byCat.get(cat) ?? [], elo);
    // Primary form is the rendered standings PNG; text section on failure.
    const png = await tryRenderSection({
      title: `${CATEGORY_LABEL[cat].toUpperCase()} LEADERBOARD`,
      ratings,
    });
    const content = png ? "" : formatSection(`🏆 ${CATEGORY_LABEL[cat]} Leaderboard`, ratings);
    await upsertOneMessage(url, db, `lb_msg:${base}:${cat}`, content, png);
  }
}

// --- TrueSkill 2 delivery (parallel to the ELO results/leaderboard) ----

/**
 * One line of per-player CSR ratings + changes, biggest gain first — the CSR
 * analog of {@link formatEloLine}, used in the text fallback when the PNG fails.
 */
function formatCsrLine(r: CarnageReport, changes?: Map<string, CsrChange>): string {
  if (!changes?.size) return "";
  const rated = r.players.filter((p) => changes.has(p.xuid));
  if (!rated.length) return "";
  const sorted = [...rated].sort((a, b) => changes.get(b.xuid)!.delta - changes.get(a.xuid)!.delta);
  const parts = sorted.map((p) => {
    const c = changes.get(p.xuid)!;
    return `${displayName(p.gamertag)} ${csrText(c.csr)} (${c.delta >= 0 ? "+" : ""}${c.delta})`;
  });
  return `\n🎖️ **CSR:** ${parts.join(" · ")}`;
}

/**
 * Post a per-match TrueSkill 2 summary to the #ts2-game-results channel:
 * the carnage-screen PNG with the CSR column (tier + number + change). Falls back
 * to the text scoreboard + a CSR line if rendering fails. Returns the message id.
 */
export async function postCsrMatchResult(
  url: string | undefined,
  report: CarnageReport,
  csrChanges?: Map<string, CsrChange>,
  win?: MatchWinChances,
  components?: object[],
): Promise<string | undefined> {
  if (!url) return undefined;
  let png: Buffer | undefined;
  try {
    png = await renderCarnageCsrPng(report, csrChanges, win);
  } catch (e) {
    console.warn("[discord] CSR carnage render failed, falling back to text:", (e as Error).message);
  }
  return png
    ? postAndReturnId(url, formatMatchCaption(report), png, "carnage-csr.png", components)
    : postAndReturnId(
        url,
        formatMatchResult(report) + formatCsrLine(report, csrChanges),
        undefined,
        "leaderboard.png",
        components,
      );
}

/**
 * Post a per-match result with the Void/Exclude buttons when an app-owned
 * webhook is available (it carries components; a plain webhook can't), else the
 * plain post to the configured results webhook. The watcher's entry point —
 * resolves the right webhook + buttons so watch.ts stays simple. Returns the id.
 */
export async function postCsrMatchResultWithControls(
  db: DB,
  report: CarnageReport,
  csrChanges?: Map<string, CsrChange>,
  win?: MatchWinChances,
): Promise<string | undefined> {
  const appUrl = await kvGet(db, APP_WEBHOOK_KEY);
  const url = appUrl ?? config.discordResultsWebhookUrl;
  const components = appUrl ? matchButtons(report.matchId) : undefined;
  return postCsrMatchResult(url, report, csrChanges, win, components);
}

/** Per-category CSR rows, ranked best-first — the shape the PNG renderer wants. */
function csrRows(matches: StoredMatch[], hidden: ReadonlySet<string> = new Set()): CsrRow[] {
  return rateCategory(matches)
    .filter((r) => r.games > 0 && !hidden.has(r.xuid))
    .sort((a, b) => b.skill - a.skill)
    .map((r) => ({
      gamertag: r.gamertag,
      skill: r.skill,
      peakSkill: r.peakSkill,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
      games: r.games,
      kills: r.kills,
      deaths: r.deaths,
    }));
}

/** Render one CSR board section to PNG, or undefined if rendering fails. */
async function tryRenderCsrSection(
  cat: Category,
  matches: StoredMatch[],
  hidden: ReadonlySet<string> = new Set(),
): Promise<Buffer | undefined> {
  try {
    return await renderCsrLeaderboardPng([
      { title: `${CATEGORY_LABEL[cat].toUpperCase()} LEADERBOARD`, rows: csrRows(matches, hidden) },
    ]);
  } catch (e) {
    console.warn("[discord] CSR leaderboard render failed, falling back to text:", (e as Error).message);
    return undefined;
  }
}

/** Text fallback for one CSR board category (mirrors {@link formatSection}). */
function formatCsrSection(
  cat: Category,
  matches: StoredMatch[],
  hidden: ReadonlySet<string> = new Set(),
  limit = 20,
): string {
  const heading = `__**🎖️ ${CATEGORY_LABEL[cat]} — TrueSkill 2**__`;
  const rows = csrRows(matches, hidden).slice(0, limit);
  if (!rows.length) return `${heading}\n_No matches yet._`;
  const names = rows.map((r) => displayName(r.gamertag));
  const nameW = Math.max(6, ...names.map((n) => n.length));
  const head = `${"#".padEnd(5)}${"Player".padEnd(nameW)}  ${"CSR".padEnd(16)} W-L-D    Win%   K/D`;
  const lines = rows.map((r, i) => {
    const cell = csrFromSkill(r.skill);
    const label = `${cell.label} (${cell.value})`;
    const wld = `${r.wins}-${r.losses}-${r.draws}`;
    const winPct = r.games ? `${Math.round((r.wins / r.games) * 100)}%` : "—";
    const kd = r.deaths ? (r.kills / r.deaths).toFixed(2) : r.kills.toFixed(2);
    const marker = MEDALS[i] ?? "  ";
    return `${marker}${String(i + 1).padEnd(2)} ${names[i].padEnd(nameW)}  ${label.padEnd(16)} ${wld.padEnd(
      7,
    )} ${winPct.padStart(4)}  ${kd}`;
  });
  return [heading, "```", head, ...lines, "```"].join("\n");
}

/**
 * Refresh the live TrueSkill 2 leaderboard as THREE persistent messages —
 * one per board category — in #ts2-leaderboard, each its own CSR standings PNG
 * (text section as fallback) edited in place. Same per-message race handling and
 * 2v2 → FFA → 4v4 post order as the ELO board ({@link upsertLeaderboard}).
 */
export async function upsertCsrLeaderboard(url: string | undefined, db: DB): Promise<void> {
  if (!url) return;
  const matches = await matchesChrono(db);
  const hidden = await hiddenXuids(db);
  // Drop the old single combined message if this webhook still tracks one.
  await retireCombinedLeaderboard(url, db);

  const byCat = groupByCategory(matches);
  const base = webhookId(url);
  for (const cat of LEADERBOARD_POST_ORDER) {
    const catMatches = byCat.get(cat) ?? [];
    const png = await tryRenderCsrSection(cat, catMatches, hidden);
    const content = png ? "" : formatCsrSection(cat, catMatches, hidden);
    // Reuse the `lb_msg:` slot the ELO board used: on the now-CSR #leaderboard
    // this edits the existing per-category messages in place rather than
    // leaving the old ELO ones behind.
    await upsertOneMessage(url, db, `lb_msg:${base}:${cat}`, content, png);
  }
}

/** Per-category CSR rating tables in display order, for the combined /leaderboard PNG. */
function buildCsrBoardSections(
  matches: StoredMatch[],
  hidden: ReadonlySet<string> = new Set(),
): { title: string; rows: CsrRow[] }[] {
  const byCat = groupByCategory(matches);
  return BOARD_CATEGORIES.map((c) => ({
    title: `${CATEGORY_LABEL[c].toUpperCase()} LEADERBOARD`,
    rows: csrRows(byCat.get(c) ?? [], hidden),
  }));
}

/** The full CSR leaderboard PNG (all categories), or undefined if rendering fails. */
async function tryRenderCsrLeaderboard(
  matches: StoredMatch[],
  hidden: ReadonlySet<string> = new Set(),
): Promise<Buffer | undefined> {
  try {
    return await renderCsrLeaderboardPng(buildCsrBoardSections(matches, hidden));
  } catch (e) {
    console.warn("[discord] CSR leaderboard render failed, falling back to text:", (e as Error).message);
    return undefined;
  }
}

/** Text form of the full CSR leaderboard — the PNG fallback and console output. */
export function formatCsrLeaderboard(
  matches: StoredMatch[],
  hidden: ReadonlySet<string> = new Set(),
): string {
  const byCat = groupByCategory(matches);
  const sections = BOARD_CATEGORIES.map((c) => formatCsrSection(c, byCat.get(c) ?? [], hidden));
  return ["**Halo 3 Customs — CSR Standings**", ...sections].join("\n\n");
}

interface CsrStatRow {
  mode: string;
  rank: string;
  csr: string;
  wld: string;
  win: string;
  kd: string;
}
type CsrStatsResult =
  | { kind: "none"; query: string }
  | { kind: "unranked"; label: string }
  | {
      kind: "ok";
      label: string;
      rows: CsrStatRow[];
      totals: { games: number; wins: number; losses: number; draws: number; kills: number; deaths: number };
    };

/**
 * Per-player CSR stats, computed once and rendered as either a text card
 * ({@link formatCsrPlayerStats}) or a rich embed ({@link buildCsrPlayerStatsEmbed}).
 */
function computeCsrPlayerStats(matches: StoredMatch[], query: string): CsrStatsResult {
  const who = resolvePlayer(matches, query);
  if (!who) return { kind: "none", query };

  const byCat = groupByCategory(matches);
  const rows: CsrStatRow[] = [];
  let games = 0,
    wins = 0,
    losses = 0,
    draws = 0,
    kills = 0,
    deaths = 0;

  for (const c of BOARD_CATEGORIES) {
    const ranked = rateCategory(byCat.get(c) ?? [])
      .filter((r) => r.games > 0)
      .sort((a, b) => b.skill - a.skill);
    const idx = ranked.findIndex((r) => r.xuid === who.xuid);
    if (idx === -1) continue;
    const r = ranked[idx];
    games += r.games;
    wins += r.wins;
    losses += r.losses;
    draws += r.draws;
    kills += r.kills;
    deaths += r.deaths;
    rows.push({
      mode: CATEGORY_LABEL[c],
      rank: `#${idx + 1}/${ranked.length}`,
      csr: csrText(csrFromSkill(r.skill)),
      wld: `${r.wins}-${r.losses}-${r.draws}`,
      win: r.games ? `${Math.round((r.wins / r.games) * 100)}%` : "—",
      kd: r.deaths ? (r.kills / r.deaths).toFixed(2) : r.kills.toFixed(2),
    });
  }

  if (!rows.length) return { kind: "unranked", label: who.label };
  return { kind: "ok", label: who.label, rows, totals: { games, wins, losses, draws, kills, deaths } };
}

/**
 * Per-player CSR stats card: tier + number, rank, W-L-D, Win% and K/D in each
 * board category, plus an overall line — the CSR analog of {@link formatPlayerStats}.
 */
export function formatCsrPlayerStats(matches: StoredMatch[], query: string): string {
  const res = computeCsrPlayerStats(matches, query);
  if (res.kind === "none") return `🔍 No player matching **${query}** found.`;
  if (res.kind === "unranked")
    return `📊 **${res.label}** hasn't played any ranked (2v2 / 4v4 / FFA) matches yet.`;
  const { label: who_label, rows, totals } = res;
  const { games, wins, losses, draws, kills, deaths } = totals;

  const w = {
    mode: Math.max(4, ...rows.map((r) => r.mode.length)),
    rank: Math.max(4, ...rows.map((r) => r.rank.length)),
    csr: Math.max(3, ...rows.map((r) => r.csr.length)),
    wld: Math.max(5, ...rows.map((r) => r.wld.length)),
    win: Math.max(4, ...rows.map((r) => r.win.length)),
  };
  const head =
    `${"Mode".padEnd(w.mode)}  ${"Rank".padEnd(w.rank)}  ${"CSR".padEnd(w.csr)}  ` +
    `${"W-L-D".padEnd(w.wld)}  ${"Win%".padStart(w.win)}   K/D`;
  const lines = rows.map(
    (r) =>
      `${r.mode.padEnd(w.mode)}  ${r.rank.padEnd(w.rank)}  ${r.csr.padEnd(w.csr)}  ` +
      `${r.wld.padEnd(w.wld)}  ${r.win.padStart(w.win)}  ${r.kd}`,
  );

  const overallKd = deaths ? (kills / deaths).toFixed(2) : kills.toFixed(2);
  const overallWin = games ? `${Math.round((wins / games) * 100)}%` : "—";
  const overall = `Overall: ${games} games · ${wins}-${losses}-${draws} (${overallWin}) · K/D ${overallKd}`;

  return [`📊 **${who_label}** — Halo 3 Customs CSR`, "```", head, ...lines, "", overall, "```"].join(
    "\n",
  );
}

/**
 * Per-player CSR stats as a rich embed (one inline field per board category +
 * an overall footer), or a plain `content` line for the not-found / unranked
 * cases. Used by the `/stats <player>` slash reply.
 */
export function buildCsrPlayerStatsEmbed(
  matches: StoredMatch[],
  query: string,
): { embed?: APIEmbed; content?: string } {
  const res = computeCsrPlayerStats(matches, query);
  if (res.kind === "none") return { content: `🔍 No player matching **${query}** found.` };
  if (res.kind === "unranked")
    return {
      content: `📊 **${res.label}** hasn't played any ranked (2v2 / 4v4 / FFA) matches yet.`,
    };
  const { label, rows, totals } = res;
  const fields = rows.map((r) => ({
    name: r.mode,
    value: `**${r.csr}**\nRank ${r.rank} · ${r.wld} (${r.win}) · K/D ${r.kd}`,
    inline: true,
  }));
  const overallKd = totals.deaths ? (totals.kills / totals.deaths).toFixed(2) : totals.kills.toFixed(2);
  const overallWin = totals.games ? `${Math.round((totals.wins / totals.games) * 100)}%` : "—";
  return {
    embed: {
      title: `📊 ${label} — Halo 3 Customs CSR`,
      color: EMBED.neutral,
      fields,
      footer: {
        text: `${totals.games} games · ${totals.wins}-${totals.losses}-${totals.draws} (${overallWin}) · K/D ${overallKd}`,
      },
      timestamp: new Date().toISOString(),
    },
  };
}

/** Embed wrapper around the /leaderboard standings PNG (attachment://…). */
function leaderboardEmbed(): APIEmbed {
  return {
    title: "🏆 Halo 3 Customs — CSR Standings",
    color: EMBED.neutral,
    image: { url: "attachment://leaderboard.png" },
    footer: { text: "2v2 · FFA · 4v4 — TrueSkill 2" },
    timestamp: new Date().toISOString(),
  };
}

/**
 * The weekly recap embed: games played, the most active player, the MVP (best
 * K/D, ≥2 games) over the last `windowMs`, and the current per-category CSR
 * leaders. Returns null if no counted matches fell in the window.
 */
export function buildRecapEmbed(matches: StoredMatch[], windowMs = 7 * 86_400_000): APIEmbed | null {
  const since = Date.now() - windowMs;
  const week = matches.filter((m) => m.playedAt >= since && !m.excluded);
  if (!week.length) return null;

  const byPlayer = new Map<string, { name: string; games: number; kills: number; deaths: number }>();
  for (const m of week)
    for (const p of m.players) {
      if (!p.xuid) continue;
      const e = byPlayer.get(p.xuid) ?? { name: displayName(p.gamertag), games: 0, kills: 0, deaths: 0 };
      e.games++;
      e.kills += p.kills;
      e.deaths += p.deaths;
      byPlayer.set(p.xuid, e);
    }
  const players = [...byPlayer.values()];
  const kd = (p: { kills: number; deaths: number }): number => p.kills / Math.max(1, p.deaths);
  const mostActive = players.slice().sort((a, b) => b.games - a.games)[0];
  const mvp = players.filter((p) => p.games >= 2).sort((a, b) => kd(b) - kd(a))[0];

  const byCat = groupByCategory(matches);
  const leaders = BOARD_CATEGORIES.map((cat) => {
    const top = rateCategory(byCat.get(cat) ?? [])
      .filter((r) => r.games > 0)
      .sort((a, b) => b.skill - a.skill)[0];
    return top
      ? `**${CATEGORY_LABEL[cat]}** — ${displayName(top.gamertag)} (${csrText(csrFromSkill(top.skill))})`
      : null;
  }).filter((s): s is string => s !== null);

  const fields: APIEmbed["fields"] = [
    { name: "Games this week", value: String(week.length), inline: true },
  ];
  if (mostActive) fields.push({ name: "Most active", value: `${mostActive.name} (${mostActive.games})`, inline: true });
  if (mvp) fields.push({ name: "MVP (K/D)", value: `${mvp.name} (${kd(mvp).toFixed(2)})`, inline: true });
  if (leaders.length) fields.push({ name: "Current leaders", value: leaders.join("\n") });

  return {
    title: "📅 Weekly Recap — Halo 3 Customs",
    color: EMBED.gold,
    fields,
    timestamp: new Date().toISOString(),
  };
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

const DISCORD_API = "https://discord.com/api/v10";

/** Split a webhook URL into its id + token (the two path segments after /webhooks/). */
function parseWebhookUrl(url: string): { id: string; token: string } | undefined {
  const m = url.match(/\/webhooks\/(\d+)\/([\w-]+)/);
  return m ? { id: m[1], token: m[2] } : undefined;
}

// --- app-owned results webhook (buttons) -----------------------------------
// Interactive components (the Void/Exclude buttons) are silently dropped by
// Discord on a plain incoming webhook — only an *application-owned* webhook can
// carry them. So when a bot token is configured we find-or-create our own
// webhook in the results channel and post through that; its URL is cached in the
// shared kv (`results_app_webhook`) so every instance and the watcher converge.

const APP_WEBHOOK_KEY = "results_app_webhook";

/**
 * Ensure an application-owned webhook exists in the results channel and cache
 * its URL. Idempotent (find-or-create, so restarts reuse it). Returns the URL,
 * or undefined if there's no results webhook to derive the channel from / the
 * bot lacks Manage Webhooks.
 */
async function ensureAppResultsWebhook(
  token: string,
  appId: string,
  db: DB,
): Promise<string | undefined> {
  const cached = await kvGet(db, APP_WEBHOOK_KEY);
  if (cached) return cached;
  const base = config.discordResultsWebhookUrl;
  if (!base) return undefined;
  const parsed = parseWebhookUrl(base);
  if (!parsed) return undefined;

  const auth = { authorization: `Bot ${token}`, "user-agent": "h3-tracker" };
  try {
    // The token route needs no auth and tells us which channel to target.
    const metaRes = await fetch(`${DISCORD_API}/webhooks/${parsed.id}/${parsed.token}`, {
      headers: { "user-agent": "h3-tracker" },
    });
    if (!metaRes.ok) return undefined;
    const channelId = ((await metaRes.json()) as { channel_id?: string }).channel_id;
    if (!channelId) return undefined;

    // Reuse our existing app-owned webhook in that channel, else create one.
    const listRes = await fetch(`${DISCORD_API}/channels/${channelId}/webhooks`, { headers: auth });
    if (!listRes.ok) return undefined;
    const hooks = (await listRes.json()) as { id: string; token?: string; application_id?: string }[];
    let hook = hooks.find((h) => h.application_id === appId && h.token);
    if (!hook) {
      const createRes = await fetch(`${DISCORD_API}/channels/${channelId}/webhooks`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ name: "H3 Tracker" }),
      });
      if (!createRes.ok) return undefined;
      hook = (await createRes.json()) as { id: string; token?: string; application_id?: string };
    }
    if (!hook?.token) return undefined;
    const url = `${DISCORD_API}/webhooks/${hook.id}/${hook.token}`;
    await kvClaim(db, APP_WEBHOOK_KEY, url);
    return (await kvGet(db, APP_WEBHOOK_KEY)) ?? url;
  } catch {
    return undefined; // best-effort: no buttons, fall back to the plain webhook
  }
}

/**
 * Webhook URLs that may have authored a results post, app-owned first: an edit
 * or delete tries each (404 → next) so it works whether the post predates the
 * app webhook (user webhook) or carries buttons (app webhook).
 */
export async function resultsWebhookCandidates(db: DB): Promise<string[]> {
  const urls: string[] = [];
  const app = await kvGet(db, APP_WEBHOOK_KEY);
  if (app) urls.push(app);
  if (config.discordResultsWebhookUrl && config.discordResultsWebhookUrl !== app)
    urls.push(config.discordResultsWebhookUrl);
  return urls;
}

/** The Void / Exclude action row for a results post, keyed by match id. */
function matchButtons(matchId: string): object[] {
  return [
    {
      type: 1, // action row
      components: [
        { type: 2, style: 4, label: "Void", custom_id: `void:${matchId}` }, // danger
        { type: 2, style: 2, label: "Exclude", custom_id: `exclude:${matchId}` }, // secondary
      ],
    },
  ];
}

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the Halo 3 customs CSR leaderboard"),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Per-player CSR, rank, W-L-D and K/D — or the match count if no player given")
    .addStringOption((o) =>
      o
        .setName("player")
        .setDescription("Gamertag or display name (partial works)")
        .setRequired(false)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("delete")
    .setDescription("Void a game so it stops counting — pick it or give its message id")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName("game")
        .setDescription("Pick a recent game, or paste its #game-results message id / link")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("exclude")
    .setDescription("Drop a game from the boards but keep its post (off-format) — pick it or give its id")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName("game")
        .setDescription("Pick a recent game, or paste its #game-results message id / link")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addBooleanOption((o) =>
      o
        .setName("restore")
        .setDescription("Undo: count the game again (default false)")
        .setRequired(false),
    ),
].map((c) => c.toJSON());

export async function startBot(
  token: string,
  guildId: string | undefined,
  db: DB,
  resultsWebhookUrl?: string,
  leaderboardWebhookUrl?: string,
): Promise<Client> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("clientReady", async (c) => {
    // Gateway is live the moment the ready event fires — surface that in the
    // status bar before the (slower, fallible) command registration so a
    // hang/throw there can't leave the footer stuck on "connecting".
    statusBar.setBot("online");
    console.log(`[discord] bot online as ${c.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(token);
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), { body: COMMANDS });
    } else {
      await rest.put(Routes.applicationCommands(c.user.id), { body: COMMANDS });
    }
    console.log("[discord] commands registered");
    // Provision our own webhook in the results channel so per-match posts can
    // carry the Void/Exclude buttons (plain webhooks strip components).
    if (resultsWebhookUrl) {
      const url = await ensureAppResultsWebhook(token, c.user.id, db);
      if (url) console.log("[discord] results buttons enabled (app-owned webhook)");
    }
    startRecapScheduler(db);
  });

  client.on("interactionCreate", async (i) => {
    try {
      if (i.isAutocomplete()) {
        await handleAutocomplete(i, db);
        return;
      }
      if (i.isButton()) {
        await handleButton(i, db, leaderboardWebhookUrl);
        return;
      }
      if (!i.isChatInputCommand()) return;
      const ix = i;
      if (ix.commandName === "leaderboard") {
        const matches = await matchesChrono(db);
        const hidden = await hiddenXuids(db);
        const png = await tryRenderCsrLeaderboard(matches, hidden);
        if (png) {
          await ix.reply({
            embeds: [leaderboardEmbed()],
            files: [{ attachment: png, name: "leaderboard.png" }],
          });
        } else {
          await ix.reply(formatCsrLeaderboard(matches, hidden));
        }
      } else if (ix.commandName === "stats") {
        const query = ix.options.getString("player");
        if (query) {
          const { embed, content } = buildCsrPlayerStatsEmbed(await matchesChrono(db), query);
          await ix.reply(embed ? { embeds: [embed] } : { content: content ?? "" });
        } else {
          await ix.reply(`📊 ${await matchCount(db)} tracked Halo 3 custom matches recorded.`);
        }
      } else if (ix.commandName === "delete") {
        await handleDelete(ix, db, leaderboardWebhookUrl);
      } else if (ix.commandName === "exclude") {
        await handleExclude(ix, db, leaderboardWebhookUrl);
      }
    } catch (e) {
      console.error("[discord] interaction error:", e);
      if (i.isRepliable() && !i.replied && !i.deferred)
        await i.reply({ content: "Something went wrong.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  await client.login(token);
  return client;
}

/** Autocomplete: player names for /stats, recent games for /delete & /exclude. */
async function handleAutocomplete(ix: AutocompleteInteraction, db: DB): Promise<void> {
  const focused = ix.options.getFocused(true);
  const q = String(focused.value ?? "").toLowerCase();
  const matches = await matchesChrono(db);
  if (focused.name === "player") {
    const names = new Set<string>();
    for (const m of matches) for (const p of m.players) if (p.xuid) names.add(displayName(p.gamertag));
    const choices = [...names]
      .filter((n) => n.toLowerCase().includes(q))
      .slice(0, 25)
      .map((n) => ({ name: n, value: n }));
    await ix.respond(choices);
    return;
  }
  if (focused.name === "game") {
    const msgByMatch = new Map(
      (await resultsRestyleTargets(db, 0, true)).map((t) => [t.matchId, t.msgId]),
    );
    const choices = matches
      .filter((m) => msgByMatch.has(m.matchId))
      .sort((a, b) => b.playedAt - a.playedAt)
      .map((m) => ({ name: matchChoiceLabel(m), value: msgByMatch.get(m.matchId)! }))
      .filter((ch) => ch.name.toLowerCase().includes(q))
      .slice(0, 25);
    await ix.respond(choices);
    return;
  }
  await ix.respond([]);
}

/** A ≤100-char plain-text label for one match, for the /delete autocomplete list. */
function matchChoiceLabel(m: StoredMatch): string {
  const when = new Date(m.playedAt).toISOString().slice(0, 16).replace("T", " ");
  const roster = [...m.players]
    .sort((a, b) => a.teamId - b.teamId || a.standing - b.standing)
    .map((p) => displayName(p.gamertag))
    .join(", ");
  const s = `${m.gameTypeName} (${categorize(m)}) — ${when} — ${roster}`;
  return s.length > 100 ? s.slice(0, 97) + "…" : s;
}

/**
 * Void / Exclude button click. Gated to Manage Server (component interactions
 * carry no default_member_permissions, so we check manually). Operates on the
 * post the button is attached to — always one of our app-webhook posts.
 */
async function handleButton(
  ix: ButtonInteraction,
  db: DB,
  leaderboardWebhookUrl?: string,
): Promise<void> {
  if (!ix.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await ix.reply({
      content: "You need the Manage Server permission to do that.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const [action, matchId] = ix.customId.split(":");
  const msgId = ix.message.id;
  await ix.deferReply({ flags: MessageFlags.Ephemeral });
  const reply =
    action === "void"
      ? await voidMatch(db, matchId, msgId, leaderboardWebhookUrl)
      : await excludeMatch(db, matchId, msgId, false, leaderboardWebhookUrl);
  await ix.editReply(reply);
}

/** Post the weekly recap on Sundays from 20:00 local, once per ISO week. */
function startRecapScheduler(db: DB): void {
  const url = config.discordResultsWebhookUrl;
  if (!url) return;
  const tick = async (): Promise<void> => {
    try {
      const now = new Date();
      if (now.getDay() !== 0 || now.getHours() < 20) return; // Sunday evening
      const embed = buildRecapEmbed(await matchesChrono(db));
      if (!embed) return;
      const weekKey = `recap:${now.getUTCFullYear()}-${isoWeek(now)}`;
      if (!(await kvClaim(db, weekKey, now.toISOString()))) return; // already posted (any instance)
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      });
      console.log("[recap] posted weekly recap");
    } catch (e) {
      console.error("[recap] weekly recap failed:", (e as Error).message);
    }
  };
  const timer = setInterval(() => void tick(), 60 * 60 * 1000);
  timer.unref?.();
  void tick();
}

/** ISO-8601 week number ("W01".."W53") of a date, for the recap dedupe key. */
function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `W${String(week).padStart(2, "0")}`;
}

/**
 * Void a game referenced by its #game-results message: drop it from the DB
 * (CSR/leaderboard recompute from history), delete the original post, and refresh
 * the live leaderboard. Replies publicly. Gated to Manage Server at registration.
 */
async function handleDelete(
  ix: ChatInputCommandInteraction,
  db: DB,
  leaderboardWebhookUrl?: string,
): Promise<void> {
  const msgId = extractMessageId(ix.options.getString("game", true));
  if (!msgId) {
    await ix.reply({ content: "That doesn't look like a message id or link.", flags: MessageFlags.Ephemeral });
    return;
  }
  const matchId = await matchIdByResultsMsg(db, msgId);
  if (!matchId) {
    await ix.reply({
      content:
        "No tracked game found for that post — it may predate message tracking. " +
        "Use the `remove-match` CLI on the host for older games.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await ix.deferReply({ flags: MessageFlags.Ephemeral });
  await ix.editReply(await voidMatch(db, matchId, msgId, leaderboardWebhookUrl));
}

/**
 * Void a match: drop it from the DB (CSR/leaderboard recompute from history),
 * delete its #game-results post (trying each candidate webhook), refresh the
 * live leaderboard, and force-restyle later posts in the background (a deleted
 * game shifts every later CSR change). Returns the confirmation text. Shared by
 * the `/delete` command and the Void button.
 */
async function voidMatch(
  db: DB,
  matchId: string,
  msgId: string,
  leaderboardWebhookUrl?: string,
): Promise<string> {
  const target = (await matchesChrono(db)).find((m) => m.matchId === matchId);
  const summary = target ? matchSummary(target) : `match \`${matchId}\``;

  await deleteMatch(db, matchId);
  for (const url of await resultsWebhookCandidates(db)) await deleteMessage(url, msgId);
  try {
    await upsertCsrLeaderboard(leaderboardWebhookUrl, db);
  } catch (e) {
    console.error("[discord] leaderboard refresh after delete failed:", (e as Error).message);
  }

  // Detached, rate-limited re-style of later posts. Dynamic import avoids a
  // heal.ts ↔ discord.ts import cycle.
  void (async () => {
    try {
      const { healStaleResults } = await import("./heal.ts");
      await healStaleResults(db, { force: true, log: (m) => console.log("[heal]", m) });
    } catch (e) {
      console.error("[discord] post-delete restyle failed:", (e as Error).message);
    }
  })();

  return `🗑️ Voided ${summary}. ${await matchCount(db)} matches remain.`;
}

/**
 * Exclude (or, with `restore`, re-include) a game referenced by its
 * #game-results post: flip the match's excluded flag so it drops off / rejoins
 * every board (CSR recomputes from history), re-style its post in place to the
 * off-format / counted caption, and refresh the live leaderboard. Unlike
 * `/delete`, the match and its post are kept. Gated to Manage Server.
 */
async function handleExclude(
  ix: ChatInputCommandInteraction,
  db: DB,
  leaderboardWebhookUrl?: string,
): Promise<void> {
  const msgId = extractMessageId(ix.options.getString("game", true));
  if (!msgId) {
    await ix.reply({ content: "That doesn't look like a message id or link.", flags: MessageFlags.Ephemeral });
    return;
  }
  const restore = ix.options.getBoolean("restore") ?? false;
  const matchId = await matchIdByResultsMsg(db, msgId);
  if (!matchId) {
    await ix.reply({
      content:
        "No tracked game found for that post — it may predate message tracking. " +
        "Use the `exclude-match` CLI on the host for older games.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await ix.deferReply({ flags: MessageFlags.Ephemeral });
  await ix.editReply(await excludeMatch(db, matchId, msgId, restore, leaderboardWebhookUrl));
}

/**
 * Exclude (or, with `restore`, re-include) a match: flip its excluded flag so it
 * drops off / rejoins every board (CSR recomputes from history), re-style its
 * post in place to the off-format / counted caption, and refresh the live
 * leaderboard. The match + post are kept. Shared by `/exclude` and the button.
 */
async function excludeMatch(
  db: DB,
  matchId: string,
  msgId: string,
  restore: boolean,
  leaderboardWebhookUrl?: string,
): Promise<string> {
  const target = (await matchesChrono(db)).find((m) => m.matchId === matchId);
  const summary = target ? matchSummary(target) : `match \`${matchId}\``;

  await setMatchExcluded(db, matchId, !restore);
  try {
    await restyleResultPost(db, matchId, msgId);
  } catch (e) {
    console.error("[discord] result re-style after exclude failed:", (e as Error).message);
  }
  try {
    await upsertCsrLeaderboard(leaderboardWebhookUrl, db);
  } catch (e) {
    console.error("[discord] leaderboard refresh after exclude failed:", (e as Error).message);
  }

  return restore
    ? `✅ Restored ${summary} — it counts toward the leaderboard again.`
    : `🚫 Excluded ${summary} from the leaderboards (kept as an off-format post).`;
}
