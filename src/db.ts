/**
 * SQLite store. Players are keyed by XUID (stable across Gamertag changes);
 * the latest Gamertag is kept for display. Matches dedupe on GameUniqueId.
 *
 * Ratings are NOT stored — they are recomputed from match history in
 * chronological order whenever needed (see elo.ts). That keeps ELO
 * deterministic and lets us retune K / replay history with zero drift.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { CarnageReport } from "./parseCarnage.ts";

export type DB = Database.Database;

export interface StoredMatch {
  matchId: string;
  gameTypeName: string;
  teamsEnabled: boolean;
  playedAt: number; // epoch ms — chronological key for ELO replay
  winningTeamId: number | null;
  players: {
    xuid: string;
    gamertag: string;
    teamId: number;
    standing: number;
    score: number;
    kills: number;
    deaths: number;
    assists: number;
  }[];
}

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      xuid       TEXT PRIMARY KEY,
      gamertag   TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS matches (
      match_id        TEXT PRIMARY KEY,
      game_type       TEXT NOT NULL,
      teams_enabled   INTEGER NOT NULL,
      played_at       INTEGER NOT NULL,
      winning_team_id INTEGER,
      recorded_at     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS match_players (
      match_id  TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
      xuid      TEXT NOT NULL,
      gamertag  TEXT NOT NULL,
      team_id   INTEGER NOT NULL,
      standing  INTEGER NOT NULL,
      score     INTEGER NOT NULL,
      kills     INTEGER NOT NULL,
      deaths    INTEGER NOT NULL,
      assists   INTEGER NOT NULL,
      PRIMARY KEY (match_id, xuid)
    );
    CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at);
  `);
  return db;
}

export function hasMatch(db: DB, matchId: string): boolean {
  return db.prepare("SELECT 1 FROM matches WHERE match_id = ?").get(matchId) != null;
}

/**
 * Insert a tracked carnage report. Returns false if the match was already
 * recorded (dedupe) — the watcher relies on this to stay idempotent.
 */
export function recordMatch(db: DB, r: CarnageReport): boolean {
  if (hasMatch(db, r.matchId)) return false;

  const playedAt = r.playedAt.getTime();
  const now = Date.now();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO matches
         (match_id, game_type, teams_enabled, played_at, winning_team_id, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      r.matchId,
      r.gameTypeName,
      r.teamsEnabled ? 1 : 0,
      playedAt,
      r.winningTeamId,
      now,
    );

    const insPlayer = db.prepare(
      `INSERT INTO match_players
         (match_id, xuid, gamertag, team_id, standing, score, kills, deaths, assists)
       VALUES (@match_id, @xuid, @gamertag, @team_id, @standing, @score, @kills, @deaths, @assists)`,
    );
    const upsertId = db.prepare(
      `INSERT INTO players (xuid, gamertag, first_seen, last_seen)
       VALUES (@xuid, @gamertag, @t, @t)
       ON CONFLICT(xuid) DO UPDATE SET gamertag = @gamertag, last_seen = @t`,
    );

    for (const p of r.players) {
      if (!p.xuid) continue; // guests / bots have no XUID — not rateable
      insPlayer.run({
        match_id: r.matchId,
        xuid: p.xuid,
        gamertag: p.gamertag,
        team_id: p.teamId,
        standing: p.standing,
        score: p.score,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
      });
      upsertId.run({ xuid: p.xuid, gamertag: p.gamertag, t: playedAt });
    }
  });

  tx();
  return true;
}

/** Every match with its players, oldest first — the input to ELO replay. */
export function matchesChrono(db: DB): StoredMatch[] {
  const matches = db
    .prepare(
      `SELECT match_id, game_type, teams_enabled, played_at, winning_team_id
         FROM matches ORDER BY played_at ASC, recorded_at ASC`,
    )
    .all() as any[];

  const playersStmt = db.prepare(
    `SELECT xuid, gamertag, team_id, standing, score, kills, deaths, assists
       FROM match_players WHERE match_id = ?`,
  );

  return matches.map((m) => ({
    matchId: m.match_id,
    gameTypeName: m.game_type,
    teamsEnabled: !!m.teams_enabled,
    playedAt: m.played_at,
    winningTeamId: m.winning_team_id,
    players: (playersStmt.all(m.match_id) as any[]).map((p) => ({
      xuid: p.xuid,
      gamertag: p.gamertag,
      teamId: p.team_id,
      standing: p.standing,
      score: p.score,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
    })),
  }));
}

/** Current display Gamertag per XUID. */
export function displayNames(db: DB): Map<string, string> {
  const rows = db.prepare("SELECT xuid, gamertag FROM players").all() as any[];
  return new Map(rows.map((r) => [r.xuid, r.gamertag]));
}

export function matchCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) n FROM matches").get() as any).n;
}
