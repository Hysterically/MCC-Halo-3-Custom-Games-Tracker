#include "elo.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <unordered_map>

#include "category.h"

namespace {

double expected(double a, double b) { return 1.0 / (1.0 + std::pow(10.0, (b - a) / 400.0)); }

// Stable team key: the real teamId when teams are on, otherwise a unique
// per-player id from the XUID so every FFA player is a team of one. Mirrors the
// JS `BigInt(xuid) % 2147483647n` (XUIDs fit in 64 bits).
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

std::vector<Rating> computeRatings(const std::vector<StoredMatch>& matches, EloOptions opt) {
    // Insertion-ordered rating table (mirrors JS Map iteration order, which the
    // final stable sort relies on for tie-breaks).
    std::vector<Rating> table;
    std::unordered_map<std::string, size_t> index;

    auto ensure = [&](const std::string& xuid, const std::string& gamertag) -> Rating& {
        auto it = index.find(xuid);
        if (it == index.end()) {
            Rating r;
            r.xuid = xuid;
            r.rating = opt.start;
            index[xuid] = table.size();
            table.push_back(r);
            it = index.find(xuid);
        }
        Rating& r = table[it->second];
        r.gamertag = gamertag;  // keep most-recent name
        return r;
    };

    for (const auto& m : matches) {
        if (m.players.size() < 2) continue;

        struct Team {
            long long key = 0;
            std::vector<std::string> xuids;
            int rank = std::numeric_limits<int>::max();
            double avg = 0;
        };
        std::vector<Team> teams;
        std::unordered_map<long long, size_t> tindex;

        for (const auto& p : m.players) {
            long long key = teamKey(m, p);
            auto it = tindex.find(key);
            if (it == tindex.end()) {
                Team t;
                t.key = key;
                tindex[key] = teams.size();
                teams.push_back(std::move(t));
                it = tindex.find(key);
            }
            Team& t = teams[it->second];
            t.xuids.push_back(p.xuid);
            t.rank = std::min(t.rank, p.standing);
        }
        if (teams.size() < 2) continue;

        for (auto& t : teams) {
            double sum = 0;
            for (const auto& x : t.xuids) sum += ensure(x, nameOf(m, x)).rating;
            t.avg = sum / static_cast<double>(t.xuids.size());
        }

        int bestRank = std::numeric_limits<int>::max();
        for (const auto& t : teams) bestRank = std::min(bestRank, t.rank);
        int winnersAtBest = 0;
        for (const auto& t : teams)
            if (t.rank == bestRank) ++winnersAtBest;

        std::vector<double> delta(teams.size(), 0.0);
        for (size_t i = 0; i < teams.size(); ++i) {
            double sum = 0;
            for (size_t j = 0; j < teams.size(); ++j) {
                if (i == j) continue;
                double s = teams[i].rank < teams[j].rank   ? 1.0
                           : teams[i].rank > teams[j].rank ? 0.0
                                                           : 0.5;
                sum += s - expected(teams[i].avg, teams[j].avg);
            }
            delta[i] = (opt.k * sum) / static_cast<double>(teams.size() - 1);
        }

        for (size_t ti = 0; ti < teams.size(); ++ti) {
            const Team& t = teams[ti];
            bool isWin = t.rank == bestRank && winnersAtBest == 1;
            bool isDraw = t.rank == bestRank && winnersAtBest > 1;
            for (const auto& xuid : t.xuids) {
                Rating& r = ensure(xuid, nameOf(m, xuid));
                r.rating += delta[ti];
                r.games += 1;
                if (isWin)
                    r.wins += 1;
                else if (isDraw)
                    r.draws += 1;
                else
                    r.losses += 1;
                for (const auto& p : m.players) {
                    if (p.xuid == xuid) {
                        r.kills += p.kills;
                        r.deaths += p.deaths;
                        break;
                    }
                }
            }
        }
    }

    std::stable_sort(table.begin(), table.end(),
                     [](const Rating& a, const Rating& b) { return a.rating > b.rating; });
    return table;
}

std::map<std::string, EloChange> matchEloChanges(const std::vector<StoredMatch>& matches,
                                                 const std::string& matchId, EloOptions opt) {
    std::map<std::string, EloChange> changes;

    size_t idx = matches.size();
    for (size_t i = 0; i < matches.size(); ++i) {
        if (matches[i].matchId == matchId) {
            idx = i;
            break;
        }
    }
    if (idx == matches.size()) return changes;
    const StoredMatch& match = matches[idx];
    Category cat = categorize(match);
    if (cat == Category::Other) return changes;

    // Replay the match's category up to and including it, and diff against the
    // replay that stops just before it.
    std::vector<StoredMatch> hist;
    for (size_t i = 0; i <= idx; ++i)
        if (categorize(matches[i]) == cat) hist.push_back(matches[i]);
    std::vector<StoredMatch> prior(hist.begin(), hist.end() - 1);

    std::unordered_map<std::string, double> before, after;
    for (const Rating& r : computeRatings(prior, opt)) before[r.xuid] = r.rating;
    for (const Rating& r : computeRatings(hist, opt)) after[r.xuid] = r.rating;

    for (const auto& p : match.players) {
        auto a = after.find(p.xuid);
        if (a == after.end()) continue;
        auto b = before.find(p.xuid);
        changes[p.xuid] = {a->second, a->second - (b != before.end() ? b->second : opt.start)};
    }
    return changes;
}
