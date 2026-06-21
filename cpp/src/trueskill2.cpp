#include "trueskill2.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <unordered_map>

#include "category.h"

namespace {

// ---------------------------------------------------------------------------
// TrueSkill parameters (mirror src/trueskill2.ts).
// ---------------------------------------------------------------------------
constexpr double MU0 = 25;            // prior mean skill
constexpr double SIGMA0 = 25.0 / 3;   // prior std-dev (~8.333)
constexpr double BETA = SIGMA0 / 2;   // performance noise — "skill class width"
constexpr double TAU = SIGMA0 / 100;  // per-match skill-drift variance
constexpr double DRAW_PROB = 0.1;     // assumed probability of a draw
constexpr double SIGMA_MIN = 1.0;     // operational floor on uncertainty

// Experience effect (eq. 8): a small, positive, decaying mean increment.
constexpr double EXP_OFFSET_MAX = 0.15;
constexpr double EXP_OFFSET_SCALE = 8;
constexpr int EXP_CAP = 200;

// Individual statistics (eq. 9): kills/deaths as noisy performance readouts.
constexpr double PERF_SPREAD = BETA;    // ~4.17 rating pts per K/D std-dev
constexpr double OBS_BETA = 2 * BETA;   // ~8.33 — performance-observation noise

// Win-chance bar: the displayed bar is a plain monotonic (logistic) function of the
// gap between the two teams' *displayed* average CSR — the same numbers printed beside
// the bar — so it can never contradict them. Scale is CSR points per e-fold of odds,
// anchored so a ~127-CSR average gap reads ~73% (matches the reference design).
constexpr double WIN_BAR_CSR_SCALE = 130;

constexpr double TINY = 2.222758749e-162;
const double INF = std::numeric_limits<double>::infinity();

double experienceOffset(long games) {
    return EXP_OFFSET_MAX * std::exp(-static_cast<double>(std::min<long>(games, EXP_CAP)) /
                                     EXP_OFFSET_SCALE);
}

// --- Normal distribution helpers (pdf / cdf / inverse-cdf) -------------------
const double SQRT2 = std::sqrt(2.0);
const double SQRT2PI = std::sqrt(2.0 * 3.14159265358979323846);

double pdf(double x) { return std::exp(-0.5 * x * x) / SQRT2PI; }

// erf via Abramowitz & Stegun 7.1.26 (good to ~1e-7).
double erfApprox(double x) {
    double sign = x < 0 ? -1 : 1;
    double ax = std::fabs(x);
    double t = 1 / (1 + 0.3275911 * ax);
    double y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
                    0.254829592) *
                       t * std::exp(-ax * ax);
    return sign * y;
}

double cdf(double x) { return 0.5 * (1 + erfApprox(x / SQRT2)); }

// Inverse CDF (Acklam's rational approximation).
double ppf(double p) {
    if (p <= 0) return -INF;
    if (p >= 1) return INF;
    static const double a[6] = {-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
                                1.38357751867269e2, -3.066479806614716e1, 2.506628277459239};
    static const double b[5] = {-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
                                6.680131188771972e1, -1.328068155288572e1};
    static const double c[6] = {-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
                                -2.549732539343734, 4.374664141464968, 2.938163982698783};
    static const double d[4] = {7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
                                3.754408661907416};
    const double plow = 0.02425;
    const double phigh = 1 - plow;
    double q, r;
    if (p < plow) {
        q = std::sqrt(-2 * std::log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= phigh) {
        q = p - 0.5;
        r = q * q;
        return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
               (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    q = std::sqrt(-2 * std::log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// Truncated-Gaussian correction terms (the "surprise" of the outcome).
double vWin(double diff, double margin) {
    double x = diff - margin;
    double denom = cdf(x);
    return denom > TINY ? pdf(x) / denom : -x;
}
double wWin(double diff, double margin) {
    double x = diff - margin;
    double denom = cdf(x);
    if (denom < TINY) return diff - margin < 0 ? 1 : 0;
    double v = vWin(diff, margin);
    return v * (v + x);
}
double vDraw(double diff, double margin) {
    double ad = std::fabs(diff);
    double a = margin - ad;
    double b = -margin - ad;
    double denom = cdf(a) - cdf(b);
    double numer = pdf(b) - pdf(a);
    double v = std::fabs(denom) > TINY ? numer / denom : a;
    return diff < 0 ? -v : v;
}
double wDraw(double diff, double margin) {
    double ad = std::fabs(diff);
    double a = margin - ad;
    double b = -margin - ad;
    double denom = cdf(a) - cdf(b);
    if (std::fabs(denom) < TINY) return 1;
    double v = vDraw(ad, margin);
    return v * v + (a * pdf(a) - b * pdf(b)) / denom;
}

// ---------------------------------------------------------------------------
// Gaussian in (precision, precision-mean) form.
//   pi = 1 / sigma^2          tau = mu / sigma^2
// ---------------------------------------------------------------------------
struct Gaussian {
    double pi = 0;
    double tau = 0;
    double mu() const { return pi == 0 ? 0 : tau / pi; }
    double sigma() const { return pi == 0 ? INF : std::sqrt(1 / pi); }
    Gaussian mul(const Gaussian& o) const { return {pi + o.pi, tau + o.tau}; }
    Gaussian div(const Gaussian& o) const { return {pi - o.pi, tau - o.tau}; }
};

Gaussian fromMuSigma(double mu, double sigma) {
    double pi = 1 / (sigma * sigma);
    return {pi, pi * mu};
}

double deltaOf(const Gaussian& a, const Gaussian& b) {
    double piDelta = std::fabs(a.pi - b.pi);
    if (std::isinf(piDelta)) return 0;
    return std::max(std::fabs(a.tau - b.tau), std::sqrt(piDelta));
}

// A variable node: a Gaussian plus the message each adjacent factor last sent.
// Factors are identified by int ids (the TS port uses object identity).
struct Variable : Gaussian {
    std::unordered_map<int, Gaussian> messages;

    double setValue(const Gaussian& val) {
        double d = deltaOf(*this, val);
        pi = val.pi;
        tau = val.tau;
        return d;
    }
    double updateMessage(int factor, const Gaussian& msg) {
        Gaussian old = messages[factor];
        messages[factor] = msg;
        return setValue(static_cast<const Gaussian&>(*this).div(old).mul(msg));
    }
    double updateValue(int factor, const Gaussian& val) {
        Gaussian old = messages[factor];
        messages[factor] = val.mul(old).div(static_cast<const Gaussian&>(*this));
        return setValue(val);
    }
};

// SumFactor: target = Σ coeff_i * vals_i (solved for `target`'s slot).
double sumUpdate(Variable& target, int f, const std::vector<Variable*>& vals,
                 const std::vector<double>& coeffs) {
    double piInv = 0;
    double mu = 0;
    for (size_t i = 0; i < vals.size(); ++i) {
        Gaussian div = static_cast<const Gaussian&>(*vals[i]).div(vals[i]->messages[f]);
        mu += coeffs[i] * div.mu();
        if (std::isinf(piInv)) continue;
        piInv = div.pi == 0 ? INF : piInv + (coeffs[i] * coeffs[i]) / div.pi;
    }
    double pi = 1 / piInv;
    return target.updateMessage(f, Gaussian{pi, pi * mu});
}

double sumDown(Variable& sumVar, int f, const std::vector<Variable*>& terms,
               const std::vector<double>& coeffs) {
    return sumUpdate(sumVar, f, terms, coeffs);
}

double sumUp(int f, Variable& sumVar, std::vector<Variable*> terms, std::vector<double> coeffs,
             int index) {
    double c = coeffs[index];
    std::vector<double> newCoeffs(coeffs.size());
    for (size_t x = 0; x < coeffs.size(); ++x)
        newCoeffs[x] = static_cast<int>(x) == index ? 1 / c : -coeffs[x] / c;
    std::vector<Variable*> vals = terms;
    vals[index] = &sumVar;
    return sumUpdate(*terms[index], f, vals, newCoeffs);
}

double sumUpTeam(int f, Variable& teamPerf, std::vector<Variable*> members, int index) {
    std::vector<double> coeffs(members.size());
    for (size_t x = 0; x < members.size(); ++x)
        coeffs[x] = static_cast<int>(x) == index ? 1.0 : -1.0;
    std::vector<Variable*> vals = members;
    vals[index] = &teamPerf;
    return sumUpdate(*members[index], f, vals, coeffs);
}

// TruncateFactor up: apply the win/draw ordering to the team-difference var.
double truncUp(int f, double margin, bool drawn, Variable& teamDiff) {
    Gaussian div = static_cast<const Gaussian&>(teamDiff).div(teamDiff.messages[f]);
    double sqrtPi = std::sqrt(div.pi);
    double dOverSqrt = div.tau / sqrtPi;
    double marginScaled = margin * sqrtPi;
    double v = drawn ? vDraw(dOverSqrt, marginScaled) : vWin(dOverSqrt, marginScaled);
    double w = drawn ? wDraw(dOverSqrt, marginScaled) : wWin(dOverSqrt, marginScaled);
    double denom = 1 - w;
    double pi = div.pi / denom;
    double tau = (div.tau + sqrtPi * v) / denom;
    return teamDiff.updateValue(f, Gaussian{pi, tau});
}

struct RG {
    double mu;
    double sigma;
};

// The TrueSkill 2 `rate` routine (mirror of trueskill2.ts `rate`). `groups` and
// `obs` are parallel nested arrays (team -> member); each member carries a list
// of observation means (one per stat with a usable signal this match).
std::vector<std::vector<RG>> rate(const std::vector<std::vector<RG>>& groups,
                                  const std::vector<int>& ranks,
                                  const std::vector<std::vector<std::vector<double>>>& obs) {
    int nextFactor = 0;
    auto newFactor = [&]() { return nextFactor++; };

    // Sort groups by rank (ascending = best first), remembering original order.
    std::vector<int> order(ranks.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = static_cast<int>(i);
    std::stable_sort(order.begin(), order.end(),
                     [&](int x, int y) { return ranks[x] < ranks[y]; });

    std::vector<std::vector<RG>> sortedGroups;
    std::vector<int> sortedRanks;
    std::vector<std::vector<double>> flatObs;  // obs list per flat player
    for (int i : order) {
        sortedGroups.push_back(groups[i]);
        sortedRanks.push_back(ranks[i]);
        for (const auto& memberObs : obs[i]) flatObs.push_back(memberObs);
    }

    std::vector<RG> flat;
    for (const auto& g : sortedGroups)
        for (const auto& r : g) flat.push_back(r);
    int T = static_cast<int>(sortedGroups.size());
    int N = static_cast<int>(flat.size());

    // Layer 1: skill / perf / team variables. Stable addresses for pointers.
    std::vector<Variable> skill(N), perf(N), teamPerf(T);
    std::vector<Variable> teamDiff(std::max(0, T - 1));

    // Prior factors: skill ~ N(mu, sigma^2 + tau^2) — the per-match drift bump.
    struct PF {
        int f, i;
        Gaussian val;
    };
    std::vector<PF> priorFactors;
    for (int i = 0; i < N; ++i) {
        int f = newFactor();
        priorFactors.push_back(
            {f, i, fromMuSigma(flat[i].mu, std::sqrt(flat[i].sigma * flat[i].sigma + TAU * TAU))});
    }

    // Likelihood factors: perf = skill + N(0, beta^2).
    double beta2 = BETA * BETA;
    std::vector<int> likeFactors(N);
    for (int i = 0; i < N; ++i) likeFactors[i] = newFactor();

    // Performance-observation factors: each observed stat is obs ~ N(perf_i, OBS_BETA^2).
    struct OF {
        int f, i;
        double val;
    };
    std::vector<OF> obsFactors;
    for (int i = 0; i < N; ++i)
        for (double val : flatObs[i]) obsFactors.push_back({newFactor(), i, val});

    // Team-perf sum factors: teamPerf = sum of member perfs.
    struct TF {
        int f, t;
        std::vector<int> idxs;
    };
    std::vector<TF> teamFactors;
    int cursor = 0;
    for (int t = 0; t < T; ++t) {
        TF tf;
        tf.f = newFactor();
        tf.t = t;
        for (size_t k = 0; k < sortedGroups[t].size(); ++k) tf.idxs.push_back(cursor++);
        teamFactors.push_back(std::move(tf));
    }

    // Team-diff sum factors + truncation factors (the ordering constraints).
    std::vector<int> diffFactors(std::max(0, T - 1));
    for (int k = 0; k < T - 1; ++k) diffFactors[k] = newFactor();
    struct TR {
        int f;
        double margin;
        bool drawn;
    };
    std::vector<TR> truncFactors(std::max(0, T - 1));
    for (int k = 0; k < T - 1; ++k) {
        int sizeSum =
            static_cast<int>(sortedGroups[k].size() + sortedGroups[k + 1].size());
        double margin = ppf((DRAW_PROB + 1) / 2) * std::sqrt(static_cast<double>(sizeSum)) * BETA;
        bool drawn = sortedRanks[k] == sortedRanks[k + 1];
        truncFactors[k] = {newFactor(), margin, drawn};
    }

    // --- message passing ---
    // Down: priors -> skill.
    for (const auto& p : priorFactors) skill[p.i].updateValue(p.f, p.val);
    // Down: skill -> perf.
    for (int i = 0; i < N; ++i) {
        int f = likeFactors[i];
        Gaussian msg = static_cast<const Gaussian&>(skill[i]).div(skill[i].messages[f]);
        double a = 1 / (1 + beta2 * msg.pi);
        perf[i].updateMessage(f, Gaussian{a * msg.pi, a * msg.tau});
    }
    // Down: individual-statistic observations -> perf.
    for (const auto& o : obsFactors)
        perf[o.i].updateMessage(o.f, fromMuSigma(o.val, OBS_BETA));
    // Down: perf -> teamPerf.
    for (const auto& tf : teamFactors) {
        std::vector<Variable*> terms;
        std::vector<double> coeffs;
        for (int i : tf.idxs) {
            terms.push_back(&perf[i]);
            coeffs.push_back(1.0);
        }
        sumDown(teamPerf[tf.t], tf.f, terms, coeffs);
    }

    auto diffTerms = [&](int k) {
        return std::vector<Variable*>{&teamPerf[k], &teamPerf[k + 1]};
    };
    const std::vector<double> diffCoeffs = {1, -1};

    // Iterate the diff/trunc chain to convergence.
    int iters = T <= 2 ? 1 : 20;
    for (int it = 0; it < iters; ++it) {
        double d = 0;
        if (T - 1 == 1) {
            sumDown(teamDiff[0], diffFactors[0], diffTerms(0), diffCoeffs);
            d = truncUp(truncFactors[0].f, truncFactors[0].margin, truncFactors[0].drawn,
                        teamDiff[0]);
        } else {
            for (int k = 0; k < T - 2; ++k) {
                sumDown(teamDiff[k], diffFactors[k], diffTerms(k), diffCoeffs);
                d = std::max(d, truncUp(truncFactors[k].f, truncFactors[k].margin,
                                        truncFactors[k].drawn, teamDiff[k]));
                sumUp(diffFactors[k], teamDiff[k], diffTerms(k), diffCoeffs, 1);
            }
            for (int k = T - 2; k > 0; --k) {
                sumDown(teamDiff[k], diffFactors[k], diffTerms(k), diffCoeffs);
                d = std::max(d, truncUp(truncFactors[k].f, truncFactors[k].margin,
                                        truncFactors[k].drawn, teamDiff[k]));
                sumUp(diffFactors[k], teamDiff[k], diffTerms(k), diffCoeffs, 0);
            }
        }
        if (d <= 1e-4) break;
    }

    // Up: teamDiff -> teamPerf (the two ends of the chain).
    if (T - 1 >= 1) {
        sumUp(diffFactors[0], teamDiff[0], diffTerms(0), diffCoeffs, 0);
        sumUp(diffFactors[T - 2], teamDiff[T - 2], diffTerms(T - 2), diffCoeffs, 1);
    }

    // Up: teamPerf -> perf.
    for (const auto& tf : teamFactors) {
        std::vector<Variable*> members;
        for (int i : tf.idxs) members.push_back(&perf[i]);
        for (size_t m = 0; m < tf.idxs.size(); ++m)
            sumUpTeam(tf.f, teamPerf[tf.t], members, static_cast<int>(m));
    }
    // Up: perf -> skill.
    for (int i = 0; i < N; ++i) {
        int f = likeFactors[i];
        Gaussian msg = static_cast<const Gaussian&>(perf[i]).div(perf[i].messages[f]);
        double a = 1 / (1 + beta2 * msg.pi);
        skill[i].updateMessage(f, Gaussian{a * msg.pi, a * msg.tau});
    }

    // Read out updated skills, un-sort back to caller order.
    std::vector<std::vector<RG>> out(groups.size());
    for (size_t gi = 0; gi < groups.size(); ++gi) out[gi].resize(groups[gi].size());
    int fi = 0;
    for (int sortedGroupIdx = 0; sortedGroupIdx < T; ++sortedGroupIdx) {
        int origGroupIdx = order[sortedGroupIdx];
        for (size_t memberIdx = 0; memberIdx < sortedGroups[sortedGroupIdx].size(); ++memberIdx) {
            const Variable& s = skill[fi++];
            out[origGroupIdx][memberIdx] = {s.mu(), s.sigma()};
        }
    }
    return out;
}

// Stable team key — the real teamId when teams are on, otherwise a unique
// per-player id from the XUID (FFA player = team of one). Mirrors teamKey in
// trueskill2.ts and the C++ ELO port.
long long teamKey(const StoredMatch& m, const StoredPlayer& p) {
    if (m.teamsEnabled) return p.teamId;
    if (p.xuid.empty()) return 0;
    unsigned long long v = 0;
    try {
        v = std::stoull(p.xuid, nullptr, 16);
    } catch (...) {
        v = 0;
    }
    return static_cast<long long>(v % 2147483647ULL);
}

const std::string& nameOf(const StoredMatch& m, const std::string& xuid) {
    for (const auto& p : m.players)
        if (p.xuid == xuid) return p.gamertag;
    return xuid;
}

}  // namespace

std::vector<MMR> rateCategory(const std::vector<StoredMatch>& matches) {
    // Insertion-ordered table (mirrors JS Map iteration order).
    std::vector<MMR> table;
    std::unordered_map<std::string, size_t> index;

    auto ensure = [&](const std::string& xuid, const std::string& gt) -> MMR& {
        auto it = index.find(xuid);
        if (it == index.end()) {
            MMR r;
            r.xuid = xuid;
            r.gamertag = gt;
            r.mu = MU0;
            r.sigma = SIGMA0;
            r.skill = TS2_SEED_SKILL;
            r.peakSkill = TS2_SEED_SKILL;
            index[xuid] = table.size();
            table.push_back(r);
            it = index.find(xuid);
        }
        MMR& r = table[it->second];
        r.gamertag = gt;
        return r;
    };

    for (const auto& m : matches) {
        std::vector<const StoredPlayer*> rated;
        for (const auto& p : m.players)
            if (!p.xuid.empty()) rated.push_back(&p);
        if (rated.size() < 2) continue;

        // Group into teams (teamId, or one team per player in FFA).
        struct Team {
            long long key;
            std::vector<const StoredPlayer*> players;
            int rank;
        };
        std::vector<Team> teams;
        std::unordered_map<long long, size_t> tindex;
        for (const auto* p : rated) {
            long long key = teamKey(m, *p);
            auto it = tindex.find(key);
            if (it == tindex.end()) {
                tindex[key] = teams.size();
                teams.push_back({key, {}, std::numeric_limits<int>::max()});
                it = tindex.find(key);
            }
            Team& t = teams[it->second];
            t.players.push_back(p);
            t.rank = std::min(t.rank, p->standing);
        }
        if (teams.size() < 2) continue;

        // Individual-statistics signal (eq. 9): z-score each player's kills and
        // deaths across the lobby and place them on the rating scale around the
        // lobby's mean skill at the fixed PERF_SPREAD.
        double meanMu = 0;
        for (const auto* p : rated) meanMu += ensure(p->xuid, p->gamertag).mu;
        meanMu /= static_cast<double>(rated.size());

        auto zScores = [&](const std::vector<double>& vals,
                           std::vector<double>& out) -> bool {  // false => no usable signal
            double mean = 0;
            for (double v : vals) mean += v;
            mean /= static_cast<double>(vals.size());
            double var = 0;
            for (double v : vals) var += (v - mean) * (v - mean);
            double sd = std::sqrt(var / static_cast<double>(vals.size()));
            if (sd < 1e-9) return false;
            out.resize(vals.size());
            for (size_t i = 0; i < vals.size(); ++i) out[i] = (vals[i] - mean) / sd;
            return true;
        };

        std::vector<double> killVals, deathVals;
        for (const auto* p : rated) {
            killVals.push_back(static_cast<double>(p->kills));
            deathVals.push_back(static_cast<double>(p->deaths));
        }
        std::vector<double> killZ, deathZ;
        bool haveKillZ = zScores(killVals, killZ);
        bool haveDeathZ = zScores(deathVals, deathZ);
        std::unordered_map<std::string, size_t> idxOf;
        for (size_t i = 0; i < rated.size(); ++i) idxOf[rated[i]->xuid] = i;

        auto obsFor = [&](const StoredPlayer* p) {
            std::vector<double> out;
            size_t i = idxOf[p->xuid];
            if (haveKillZ) out.push_back(meanMu + killZ[i] * PERF_SPREAD);   // kills: w_p > 0
            if (haveDeathZ) out.push_back(meanMu - deathZ[i] * PERF_SPREAD);  // deaths: w_p < 0
            return out;
        };

        std::vector<std::vector<RG>> groups;
        std::vector<std::vector<std::vector<double>>> obs;
        std::vector<int> ranks;
        for (const auto& t : teams) {
            std::vector<RG> g;
            std::vector<std::vector<double>> og;
            for (const auto* p : t.players) {
                MMR& r = ensure(p->xuid, p->gamertag);
                g.push_back({r.mu, r.sigma});
                og.push_back(obsFor(p));
            }
            groups.push_back(std::move(g));
            obs.push_back(std::move(og));
            ranks.push_back(t.rank);
        }

        std::vector<std::vector<RG>> updated = rate(groups, ranks, obs);

        int bestRank = std::numeric_limits<int>::max();
        for (int rnk : ranks) bestRank = std::min(bestRank, rnk);
        int winners = 0;
        for (int rnk : ranks)
            if (rnk == bestRank) ++winners;

        for (size_t ti = 0; ti < teams.size(); ++ti) {
            const Team& t = teams[ti];
            bool isSoleWin = t.rank == bestRank && winners == 1;
            bool isDraw = t.rank == bestRank && winners > 1;
            for (size_t pi = 0; pi < t.players.size(); ++pi) {
                const StoredPlayer* p = t.players[pi];
                MMR& r = ensure(p->xuid, p->gamertag);
                // Experience bias (eq. 8): keyed on games played BEFORE this match.
                r.mu = updated[ti][pi].mu + experienceOffset(r.games);
                r.sigma = std::max(SIGMA_MIN, updated[ti][pi].sigma);
                r.skill = r.mu - 3 * r.sigma;
                r.peakSkill = std::max(r.peakSkill, r.skill);
                r.games += 1;
                if (isSoleWin)
                    r.wins += 1;
                else if (isDraw)
                    r.draws += 1;
                else
                    r.losses += 1;
                r.kills += p->kills;
                r.deaths += p->deaths;
            }
        }
    }

    return table;
}

std::map<std::string, CsrChange> matchCsrChanges(const std::vector<StoredMatch>& matches,
                                                 const std::string& matchId) {
    std::map<std::string, CsrChange> changes;

    size_t idx = matches.size();
    for (size_t i = 0; i < matches.size(); ++i)
        if (matches[i].matchId == matchId) {
            idx = i;
            break;
        }
    if (idx == matches.size()) return changes;
    const StoredMatch& match = matches[idx];
    Category cat = boardCategory(match);
    if (cat == Category::Other) return changes;

    std::vector<StoredMatch> hist;
    for (size_t i = 0; i <= idx; ++i)
        if (boardCategory(matches[i]) == cat) hist.push_back(matches[i]);
    std::vector<StoredMatch> prior(hist.begin(), hist.end() - 1);

    std::unordered_map<std::string, double> before, after;
    for (const MMR& r : rateCategory(prior)) before[r.xuid] = r.skill;
    for (const MMR& r : rateCategory(hist)) after[r.xuid] = r.skill;

    for (const auto& p : match.players) {
        auto a = after.find(p.xuid);
        if (a == after.end()) continue;
        auto b = before.find(p.xuid);
        double bSkill = b != before.end() ? b->second : TS2_SEED_SKILL;
        Csr csrAfter = csrFromSkill(a->second);
        Csr csrBefore = csrFromSkill(bSkill);
        changes[p.xuid] = {a->second, csrAfter, csrAfter.value - csrBefore.value};
    }
    return changes;
}

std::optional<MatchWinChances> matchWinChances(const std::vector<StoredMatch>& matches,
                                               const std::string& matchId) {
    size_t idx = matches.size();
    for (size_t i = 0; i < matches.size(); ++i)
        if (matches[i].matchId == matchId) {
            idx = i;
            break;
        }
    if (idx == matches.size()) return std::nullopt;
    const StoredMatch& match = matches[idx];
    if (!match.teamsEnabled) return std::nullopt;
    Category cat = boardCategory(match);
    if (cat == Category::Other) return std::nullopt;

    std::vector<StoredMatch> hist;
    for (size_t i = 0; i <= idx; ++i)
        if (boardCategory(matches[i]) == cat) hist.push_back(matches[i]);
    std::vector<StoredMatch> prior(hist.begin(), hist.end() - 1);

    // Pre-match ratings (mu/sigma) — missing player falls back to the prior.
    std::unordered_map<std::string, MMR> pre;
    for (const MMR& r : rateCategory(prior)) pre[r.xuid] = r;

    struct Agg {
        int teamId = 0;
        long long csrSum = 0;
        int n = 0;
    };
    std::map<int, Agg> teams;  // by teamId
    for (const auto& p : match.players) {
        if (p.xuid.empty()) continue;  // unrated guest — not part of team rating
        auto it = pre.find(p.xuid);
        double mu = it != pre.end() ? it->second.mu : MU0;
        double sigma = it != pre.end() ? it->second.sigma : SIGMA0;
        Agg& t = teams[p.teamId];
        t.teamId = p.teamId;
        t.csrSum += csrFromSkill(mu - 3 * sigma).value;  // unrated -> CSR 0
        t.n += 1;
    }
    if (teams.size() != 2) return std::nullopt;

    // Winner first so the bar's left segment matches the board's row ordering.
    std::vector<Agg> arr;
    for (auto& kv : teams) arr.push_back(kv.second);
    const std::optional<int>& winning = match.winningTeamId;
    std::stable_sort(arr.begin(), arr.end(), [&](const Agg& x, const Agg& y) {
        if (winning) {
            if (x.teamId == *winning) return true;
            if (y.teamId == *winning) return false;
        }
        return x.teamId < y.teamId;
    });
    const Agg& A = arr[0];
    const Agg& B = arr[1];
    int avgA = static_cast<int>(std::lround(static_cast<double>(A.csrSum) / A.n));
    int avgB = static_cast<int>(std::lround(static_cast<double>(B.csrSum) / B.n));

    // Bar = logistic of the gap between the two displayed average CSRs.
    double probA = 1.0 / (1.0 + std::exp(-(avgA - avgB) / WIN_BAR_CSR_SCALE));

    MatchWinChances out;
    out.teams[0] = {A.teamId, avgA, probA};
    out.teams[1] = {B.teamId, avgB, 1.0 - probA};
    return out;
}
