/**
 * TrueSkill 2 — the production rating engine (the Bayesian ladder that runs
 * alongside ELO). This is the promoted, DB-reading port of the `trueskill 2/`
 * analysis sandbox; the factor-graph math is carried over VERBATIM so the live
 * ladder matches the tuned analysis there.
 *
 * On top of classic TrueSkill's team win/loss ordering it folds in each player's
 * individual per-match statistics as noisy readouts of their performance
 * (paper §8, eq. 9): kills (+) and deaths (-), at a single fixed K/D spread
 * (PERF_SPREAD). Plus a small decaying experience bias on the mean (paper §7,
 * eq. 8). It does NOT use the objective-score signal — that's the separate
 * "TrueSkill 2 + OBJ" variant; this is plain TrueSkill 2 (win/loss + K/D only).
 *
 * Ratings are recomputed from full match history (like ELO) — nothing is stored,
 * so the ladder is deterministic and retunable. The displayed rank is the
 * conservative skill `mu - 3*sigma`, mapped to CSR by ./csr.ts.
 */

import type { StoredMatch } from "./db.ts";
import { boardCategory } from "./category.ts";
import { csrFromSkill, type Csr } from "./csr.ts";

// ---------------------------------------------------------------------------
// TrueSkill parameters. The skill-class constants (mu0, sigma0, beta, draw)
// match ../src/mmr.ts / the sandbox so all the ladders are directly comparable;
// the rest are the TS2-specific additions. Mirrored in cpp/.
// ---------------------------------------------------------------------------
const MU0 = 25; // prior mean skill
const SIGMA0 = 25 / 3; // prior std-dev (~8.333)
const BETA = SIGMA0 / 2; // performance noise — "skill class width"
const TAU = SIGMA0 / 100; // constant per-match skill-drift variance (paper's gamma)
const DRAW_PROB = 0.1; // assumed probability of a draw
const SIGMA_MIN = 1.0; // operational floor on uncertainty (NOT from the paper)

/** Seed conservative skill of a brand-new (unrated) player: mu0 - 3*sigma0 = 0. */
export const SEED_SKILL = MU0 - 3 * SIGMA0;

// TS2 EXPERIENCE EFFECT — paper §7, eq. (8). A small, positive, decaying
// increment is added to a player's skill mean after each match: a biased random
// walk, so players drift upward fastest in their first games. The paper learns a
// 200-long array from data; lacking that, we approximate with a decaying
// exponential, capped at 200 games exactly as the paper does.
const EXP_OFFSET_MAX = 0.15; // upward bias applied on a brand-new player's first match
const EXP_OFFSET_SCALE = 8; // games for the bias to fall ~1/e
const EXP_CAP = 200; // paper caps experience at 200

// TS2 INDIVIDUAL STATISTICS — paper §8, eq. (9). Kills and deaths are noisy
// linear readouts of performance (kills weight w_p>0, deaths w_p<0). We z-score
// each within the lobby and map onto the rating scale at a single fixed spread
// (the paper fits per-mode weights; with <1000 matches it says to use fixed
// params). PERF_SPREAD is rating-points per std-dev; OBS_BETA is observation
// noise. (Plain TrueSkill 2 uses one K/D spread for every mode and no objective
// signal — the per-mode / objective weighting is the separate "+ OBJ" variant.)
const PERF_SPREAD = BETA; // ~4.17 rating pts per K/D std-dev (all modes)
const OBS_BETA = 2 * BETA; // ~8.33 — performance-observation noise

function experienceOffset(games: number): number {
  return EXP_OFFSET_MAX * Math.exp(-Math.min(games, EXP_CAP) / EXP_OFFSET_SCALE);
}

// ---------------------------------------------------------------------------
// Normal distribution helpers (pdf / cdf / inverse-cdf).
// ---------------------------------------------------------------------------
const SQRT2 = Math.sqrt(2);
const SQRT2PI = Math.sqrt(2 * Math.PI);

function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

// erf via Abramowitz & Stegun 7.1.26 (good to ~1e-7).
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function cdf(x: number): number {
  return 0.5 * (1 + erf(x / SQRT2));
}

// Inverse CDF (Acklam's rational approximation).
function ppf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// Truncated-Gaussian correction terms (the "surprise" of the outcome).
function vWin(diff: number, margin: number): number {
  const x = diff - margin;
  const denom = cdf(x);
  return denom > 2.222758749e-162 ? pdf(x) / denom : -x;
}
function wWin(diff: number, margin: number): number {
  const x = diff - margin;
  const denom = cdf(x);
  if (denom < 2.222758749e-162) return diff - margin < 0 ? 1 : 0;
  const v = vWin(diff, margin);
  return v * (v + x);
}
function vDraw(diff: number, margin: number): number {
  const ad = Math.abs(diff);
  const a = margin - ad;
  const b = -margin - ad;
  const denom = cdf(a) - cdf(b);
  const numer = pdf(b) - pdf(a);
  const v = Math.abs(denom) > 2.222758749e-162 ? numer / denom : a;
  return diff < 0 ? -v : v;
}
function wDraw(diff: number, margin: number): number {
  const ad = Math.abs(diff);
  const a = margin - ad;
  const b = -margin - ad;
  const denom = cdf(a) - cdf(b);
  if (Math.abs(denom) < 2.222758749e-162) return 1;
  const v = vDraw(ad, margin);
  return v * v + (a * pdf(a) - b * pdf(b)) / denom;
}

// ---------------------------------------------------------------------------
// Gaussian in (precision, precision-mean) form.
//   pi  = 1 / sigma^2          tau = mu / sigma^2
// ---------------------------------------------------------------------------
class Gaussian {
  constructor(public pi = 0, public tau = 0) {}
  static fromMuSigma(mu: number, sigma: number): Gaussian {
    const pi = 1 / (sigma * sigma);
    return new Gaussian(pi, pi * mu);
  }
  get mu(): number {
    return this.pi === 0 ? 0 : this.tau / this.pi;
  }
  get sigma(): number {
    return this.pi === 0 ? Infinity : Math.sqrt(1 / this.pi);
  }
  mul(o: Gaussian): Gaussian {
    return new Gaussian(this.pi + o.pi, this.tau + o.tau);
  }
  div(o: Gaussian): Gaussian {
    return new Gaussian(this.pi - o.pi, this.tau - o.tau);
  }
}

function delta(a: Gaussian, b: Gaussian): number {
  const piDelta = Math.abs(a.pi - b.pi);
  if (piDelta === Infinity) return 0;
  return Math.max(Math.abs(a.tau - b.tau), Math.sqrt(piDelta));
}

// A variable node: a Gaussian plus the message each adjacent factor last sent.
class Variable extends Gaussian {
  messages = new Map<object, Gaussian>();
  setValue(val: Gaussian): number {
    const d = delta(this, val);
    this.pi = val.pi;
    this.tau = val.tau;
    return d;
  }
  updateMessage(factor: object, msg: Gaussian): number {
    const old = this.messages.get(factor)!;
    this.messages.set(factor, msg);
    return this.setValue(this.div(old).mul(msg));
  }
  updateValue(factor: object, val: Gaussian): number {
    const old = this.messages.get(factor)!;
    this.messages.set(factor, val.mul(old).div(this));
    return this.setValue(val);
  }
}

// ---------------------------------------------------------------------------
// The TrueSkill 2 `rate` routine. Same factor graph as TS1, plus zero or more
// individual-statistic observations on each player's perf variable. `groups`
// and `obs` are parallel nested arrays (team -> member); each member carries a
// list of observation means (one per stat that had a usable signal this match).
// ---------------------------------------------------------------------------
interface RG {
  mu: number;
  sigma: number;
}

function rate(groups: RG[][], ranks: number[], obs: number[][][]): RG[][] {
  // Sort groups by rank (ascending = best first), remembering original order.
  const order = ranks.map((_, i) => i).sort((x, y) => ranks[x] - ranks[y]);
  const sortedGroups = order.map((i) => groups[i]);
  const sortedRanks = order.map((i) => ranks[i]);
  const flatObs = order.flatMap((i) => obs[i]);

  const flat = sortedGroups.flat();
  const T = sortedGroups.length;

  // Layer 1: skill / perf / team variables.
  const skill = flat.map(() => new Variable());
  const perf = flat.map(() => new Variable());
  const teamPerf = sortedGroups.map(() => new Variable());
  const teamDiff = Array.from({ length: T - 1 }, () => new Variable());

  // Prior factors: skill ~ N(mu, sigma^2 + tau^2) — the per-match drift bump.
  const priorFactors = flat.map((r, i) => {
    const f = {};
    skill[i].messages.set(f, new Gaussian());
    return { f, i, val: Gaussian.fromMuSigma(r.mu, Math.sqrt(r.sigma * r.sigma + TAU * TAU)) };
  });

  // Likelihood factors: perf = skill + N(0, beta^2).
  const beta2 = BETA * BETA;
  const likeFactors = flat.map((_, i) => {
    const f = {};
    skill[i].messages.set(f, new Gaussian());
    perf[i].messages.set(f, new Gaussian());
    return { f, i };
  });

  // TS2 performance-observation factors: each observed stat is obs ~ N(perf_i,
  // OBS_BETA^2). Leaf factors with fixed values, so they send their message once.
  const obsFactors: { f: object; i: number; val: number }[] = [];
  flat.forEach((_, i) => {
    for (const val of flatObs[i]) {
      const f = {};
      perf[i].messages.set(f, new Gaussian());
      obsFactors.push({ f, i, val });
    }
  });

  // Team-perf sum factors: teamPerf = sum of member perfs.
  let cursor = 0;
  const teamFactors = sortedGroups.map((g, t) => {
    const f = {};
    const idxs = g.map(() => cursor++);
    teamPerf[t].messages.set(f, new Gaussian());
    for (const i of idxs) perf[i].messages.set(f, new Gaussian());
    return { f, t, idxs };
  });

  // Team-diff sum factors + truncation factors (the ordering constraints).
  const diffFactors = teamDiff.map((_, k) => {
    const f = {};
    teamPerf[k].messages.set(f, new Gaussian());
    teamPerf[k + 1].messages.set(f, new Gaussian());
    teamDiff[k].messages.set(f, new Gaussian());
    return { f, k };
  });
  const truncFactors = teamDiff.map((_, k) => {
    const f = {};
    teamDiff[k].messages.set(f, new Gaussian());
    const sizeSum = sortedGroups[k].length + sortedGroups[k + 1].length;
    const margin = ppf((DRAW_PROB + 1) / 2) * Math.sqrt(sizeSum) * BETA;
    const drawn = sortedRanks[k] === sortedRanks[k + 1];
    return { f, k, margin, drawn };
  });

  // --- message passing ---
  // Down: priors -> skill.
  for (const p of priorFactors) skill[p.i].updateValue(p.f, p.val);
  // Down: skill -> perf.
  for (const l of likeFactors) {
    const msg = skill[l.i].div(skill[l.i].messages.get(l.f)!);
    const a = 1 / (1 + beta2 * msg.pi);
    perf[l.i].updateMessage(l.f, new Gaussian(a * msg.pi, a * msg.tau));
  }
  // TS2 — Down: individual-statistic observations -> perf (before the team sum,
  // so each player's kills/deaths/obj inform the team comparison).
  for (const o of obsFactors) {
    perf[o.i].updateMessage(o.f, Gaussian.fromMuSigma(o.val, OBS_BETA));
  }
  // Down: perf -> teamPerf.
  for (const tf of teamFactors) sumDown(teamPerf[tf.t], tf.f, tf.idxs.map((i) => perf[i]), tf.idxs.map(() => 1));

  // Iterate the diff/trunc chain to convergence.
  const iters = T <= 2 ? 1 : 20;
  for (let it = 0; it < iters; it++) {
    let d = 0;
    if (T - 1 === 1) {
      sumDown(teamDiff[0], diffFactors[0].f, [teamPerf[0], teamPerf[1]], [1, -1]);
      d = truncUp(truncFactors[0], teamDiff[0]);
    } else {
      for (let k = 0; k < T - 2; k++) {
        sumDown(teamDiff[k], diffFactors[k].f, [teamPerf[k], teamPerf[k + 1]], [1, -1]);
        d = Math.max(d, truncUp(truncFactors[k], teamDiff[k]));
        sumUp(diffFactors[k].f, teamDiff[k], [teamPerf[k], teamPerf[k + 1]], [1, -1], 1);
      }
      for (let k = T - 2; k > 0; k--) {
        sumDown(teamDiff[k], diffFactors[k].f, [teamPerf[k], teamPerf[k + 1]], [1, -1]);
        d = Math.max(d, truncUp(truncFactors[k], teamDiff[k]));
        sumUp(diffFactors[k].f, teamDiff[k], [teamPerf[k], teamPerf[k + 1]], [1, -1], 0);
      }
    }
    if (d <= 1e-4) break;
  }

  // Up: teamDiff -> teamPerf (the two ends of the chain).
  sumUp(diffFactors[0].f, teamDiff[0], [teamPerf[0], teamPerf[1]], [1, -1], 0);
  sumUp(diffFactors[T - 2].f, teamDiff[T - 2], [teamPerf[T - 2], teamPerf[T - 1]], [1, -1], 1);

  // Up: teamPerf -> perf.
  for (const tf of teamFactors) {
    const members = tf.idxs.map((i) => perf[i]);
    for (let m = 0; m < tf.idxs.length; m++) {
      sumUpTeam(tf.f, teamPerf[tf.t], members, m);
    }
  }
  // Up: perf -> skill.
  for (const l of likeFactors) {
    const msg = perf[l.i].div(perf[l.i].messages.get(l.f)!);
    const a = 1 / (1 + beta2 * msg.pi);
    skill[l.i].updateMessage(l.f, new Gaussian(a * msg.pi, a * msg.tau));
  }

  // Read out updated skills, un-sort back to caller order.
  const out: RG[][] = groups.map((g) => g.map(() => ({ mu: 0, sigma: 0 })));
  let fi = 0;
  order.forEach((origGroupIdx, sortedGroupIdx) => {
    sortedGroups[sortedGroupIdx].forEach((_, memberIdx) => {
      const s = skill[fi++];
      out[origGroupIdx][memberIdx] = { mu: s.mu, sigma: s.sigma };
    });
  });
  return out;
}

// SumFactor down: sumVar = Σ coeff_i * term_i.
function sumDown(sumVar: Variable, f: object, terms: Variable[], coeffs: number[]): number {
  return sumUpdate(sumVar, f, terms, coeffs);
}
// SumFactor up to a chosen term (rearrange the equation for that term).
function sumUp(f: object, sumVar: Variable, terms: Variable[], coeffs: number[], index: number): number {
  const c = coeffs[index];
  const newCoeffs = coeffs.map((cc, x) => (x === index ? 1 / c : -cc / c));
  const vals = terms.slice();
  vals[index] = sumVar;
  return sumUpdate(terms[index], f, vals, newCoeffs);
}
function sumUpTeam(f: object, teamPerf: Variable, members: Variable[], index: number): number {
  // teamPerf = Σ member; solve for member[index].
  const coeffs = members.map((_, x) => (x === index ? 1 : -1));
  const vals = members.slice();
  vals[index] = teamPerf;
  return sumUpdate(members[index], f, vals, coeffs);
}
function sumUpdate(target: Variable, f: object, vals: Variable[], coeffs: number[]): number {
  let piInv = 0;
  let mu = 0;
  for (let i = 0; i < vals.length; i++) {
    const div = vals[i].div(vals[i].messages.get(f)!);
    mu += coeffs[i] * div.mu;
    if (piInv === Infinity) continue;
    piInv = div.pi === 0 ? Infinity : piInv + (coeffs[i] * coeffs[i]) / div.pi;
  }
  const pi = 1 / piInv;
  return target.updateMessage(f, new Gaussian(pi, pi * mu));
}

// TruncateFactor up: apply the win/draw ordering to the team-difference var.
function truncUp(tf: { f: object; margin: number; drawn: boolean }, teamDiff: Variable): number {
  const div = teamDiff.div(teamDiff.messages.get(tf.f)!);
  const sqrtPi = Math.sqrt(div.pi);
  const dOverSqrt = div.tau / sqrtPi;
  const marginScaled = tf.margin * sqrtPi;
  const v = tf.drawn ? vDraw(dOverSqrt, marginScaled) : vWin(dOverSqrt, marginScaled);
  const w = tf.drawn ? wDraw(dOverSqrt, marginScaled) : wWin(dOverSqrt, marginScaled);
  const denom = 1 - w;
  const pi = div.pi / denom;
  const tau = (div.tau + sqrtPi * v) / denom;
  return teamDiff.updateValue(tf.f, new Gaussian(pi, tau));
}

// ---------------------------------------------------------------------------
// Replay one category's history through TrueSkill 2.
// ---------------------------------------------------------------------------
export interface MMR {
  xuid: string;
  gamertag: string;
  mu: number;
  sigma: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  kills: number;
  deaths: number;
  /** Conservative skill mu - 3*sigma — what the ladder ranks on. */
  skill: number;
  /** Highest `skill` this player ever held (peak / lifetime-best CSR). */
  peakSkill: number;
}

function teamKey(m: StoredMatch, p: StoredMatch["players"][number]): number {
  return m.teamsEnabled ? p.teamId : Number(BigInt(p.xuid) % 2147483647n);
}

/**
 * Replay `matches` (one leaderboard category's history, oldest first) through the
 * engine and return each player's rating. `initial` optionally seeds the table so
 * a caller can rate from a known ladder.
 */
export function rateCategory(
  matches: StoredMatch[],
  opts: { initial?: Map<string, MMR> } = {},
): MMR[] {
  const table = new Map<string, MMR>();
  if (opts.initial) for (const [k, v] of opts.initial) table.set(k, { ...v });
  const ensure = (xuid: string, gt: string): MMR => {
    let r = table.get(xuid);
    if (!r) {
      r = {
        xuid, gamertag: gt, mu: MU0, sigma: SIGMA0,
        games: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0,
        skill: SEED_SKILL, peakSkill: SEED_SKILL,
      };
      table.set(xuid, r);
    }
    r.gamertag = gt;
    return r;
  };

  for (const m of matches) {
    const rated = m.players.filter((p) => p.xuid);
    if (rated.length < 2) continue;

    // Group into teams (teamId, or one team per player in FFA).
    const teams = new Map<number, { players: StoredMatch["players"]; rank: number }>();
    for (const p of rated) {
      const key = teamKey(m, p);
      const t = teams.get(key) ?? { players: [], rank: Infinity };
      t.players.push(p);
      t.rank = Math.min(t.rank, p.standing);
      teams.set(key, t);
    }
    if (teams.size < 2) continue;

    // TS2 individual-statistics signal (eq. 9): z-score each player's kills and
    // deaths across the lobby and place them on the rating scale around the
    // lobby's mean skill, at the fixed PERF_SPREAD. The lobby z-score stands in
    // for eq. (9)'s explicit opponent term (see sandbox README). No objective
    // signal — this is plain TrueSkill 2.
    const meanMu = rated.reduce((a, p) => a + ensure(p.xuid, p.gamertag).mu, 0) / rated.length;
    const zScores = (vals: number[]): number[] | null => {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      return sd < 1e-9 ? null : vals.map((v) => (v - mean) / sd);
    };
    const idxOf = new Map(rated.map((p, i) => [p.xuid, i]));
    const killZ = zScores(rated.map((p) => p.kills ?? 0));
    const deathZ = zScores(rated.map((p) => p.deaths ?? 0));
    const obsFor = (p: StoredMatch["players"][number]): number[] => {
      const i = idxOf.get(p.xuid)!;
      const out: number[] = [];
      if (killZ) out.push(meanMu + killZ[i] * PERF_SPREAD); // kills: w_p > 0
      if (deathZ) out.push(meanMu - deathZ[i] * PERF_SPREAD); // deaths: w_p < 0
      return out;
    };

    const teamArr = [...teams.values()];
    const groups: RG[][] = [];
    const obs: number[][][] = [];
    for (const t of teamArr) {
      const g: RG[] = [];
      const og: number[][] = [];
      for (const p of t.players) {
        const r = ensure(p.xuid, p.gamertag);
        g.push({ mu: r.mu, sigma: r.sigma });
        og.push(obsFor(p));
      }
      groups.push(g);
      obs.push(og);
    }
    const ranks = teamArr.map((t) => t.rank);

    const updated = rate(groups, ranks, obs);

    const bestRank = Math.min(...ranks);
    const winners = ranks.filter((r) => r === bestRank).length;
    teamArr.forEach((t, ti) => {
      const isSoleWin = t.rank === bestRank && winners === 1;
      const isDraw = t.rank === bestRank && winners > 1;
      t.players.forEach((p, pi) => {
        const r = ensure(p.xuid, p.gamertag);
        // TS2 experience bias (eq. 8): positive, decaying increment on the mean,
        // keyed on games played *before* this match.
        r.mu = updated[ti][pi].mu + experienceOffset(r.games);
        r.sigma = Math.max(SIGMA_MIN, updated[ti][pi].sigma);
        r.skill = r.mu - 3 * r.sigma;
        r.peakSkill = Math.max(r.peakSkill, r.skill);
        r.games += 1;
        if (isSoleWin) r.wins += 1;
        else if (isDraw) r.draws += 1;
        else r.losses += 1;
        r.kills += p.kills ?? 0;
        r.deaths += p.deaths ?? 0;
      });
    });
  }

  return [...table.values()];
}

// ---------------------------------------------------------------------------
// Per-match CSR change (the analog of elo.ts' matchEloChanges).
// ---------------------------------------------------------------------------

/** Pre-match win-probability + average CSR for one team in a 2-team matchup. */
export interface TeamWinChance {
  teamId: number;
  /** Mean of the team's rated players' pre-match CSR (rounded). */
  avgCsr: number;
  /** Pre-match probability this team wins (the two teams sum to ~1). */
  winProb: number;
}

/** The two teams of a rated 2-team match, for the result-post win bar. */
export interface MatchWinChances {
  teams: [TeamWinChance, TeamWinChance];
}

/** A player's post-match CSR and the change (in CSR points) this match produced. */
export interface CsrChange {
  /** Conservative skill mu - 3*sigma after this match. */
  skill: number;
  /** CSR display after this match. */
  csr: Csr;
  /** Change in CSR value this match produced (post - pre). */
  delta: number;
}

/**
 * Per-player post-match CSR + change (xuid -> CsrChange) produced by one specific
 * match, computed against the same per-category history the leaderboard uses:
 * replay the match's category up to and including it, and diff CSR against the
 * replay that stops just before it. Returns null for off-format matches or if the
 * match isn't in `matches`. A brand-new player's pre-match CSR is the seed (0).
 */
export function matchCsrChanges(
  matches: StoredMatch[],
  matchId: string,
): Map<string, CsrChange> | null {
  const idx = matches.findIndex((m) => m.matchId === matchId);
  if (idx === -1) return null;
  const match = matches[idx];
  const cat = boardCategory(match);
  if (cat === "other") return null;

  const hist = matches.slice(0, idx + 1).filter((m) => boardCategory(m) === cat);
  const before = new Map(rateCategory(hist.slice(0, -1)).map((r) => [r.xuid, r.skill]));
  const after = new Map(rateCategory(hist).map((r) => [r.xuid, r.skill]));

  const changes = new Map<string, CsrChange>();
  for (const p of match.players) {
    const a = after.get(p.xuid);
    if (a === undefined) continue;
    const b = before.get(p.xuid) ?? SEED_SKILL;
    const csrAfter = csrFromSkill(a);
    const csrBefore = csrFromSkill(b);
    changes.set(p.xuid, { skill: a, csr: csrAfter, delta: csrAfter.value - csrBefore.value });
  }
  return changes;
}

/**
 * Pre-match win probability + average CSR for each team of a rated 2-team match,
 * for the result-post win bar. Computed from the ratings *before* this match (the
 * same pre-replay `matchCsrChanges` diffs against), using the TrueSkill team
 * performance model: `teamMu = Σ μ`, `teamVar = Σ (σ² + β²)`, and
 * `P(A) = Φ((teamMuA − teamMuB) / √(varA + varB))`. The team listed first is the
 * winner (so the bar's left side matches the board's winner-first ordering).
 *
 * Returns null unless the match is on-format, has teams, and groups into exactly
 * two teams that each have at least one rated player.
 */
export function matchWinChances(
  matches: StoredMatch[],
  matchId: string,
): MatchWinChances | null {
  const idx = matches.findIndex((m) => m.matchId === matchId);
  if (idx === -1) return null;
  const match = matches[idx];
  if (!match.teamsEnabled) return null;
  const cat = boardCategory(match);
  if (cat === "other") return null;

  const hist = matches.slice(0, idx + 1).filter((m) => boardCategory(m) === cat);
  const pre = new Map(rateCategory(hist.slice(0, -1)).map((r) => [r.xuid, r]));

  interface Agg {
    teamId: number;
    mu: number;
    variance: number;
    csrSum: number;
    n: number;
  }
  const teams = new Map<number, Agg>();
  for (const p of match.players) {
    if (!p.xuid) continue; // unrated guest — not part of the team rating
    const r = pre.get(p.xuid);
    const mu = r?.mu ?? MU0;
    const sigma = r?.sigma ?? SIGMA0;
    const t = teams.get(p.teamId) ?? { teamId: p.teamId, mu: 0, variance: 0, csrSum: 0, n: 0 };
    t.mu += mu;
    t.variance += sigma * sigma + BETA * BETA;
    t.csrSum += csrFromSkill(mu - 3 * sigma).value;
    t.n += 1;
    teams.set(p.teamId, t);
  }
  if (teams.size !== 2) return null;

  // Winner first so the bar's left segment matches the board's row ordering.
  const [A, B] = [...teams.values()].sort((x, y) => {
    if (match.winningTeamId != null) {
      if (x.teamId === match.winningTeamId) return -1;
      if (y.teamId === match.winningTeamId) return 1;
    }
    return x.teamId - y.teamId;
  });
  const probA = cdf((A.mu - B.mu) / Math.sqrt(A.variance + B.variance));
  return {
    teams: [
      { teamId: A.teamId, avgCsr: Math.round(A.csrSum / A.n), winProb: probA },
      { teamId: B.teamId, avgCsr: Math.round(B.csrSum / B.n), winProb: 1 - probA },
    ],
  };
}
