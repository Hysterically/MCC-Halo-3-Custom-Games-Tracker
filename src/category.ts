/**
 * How a match gets classified for leaderboard purposes.
 *
 *   "2v2"   — teams on, two teams of two human players.
 *   "4v4"   — teams on, two teams of exactly four human players.
 *   "ffa"   — teams off (Rumble Pit / Lone Wolves / any non-team custom).
 *   "other" — everything else (1v1, 3v3, asymmetric, 3+ teams, 5v5+). These
 *             matches are still recorded and posted to #game-results, they
 *             just don't contribute to any leaderboard.
 */

export type Category = "2v2" | "4v4" | "ffa" | "other";

/** Display name used in match summaries and section headers. */
export const CATEGORY_LABEL: Record<Category, string> = {
  "2v2": "2v2",
  "4v4": "4v4",
  ffa: "FFA",
  other: "—",
};

/** Categories that get a leaderboard section, in display order. */
export const BOARD_CATEGORIES: Category[] = ["2v2", "4v4", "ffa"];

/**
 * Order the per-category leaderboard messages are posted to Discord, top to
 * bottom. 4v4 goes LAST so it lands at the bottom of the channel — the newest /
 * most in-focus message. Same set as {@link BOARD_CATEGORIES}, reordered.
 */
export const LEADERBOARD_POST_ORDER: Category[] = ["2v2", "ffa", "4v4"];

/**
 * A game shorter than this (in seconds) didn't really happen — it was set up
 * and ended/aborted before a result (e.g. a 0-0 "no-contest" that lands as a
 * tie). Such games are still recorded and posted, but kept off every
 * leaderboard. Duration = the longest any player was in the game; matches
 * recorded before duration tracking existed have no duration and always count.
 */
export const MIN_LEADERBOARD_SECONDS = 60;

/** Structural shape both CarnageReport and StoredMatch satisfy. */
interface CategorisableMatch {
  teamsEnabled: boolean;
  players: { teamId: number; xuid: string }[];
  /** Longest secondsPlayed across players; undefined if not tracked. */
  durationSeconds?: number;
  /** Manually voided from the boards (kept recorded + posted, just off-format). */
  excluded?: boolean;
}

/**
 * Leaderboard classification: the structural {@link categorize}, except a game
 * shorter than `minSeconds` is forced to "other" so aborted / no-contest games
 * never reach a board. A game explicitly flagged `excluded` is likewise forced
 * to "other" — the manual lever for voiding a game from every board while
 * keeping its #game-results post. This is the categorizer every board and
 * per-player stat goes through; {@link categorize} stays the pure structural one.
 */
export function boardCategory(
  m: CategorisableMatch,
  minSeconds = MIN_LEADERBOARD_SECONDS,
): Category {
  if (m.excluded) return "other";
  if (m.durationSeconds != null && m.durationSeconds < minSeconds) return "other";
  return categorize(m);
}

export function categorize(m: CategorisableMatch): Category {
  // Guests / bots have no XUID and aren't rateable — ignore them when
  // shaping the match so e.g. a 2v2-with-a-guest still classifies as 2v2.
  const real = m.players.filter((p) => p.xuid);
  if (!m.teamsEnabled) return real.length >= 2 ? "ffa" : "other";

  const sizes = new Map<number, number>();
  for (const p of real) {
    if (p.teamId < 0) continue;
    sizes.set(p.teamId, (sizes.get(p.teamId) ?? 0) + 1);
  }
  const counts = [...sizes.values()];
  if (counts.length !== 2 || counts[0] !== counts[1]) return "other";
  if (counts[0] === 2) return "2v2";
  if (counts[0] === 4) return "4v4";
  return "other";
}
