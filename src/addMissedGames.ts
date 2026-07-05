/**
 * One-off, owner-only maintenance for a specific gap in the shared history.
 *
 * Two 4v4 games were never recorded (the tracker wasn't running and no other
 * instance on the shared DB caught them); their carnage XMLs have since rotated
 * out of MCC, so they're reconstructed from screenshots here. A third, recorded
 * game on The Pit has the wrong winner. This script:
 *
 *   1. inserts the Guardian game (HARDCORE BALL, RED won) just BEFORE Construct,
 *   2. inserts the Amp game (HARDCORE TS, RED won) just AFTER Construct,
 *   3. flips The Pit game to a BLUE win (winner column AND player standings —
 *      the ladder derives the winner from standings, the post headline from the
 *      winner column), and
 *   4. reorders #game-results: deletes the Construct post and every post after
 *      it, then reposts the whole tail in chronological order so the two new
 *      posts land in their correct mid-channel slots.
 *
 * Ratings (CSR) are recomputed from history on read, so the inserts/flip are the
 * source of truth; the repost just makes the frozen post captions match.
 *
 * Not a shipped feature — no C++ port, no release. The data lands in the shared
 * remote DB that both implementations read.
 *
 *   tsx src/addMissedGames.ts            # dry run: resolve + validate, change nothing
 *   tsx src/addMissedGames.ts --confirm  # apply
 */

import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import {
  openDb,
  matchesChrono,
  matchCount,
  recordMatch,
  setMatchResultsMsg,
  setMatchResultsFmt,
  clearMatchResultsMsg,
  matchIdByResultsMsg,
  recordedAtByMatch,
  type DB,
  type StoredMatch,
} from "./db.ts";
import { toReport, snowflakeMs } from "./heal.ts";
import { matchCsrChanges, matchWinChances } from "./trueskill2.ts";
import {
  postCsrMatchResultWithControls,
  upsertCsrLeaderboard,
  resultsWebhookCandidates,
  deleteMessage,
} from "./discord.ts";
import { categorize } from "./category.ts";
import { displayName } from "./aliases.ts";
import { RESULTS_FMT_VERSION } from "./version.ts";
import type { CarnageReport, CarnagePlayer } from "./parseCarnage.ts";

const CONFIRM = process.argv.includes("--confirm");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Discord #game-results message ids the user gave as anchors. One-off script:
 *  paste the real ids (here and in verifyPosts below) before running. */
const CONSTRUCT_MSG = "PASTE_CONSTRUCT_MESSAGE_ID";
const PIT_MSG = "PASTE_PIT_MESSAGE_ID";

/** Seconds to nudge the new games off Construct's timestamp (well inside the
 *  ~46 min / ~24.5 min gaps to its neighbors, so they land adjacent to it). */
const OFFSET_MS = 60_000;

/** A roster row from a screenshot: Score / Kills / Assists / Deaths. team 0 = red, 1 = blue. */
interface Row {
  tag: string;
  team: number;
  s: number;
  k: number;
  a: number;
  d: number;
}

// RED (team 0) won both games — set red standing 0, blue standing 1.
const GUARDIAN: Row[] = [
  { tag: "Topher", team: 0, s: 101, k: 20, a: 16, d: 19 },
  { tag: "B7ENDEN", team: 0, s: 48, k: 23, a: 19, d: 25 },
  { tag: "Blopped", team: 0, s: 42, k: 32, a: 12, d: 19 },
  { tag: "QB14GhOsT14QB", team: 0, s: 38, k: 29, a: 24, d: 19 },
  { tag: "mike domination", team: 1, s: 66, k: 18, a: 17, d: 30 },
  { tag: "iwreckshop91", team: 1, s: 31, k: 22, a: 12, d: 24 },
  { tag: "oWhittaker", team: 1, s: 18, k: 20, a: 17, d: 28 },
  { tag: "HystericaIly", team: 1, s: 0, k: 22, a: 15, d: 22 },
];

const AMP: Row[] = [
  { tag: "B7ENDEN", team: 0, s: 15, k: 15, a: 13, d: 10 },
  { tag: "Blopped", team: 0, s: 13, k: 13, a: 9, d: 11 },
  { tag: "Topher", team: 0, s: 11, k: 11, a: 10, d: 11 },
  { tag: "QB14GhOsT14QB", team: 0, s: 11, k: 11, a: 15, d: 11 },
  { tag: "iwreckshop91", team: 1, s: 14, k: 14, a: 9, d: 11 },
  { tag: "oWhittaker", team: 1, s: 12, k: 12, a: 6, d: 14 },
  { tag: "mike domination", team: 1, s: 10, k: 10, a: 12, d: 16 },
  { tag: "HystericaIly", team: 1, s: 7, k: 7, a: 11, d: 9 },
];

/**
 * Resolve a gamertag to exactly one XUID (case-insensitive, over current +
 * historical names), then return that player's CURRENT stored gamertag so the
 * insert's player upsert never renames anyone. Throws unless exactly one match.
 */
async function resolveXuid(db: DB, tag: string): Promise<{ xuid: string; gamertag: string }> {
  const res = await db.execute({
    sql: `SELECT DISTINCT xuid FROM (
            SELECT xuid, gamertag FROM players
            UNION
            SELECT xuid, gamertag FROM match_players
          ) WHERE lower(gamertag) = lower(?)`,
    args: [tag],
  });
  if (res.rows.length !== 1) {
    throw new Error(`gamertag "${tag}" resolved to ${res.rows.length} XUIDs (need exactly 1)`);
  }
  const xuid = String(res.rows[0].xuid);
  const nameRes = await db.execute({ sql: "SELECT gamertag FROM players WHERE xuid = ?", args: [xuid] });
  const gamertag = nameRes.rows[0] ? String(nameRes.rows[0].gamertag) : tag;
  return { xuid, gamertag };
}

/** Build a recordable CarnageReport for a new RED-win team game from a roster. */
async function buildReport(
  db: DB,
  rows: Row[],
  gameTypeName: string,
  mapName: string,
  playedAtMs: number,
): Promise<CarnageReport> {
  const players: CarnagePlayer[] = [];
  for (const r of rows) {
    const { xuid, gamertag } = await resolveXuid(db, r.tag);
    players.push({
      gamertag,
      xuid,
      teamId: r.team,
      standing: r.team === 0 ? 0 : 1, // red (team 0) won
      score: r.s,
      kills: r.k,
      deaths: r.d,
      assists: r.a,
      betrayals: 0,
      suicides: 0,
      secondsPlayed: 0,
      completedGame: true,
    });
  }
  return {
    matchId: randomUUID(),
    gameEnum: 2,
    isHalo3: true,
    isMatchmaking: false,
    isCustom: true,
    teamsEnabled: true,
    completed: true,
    gameTypeName,
    hopperName: "",
    playedAt: new Date(playedAtMs),
    mapName,
    mapVariant: undefined,
    players,
    durationSeconds: undefined, // NULL → "always count" (keeps it on the 4v4 board)
    winningTeamId: 0,
    winners: players.filter((p) => p.teamId === 0).map((p) => p.gamertag),
    tracked: true,
    excluded: false,
  };
}

/** Stable key for "same set of players", regardless of order. */
const rosterKey = (xuids: string[]): string => [...xuids].sort().join("|");

/** Resolve a match from a #game-results message id: stored id first, else the
 *  nearest match by recorded_at to the id's snowflake time (≤10 min). */
async function resolveByMsg(
  db: DB,
  chrono: StoredMatch[],
  recordedAt: Map<string, number>,
  msgId: string,
  label: string,
): Promise<StoredMatch> {
  const exact = await matchIdByResultsMsg(db, msgId);
  let match = exact ? chrono.find((m) => m.matchId === exact) : undefined;
  if (!match) {
    const t = snowflakeMs(msgId);
    let best: StoredMatch | undefined;
    let bestDiff = Infinity;
    for (const m of chrono) {
      const rec = recordedAt.get(m.matchId);
      if (rec == null) continue;
      const diff = Math.abs(rec - t);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = m;
      }
    }
    if (best && bestDiff <= 10 * 60_000) match = best;
  }
  if (!match) throw new Error(`could not resolve the ${label} game from message id ${msgId}`);
  return match;
}

function describe(m: StoredMatch): string {
  const roster = [...m.players]
    .sort((a, b) => a.teamId - b.teamId || a.standing - b.standing)
    .map((p) => `${displayName(p.gamertag)}[t${p.teamId}/s${p.standing}]`)
    .join(", ");
  const map = [m.mapName, m.mapVariant].filter(Boolean).join(" — ") || "?";
  return (
    `${m.gameTypeName} (${categorize(m)}) on ${map}\n` +
    `      @ ${new Date(m.playedAt).toISOString()}  winner=team${m.winningTeamId}\n` +
    `      ${roster}`
  );
}

function printReport(label: string, r: CarnageReport): void {
  console.log(`\n${label}: ${r.gameTypeName} (${categorize(r)}) on ${r.mapName}`);
  console.log(`  @ ${r.playedAt.toISOString()}  winner=team${r.winningTeamId}`);
  for (const p of [...r.players].sort((a, b) => a.teamId - b.teamId || b.score - a.score)) {
    console.log(
      `    t${p.teamId} s${p.standing}  ${displayName(p.gamertag).padEnd(18)} ${p.xuid}  ` +
        `${p.score}/${p.kills}/${p.assists}/${p.deaths}`,
    );
  }
}

/** Post-apply check: confirm the 4 replaced posts were actually deleted (a
 *  silently-dropped delete would leave a duplicate in the channel). */
async function verifyPosts(db: DB): Promise<void> {
  const oldIds = [
    CONSTRUCT_MSG,
    "PASTE_NARROWS_MESSAGE_ID",
    "PASTE_HERETIC_MESSAGE_ID",
    PIT_MSG,
  ];
  const candidates = await resultsWebhookCandidates(db);
  if (!candidates.length) {
    console.log("No results webhook configured — cannot verify.");
    return;
  }
  console.log("Checking the 4 replaced posts are gone:");
  for (const id of oldIds) {
    const hits = await Promise.all(candidates.map((u) => fetch(`${u}/messages/${id}`).then((r) => r.ok).catch(() => false)));
    console.log(`  ${id}: ${hits.some(Boolean) ? "STILL PRESENT (!) — delete a duplicate by hand" : "gone ✓"}`);
  }
}

async function main(db: DB): Promise<void> {
  if (process.argv.includes("--verify")) {
    await verifyPosts(db);
    return;
  }
  console.log(CONFIRM ? "MODE: APPLY (--confirm)\n" : "MODE: DRY RUN (no changes)\n");

  const chrono = await matchesChrono(db);
  const recordedAt = await recordedAtByMatch(db);
  console.log(`History: ${chrono.length} matches.`);

  // --- Resolve the two anchor games -----------------------------------------
  const construct = await resolveByMsg(db, chrono, recordedAt, CONSTRUCT_MSG, "Construct");
  const pit = await resolveByMsg(db, chrono, recordedAt, PIT_MSG, "Pit");
  console.log(`\nConstruct anchor (msg ${CONSTRUCT_MSG}):\n  → ${describe(construct)}`);
  console.log(`\nPit game (msg ${PIT_MSG}):\n  → ${describe(pit)}`);

  // --- Positioning ----------------------------------------------------------
  const cIdx = chrono.findIndex((m) => m.matchId === construct.matchId);
  const before = chrono[cIdx - 1];
  const after = chrono[cIdx + 1];
  const guardianMs = construct.playedAt - OFFSET_MS;
  const ampMs = construct.playedAt + OFFSET_MS;
  // Collision asserts are deferred until after duplicate detection so a re-run
  // (where the games already occupy their slots) is cleanly idempotent.

  const dumpNeighbor = (lbl: string, m: StoredMatch | undefined): void => {
    if (!m) return;
    console.log(`  ${lbl} : ${describe(m)}`);
    for (const p of [...m.players].sort((a, b) => a.teamId - b.teamId || b.score - a.score))
      console.log(`          t${p.teamId} s${p.standing}  ${displayName(p.gamertag).padEnd(18)} ${p.score}/${p.kills}/${p.assists}/${p.deaths}`);
  };
  console.log("\nPlacement (chronological):");
  dumpNeighbor("before", before);
  console.log(`  NEW    : Guardian (HARDCORE BALL) @ ${new Date(guardianMs).toISOString()}`);
  console.log(`  anchor : Construct @ ${new Date(construct.playedAt).toISOString()}`);
  console.log(`  NEW    : Amp (HARDCORE TS)       @ ${new Date(ampMs).toISOString()}`);
  dumpNeighbor("after ", after);

  // --- Build the two new games (resolves XUIDs; aborts on any bad tag) -------
  const guardian = await buildReport(db, GUARDIAN, "HARDCORE BALL", "Guardian", guardianMs);
  const amp = await buildReport(db, AMP, "HARDCORE TS", "Amplified", ampMs);
  printReport("Guardian (new)", guardian);
  printReport("Amp (new)", amp);
  if (categorize(guardian) !== "4v4" || categorize(amp) !== "4v4")
    throw new Error("A new game did not classify as 4v4 — check the roster/teams.");

  // --- Duplicate / re-run detection -----------------------------------------
  const dup = (gameType: string, r: CarnageReport): { exact: boolean; loose: StoredMatch[] } => {
    const key = rosterKey(r.players.map((p) => p.xuid));
    const target = r.playedAt.getTime();
    const same = chrono.filter(
      (m) => m.gameTypeName === gameType && rosterKey(m.players.map((p) => p.xuid)) === key,
    );
    return { exact: same.some((m) => m.playedAt === target), loose: same };
  };
  const dupG = dup("HARDCORE BALL", guardian);
  const dupA = dup("HARDCORE TS", amp);

  // Validate the slots — but only for a game we're actually about to insert. On a
  // re-run the game already sits at its slot, which is correct, not a collision.
  if (!dupG.exact) {
    if (before && guardianMs <= before.playedAt)
      throw new Error(`Guardian slot ${guardianMs} collides with the match before Construct (${before.playedAt}).`);
    if (guardianMs >= construct.playedAt) throw new Error("Guardian slot is not before Construct.");
  }
  if (!dupA.exact) {
    if (ampMs <= construct.playedAt) throw new Error("Amp slot is not after Construct.");
    if (after && ampMs >= after.playedAt)
      throw new Error(`Amp slot ${ampMs} collides with the match after Construct (${after.playedAt}).`);
  }
  for (const [name, d] of [["Guardian", dupG], ["Amp", dupA]] as const) {
    if (d.exact) console.log(`\n[idempotent] ${name} already exists at its target slot — insert will be skipped.`);
    else if (d.loose.length) {
      console.log(
        `\n[heads-up] ${d.loose.length} existing game(s) with ${name}'s exact roster at other times` +
          ` — compare stats to be sure this isn't the same game already recorded:`,
      );
      for (const m of d.loose) {
        console.log(`  ${describe(m)}`);
        for (const p of [...m.players].sort((a, b) => a.teamId - b.teamId || b.score - a.score))
          console.log(`      t${p.teamId} s${p.standing}  ${displayName(p.gamertag).padEnd(18)} ${p.score}/${p.kills}/${p.assists}/${p.deaths}`);
      }
    }
  }

  // --- The Pit flip preview -------------------------------------------------
  const pitBlue = pit.players.filter((p) => p.teamId === 1);
  const pitRed = pit.players.filter((p) => p.teamId === 0);
  if (pitBlue.length === 0 || pitRed.length === 0)
    throw new Error("Pit game is not a red/blue two-team game; aborting the winner flip.");
  console.log(
    `\nPit winner flip: winning_team_id ${pit.winningTeamId} → 1 (blue); ` +
      `standings → blue(${pitBlue.length}) = 0, red(${pitRed.length}) = 1.`,
  );

  // --- The channel tail that will be deleted + reposted ---------------------
  const tailPreview = chrono.filter((m) => m.playedAt >= guardianMs);
  console.log(`\nChannel reorder — tail to repost in order (${tailPreview.length} existing + 2 new):`);
  console.log(`  NEW Guardian → ${construct.gameTypeName}(Construct) → NEW Amp → ` + tailPreview.filter((m) => m.matchId !== construct.matchId).map((m) => `${m.gameTypeName}(${m.mapName ?? "?"})`).join(" → "));

  if (!CONFIRM) {
    console.log("\nDry run complete. Re-run with --confirm to apply.");
    return;
  }

  // === APPLY ================================================================
  console.log("\n--- applying ---");

  if (!dupG.exact) {
    const ok = await recordMatch(db, guardian);
    console.log(`recordMatch(Guardian) → ${ok}`);
  }
  if (!dupA.exact) {
    const ok = await recordMatch(db, amp);
    console.log(`recordMatch(Amp) → ${ok}`);
  }

  // Pit flip (idempotent: re-applying sets the same values).
  const u1 = await db.execute({ sql: "UPDATE matches SET winning_team_id = 1 WHERE match_id = ?", args: [pit.matchId] });
  const u2 = await db.execute({ sql: "UPDATE match_players SET standing = 0 WHERE match_id = ? AND team_id = 1", args: [pit.matchId] });
  const u3 = await db.execute({ sql: "UPDATE match_players SET standing = 1 WHERE match_id = ? AND team_id = 0", args: [pit.matchId] });
  console.log(`Pit flip: matches=${u1.rowsAffected}, blue→0=${u2.rowsAffected}, red→1=${u3.rowsAffected}`);
  if (u1.rowsAffected < 1) throw new Error("Pit winner update affected no rows — aborting before reposting.");

  console.log(`matchCount now: ${await matchCount(db)}`);

  // --- Reorder #game-results -------------------------------------------------
  if (!config.discordResultsWebhookUrl) {
    console.warn("\nDISCORD_RESULTS_WEBHOOK_URL not set — DB updated, but the channel was NOT reposted.");
  } else {
    // Snapshot which tail matches currently have a post, then re-read history.
    const msgRes = await db.execute("SELECT match_id, results_msg_id FROM matches WHERE results_msg_id IS NOT NULL");
    const msgByMatch = new Map(msgRes.rows.map((r) => [String(r.match_id), String(r.results_msg_id)]));

    const chrono2 = await matchesChrono(db);
    const tail = chrono2.filter((m) => m.playedAt >= guardianMs);
    const candidates = await resultsWebhookCandidates(db);

    console.log(`\nDeleting ${[...tail].filter((m) => msgByMatch.has(m.matchId)).length} existing tail posts…`);
    for (const m of tail) {
      const old = msgByMatch.get(m.matchId);
      if (!old) continue;
      for (const url of candidates) await deleteMessage(url, old);
      await clearMatchResultsMsg(db, m.matchId);
      console.log(`  deleted ${old} (${m.gameTypeName} / ${m.mapName ?? "?"})`);
      await sleep(500);
    }

    console.log(`\nReposting ${tail.length} tail games in order…`);
    for (const m of tail) {
      const report = toReport(m);
      const csr = matchCsrChanges(chrono2, m.matchId) ?? undefined;
      const win = matchWinChances(chrono2, m.matchId) ?? undefined;
      const id = await postCsrMatchResultWithControls(db, report, csr, win);
      if (id) {
        await setMatchResultsMsg(db, m.matchId, id);
        await setMatchResultsFmt(db, m.matchId, RESULTS_FMT_VERSION);
        console.log(`  posted ${m.gameTypeName} / ${m.mapName ?? "?"} → ${id}`);
      } else {
        console.warn(`  WARNING: no message id returned for ${m.gameTypeName} / ${m.mapName ?? "?"}`);
      }
      await sleep(600);
    }
  }

  try {
    await upsertCsrLeaderboard(config.discordLeaderboardWebhookUrl, db);
    console.log("\nLeaderboard refreshed.");
  } catch (e) {
    console.error("Leaderboard upsert failed:", (e as Error).message);
  }

  console.log("\nDone.");
}

const db = await openDb(config.dbUrl, config.dbAuthToken);
try {
  await main(db);
} catch (e) {
  console.error("\nFAILED:", (e as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
