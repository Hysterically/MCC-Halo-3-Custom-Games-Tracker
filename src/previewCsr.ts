/**
 * One-off: render the per-match CSR carnage PNG for the most recent 4v4 match in
 * the live DB, so we can eyeball the TrueSkill 2 results layout. Read-only.
 *
 *   npx tsx src/previewCsr.ts          # -> preview-csr.png (latest 4v4)
 */
import { writeFileSync } from "node:fs";
import { config } from "./config.ts";
import { openDb, matchesChrono, type StoredMatch } from "./db.ts";
import { boardCategory } from "./category.ts";
import { matchCsrChanges, rateCategory } from "./trueskill2.ts";
import { renderCarnageCsrPng } from "./renderCarnage.ts";
import { renderCsrLeaderboardPng } from "./renderCsrLeaderboard.ts";
import type { CarnageReport } from "./parseCarnage.ts";

/** Build the minimal CarnageReport the renderer needs from a StoredMatch. */
function toReport(m: StoredMatch): CarnageReport {
  return {
    matchId: m.matchId,
    gameEnum: 2,
    isHalo3: true,
    isMatchmaking: false,
    isCustom: true,
    teamsEnabled: m.teamsEnabled,
    completed: true,
    gameTypeName: m.gameTypeName,
    hopperName: "",
    playedAt: new Date(m.playedAt),
    mapName: m.mapName,
    mapVariant: m.mapVariant,
    durationSeconds: m.durationSeconds,
    winningTeamId: m.winningTeamId,
    winners: [],
    tracked: true,
    players: m.players.map((p) => ({
      gamertag: p.gamertag,
      xuid: p.xuid,
      teamId: p.teamId,
      score: p.score,
      standing: p.standing,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      betrayals: 0,
      suicides: 0,
      secondsPlayed: m.durationSeconds ?? 0,
      completedGame: true,
    })),
  };
}

const db = await openDb(config.dbUrl, config.dbAuthToken);
const all = await matchesChrono(db);
const cat = (process.argv[2] ?? "4v4") as ReturnType<typeof boardCategory>;
const latest = [...all].reverse().find((m) => boardCategory(m) === cat);
if (!latest) throw new Error(`no ${cat} match found`);

const changes = matchCsrChanges(all, latest.matchId) ?? undefined;
const png = await renderCarnageCsrPng(toReport(latest), changes);
writeFileSync("preview-csr.png", png);
console.log(
  `Wrote preview-csr.png — ${latest.gameTypeName} (${cat}), ${latest.players.length} players, ${changes?.size ?? 0} rated`,
);

const rows = rateCategory(all.filter((m) => boardCategory(m) === cat))
  .filter((r) => r.games > 0)
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
const board = await renderCsrLeaderboardPng([{ title: `${cat.toUpperCase()} LEADERBOARD`, rows }]);
writeFileSync("preview-csr-leaderboard.png", board);
console.log(`Wrote preview-csr-leaderboard.png — ${rows.length} rows`);

db.close();
