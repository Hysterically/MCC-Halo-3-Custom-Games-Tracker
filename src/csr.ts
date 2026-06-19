/**
 * CSR (Competitive Skill Rank) — a Halo-5-style *display* of the TrueSkill 2
 * rating. The engine ranks on the conservative skill `mu - 3*sigma` (the paper's
 * recommended single ordered ranking); this module maps that single number onto
 * the familiar Halo 5 tier ladder so the leaderboard and per-match posts read
 * like the in-game rank. It changes nothing in the engine — it is purely a view.
 *
 * The tier STRUCTURE is Halo 5's (Bronze/Silver/Gold/Platinum/Diamond each split
 * into sub-ranks 1-6 of 50 CSR, then numeric Onyx at 1500+). The linear CSR scale
 * is a display choice: the TrueSkill 2 paper fixes the rating's scale only up to a
 * free constant, so `CSR_SCALE` is chosen so the strongest sustained players reach
 * Onyx. Keep these constants identical to the `trueskill 2/` sandbox so the
 * live ladder matches the tuned analysis there.
 */

export const CSR_SCALE = 63; // CSR = round(CSR_SCALE * (mu - 3*sigma)), floored at 0

const CSR_TIERS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"] as const;
const CSR_COLORS = ["#c07a44", "#cfd8df", "#f3c84a", "#56d3bf", "#82b8ff"] as const; // bronze..diamond
const ONYX_COLOR = "#b274ff";
const ONYX_THRESHOLD = 1500;

/**
 * Champion is NOT a tier — it's an accolade layered on top of Onyx, exactly as in
 * Halo Wars 2 / Halo 5: up to the top 3 players on a board (per playlist) who have also
 * cleared this CSR floor. It's awarded by leaderboard position, so it can't be
 * derived from a player's skill alone; the renderer applies it to the top 3 rows when the
 * player's CSR is at or above this floor. A champion is still Onyx-rated underneath.
 */
export const CHAMPION_THRESHOLD = 1600;
const CSR_PER_TIER = 300; // 6 sub-ranks * 50 CSR
const CSR_PER_SUB = 50;

export interface Csr {
  /** Numeric CSR (the raw display number). */
  value: number;
  /** Tier word, e.g. "Diamond" or "Onyx". */
  tier: string;
  /** Sub-rank 1..6, or null for Onyx (which has none). */
  sub: number | null;
  /** Tier label without the number, e.g. "Diamond 5" or "Onyx". */
  label: string;
  /** Tier colour (hex), for colour-coding the rank in PNGs. */
  color: string;
  /**
   * Emblem key — the assets/csr-<emblem>.png division logo for this exact rank.
   * Per sub-rank: "diamond-5", "gold-1", … ("onyx" has no sub-rank).
   */
  emblem: string;
  isOnyx: boolean;
}

/** Map a conservative-skill value (mu - 3*sigma) to its CSR display. */
export function csrFromSkill(skill: number): Csr {
  const value = Math.max(0, Math.round(skill * CSR_SCALE));
  if (value >= ONYX_THRESHOLD) {
    return { value, tier: "Onyx", sub: null, label: "Onyx", color: ONYX_COLOR, emblem: "onyx", isOnyx: true };
  }
  const tier = Math.min(CSR_TIERS.length - 1, Math.floor(value / CSR_PER_TIER));
  const sub = Math.floor((value % CSR_PER_TIER) / CSR_PER_SUB) + 1; // 1..6
  return {
    value,
    tier: CSR_TIERS[tier],
    sub,
    label: `${CSR_TIERS[tier]} ${sub}`,
    color: CSR_COLORS[tier],
    emblem: `${CSR_TIERS[tier].toLowerCase()}-${sub}`,
    isOnyx: false,
  };
}

/** "Diamond 5 1427" / "Onyx 1623" — the tier label followed by the raw number. */
export function csrText(c: Csr): string {
  return `${c.label} ${c.value}`;
}
