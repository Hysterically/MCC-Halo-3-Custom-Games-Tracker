/**
 * Classic ELO, team-average. Ratings are recomputed from scratch over the
 * full match history every time (deterministic, no drift, retunable).
 *
 * A "team" is the set of players sharing mTeamId; in FFA each player is a
 * team of one. Team rating = mean of member ratings. Each team is scored
 * pairwise against every other team (1 / 0.5 / 0 by finishing rank, where
 * a lower mStanding = better), the per-opponent ELO deltas are averaged,
 * and that single delta is applied to every member of the team. This
 * collapses to textbook 1v1 ELO for two teams and generalises cleanly to
 * N teams / FFA.
 */

import type { StoredMatch } from "./db.ts";
import { boardCategory } from "./category.ts";

export interface Rating {
  xuid: string;
  gamertag: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  kills: number;
  deaths: number;
}

export interface EloOptions {
  start: number;
  k: number;
}

const expected = (a: number, b: number): number => 1 / (1 + 10 ** ((b - a) / 400));

/**
 * Stable team key: the real mTeamId when teams are on, otherwise a unique
 * per-player id derived from the XUID so every FFA player is a team of one.
 */
function teamKey(m: StoredMatch, p: StoredMatch["players"][number]): number {
  return m.teamsEnabled ? p.teamId : Number(BigInt(p.xuid) % 2147483647n);
}

export function computeRatings(matches: StoredMatch[], opt: EloOptions): Rating[] {
  const table = new Map<string, Rating>();

  const ensure = (xuid: string, gamertag: string): Rating => {
    let r = table.get(xuid);
    if (!r) {
      r = {
        xuid,
        gamertag,
        rating: opt.start,
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        kills: 0,
        deaths: 0,
      };
      table.set(xuid, r);
    }
    r.gamertag = gamertag; // keep most-recent name
    return r;
  };

  for (const m of matches) {
    if (m.players.length < 2) continue;

    // Group players into teams.
    const teams = new Map<number, { xuids: string[]; rank: number; avg: number }>();
    for (const p of m.players) {
      const key = teamKey(m, p);
      const t = teams.get(key) ?? { xuids: [], rank: Infinity, avg: 0 };
      t.xuids.push(p.xuid);
      t.rank = Math.min(t.rank, p.standing);
      teams.set(key, t);
    }
    if (teams.size < 2) continue;

    for (const t of teams.values()) {
      t.avg =
        t.xuids.reduce((s, x) => s + ensure(x, name(m, x)).rating, 0) / t.xuids.length;
    }

    const bestRank = Math.min(...[...teams.values()].map((t) => t.rank));
    const winnersAtBest = [...teams.values()].filter((t) => t.rank === bestRank).length;

    const entries = [...teams.entries()];
    const delta = new Map<number, number>();

    for (let i = 0; i < entries.length; i++) {
      const [keyA, A] = entries[i];
      let sum = 0;
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        const B = entries[j];
        const s = A.rank < B[1].rank ? 1 : A.rank > B[1].rank ? 0 : 0.5;
        sum += s - expected(A.avg, B[1].avg);
      }
      delta.set(keyA, (opt.k * sum) / (entries.length - 1));
    }

    for (const [key, t] of teams) {
      const isWin = t.rank === bestRank && winnersAtBest === 1;
      const isDraw = t.rank === bestRank && winnersAtBest > 1;
      for (const xuid of t.xuids) {
        const r = ensure(xuid, name(m, xuid));
        r.rating += delta.get(key)!;
        r.games += 1;
        if (isWin) r.wins += 1;
        else if (isDraw) r.draws += 1;
        else r.losses += 1;
        const mp = m.players.find((p) => p.xuid === xuid)!;
        r.kills += mp.kills;
        r.deaths += mp.deaths;
      }
    }
  }

  return [...table.values()].sort((a, b) => b.rating - a.rating);
}

function name(m: StoredMatch, xuid: string): string {
  return m.players.find((p) => p.xuid === xuid)?.gamertag ?? xuid;
}

/** A player's post-match rating and the change this match produced. */
export interface EloChange {
  rating: number;
  delta: number;
}

/**
 * Per-player post-match rating + change (xuid -> EloChange) produced by one
 * specific match, computed against the same per-category history the
 * leaderboard uses: replay the match's category up to and including it, and
 * diff against the replay that stops just before it. Returns null for
 * off-format matches (they don't touch any board) or if the match isn't in
 * `matches`.
 */
export function matchEloChanges(
  matches: StoredMatch[],
  matchId: string,
  opt: EloOptions,
): Map<string, EloChange> | null {
  const idx = matches.findIndex((m) => m.matchId === matchId);
  if (idx === -1) return null;
  const match = matches[idx];
  const cat = boardCategory(match);
  if (cat === "other") return null;

  const hist = matches.slice(0, idx + 1).filter((m) => boardCategory(m) === cat);
  const before = new Map(
    computeRatings(hist.slice(0, -1), opt).map((r) => [r.xuid, r.rating]),
  );
  const after = new Map(computeRatings(hist, opt).map((r) => [r.xuid, r.rating]));

  const changes = new Map<string, EloChange>();
  for (const p of match.players) {
    const a = after.get(p.xuid);
    if (a === undefined) continue;
    changes.set(p.xuid, { rating: a, delta: a - (before.get(p.xuid) ?? opt.start) });
  }
  return changes;
}
