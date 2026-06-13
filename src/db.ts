/**
 * libSQL store (SQLite-compatible). Players are keyed by XUID (stable across
 * Gamertag changes); the latest Gamertag is kept for display. Matches dedupe on
 * GameUniqueId.
 *
 * The same code talks to a local `file:` DB (solo use) or a remote libSQL/Turso
 * URL shared by several PCs. When shared, this layer doubles as the
 * cross-instance guard: recordMatch() inserts the match with
 * `ON CONFLICT DO NOTHING` inside a write transaction and returns true ONLY for
 * the instance whose insert actually created the row. Every other instance that
 * later sees the same GameUniqueId gets false and skips posting — so a match is
 * recorded and announced to Discord exactly once, no matter how many watchers
 * run.
 *
 * Ratings are NOT stored — they are recomputed from match history in
 * chronological order whenever needed (see elo.ts). That keeps ELO
 * deterministic and lets us retune K / replay history with zero drift.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import type { CarnageReport } from "./parseCarnage.ts";

export type DB = Client;

export interface StoredMatch {
  matchId: string;
  gameTypeName: string;
  teamsEnabled: boolean;
  playedAt: number; // epoch ms — chronological key for ELO replay
  winningTeamId: number | null;
  mapName?: string;
  mapVariant?: string;
  durationSeconds?: number; // longest secondsPlayed; undefined on pre-tracking rows
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

const num = (v: unknown): number => Number(v ?? 0);

/**
 * In-process write mutex. A single watcher can finish two matches at almost the
 * same instant (chokidar fires overlapping events); without serialization their
 * write transactions collide as SQLITE_BUSY on a local file. Chaining every
 * write through one promise keeps them strictly sequential. Cross-instance
 * writes to a shared remote DB are serialized by the server, so this only
 * guards same-process concurrency.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function openDb(url: string, authToken?: string): Promise<DB> {
  const isFile = url.startsWith("file:");
  if (isFile) {
    // Make sure the parent folder exists before libSQL opens the file.
    mkdirSync(dirname(fileURLToPath(url)), { recursive: true });
  }

  const db = createClient(authToken ? { url, authToken } : { url });

  // WAL + a busy timeout only matter for a local file; they're no-ops /
  // unsupported on remote libSQL. busy_timeout makes a writer wait for a lock
  // instead of failing instantly with SQLITE_BUSY (a backstop to serializeWrite).
  if (isFile) {
    await db.execute("PRAGMA journal_mode = WAL").catch(() => {});
    await db.execute("PRAGMA busy_timeout = 5000").catch(() => {});
  }
  await db.execute("PRAGMA foreign_keys = ON").catch(() => {});

  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS players (
         xuid       TEXT PRIMARY KEY,
         gamertag   TEXT NOT NULL,
         first_seen INTEGER NOT NULL,
         last_seen  INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS matches (
         match_id        TEXT PRIMARY KEY,
         game_type       TEXT NOT NULL,
         teams_enabled   INTEGER NOT NULL,
         played_at       INTEGER NOT NULL,
         winning_team_id INTEGER,
         recorded_at     INTEGER NOT NULL,
         map_name        TEXT,
         map_variant     TEXT,
         duration_seconds INTEGER
       )`,
      `CREATE TABLE IF NOT EXISTS match_players (
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
       )`,
      `CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at)`,
      `CREATE TABLE IF NOT EXISTS kv (
         k TEXT PRIMARY KEY,
         v TEXT NOT NULL
       )`,
    ],
    "write",
  );

  // Migrate pre-map databases in place; "duplicate column" just means done.
  for (const col of ["map_name", "map_variant"]) {
    await db.execute(`ALTER TABLE matches ADD COLUMN ${col} TEXT`).catch(() => {});
  }
  // Pre-duration databases: add the column; old rows stay NULL (= always count).
  await db.execute("ALTER TABLE matches ADD COLUMN duration_seconds INTEGER").catch(() => {});

  return db;
}

export async function kvGet(db: DB, k: string): Promise<string | undefined> {
  const res = await db.execute({ sql: "SELECT v FROM kv WHERE k = ?", args: [k] });
  return res.rows[0] ? String(res.rows[0].v) : undefined;
}

export async function kvSet(db: DB, k: string, v: string): Promise<void> {
  await serializeWrite(() =>
    db.execute({
      sql: "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      args: [k, v],
    }),
  );
}

export async function kvDelete(db: DB, k: string): Promise<void> {
  await serializeWrite(() => db.execute({ sql: "DELETE FROM kv WHERE k = ?", args: [k] }));
}

/**
 * Claim a kv key atomically: insert only if absent. Returns true if THIS call
 * created the row (i.e. we won the race), false if it was already set.
 */
export async function kvClaim(db: DB, k: string, v: string): Promise<boolean> {
  const res = await serializeWrite(() =>
    db.execute({
      sql: "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING",
      args: [k, v],
    }),
  );
  return res.rowsAffected === 1;
}

/**
 * Compare-and-swap a kv value: set to `next` only if it currently equals
 * `expected`. Returns true if the swap happened. Lets two instances safely
 * replace a stale value (e.g. a deleted leaderboard message id).
 */
export async function kvCas(db: DB, k: string, expected: string, next: string): Promise<boolean> {
  const res = await serializeWrite(() =>
    db.execute({
      sql: "UPDATE kv SET v = ? WHERE k = ? AND v = ?",
      args: [next, k, expected],
    }),
  );
  return res.rowsAffected === 1;
}

export async function hasMatch(db: DB, matchId: string): Promise<boolean> {
  const res = await db.execute({ sql: "SELECT 1 FROM matches WHERE match_id = ?", args: [matchId] });
  return res.rows.length > 0;
}

/**
 * Insert a tracked carnage report. Returns false if the match was already
 * recorded — by this instance OR any other instance sharing the DB. The watcher
 * relies on this to stay idempotent and to avoid duplicate Discord posts when
 * several watchers run at once.
 *
 * The match row is inserted with ON CONFLICT DO NOTHING inside a write
 * transaction: whichever instance's insert reports rowsAffected === 1 owns the
 * match; everyone else rolls back and returns false.
 */
export async function recordMatch(db: DB, r: CarnageReport): Promise<boolean> {
  return serializeWrite(() => recordMatchTx(db, r));
}

async function recordMatchTx(db: DB, r: CarnageReport): Promise<boolean> {
  const playedAt = r.playedAt.getTime();
  const now = Date.now();

  const tx = await db.transaction("write");
  try {
    const claim = await tx.execute({
      sql: `INSERT INTO matches
              (match_id, game_type, teams_enabled, played_at, winning_team_id, recorded_at,
               map_name, map_variant, duration_seconds)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(match_id) DO NOTHING`,
      args: [
        r.matchId,
        r.gameTypeName,
        r.teamsEnabled ? 1 : 0,
        playedAt,
        r.winningTeamId,
        now,
        r.mapName ?? null,
        r.mapVariant ?? null,
        r.durationSeconds ?? null,
      ],
    });

    if (claim.rowsAffected === 0) {
      await tx.rollback();
      return false; // already recorded (by us or another instance)
    }

    for (const p of r.players) {
      if (!p.xuid) continue; // guests / bots have no XUID — not rateable
      await tx.execute({
        sql: `INSERT INTO match_players
                (match_id, xuid, gamertag, team_id, standing, score, kills, deaths, assists)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [r.matchId, p.xuid, p.gamertag, p.teamId, p.standing, p.score, p.kills, p.deaths, p.assists],
      });
      await tx.execute({
        sql: `INSERT INTO players (xuid, gamertag, first_seen, last_seen)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(xuid) DO UPDATE SET gamertag = excluded.gamertag, last_seen = excluded.last_seen`,
        args: [p.xuid, p.gamertag, playedAt, playedAt],
      });
    }

    await tx.commit();
    return true;
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}

/** Every match with its players, oldest first — the input to ELO replay. */
export async function matchesChrono(db: DB): Promise<StoredMatch[]> {
  // Two bulk queries (not N+1) keep this cheap over a remote DB.
  const matchesRes = await db.execute(
    `SELECT match_id, game_type, teams_enabled, played_at, winning_team_id, map_name, map_variant,
            duration_seconds
       FROM matches ORDER BY played_at ASC, recorded_at ASC`,
  );
  const playersRes = await db.execute(
    `SELECT match_id, xuid, gamertag, team_id, standing, score, kills, deaths, assists
       FROM match_players`,
  );

  const byMatch = new Map<string, StoredMatch["players"]>();
  for (const p of playersRes.rows) {
    const id = String(p.match_id);
    const arr = byMatch.get(id) ?? [];
    arr.push({
      xuid: String(p.xuid),
      gamertag: String(p.gamertag),
      teamId: num(p.team_id),
      standing: num(p.standing),
      score: num(p.score),
      kills: num(p.kills),
      deaths: num(p.deaths),
      assists: num(p.assists),
    });
    byMatch.set(id, arr);
  }

  return matchesRes.rows.map((m) => ({
    matchId: String(m.match_id),
    gameTypeName: String(m.game_type),
    teamsEnabled: !!num(m.teams_enabled),
    playedAt: num(m.played_at),
    winningTeamId: m.winning_team_id == null ? null : num(m.winning_team_id),
    mapName: m.map_name == null ? undefined : String(m.map_name),
    mapVariant: m.map_variant == null ? undefined : String(m.map_variant),
    durationSeconds: m.duration_seconds == null ? undefined : num(m.duration_seconds),
    players: byMatch.get(String(m.match_id)) ?? [],
  }));
}

/** Current display Gamertag per XUID. */
export async function displayNames(db: DB): Promise<Map<string, string>> {
  const res = await db.execute("SELECT xuid, gamertag FROM players");
  return new Map(res.rows.map((r) => [String(r.xuid), String(r.gamertag)]));
}

export async function matchCount(db: DB): Promise<number> {
  const res = await db.execute("SELECT COUNT(*) AS n FROM matches");
  return num(res.rows[0]?.n);
}
