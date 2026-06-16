/**
 * Renders the ELO standings as a PNG styled after the carnage-screen renderer
 * (renderCarnage.ts): same canvas width, background gradient, fonts,
 * light-blue column headers and row treatment, so the #leaderboard post and
 * the #game-results posts read as a set.
 *
 * One section per board category (2v2 / 4v4 / FFA). The 🥇🥈🥉 podium medals
 * (baked PNGs — see genMedalAssets.ts) float on the background gutter left of
 * the table, mirrored by equal empty space on the right; the rank cell stays
 * neutral like the carnage screen's ELO cell.
 */

import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import type { Rating } from "./elo.ts";
import { displayName } from "./aliases.ts";

/** One leaderboard table, e.g. { title: "4V4 LEADERBOARD", ratings: [...] }. */
export interface BoardSection {
  title: string;
  ratings: Rating[];
}

// --- palette / layout (shared numbers mirror renderCarnage.ts) ---------------

const W = 1500;
const MARGIN = 16;
const TITLE_BASELINE = 60;
const ROW_H = 46;
const ROW_GAP = 3;
const BOTTOM_PAD = 26;
const FONT = "Bahnschrift, Arial";

// All rows share the neutral steel used for FFA rows on the carnage screen;
// the rank cell is the darker neutral used for the ELO cell there.
const ROW_COLOR = "#39434f";
const RANK_CELL_COLOR = "#272e37";

/**
 * Stat columns: header left-aligned at `x`, value right-aligned at `right` —
 * the carnage screen's unrated layout shifted left so the table is inset by
 * the medal gutter on both sides.
 */
const COLS = [
  { label: "ELO", x: 644, right: 824 },
  { label: "W-L-D", x: 849, right: 1026 },
  { label: "WIN%", x: 1051, right: 1228 },
  { label: "K/D", x: 1253, right: 1428 },
];

const SECTION_TITLE_H = 56; // gap above + section title baseline
const HEADER_GAP = 34; // section title baseline -> header baseline
const HEADER_TO_ROWS = 12; // header baseline -> first row top
const EMPTY_H = 36; // "no matches yet" line
const GUTTER_W = 56; // background strip left of the rows where the medals live
const RANK_W = 64; // rank-number cell at the start of each row
const MEDAL_SIZE = 32;

// --- medal images -------------------------------------------------------------

let medalCache: Promise<Image[]> | undefined;

/** The baked 🥇🥈🥉 PNGs; loaded once, rejects if the assets are missing. */
function medals(): Promise<Image[]> {
  medalCache ??= Promise.all(
    [1, 2, 3].map(async (n) =>
      loadImage(await readFile(new URL(`../assets/medal-${n}.png`, import.meta.url))),
    ),
  );
  return medalCache;
}

// --- renderer ------------------------------------------------------------------

function sectionHeight(s: BoardSection, limit: number): number {
  const rows = Math.min(s.ratings.length, limit);
  const body = rows ? HEADER_GAP + HEADER_TO_ROWS + rows * (ROW_H + ROW_GAP) - ROW_GAP : EMPTY_H;
  return SECTION_TITLE_H + body;
}

export async function renderLeaderboardPng(
  sections: BoardSection[],
  limit = 20,
): Promise<Buffer> {
  const medalImgs = await medals();
  const height =
    TITLE_BASELINE + 10 + sections.reduce((h, s) => h + sectionHeight(s, limit), 0) + BOTTOM_PAD;
  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");

  // Background: near-black with a faint cool gradient like the in-game scene.
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#14171c");
  bg.addColorStop(1, "#0a0c10");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, height);

  // Headline, same pattern as "<X> TEAM WON" + gametype subtitle, but centred:
  // measure "ELO STANDINGS  HALO 3 CUSTOMS" as one unit and centre it on W.
  const title = "ELO STANDINGS";
  const subtitle = "HALO 3 CUSTOMS";
  const TITLE_GAP = 26;
  ctx.font = `bold 44px ${FONT}`;
  const titleW = ctx.measureText(title).width;
  ctx.font = `28px ${FONT}`;
  const subtitleW = ctx.measureText(subtitle).width;
  const startX = Math.round((W - (titleW + TITLE_GAP + subtitleW)) / 2);
  ctx.font = `bold 44px ${FONT}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(title, startX, TITLE_BASELINE);
  ctx.font = `28px ${FONT}`;
  ctx.fillStyle = "#d4dbe4";
  ctx.fillText(subtitle, startX + titleW + TITLE_GAP, TITLE_BASELINE);

  let y = TITLE_BASELINE + 10;
  for (const s of sections) {
    drawSection(ctx, s, y, limit, medalImgs);
    y += sectionHeight(s, limit);
  }

  return canvas.toBuffer("image/png");
}

function drawSection(
  ctx: SKRSContext2D,
  s: BoardSection,
  top: number,
  limit: number,
  medalImgs: Image[],
): void {
  const titleBaseline = top + SECTION_TITLE_H;
  ctx.font = `bold 30px ${FONT}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(s.title, MARGIN, titleBaseline);

  if (!s.ratings.length) {
    ctx.font = `22px ${FONT}`;
    ctx.fillStyle = "#8b95a1";
    ctx.fillText("NO MATCHES YET", MARGIN + 2, titleBaseline + EMPTY_H);
    return;
  }

  const headerBaseline = titleBaseline + HEADER_GAP;
  ctx.font = `20px ${FONT}`;
  ctx.fillStyle = "#76b5d8";
  ctx.fillText("#", MARGIN + GUTTER_W + 18, headerBaseline);
  ctx.fillText("PLAYERS", MARGIN + GUTTER_W + RANK_W + 16, headerBaseline);
  for (const c of COLS) ctx.fillText(c.label, c.x, headerBaseline);

  const rowsTop = headerBaseline + HEADER_TO_ROWS;
  const rows = s.ratings.slice(0, limit);
  for (let i = 0; i < rows.length; i++) {
    drawRow(ctx, rows[i], i, rowsTop + i * (ROW_H + ROW_GAP), medalImgs);
  }
}

function drawRow(
  ctx: SKRSContext2D,
  r: Rating,
  i: number,
  y: number,
  medalImgs: Image[],
): void {
  const rowX = MARGIN + GUTTER_W;
  ctx.fillStyle = ROW_COLOR;
  ctx.fillRect(rowX, y, W - MARGIN - GUTTER_W - rowX, ROW_H);

  // Rank cell stays neutral, like the ELO cell on the carnage screen.
  ctx.fillStyle = RANK_CELL_COLOR;
  ctx.fillRect(rowX, y, RANK_W, ROW_H);

  // Dark separators: after the rank cell and between stat columns.
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(rowX + RANK_W, y, 2, ROW_H);
  for (const c of COLS) ctx.fillRect(c.x - 14, y, 2, ROW_H);

  const mid = y + ROW_H / 2 + 8; // baseline that visually centres 22px text

  // Podium medals float on the background gutter, outside the row.
  if (i < 3) {
    ctx.drawImage(medalImgs[i], MARGIN + (GUTTER_W - MEDAL_SIZE) / 2,
      y + (ROW_H - MEDAL_SIZE) / 2, MEDAL_SIZE, MEDAL_SIZE);
  }

  ctx.font = `22px ${FONT}`;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "right";
  ctx.fillText(String(i + 1), rowX + RANK_W - 18, mid);
  ctx.textAlign = "left";
  ctx.fillText(displayName(r.gamertag), rowX + RANK_W + 16, mid);

  const winPct = r.games ? `${Math.round((r.wins / r.games) * 100)}%` : "—";
  const kd = r.deaths ? (r.kills / r.deaths).toFixed(2) : r.kills.toFixed(2);
  const values = [
    String(Math.round(r.rating)),
    `${r.wins}-${r.losses}-${r.draws}`,
    winPct,
    kd,
  ];
  ctx.textAlign = "right";
  for (let c = 0; c < COLS.length; c++) ctx.fillText(values[c], COLS[c].right - 6, mid);
  ctx.textAlign = "left";
}
