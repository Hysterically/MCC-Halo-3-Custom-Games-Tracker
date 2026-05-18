/**
 * Parser for MCC `mpcarnagereport*.xml`. Schema confirmed against a real
 * Halo 3 report (Ranked Team Slayer sample, 8 players).
 *
 * Tracked game = Halo 3 (mGameEnum === 2) AND a custom game
 * (IsMatchmaking === false) AND completed (mLastMatchIncomplete === false).
 *
 * fast-xml-parser puts attributes under `@_name`. A single <Player> comes
 * back as an object, many as an array — we normalise to an array.
 */

import { readFile, stat } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

/** mGameEnum value for Halo 3 (confirmed: HopperName "$MP_H3RankedTeamSlayer"). */
export const GAME_HALO3 = 2;

export interface CarnagePlayer {
  gamertag: string;
  xuid: string; // e.g. "0x0009000001486F86"
  teamId: number; // -1 if FFA / no team
  score: number;
  standing: number; // 0 = best place
  kills: number;
  deaths: number;
  assists: number;
  betrayals: number;
  suicides: number;
  secondsPlayed: number;
  completedGame: boolean;
}

export interface CarnageReport {
  matchId: string; // GameUniqueId — dedupe key
  gameEnum: number;
  isHalo3: boolean;
  isMatchmaking: boolean;
  isCustom: boolean;
  teamsEnabled: boolean;
  completed: boolean;
  gameTypeName: string; // e.g. "TEAM SLAYER BR"
  hopperName: string; // empty for customs
  playedAt: Date; // file mtime (no timestamp in the XML)
  players: CarnagePlayer[];
  /** Winning team id, or null for FFA / undecided. */
  winningTeamId: number | null;
  /** Gamertags credited with the win. */
  winners: string[];
  /** True if this is a Halo 3 custom game that completed — i.e. one we track. */
  tracked: boolean;
}

const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: unknown): boolean => String(v).toLowerCase() === "true";
const asArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export async function parseCarnageFile(path: string): Promise<CarnageReport> {
  const [xml, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  return parseCarnageXml(xml, st.mtime);
}

export function parseCarnageXml(xml: string, playedAt = new Date()): CarnageReport {
  const root = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml)
    ?.MultiplayerCarnageReport;
  if (!root) throw new Error("Not a MultiplayerCarnageReport (unexpected XML root).");

  const gameEnum = num(root.GameEnum?.["@_mGameEnum"], -1);
  const isMatchmaking = bool(root.IsMatchmaking?.["@_IsMatchmaking"]);
  const teamsEnabled = bool(root.IsTeamsEnabled?.["@_IsTeamsEnabled"]);
  const completed = !bool(root.mLastMatchIncomplete?.["@_mLastMatchIncomplete"]);

  const players: CarnagePlayer[] = asArray<any>(root.Players?.Player).map((p) => ({
    gamertag: String(p["@_mGamertagText"] ?? ""),
    xuid: String(p["@_mXboxUserId"] ?? ""),
    teamId: num(p["@_mTeamId"], -1),
    score: num(p["@_Score"]),
    standing: num(p["@_mStanding"], 999),
    kills: num(p["@_mKills"]),
    deaths: num(p["@_mDeaths"]),
    assists: num(p["@_mAssists"]),
    betrayals: num(p["@_mBetrayals"]),
    suicides: num(p["@_mSuicides"]),
    secondsPlayed: num(p["@_mSecondsPlayed"]),
    completedGame: num(p["@_mCompletedGame"]) === 1,
  }));

  const { winningTeamId, winners } = decideWinner(players, teamsEnabled);
  const isHalo3 = gameEnum === GAME_HALO3;
  const isCustom = !isMatchmaking;

  return {
    matchId: String(root.GameUniqueId?.["@_GameUniqueId"] ?? ""),
    gameEnum,
    isHalo3,
    isMatchmaking,
    isCustom,
    teamsEnabled,
    completed,
    gameTypeName: String(root.GameTypeName?.["@_GameTypeName"] ?? ""),
    hopperName: String(root.HopperName?.["@_HopperName"] ?? ""),
    playedAt,
    players,
    winningTeamId,
    winners,
    tracked: isHalo3 && isCustom && completed && players.length > 0,
  };
}

/**
 * Winner = best (lowest) mStanding. For team games the whole winning team
 * shares standing 0; tie-break on total team score. FFA: the standing-0 player.
 */
function decideWinner(
  players: CarnagePlayer[],
  teamsEnabled: boolean,
): { winningTeamId: number | null; winners: string[] } {
  if (!players.length) return { winningTeamId: null, winners: [] };

  if (!teamsEnabled) {
    const best = Math.min(...players.map((p) => p.standing));
    const winners = players.filter((p) => p.standing === best).map((p) => p.gamertag);
    return { winningTeamId: null, winners };
  }

  const teams = new Map<number, { bestStanding: number; totalScore: number }>();
  for (const p of players) {
    const t = teams.get(p.teamId) ?? { bestStanding: Infinity, totalScore: 0 };
    t.bestStanding = Math.min(t.bestStanding, p.standing);
    t.totalScore += p.score;
    teams.set(p.teamId, t);
  }
  const ranked = [...teams.entries()].sort(
    (a, b) => a[1].bestStanding - b[1].bestStanding || b[1].totalScore - a[1].totalScore,
  );
  const winningTeamId = ranked[0][0];
  const winners = players.filter((p) => p.teamId === winningTeamId).map((p) => p.gamertag);
  return { winningTeamId, winners };
}
