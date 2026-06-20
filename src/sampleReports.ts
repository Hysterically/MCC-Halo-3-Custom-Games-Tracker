/**
 * Synthetic carnage reports (data lifted from real screenshots) shared by the
 * render preview and the webhook test post, so the carnage-screen look can be
 * exercised without playing a match.
 */

import type { CarnageReport, CarnagePlayer } from "./parseCarnage.ts";
import type { EloChange } from "./elo.ts";
import type { CsrChange, MatchWinChances } from "./trueskill2.ts";
import { csrFromSkill } from "./csr.ts";

const p = (
  gamertag: string,
  teamId: number,
  score: number,
  kills: number,
  assists: number,
  deaths: number,
  standing: number,
): CarnagePlayer => ({
  gamertag,
  // Unique per player (the ELO-change column is keyed by XUID); same scheme
  // as the C++ sampleReport().
  xuid: `0x${gamertag}`,
  teamId,
  score,
  standing,
  kills,
  deaths,
  assists,
  betrayals: 0,
  suicides: 0,
  secondsPlayed: 600,
  completedGame: true,
});

const base = {
  matchId: "preview",
  gameEnum: 2,
  isHalo3: true,
  isMatchmaking: false,
  isCustom: true,
  completed: true,
  hopperName: "",
  playedAt: new Date(),
  winners: [],
  tracked: true,
} as const;

export const sampleTeam: CarnageReport = {
  ...base,
  teamsEnabled: true,
  gameTypeName: "Hardcore King",
  winningTeamId: 0,
  winners: ["Blopped", "a1chess", "l23LO4D3D", "Topher"],
  players: [
    p("Blopped", 0, 113, 33, 18, 18, 0),
    p("a1chess", 0, 85, 12, 14, 26, 0),
    p("l23LO4D3D", 0, 32, 42, 19, 21, 0),
    p("Topher", 0, 20, 32, 17, 20, 0),
    p("iRoKchevy", 1, 61, 15, 21, 32, 1),
    p("TRauMa L5p", 1, 49, 16, 16, 31, 1),
    p("oWhittaker", 1, 42, 34, 19, 26, 1),
    p("Hysterically", 1, 31, 20, 18, 30, 1),
  ],
};

/** Plausible post-match ratings + changes so previews show the ELO column. */
export function sampleEloChanges(r: CarnageReport): Map<string, EloChange> {
  const ffaByStanding: EloChange[] = [
    { rating: 1302, delta: 24 },
    { rating: 1278, delta: 8 },
    { rating: 1255, delta: -10 },
    { rating: 1231, delta: -22 },
  ];
  const winnerRatings = [1342, 1318, 1296, 1275];
  const loserRatings = [1289, 1263, 1241, 1210];
  let w = 0;
  let l = 0;
  return new Map(
    r.players.map((p) => {
      if (!r.teamsEnabled) {
        return [p.xuid, ffaByStanding[p.standing] ?? { rating: 1231, delta: -22 }];
      }
      return p.teamId === r.winningTeamId
        ? [p.xuid, { rating: winnerRatings[w++ % 4], delta: 16 }]
        : [p.xuid, { rating: loserRatings[l++ % 4], delta: -16 }];
    }),
  );
}

/** Plausible post-match CSR + changes so previews show the CSR column. */
export function sampleCsrChanges(r: CarnageReport): Map<string, CsrChange> {
  const winnerSkills = [25.6, 22.4, 20.1, 18.0];
  const loserSkills = [19.5, 16.8, 13.4, 9.2];
  const winnerDelta = [31, 24, 18, 12];
  const loserDelta = [-14, -19, -23, -28];
  const ffaSkills = [24.0, 20.0, 16.0, 11.0];
  const ffaDelta = [28, 9, -12, -25];
  let w = 0;
  let l = 0;
  return new Map(
    r.players.map((p) => {
      if (!r.teamsEnabled) {
        const i = Math.min(p.standing, 3);
        return [p.xuid, { skill: ffaSkills[i], csr: csrFromSkill(ffaSkills[i]), delta: ffaDelta[i] }];
      }
      const won = p.teamId === r.winningTeamId;
      const i = (won ? w++ : l++) % 4;
      const skill = won ? winnerSkills[i] : loserSkills[i];
      const delta = won ? winnerDelta[i] : loserDelta[i];
      return [p.xuid, { skill, csr: csrFromSkill(skill), delta }];
    }),
  );
}

/** Plausible per-team win bar (avg CSR from the sample CSR changes) for previews. */
export function sampleWinChances(r: CarnageReport): MatchWinChances | undefined {
  if (!r.teamsEnabled || r.winningTeamId == null) return undefined;
  const csr = sampleCsrChanges(r);
  const agg = new Map<number, { sum: number; n: number }>();
  for (const pl of r.players) {
    const c = csr.get(pl.xuid);
    if (!c) continue;
    const a = agg.get(pl.teamId) ?? { sum: 0, n: 0 };
    a.sum += c.csr.value;
    a.n += 1;
    agg.set(pl.teamId, a);
  }
  if (agg.size !== 2) return undefined;
  const [idA, idB] = [...agg.keys()].sort((x, y) =>
    x === r.winningTeamId ? -1 : y === r.winningTeamId ? 1 : x - y,
  );
  const avg = (id: number): number => Math.round(agg.get(id)!.sum / agg.get(id)!.n);
  return {
    teams: [
      { teamId: idA, avgCsr: avg(idA), winProb: 0.55 },
      { teamId: idB, avgCsr: avg(idB), winProb: 0.45 },
    ],
  };
}

export const sampleFfa: CarnageReport = {
  ...base,
  teamsEnabled: false,
  gameTypeName: "Lockout FFA",
  winningTeamId: null,
  winners: ["Blopped"],
  players: [
    p("Blopped", -1, 25, 25, 3, 14, 0),
    p("Hysterically", -1, 21, 21, 5, 18, 1),
    p("oWhittaker", -1, 17, 17, 2, 20, 2),
    p("Topher", -1, 12, 12, 6, 23, 3),
  ],
};
