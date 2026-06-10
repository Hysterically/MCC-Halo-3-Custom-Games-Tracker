/**
 * Synthetic carnage reports (data lifted from real screenshots) shared by the
 * render preview and the webhook test post, so the carnage-screen look can be
 * exercised without playing a match.
 */

import type { CarnageReport, CarnagePlayer } from "./parseCarnage.ts";

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
  xuid: `0x${gamertag.length}`,
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
