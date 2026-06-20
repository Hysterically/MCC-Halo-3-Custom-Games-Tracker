/**
 * One-off: render EVERY match in a category from the very start as its CSR
 * results PNG (the same per-match carnage layout, with that game's CSR change),
 * in chronological order, and stack them into one tall timeline image — so you
 * can trace exactly how each player climbed to their current CSR. Read-only.
 *
 *   npx tsx src/previewCsrHistory.ts            # -> preview-csr-history-4v4.png
 *   npx tsx src/previewCsrHistory.ts ffa        # other category
 *
 * Also writes the individual per-match PNGs to preview-csr-history/<cat>/.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "./config.ts";
import { openDb, matchesChrono, type StoredMatch } from "./db.ts";
import { boardCategory, type Category } from "./category.ts";
import { matchCsrChanges, matchWinChances } from "./trueskill2.ts";
import { renderCarnageCsrPng } from "./renderCarnage.ts";
import { FONT } from "./fonts.ts";
import type { CarnageReport } from "./parseCarnage.ts";

function toReport(m: StoredMatch): CarnageReport {
  const winners = m.teamsEnabled
    ? m.players.filter((p) => p.teamId === m.winningTeamId).map((p) => p.gamertag)
    : (() => {
        const best = Math.min(...m.players.map((p) => p.standing));
        return m.players.filter((p) => p.standing === best).map((p) => p.gamertag);
      })();
  return {
    matchId: m.matchId, gameEnum: 2, isHalo3: true, isMatchmaking: false, isCustom: true,
    teamsEnabled: m.teamsEnabled, completed: true, gameTypeName: m.gameTypeName, hopperName: "",
    playedAt: new Date(m.playedAt), mapName: m.mapName, mapVariant: m.mapVariant,
    durationSeconds: m.durationSeconds, winningTeamId: m.teamsEnabled ? m.winningTeamId : null,
    winners, tracked: true,
    players: m.players.map((p) => ({ ...p, betrayals: 0, suicides: 0, secondsPlayed: 0, completedGame: true })),
  };
}

const arg = (process.argv[2]?.toLowerCase() ?? "4v4") as Category;
const cat: Category = (["2v2", "4v4", "ffa"] as Category[]).includes(arg) ? arg : "4v4";

const db = await openDb(config.dbUrl, config.dbAuthToken);
const all = await matchesChrono(db);
const matches = all.filter((m) => boardCategory(m) === cat); // chronological (played_at ASC)
db.close();

if (!matches.length) {
  console.log(`No ${cat} matches found.`);
  process.exit(0);
}

const outDir = `preview-csr-history/${cat}`;
mkdirSync(outDir, { recursive: true });

// Render each match's CSR results PNG (with that game's per-match CSR change).
const tiles: { img: Awaited<ReturnType<typeof loadImage>>; label: string }[] = [];
for (let i = 0; i < matches.length; i++) {
  const m = matches[i];
  const changes = matchCsrChanges(all, m.matchId) ?? undefined;
  const win = matchWinChances(all, m.matchId) ?? undefined;
  const png = await renderCarnageCsrPng(toReport(m), changes, win);
  const date = new Date(m.playedAt).toISOString().slice(0, 16).replace("T", " ");
  const file = `${outDir}/${String(i + 1).padStart(3, "0")}-${m.gameTypeName.replace(/[^a-z0-9]+/gi, "-")}.png`;
  writeFileSync(file, png);
  tiles.push({ img: await loadImage(png), label: `GAME ${i + 1} of ${matches.length} · ${date}Z` });
}

// Stack them into one timeline image, each match under a thin caption banner.
const W = tiles[0].img.width;
const BANNER_H = 36;
const GAP = 10;
const totalH = tiles.reduce((h, t) => h + BANNER_H + t.img.height + GAP, 0);
const canvas = createCanvas(W, totalH);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#05070a";
ctx.fillRect(0, 0, W, totalH);

let y = 0;
for (const t of tiles) {
  ctx.fillStyle = "#1b2230";
  ctx.fillRect(0, y, W, BANNER_H);
  ctx.fillStyle = "#9fb6cc";
  ctx.font = `20px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText(t.label, 16, y + BANNER_H / 2 + 2);
  y += BANNER_H;
  ctx.drawImage(t.img, 0, y);
  y += t.img.height + GAP;
}

const out = `preview-csr-history-${cat}.png`;
writeFileSync(out, canvas.toBuffer("image/png"));
console.log(`Wrote ${matches.length} matches -> ${out}  (and individual PNGs in ${outDir}/)`);
