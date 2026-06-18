/**
 * Renders the TrueSkill 2 standings as a PNG in the SAME style as the ELO
 * leaderboard (renderLeaderboard.ts) so the two boards read as a set: same dark
 * carnage-screen background, centred headline, light-blue column headers, neutral
 * steel rows with a darker rank cell, and the 🥇🥈🥉 podium medals floating in
 * the left gutter. The rating column shows the rank LABEL ("diamond 5") + the
 * Halo 5 division EMBLEM + the CSR number; the rest (W-L-D / Win% / K/D) match ELO.
 *
 * Layout is computed per-render: the CSR column is sized to exactly its widest
 * row (label + emblem + number) so there's no dead space, and the three stat
 * columns evenly fill whatever width is left.
 */

import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import { displayName } from "./aliases.ts";
import { csrFromSkill, CHAMPION_THRESHOLD } from "./csr.ts";
import { csrEmblems } from "./csrEmblems.ts";
import { FONT, FONT_BOLD } from "./fonts.ts";

/** One row of a CSR board (already ranked best-first by the caller). */
export interface CsrRow {
  gamertag: string;
  skill: number; // mu - 3*sigma
  peakSkill: number; // highest skill ever held (peak CSR)
  wins: number;
  losses: number;
  draws: number;
  games: number;
  kills: number;
  deaths: number;
}

/** One CSR board table, e.g. { title: "4V4 LEADERBOARD", rows: [...] }. */
export interface CsrBoardSection {
  title: string;
  rows: CsrRow[];
}

// --- palette / layout (mirrors renderLeaderboard.ts) -------------------------

const W = 1500;
const MARGIN = 16;
const TITLE_BASELINE = 60;
const ROW_H = 46;
const ROW_GAP = 3;
const BOTTOM_PAD = 26;

const ROW_COLOR = "#39434f";
const RANK_CELL_COLOR = "#272e37";

const SECTION_TITLE_H = 56;
const HEADER_GAP = 34;
const HEADER_TO_ROWS = 12;
const EMPTY_H = 36;
const GUTTER_W = 56;
const RANK_W = 64;
const MEDAL_SIZE = 32;
const CSR_EMBLEM_H = 34; // division emblem height inside a row
const NAME_W = 340; // gamertag column width
const CSR_PAD = 20; // padding each side of the CSR content within its column
const GROUP_GAP = 10; // gap between label / emblem / number
const STAT_LABELS = ["W-L-D", "WIN%", "K/D", "PEAK CSR"] as const;

/**
 * Champion = the #1 row on a board whose CSR has cleared the Champion floor.
 * It's position-based, so it depends on the row's rank, not just its skill.
 */
function isChampion(rankIndex: number, skill: number): boolean {
  return rankIndex === 0 && csrFromSkill(skill).value >= CHAMPION_THRESHOLD;
}

/** The rank label: lowercase "tier sub" / "onyx", or "champion" for the #1≥floor. */
function rankLabel(skill: number, rankIndex = -1): string {
  if (isChampion(rankIndex, skill)) return "champion";
  const c = csrFromSkill(skill);
  return c.isOnyx ? "onyx" : `${c.tier.toLowerCase()} ${c.sub}`;
}

/** Emblem key for a row: the Halo 5 Champion insignia for #1≥floor, else the tier. */
function rowEmblem(skill: number, rankIndex: number): string {
  return isChampion(rankIndex, skill) ? "champion" : csrFromSkill(skill).emblem;
}

interface Layout {
  rankX: number; // left of the rank cell
  nameLeft: number; // left of the gamertag column
  csrLeft: number;
  csrRight: number;
  csrCenter: number;
  stats: { label: string; left: number; right: number; headerX: number; valueX: number }[];
}

/**
 * Compute column geometry: the CSR column is exactly as wide as its widest row's
 * content (label + emblem + number) plus padding; the three stat columns split
 * the remaining width to the right margin evenly.
 */
function computeLayout(
  ctx: SKRSContext2D,
  sections: CsrBoardSection[],
  limit: number,
  emblems: Record<string, Image>,
): Layout {
  ctx.font = `22px ${FONT}`;
  let maxGroup = 0;
  for (const s of sections) {
    const rows = s.rows.slice(0, limit);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const c = csrFromSkill(r.skill);
      const img = emblems[rowEmblem(r.skill, i)];
      const ew = img ? (img.width / img.height) * CSR_EMBLEM_H : 0;
      const w =
        ctx.measureText(rankLabel(r.skill, i)).width +
        GROUP_GAP + ew + GROUP_GAP +
        ctx.measureText(`(${c.value})`).width;
      maxGroup = Math.max(maxGroup, w);
    }
  }

  const rankX = MARGIN + GUTTER_W;
  const nameLeft = rankX + RANK_W;
  const csrLeft = nameLeft + NAME_W;
  const csrRight = csrLeft + maxGroup + CSR_PAD * 2;
  const statsLeft = csrRight;
  const statW = (W - MARGIN - statsLeft) / STAT_LABELS.length;
  const stats = STAT_LABELS.map((label, i) => {
    const left = statsLeft + i * statW;
    const right = left + statW;
    return { label, left, right, headerX: left + 14, valueX: right - 8 };
  });

  return { rankX, nameLeft, csrLeft, csrRight, csrCenter: (csrLeft + csrRight) / 2, stats };
}

// --- baked images ------------------------------------------------------------

let medalCache: Promise<Image[]> | undefined;
function medals(): Promise<Image[]> {
  medalCache ??= Promise.all(
    [1, 2, 3].map(async (n) =>
      loadImage(await readFile(new URL(`../assets/medal-${n}.png`, import.meta.url))),
    ),
  );
  return medalCache;
}

// --- renderer ----------------------------------------------------------------

function sectionHeight(s: CsrBoardSection, limit: number): number {
  const rows = Math.min(s.rows.length, limit);
  const body = rows ? HEADER_GAP + HEADER_TO_ROWS + rows * (ROW_H + ROW_GAP) - ROW_GAP : EMPTY_H;
  return SECTION_TITLE_H + body;
}

export async function renderCsrLeaderboardPng(
  sections: CsrBoardSection[],
  limit = 20,
): Promise<Buffer> {
  const [medalImgs, emblems] = await Promise.all([medals(), csrEmblems()]);
  const SUBTITLE_GAP = 32; // title baseline -> subtitle baseline
  const sectionsTop = TITLE_BASELINE + SUBTITLE_GAP + 14;
  const height =
    sectionsTop + sections.reduce((h, s) => h + sectionHeight(s, limit), 0) + BOTTOM_PAD;
  const canvas = createCanvas(W, height);
  const ctx = canvas.getContext("2d");
  const layout = computeLayout(ctx, sections, limit, emblems);

  // Background: near-black with a faint cool gradient like the in-game scene.
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#14171c");
  bg.addColorStop(1, "#0a0c10");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, height);

  // Centred two-line headline: "CSR STANDINGS" with "HALO 3 CUSTOMS" beneath it.
  ctx.textAlign = "center";
  ctx.font = `44px ${FONT_BOLD}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText("CSR STANDINGS", W / 2, TITLE_BASELINE);
  ctx.font = `28px ${FONT}`;
  ctx.fillStyle = "#d4dbe4";
  ctx.fillText("HALO 3 CUSTOMS", W / 2, TITLE_BASELINE + SUBTITLE_GAP);
  ctx.textAlign = "left";

  let y = sectionsTop;
  for (const s of sections) {
    drawSection(ctx, s, y, limit, medalImgs, emblems, layout);
    y += sectionHeight(s, limit);
  }

  return canvas.toBuffer("image/png");
}

function drawSection(
  ctx: SKRSContext2D,
  s: CsrBoardSection,
  top: number,
  limit: number,
  medalImgs: Image[],
  emblems: Record<string, Image>,
  layout: Layout,
): void {
  const titleBaseline = top + SECTION_TITLE_H;
  ctx.font = `30px ${FONT_BOLD}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(s.title, MARGIN, titleBaseline);

  if (!s.rows.length) {
    ctx.font = `22px ${FONT}`;
    ctx.fillStyle = "#8b95a1";
    ctx.fillText("NO MATCHES YET", MARGIN + 2, titleBaseline + EMPTY_H);
    return;
  }

  const headerBaseline = titleBaseline + HEADER_GAP;
  ctx.font = `20px ${FONT}`;
  ctx.fillStyle = "#76b5d8";
  ctx.textAlign = "left";
  ctx.fillText("#", MARGIN + GUTTER_W + 18, headerBaseline);
  ctx.fillText("PLAYERS", layout.nameLeft + 16, headerBaseline);
  ctx.fillText("CSR", layout.csrLeft + 14, headerBaseline); // left-aligned, like the others
  for (const st of layout.stats) ctx.fillText(st.label, st.headerX, headerBaseline);

  const rowsTop = headerBaseline + HEADER_TO_ROWS;
  const rows = s.rows.slice(0, limit);
  for (let i = 0; i < rows.length; i++) {
    drawRow(ctx, rows[i], i, rowsTop + i * (ROW_H + ROW_GAP), medalImgs, emblems, layout);
  }
}

function drawRow(
  ctx: SKRSContext2D,
  r: CsrRow,
  i: number,
  y: number,
  medalImgs: Image[],
  emblems: Record<string, Image>,
  layout: Layout,
): void {
  const rowX = layout.rankX;
  ctx.fillStyle = ROW_COLOR;
  ctx.fillRect(rowX, y, W - MARGIN - rowX, ROW_H);

  // Rank cell stays neutral, like the ELO board.
  ctx.fillStyle = RANK_CELL_COLOR;
  ctx.fillRect(rowX, y, RANK_W, ROW_H);

  // Dark separators at the column boundaries.
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  for (const x of [rowX + RANK_W, layout.csrLeft, ...layout.stats.map((s) => s.left)]) {
    ctx.fillRect(x, y, 2, ROW_H);
  }

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
  ctx.fillText(displayName(r.gamertag), layout.nameLeft + 16, mid);

  // CSR cell: emblem + rank label ("diamond 5", montage colour) + CSR number
  // (white), centred as one group in the (content-sized) CSR column. Emblem leads
  // (icon-then-label) so the divisions line up cleanly down the column.
  const cell = csrFromSkill(r.skill);
  const labelText = rankLabel(r.skill, i);
  const valueText = `(${cell.value})`;
  const labelW = ctx.measureText(labelText).width;
  const valueW = ctx.measureText(valueText).width;
  const img = emblems[rowEmblem(r.skill, i)];
  const ew = img ? (img.width / img.height) * CSR_EMBLEM_H : 0;
  let gx = layout.csrCenter - (ew + GROUP_GAP + labelW + GROUP_GAP + valueW) / 2;
  if (img) ctx.drawImage(img, gx, y + (ROW_H - CSR_EMBLEM_H) / 2, ew, CSR_EMBLEM_H);
  gx += ew + GROUP_GAP;
  ctx.fillStyle = "#cfe3f2"; // montage label colour (Champion included — emblem carries the distinction)
  ctx.fillText(labelText, gx, mid);
  gx += labelW + GROUP_GAP;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(valueText, gx, mid);

  // Remaining columns match the ELO board (values right-aligned in their cells).
  const winPct = r.games ? `${Math.round((r.wins / r.games) * 100)}%` : "—";
  const kd = r.deaths ? (r.kills / r.deaths).toFixed(2) : r.kills.toFixed(2);
  const peak = String(csrFromSkill(r.peakSkill).value);
  const values = [`${r.wins}-${r.losses}-${r.draws}`, winPct, kd, peak];
  ctx.textAlign = "right";
  for (let s = 0; s < layout.stats.length; s++) ctx.fillText(values[s], layout.stats[s].valueX, mid);
  ctx.textAlign = "left";
}
