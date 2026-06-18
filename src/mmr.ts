/**
 * ONE-OFF ANALYSIS — NOT part of the shipped tracker.
 *
 * Re-rates the entire match history with TrueSkill (the Bayesian factor-graph
 * model behind Halo's MMR) instead of ELO, and prints an MMR table per
 * leaderboard category. Read-only: opens the same DB the app uses, computes,
 * prints. Touches no schema, writes nothing, posts nothing.
 *
 *   npx tsx src/mmr.ts            # all categories
 *   npx tsx src/mmr.ts 2v2        # one category
 *
 * Each player carries a skill belief N(mu, sigma^2): mu = best guess, sigma =
 * uncertainty. The displayed MMR is the conservative estimate mu - 3*sigma
 * (what TrueSkill ranks on — it rises as the system grows confident in you).
 * This is a faithful port of the standard TrueSkill team/ranked update
 * (Herbrich-Minka-Graepel 2007), the same math the `trueskill` library uses.
 */

import { pathToFileURL } from "node:url";
import { config } from "./config.ts";
import { openDb, matchesChrono, type StoredMatch } from "./db.ts";
import { boardCategory, type Category, BOARD_CATEGORIES, CATEGORY_LABEL } from "./category.ts";
import { displayName } from "./aliases.ts";

// ---------------------------------------------------------------------------
// TrueSkill parameters (canonical defaults).
// ---------------------------------------------------------------------------
const MU0 = 25; // prior mean skill
const SIGMA0 = 25 / 3; // prior std-dev (~8.333)
const BETA = SIGMA0 / 2; // performance noise — "skill class width"
const TAU = SIGMA0 / 100; // dynamics — skill drift added each game
const DRAW_PROB = 0.1; // assumed probability of a draw

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
// Gaussian in (precision, precision-mean) form — the natural form for the
// message passing that drives the factor graph.
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
// The TrueSkill `rate` routine: takes rating groups (teams) and their ranks
// (lower = better; equal = draw) and returns updated [mu, sigma] per player.
// ---------------------------------------------------------------------------
interface RG {
  mu: number;
  sigma: number;
}

function rate(groups: RG[][], ranks: number[]): RG[][] {
  // Sort groups by rank (ascending = best first), remembering original order.
  const order = ranks.map((_, i) => i).sort((x, y) => ranks[x] - ranks[y]);
  const sortedGroups = order.map((i) => groups[i]);
  const sortedRanks = order.map((i) => ranks[i]);

  const flat = sortedGroups.flat();
  const n = flat.length;
  const T = sortedGroups.length;

  // Layer 1: skill variables (with dynamics added to the prior).
  const skill = flat.map((r) => new Variable());
  const perf = flat.map(() => new Variable());
  const teamPerf = sortedGroups.map(() => new Variable());
  const teamDiff = Array.from({ length: T - 1 }, () => new Variable());

  // Prior factors: skill ~ N(mu, sigma^2 + tau^2).
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
// Replay one category's history through TrueSkill.
// ---------------------------------------------------------------------------
export interface MMR {
  xuid: string;
  gamertag: string;
  mu: number;
  sigma: number;
  games: number;
  wins: number;
}

function teamKey(m: StoredMatch, p: StoredMatch["players"][number]): number {
  return m.teamsEnabled ? p.teamId : Number(BigInt(p.xuid) % 2147483647n);
}

export function rateCategory(matches: StoredMatch[]): MMR[] {
  const table = new Map<string, MMR>();
  const ensure = (xuid: string, gt: string): MMR => {
    let r = table.get(xuid);
    if (!r) {
      r = { xuid, gamertag: gt, mu: MU0, sigma: SIGMA0, games: 0, wins: 0 };
      table.set(xuid, r);
    }
    r.gamertag = gt;
    return r;
  };

  for (const m of matches) {
    if (m.players.length < 2) continue;
    // Group into teams (teamId, or one team per player in FFA).
    const teams = new Map<number, { players: StoredMatch["players"]; rank: number }>();
    for (const p of m.players) {
      const key = teamKey(m, p);
      const t = teams.get(key) ?? { players: [], rank: Infinity };
      t.players.push(p);
      t.rank = Math.min(t.rank, p.standing);
      teams.set(key, t);
    }
    if (teams.size < 2) continue;

    const teamArr = [...teams.values()];
    const groups: RG[][] = teamArr.map((t) =>
      t.players.map((p) => {
        const r = ensure(p.xuid, p.gamertag);
        return { mu: r.mu, sigma: r.sigma };
      }),
    );
    const ranks = teamArr.map((t) => t.rank);

    const updated = rate(groups, ranks);

    const bestRank = Math.min(...ranks);
    const winners = ranks.filter((r) => r === bestRank).length;
    teamArr.forEach((t, ti) => {
      const isSoleWin = t.rank === bestRank && winners === 1;
      t.players.forEach((p, pi) => {
        const r = ensure(p.xuid, p.gamertag);
        r.mu = updated[ti][pi].mu;
        r.sigma = updated[ti][pi].sigma;
        r.games += 1;
        if (isSoleWin) r.wins += 1;
      });
    });
  }

  return [...table.values()];
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const arg = process.argv[2]?.toLowerCase();
  const wanted: Category[] = arg
    ? (BOARD_CATEGORIES.filter((c) => c === arg || CATEGORY_LABEL[c].toLowerCase() === arg) as Category[])
    : BOARD_CATEGORIES;
  if (wanted.length === 0) {
    console.error(`Unknown category "${arg}". Use one of: ${BOARD_CATEGORIES.join(", ")}`);
    process.exit(1);
  }

  const db = await openDb(config.dbUrl, config.dbAuthToken);
  const all = await matchesChrono(db);

  console.log(
    `\nTrueSkill MMR — replayed over ${all.length} recorded matches` +
      `  (mu0=${MU0}, sigma0=${SIGMA0.toFixed(2)}, beta=${BETA.toFixed(2)}, tau=${TAU.toFixed(3)}, draw=${DRAW_PROB})`,
  );
  console.log("MMR = conservative skill (mu - 3*sigma); a higher mu with low sigma ranks best.\n");

  for (const cat of wanted) {
    const matches = all.filter((m) => boardCategory(m) === cat);
    const ratings = rateCategory(matches)
      .filter((r) => r.games > 0)
      .map((r) => ({ ...r, mmr: r.mu - 3 * r.sigma }))
      .sort((a, b) => b.mmr - a.mmr);

    console.log(`══ ${CATEGORY_LABEL[cat]}  (${matches.length} matches, ${ratings.length} players) ══`);
    if (ratings.length === 0) {
      console.log("  (no games)\n");
      continue;
    }
    console.log("   #  MMR     mu     sigma   W/G    player");
    ratings.forEach((r, i) => {
      const name = displayName(r.gamertag);
      console.log(
        `  ${String(i + 1).padStart(2)}  ` +
          `${r.mmr.toFixed(1).padStart(5)}  ` +
          `${r.mu.toFixed(1).padStart(5)}  ` +
          `${r.sigma.toFixed(2).padStart(5)}  ` +
          `${r.wins}/${r.games}`.padStart(6) +
          `   ${name}`,
      );
    });
    console.log("");
  }

  // libSQL client keeps the process alive on remote URLs; close it.
  db.close();
}

// Only auto-run when invoked directly (e.g. `tsx src/mmr.ts`), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
