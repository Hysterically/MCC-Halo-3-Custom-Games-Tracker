/**
 * Renders a carnage report as a PNG styled after Halo 3's post-game carnage
 * screen: big "<X> TEAM WON" headline, light-blue column headers, and one
 * team-coloured row per player (Score / Kills / Assists / Deaths). The rightmost
 * column is a neutral rating cell — ELO (post-match rating + change) or, for the
 * TrueSkill 2 board, CSR (tier label + number + change) — present only when
 * the match was rated.
 *
 * The PNG is attached to the per-match Discord post so results look like the
 * in-game screen instead of a monospace text table.
 */

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { CarnageReport, CarnagePlayer } from "./parseCarnage.ts";
import type { EloChange } from "./elo.ts";
import { type CsrChange, type MatchWinChances } from "./trueskill2.ts";
import { csrEmblems } from "./csrEmblems.ts";
import { displayName } from "./aliases.ts";
import { FONT, FONT_BOLD } from "./fonts.ts";

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
 * deaths] (-1 = rating). The players column owns everything left of the first
 * stat column. The rating column (ELO or CSR) sits right of Deaths and stays a
 * neutral cell instead of team-coloured. CSR's cell is wider to fit "Diamond 5
 * 1427 +31", so the stat columns shift left in that layout.
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

// Same geometry as COLS_ELO (the CSR content fits the same ~189px cell); only
// the label differs. The neutral cell fills the column and the emblem + number +
// change group is centred within it.
const COLS_CSR: Col[] = [
  { label: "SCORE", x: 500, right: 680, stat: 0 },
  { label: "KILLS", x: 705, right: 882, stat: 1 },
  { label: "ASSISTS", x: 907, right: 1084, stat: 2 },
  { label: "DEATHS", x: 1109, right: 1284, stat: 3 },
  { label: "CSR", x: 1309, right: 1484, stat: -1 },
];

const RATING_CELL_COLOR = "#272e37"; // neutral, regardless of team colour

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

// --- renderers ---------------------------------------------------------------

/**
 * Draws the rating cell's content (right-aligned within column `c`). Receives the
 * column and the row's vertical centre; returns nothing for an unrated player
 * (the cell stays blank). One per rating system.
 */
type RatingCell = (ctx: SKRSContext2D, c: Col, mid: number, p: CarnagePlayer, rowTop: number) => void;

/**
 * Core carnage render. `cols` decides the layout (with or without a rating
 * column); `ratingCell` fills the neutral rating cell when present.
 */
/** Centre x of the (last) rating column, from its left divider to the frame edge. */
function ratingCenter(c: Col): number {
  return (c.x - 14 + (W - MARGIN)) / 2;
}

/**
 * Top-right win-probability bar: two rounded team-coloured pills whose split is
 * each team's pre-match win chance, with end-cap initials and a
 * "<Blue> 58%   Chances of Winning   42% <Red>" label row beneath — and, in the
 * free space to the left of the bar, each team's average-CSR line. Drawn in the
 * header band right of the headline; only present for rated 2-team matches (the
 * caller passes `win` only then).
 */
const BAR_W = 290; // width of the probability bar
const BAR_H = 14;
const BAR_TOP = 44;
const CAP_W = 16; // end-cap square

/** Lighten a #rrggbb toward white (for the brighter end caps). */
function lighten(hex: string, amt = 0.35): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) + (255 - ((n >> 16) & 255)) * amt);
  const g = Math.round(((n >> 8) & 255) + (255 - ((n >> 8) & 255)) * amt);
  const b = Math.round((n & 255) + (255 - (n & 255)) * amt);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A bar segment rounded only on the chosen outer side; the inner (split) side
 * stays square so the two team segments meet flush in the middle. */
function pill(
  ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number,
  roundLeft: boolean, roundRight: boolean,
): void {
  const rl = roundLeft ? Math.min(r, w / 2, h / 2) : 0;
  const rr = roundRight ? Math.min(r, w / 2, h / 2) : 0;
  ctx.beginPath();
  ctx.moveTo(x + rl, y);
  ctx.lineTo(x + w - rr, y);
  if (rr) ctx.arcTo(x + w, y, x + w, y + h, rr);
  else ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - rr);
  if (rr) ctx.arcTo(x + w, y + h, x, y + h, rr);
  else ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + rl, y + h);
  if (rl) ctx.arcTo(x, y + h, x, y, rl);
  else ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + rl);
  if (rl) ctx.arcTo(x, y, x + w, y, rl);
  else ctx.lineTo(x, y);
  ctx.closePath();
}

function drawWinBar(ctx: SKRSContext2D, win: MatchWinChances): void {
  const [a, b] = win.teams;
  const barRight = W - MARGIN;
  const barLeft = barRight - BAR_W;
  const split = barLeft + Math.round(BAR_W * a.winProb);
  const r = BAR_H / 2;
  const colA = TEAM_ROW_COLORS[a.teamId] ?? "#39434f";
  const colB = TEAM_ROW_COLORS[b.teamId] ?? "#39434f";
  const nameA = TEAM_NAMES[a.teamId] ?? "Team";
  const nameB = TEAM_NAMES[b.teamId] ?? "Team";

  // Average-CSR line above each team's segment.
  ctx.font = `11px ${FONT}`;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.fillText(`${nameA} Team Average CSR: ${a.avgCsr}`, barLeft, BAR_TOP - 6);
  ctx.textAlign = "right";
  ctx.fillText(`${nameB} Team Average CSR: ${b.avgCsr}`, barRight, BAR_TOP - 6);

  // Two segments (left = team a, right = team b) meeting flush at the split:
  // outer ends rounded, inner ends square. A thin seam marks the boundary.
  ctx.fillStyle = colA;
  pill(ctx, barLeft, BAR_TOP, split - barLeft, BAR_H, r, true, false);
  ctx.fill();
  ctx.fillStyle = colB;
  pill(ctx, split, BAR_TOP, barRight - split, BAR_H, r, false, true);
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(split - 1, BAR_TOP, 2, BAR_H);

  // Brighter end caps with the team initial.
  const cap = (x: number, color: string, letter: string): void => {
    ctx.fillStyle = color;
    roundRect(ctx, x, BAR_TOP - 1, CAP_W, BAR_H + 2, 5);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `10px ${FONT_BOLD}`;
    ctx.textAlign = "center";
    ctx.fillText(letter, x + CAP_W / 2, BAR_TOP + BAR_H / 2 + 4);
  };
  cap(barLeft, lighten(colA), nameA[0].toUpperCase());
  cap(barRight - CAP_W, lighten(colB), nameB[0].toUpperCase());

  // Label row beneath: "<Blue> 58%   Chances of Winning   42% <Red>".
  const labelY = BAR_TOP + BAR_H + 14;
  ctx.font = `11px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillStyle = "#cfe0fb";
  ctx.fillText(`${nameA} ${Math.round(a.winProb * 100)}%`, barLeft, labelY);
  ctx.textAlign = "right";
  ctx.fillStyle = "#f6cdca";
  ctx.fillText(`${Math.round(b.winProb * 100)}% ${nameB}`, barRight, labelY);
  ctx.textAlign = "center";
  ctx.fillStyle = "#8a939e";
  ctx.fillText("Chances of Winning", (barLeft + barRight) / 2, labelY);
  ctx.textAlign = "left";
}

function render(r: CarnageReport, cols: Col[], ratingCell?: RatingCell, win?: MatchWinChances): Buffer {
  const players = orderedPlayers(r);
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
  ctx.font = `44px ${FONT_BOLD}`;
  const title = headline(r);
  ctx.fillText(title, MARGIN, TITLE_BASELINE);
  const titleW = ctx.measureText(title).width;
  ctx.font = `28px ${FONT}`;
  ctx.fillStyle = "#d4dbe4";
  const subtitle = (r.gameTypeName || "CUSTOM GAME") + (r.mapName ? ` ON ${r.mapName}` : "");
  ctx.fillText(subtitle.toUpperCase(), MARGIN + titleW + 26, TITLE_BASELINE);

  // Win-probability bar (top-right) — only for rated 2-team matches.
  if (win) drawWinBar(ctx, win);

  // Column headers (light blue, like the in-game UI).
  ctx.font = `20px ${FONT}`;
  ctx.fillStyle = "#76b5d8";
  ctx.fillText("PLAYERS", MARGIN + 2, HEADER_BASELINE);
  for (const c of cols) {
    ctx.fillText(c.label, c.x, HEADER_BASELINE);
  }

  // Rows.
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const y = ROWS_TOP + i * (ROW_H + ROW_GAP);
    drawRow(ctx, p, y, rowColor(p.teamId, r.teamsEnabled), cols, ratingCell);
  }

  return canvas.toBuffer("image/png");
}

/**
 * Per-match carnage PNG with the neutral ELO cell (post-match rating + change).
 * Unchanged behaviour: with no/empty changes it renders without a rating column.
 */
export function renderCarnagePng(r: CarnageReport, eloChanges?: Map<string, EloChange>): Buffer {
  const players = r.players;
  const hasElo = eloChanges != null && players.some((p) => eloChanges.has(p.xuid));
  const cell: RatingCell = (ctx, c, mid, p) => {
    const elo = eloChanges?.get(p.xuid);
    if (elo == null) return;
    const d = Math.round(elo.delta);
    const deltaText = d >= 0 ? `+${d}` : String(d);
    ctx.fillStyle = d > 0 ? "#7ed87e" : d < 0 ? "#e8837f" : "#c8cfd8";
    ctx.fillText(deltaText, c.right - 6, mid);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(String(Math.round(elo.rating)), c.right - 6 - ctx.measureText(deltaText).width - 9, mid);
  };
  return render(r, hasElo ? COLS_ELO : COLS, hasElo ? cell : undefined);
}

/** Emblem draw height inside a carnage row. */
const CSR_EMBLEM_H = 34;

/**
 * Per-match carnage PNG with the neutral CSR cell (TrueSkill 2): the
 * post-match rank shown as its Halo 5 division EMBLEM (the emblem encodes both
 * tier and sub-rank 1-6) + the CSR number, with a green/red change — e.g.
 * "[◆] 1427  +31". With no/empty changes it renders without the column. Async
 * because it loads the emblem artwork.
 */
export async function renderCarnageCsrPng(
  r: CarnageReport,
  csrChanges?: Map<string, CsrChange>,
  win?: MatchWinChances,
): Promise<Buffer> {
  const players = r.players;
  const hasCsr = csrChanges != null && players.some((p) => csrChanges.has(p.xuid));
  const emblems = await csrEmblems();

  const gapE = 10; // emblem -> number
  const gapD = 14; // number -> change

  const cell: RatingCell = (ctx, c, mid, p, rowTop) => {
    const ch = csrChanges?.get(p.xuid);
    if (ch == null) return;
    ctx.font = `22px ${FONT}`;
    ctx.textAlign = "left";

    // Centre the [emblem] number Δ group as one unit within the neutral cell.
    const d = ch.delta;
    const deltaText = d >= 0 ? `+${d}` : String(d);
    const mainText = String(ch.csr.value);
    const mainW = ctx.measureText(mainText).width;
    const deltaW = ctx.measureText(deltaText).width;
    const img = emblems[ch.csr.emblem];
    const ew = img ? (img.width / img.height) * CSR_EMBLEM_H : 0;
    const groupW = ew + (img ? gapE : 0) + mainW + gapD + deltaW;
    let x = ratingCenter(c) - groupW / 2;

    if (img) {
      ctx.drawImage(img, x, rowTop + (ROW_H - CSR_EMBLEM_H) / 2, ew, CSR_EMBLEM_H);
      x += ew + gapE;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillText(mainText, x, mid);
    x += mainW + gapD;
    ctx.fillStyle = d > 0 ? "#7ed87e" : d < 0 ? "#e8837f" : "#c8cfd8";
    ctx.fillText(deltaText, x, mid);
  };
  return render(r, hasCsr ? COLS_CSR : COLS, hasCsr ? cell : undefined, win);
}

function drawRow(
  ctx: SKRSContext2D,
  p: CarnagePlayer,
  y: number,
  color: string,
  cols: Col[],
  ratingCell: RatingCell | undefined,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(MARGIN, y, W - 2 * MARGIN, ROW_H);

  // The rating cell stays neutral (a rating change is not a team stat): it fills
  // the rating column, overriding the team colour there.
  const rateIdx = cols.findIndex((c) => c.stat < 0);
  if (rateIdx >= 0) {
    const left = cols[rateIdx].x - 14;
    const right = rateIdx + 1 < cols.length ? cols[rateIdx + 1].x - 14 : W - MARGIN;
    ctx.fillStyle = RATING_CELL_COLOR;
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
  ctx.font = `22px ${FONT}`;
  for (const c of cols) {
    if (c.stat >= 0) {
      ctx.fillStyle = "#ffffff";
      ctx.fillText(String(values[c.stat]), c.right - 6, mid);
      continue;
    }
    // Rating cell — blank for unrated players (guests).
    ratingCell?.(ctx, c, mid, p, y);
  }
  ctx.textAlign = "left";
}
