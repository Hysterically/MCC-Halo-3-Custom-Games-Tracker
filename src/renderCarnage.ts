/**
 * Renders a carnage report as a PNG styled after Halo 3's post-game carnage
 * screen: big "<X> TEAM WON" headline, light-blue column headers, and one
 * team-coloured row per player (Score / Kills / Assists / Deaths, plus a
 * neutral ELO column — post-match rating and change — when the match was
 * rated).
 *
 * The PNG is attached to the per-match Discord post so results look like the
 * in-game screen instead of a monospace text table.
 */

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { CarnageReport, CarnagePlayer } from "./parseCarnage.ts";
import type { EloChange } from "./elo.ts";
import { displayName } from "./aliases.ts";

// --- palette / layout -------------------------------------------------------

/** Row fill per Halo 3 team id (matches TEAM_NAMES order in discord.ts). */
const TEAM_ROW_COLORS: Record<number, string> = {
  0: "#9e211b", // red
  1: "#1d4a99", // blue
  2: "#2b6e31", // green
  3: "#b86a14", // orange
  4: "#5d3590", // purple
  5: "#a8861c", // gold
  6: "#5c4632", // brown
  7: "#b25e7e", // pink
};

const TEAM_NAMES = ["Red", "Blue", "Green", "Orange", "Purple", "Gold", "Brown", "Pink"];

const W = 1500;
const MARGIN = 16;
const TITLE_BASELINE = 60;
const HEADER_BASELINE = 106;
const ROWS_TOP = 118;
const ROW_H = 46;
const ROW_GAP = 3;
const BOTTOM_PAD = 22;

/**
 * Column geometry. Each stat column draws its header left-aligned at `x` and
 * its value right-aligned at `right`; `stat` indexes [score, kills, assists,
 * deaths] (-1 = ELO). The players column owns everything left of the first
 * stat column. Rated matches use the wider layout with an ELO column right of
 * Deaths; its cell stays neutral instead of team-coloured.
 */
interface Col {
  label: string;
  x: number;
  right: number;
  stat: number;
}

const COLS: Col[] = [
  { label: "SCORE", x: 700, right: 880, stat: 0 },
  { label: "KILLS", x: 905, right: 1082, stat: 1 },
  { label: "ASSISTS", x: 1107, right: 1284, stat: 2 },
  { label: "DEATHS", x: 1309, right: 1484, stat: 3 },
];

const COLS_ELO: Col[] = [
  { label: "SCORE", x: 500, right: 680, stat: 0 },
  { label: "KILLS", x: 705, right: 882, stat: 1 },
  { label: "ASSISTS", x: 907, right: 1084, stat: 2 },
  { label: "DEATHS", x: 1109, right: 1284, stat: 3 },
  { label: "ELO", x: 1309, right: 1484, stat: -1 },
];

const ELO_CELL_COLOR = "#272e37"; // neutral, regardless of team colour

const FONT = "Bahnschrift, Arial";

// --- helpers ----------------------------------------------------------------

function rowColor(teamId: number, teamsEnabled: boolean): string {
  if (!teamsEnabled) return "#39434f"; // FFA: neutral steel
  return TEAM_ROW_COLORS[teamId] ?? "#39434f";
}

function headline(r: CarnageReport): string {
  if (r.teamsEnabled) {
    if (r.winningTeamId == null) return "GAME OVER";
    const name = TEAM_NAMES[r.winningTeamId] ?? `TEAM ${r.winningTeamId}`;
    return `${name.toUpperCase()} TEAM WON`;
  }
  const winner = r.winners[0];
  return winner ? `${displayName(winner).toUpperCase()} WON` : "GAME OVER";
}

/** Winning team first, then by total score; players by score within a team. */
function orderedPlayers(r: CarnageReport): CarnagePlayer[] {
  if (!r.teamsEnabled) {
    return [...r.players].sort((a, b) => a.standing - b.standing || b.score - a.score);
  }
  const totals = new Map<number, number>();
  for (const p of r.players) totals.set(p.teamId, (totals.get(p.teamId) ?? 0) + p.score);
  return [...r.players].sort((a, b) => {
    if (a.teamId !== b.teamId) {
      if (a.teamId === r.winningTeamId) return -1;
      if (b.teamId === r.winningTeamId) return 1;
      return (totals.get(b.teamId) ?? 0) - (totals.get(a.teamId) ?? 0) || a.teamId - b.teamId;
    }
    return b.score - a.score || a.standing - b.standing;
  });
}

// --- renderer ----------------------------------------------------------------

export function renderCarnagePng(r: CarnageReport, eloChanges?: Map<string, EloChange>): Buffer {
  const players = orderedPlayers(r);
  const hasElo = eloChanges != null && players.some((p) => eloChanges.has(p.xuid));
  const cols = hasElo ? COLS_ELO : COLS;
  const height = ROWS_TOP + players.length * (ROW_H + ROW_GAP) - ROW_GAP + BOTTOM_PAD;
  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");

  // Background: near-black with a faint cool gradient like the in-game scene.
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#14171c");
  bg.addColorStop(1, "#0a0c10");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, height);

  // Headline: "<X> TEAM WON" + gametype.
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold 44px ${FONT}`;
  const title = headline(r);
  ctx.fillText(title, MARGIN, TITLE_BASELINE);
  const titleW = ctx.measureText(title).width;
  ctx.font = `28px ${FONT}`;
  ctx.fillStyle = "#d4dbe4";
  const subtitle =
    (r.gameTypeName || "CUSTOM GAME") + (r.mapName ? ` ON ${r.mapName}` : "");
  ctx.fillText(subtitle.toUpperCase(), MARGIN + titleW + 26, TITLE_BASELINE);

  // Column headers (light blue, like the in-game UI).
  ctx.font = `20px ${FONT}`;
  ctx.fillStyle = "#76b5d8";
  ctx.fillText("PLAYERS", MARGIN + 2, HEADER_BASELINE);
  for (const c of cols) ctx.fillText(c.label, c.x, HEADER_BASELINE);

  // Rows.
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const y = ROWS_TOP + i * (ROW_H + ROW_GAP);
    drawRow(ctx, p, y, rowColor(p.teamId, r.teamsEnabled), cols, eloChanges?.get(p.xuid));
  }

  return canvas.toBuffer("image/png");
}

function drawRow(
  ctx: SKRSContext2D,
  p: CarnagePlayer,
  y: number,
  color: string,
  cols: Col[],
  elo: EloChange | undefined,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(MARGIN, y, W - 2 * MARGIN, ROW_H);

  // The ELO cell stays neutral: a rating change is not a team stat.
  const eloIdx = cols.findIndex((c) => c.stat < 0);
  if (eloIdx >= 0) {
    const left = cols[eloIdx].x - 14;
    const right = eloIdx + 1 < cols.length ? cols[eloIdx + 1].x - 14 : W - MARGIN;
    ctx.fillStyle = ELO_CELL_COLOR;
    ctx.fillRect(left, y, right - left, ROW_H);
  }

  // Vertical separators between stat columns (the dark gaps in the H3 table).
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  for (const c of cols) ctx.fillRect(c.x - 14, y, 2, ROW_H);

  const mid = y + ROW_H / 2 + 8; // baseline that visually centres 22px text

  ctx.fillStyle = "#ffffff";
  ctx.font = `22px ${FONT}`;
  ctx.fillText(displayName(p.gamertag), MARGIN + 16, mid);

  const values = [p.score, p.kills, p.assists, p.deaths];
  ctx.textAlign = "right";
  for (const c of cols) {
    if (c.stat >= 0) {
      ctx.fillText(String(values[c.stat]), c.right - 6, mid);
      continue;
    }
    // Post-match rating + change, e.g. "1318 +16" (green gain / red loss);
    // blank for unrated players (guests).
    if (elo == null) continue;
    const d = Math.round(elo.delta);
    const deltaText = d >= 0 ? `+${d}` : String(d);
    ctx.fillStyle = d > 0 ? "#7ed87e" : d < 0 ? "#e8837f" : "#c8cfd8";
    ctx.fillText(deltaText, c.right - 6, mid);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(String(Math.round(elo.rating)), c.right - 6 - ctx.measureText(deltaText).width - 9, mid);
  }
  ctx.textAlign = "left";
}
