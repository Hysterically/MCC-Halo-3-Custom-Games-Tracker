/**
 * Dev tool: render a sample ELO-standings board to PNG so the leaderboard
 * look can be tweaked without a live DB (same idea as renderPreview.ts for
 * the carnage screen). Sample data is a plausible 4v4 board.
 *
 *   npx tsx src/renderLeaderboardPreview.ts   -> preview-leaderboard.png
 */

import { writeFile } from "node:fs/promises";
import { renderLeaderboardPng, type BoardSection } from "./renderLeaderboard.ts";
import type { Rating } from "./elo.ts";

// (gamertag, elo, wins, losses, draws, kd) — kills/deaths chosen to match kd.
const SAMPLE: [string, number, number, number, number, number][] = [
  ["SgtForge Jr", 1247, 7, 3, 0, 0.94],
  ["MasterChef117", 1230, 5, 4, 0, 1.22],
  ["GruntBirthday", 1217, 5, 3, 0, 1.1],
  ["SplazerDazer", 1216, 1, 0, 0, 0.67],
  ["RingRunner117", 1214, 2, 1, 0, 1.08],
  ["NoScopeNed", 1214, 5, 5, 0, 0.87],
  ["Hysterically", 1186, 5, 5, 0, 0.94],
  ["Cortanas Ghost", 1184, 4, 4, 0, 1.11],
  ["CrouchNade", 1169, 0, 2, 0, 1.04],
  ["TeleporterCamper", 1169, 3, 6, 0, 1.0],
  ["FlagDropper88", 1153, 3, 7, 0, 0.85],
];

const ratings: Rating[] = SAMPLE.map(([gamertag, rating, wins, losses, draws, kd]) => ({
  xuid: `0x${gamertag}`,
  gamertag,
  rating,
  games: wins + losses + draws,
  wins,
  losses,
  draws,
  kills: Math.round(kd * 100),
  deaths: 100,
}));

const sections: BoardSection[] = [
  { title: "2V2 LEADERBOARD", ratings: [] },
  { title: "4V4 LEADERBOARD", ratings },
  { title: "FFA LEADERBOARD", ratings: [] },
];

await writeFile("preview-leaderboard.png", await renderLeaderboardPng(sections));
console.log("wrote preview-leaderboard.png");
