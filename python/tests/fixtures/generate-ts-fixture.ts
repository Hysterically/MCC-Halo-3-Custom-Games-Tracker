/**
 * Generates ts_parity.json: synthetic match histories run through the
 * PRODUCTION TypeScript engine (src/trueskill2.ts rateCategory), so the Python
 * engine can be cross-checked number-for-number against it.
 *
 * Regenerate (from the repo root) after intentional engine changes:
 *   npx tsx python/tests/fixtures/generate-ts-fixture.ts
 *
 * All players get identical kills and identical deaths in every match: the TS
 * engine z-scores stats across the lobby and skips the observation when the
 * spread is zero, so these histories exercise the shared classic core
 * (win/loss/draw orderings + experience offsets + drift + sigma floor) that
 * both engines must agree on exactly. The Python engine's eq-(9) count model
 * is deliberately different from the TS z-score approximation, so histories
 * with varying counts would not (and should not) match.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rateCategory } from "../../../src/trueskill2.ts";
import type { StoredMatch } from "../../../src/db.ts";

// Small deterministic LCG so the fixture is reproducible.
let seed = 123456789;
function rand(): number {
  seed = (1103515245 * seed + 12345) % 2147483648;
  return seed / 2147483648;
}

const XUIDS = Array.from({ length: 8 }, (_, i) => String(2533274800000000 + i * 7919));

function player(xuid: string, teamId: number, standing: number) {
  return { xuid, gamertag: `Player${XUIDS.indexOf(xuid)}`, teamId, standing, score: 25, kills: 10, deaths: 10, assists: 3 };
}

function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const matches: StoredMatch[] = [];
let t = 1700000000000;

// 10 4v4 matches with random splits and outcomes, including one draw.
for (let k = 0; k < 10; k++) {
  const ids = shuffled(XUIDS);
  const drawn = k === 4;
  const teamAWins = rand() < 0.5;
  const [sA, sB] = drawn ? [1, 1] : teamAWins ? [1, 2] : [2, 1];
  matches.push({
    matchId: `fixture-4v4-${k}`,
    gameTypeName: "Slayer",
    teamsEnabled: true,
    playedAt: (t += 3_600_000),
    winningTeamId: drawn ? null : teamAWins ? 0 : 1,
    durationSeconds: 600,
    excluded: false,
    players: [
      ...ids.slice(0, 4).map((x) => player(x, 0, sA)),
      ...ids.slice(4, 8).map((x) => player(x, 1, sB)),
    ],
  });
}

// One 3-team match (2v2v2) to exercise the multi-team ordering chain.
{
  const ids = shuffled(XUIDS).slice(0, 6);
  matches.push({
    matchId: "fixture-3team",
    gameTypeName: "Slayer",
    teamsEnabled: true,
    playedAt: (t += 3_600_000),
    winningTeamId: 2,
    durationSeconds: 600,
    excluded: false,
    players: [
      player(ids[0], 2, 1), player(ids[1], 2, 1),
      player(ids[2], 0, 2), player(ids[3], 0, 2),
      player(ids[4], 1, 3), player(ids[5], 1, 3),
    ],
  });
}

// One 6-player FFA (teams off), a strict ordering.
{
  const ids = shuffled(XUIDS).slice(0, 6);
  matches.push({
    matchId: "fixture-ffa",
    gameTypeName: "Rumble Pit",
    teamsEnabled: false,
    playedAt: (t += 3_600_000),
    winningTeamId: null,
    durationSeconds: 480,
    excluded: false,
    players: ids.map((x, i) => player(x, -1, i + 1)),
  });
}

const ratings = rateCategory(matches);
const expected = Object.fromEntries(
  ratings.map((r) => [r.xuid, { mu: r.mu, sigma: r.sigma, games: r.games, wins: r.wins, losses: r.losses, draws: r.draws }]),
);

const out = { matches, expected };
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, "ts_parity.json"), JSON.stringify(out, null, 2));
console.log(`wrote ts_parity.json: ${matches.length} matches, ${ratings.length} rated players`);
