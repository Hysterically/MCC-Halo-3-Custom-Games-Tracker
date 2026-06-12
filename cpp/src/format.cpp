#include "format.h"

#include <algorithm>
#include <map>

#include "aliases.h"
#include "category.h"
#include "util.h"

namespace {

using util::join;
using util::padEnd;
using util::padStart;

// Podium markers for the top three places (gold, silver, bronze).
const char* MEDALS[3] = {"\xF0\x9F\xA5\x87", "\xF0\x9F\xA5\x88", "\xF0\x9F\xA5\x89"};
const char* TROPHY = "\xF0\x9F\x8F\x86";       // 🏆
const char* GAMEPAD = "\xF0\x9F\x8E\xAE";      // 🎮
const char* EMDASH = "\xE2\x80\x94";           // —

std::string kdStr(long long kills, long long deaths) {
    return deaths ? util::toFixed2(static_cast<double>(kills) / static_cast<double>(deaths))
                  : util::toFixed2(static_cast<double>(kills));
}

// One leaderboard section (just the code block, no outer heading).
std::string formatSection(const std::string& title, const std::vector<Rating>& ratings,
                          size_t limit = 20) {
    std::string heading = "__**" + title + "**__";
    if (ratings.empty()) return heading + "\n_No matches yet._";

    size_t n = std::min(limit, ratings.size());
    std::vector<std::string> names;
    size_t nameW = 6;
    for (size_t i = 0; i < n; ++i) {
        names.push_back(displayName(ratings[i].gamertag));
        nameW = std::max(nameW, names.back().size());
    }

    std::string head = padEnd("#", 5) + padEnd("Player", nameW) + "  Elo   W-L-D    Win%   K/D";
    std::vector<std::string> lines;
    for (size_t i = 0; i < n; ++i) {
        const Rating& r = ratings[i];
        std::string kd = kdStr(r.kills, r.deaths);
        std::string wld = std::to_string(r.wins) + "-" + std::to_string(r.losses) + "-" +
                          std::to_string(r.draws);
        std::string winPct = r.games ? std::to_string(util::jsRound(
                                           static_cast<double>(r.wins) /
                                           static_cast<double>(r.games) * 100.0)) +
                                           "%"
                                     : EMDASH;
        std::string marker = i < 3 ? MEDALS[i] : "  ";
        std::string rank = marker + padEnd(std::to_string(i + 1), 2);
        lines.push_back(rank + " " + padEnd(names[i], nameW) + "  " +
                        padStart(std::to_string(util::jsRound(r.rating)), 4) + "  " +
                        padEnd(wld, 7) + " " + padStart(winPct, 4) + "  " + kd);
    }

    std::vector<std::string> out = {heading, "```", head};
    out.insert(out.end(), lines.begin(), lines.end());
    out.push_back("```");
    return join(out, "\n");
}

const char* TEAM_NAMES[8] = {"Red", "Blue", "Green", "Orange", "Purple", "Gold", "Brown", "Pink"};
std::string teamName(int id) {
    if (id >= 0 && id < 8) return std::string(TEAM_NAMES[id]) + " Team";
    return "Team " + std::to_string(id);
}

std::string rstrip(std::string s) {
    size_t b = s.find_last_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    return s.substr(0, b + 1);
}

// One line of per-player ELO changes appended under the scoreboard table,
// biggest gain first. Empty when there are no deltas. Mirrors formatEloLine in
// src/discord.ts (byte-identical output).
std::string formatEloLine(const CarnageReport& r, const std::map<std::string, double>* deltas) {
    if (!deltas || deltas->empty()) return "";
    std::vector<std::pair<std::string, double>> entries;  // display name, delta
    for (const auto& p : r.players) {
        auto it = deltas->find(p.xuid);
        if (it != deltas->end()) entries.emplace_back(displayName(p.gamertag), it->second);
    }
    if (entries.empty()) return "";
    std::stable_sort(entries.begin(), entries.end(),
                     [](const auto& a, const auto& b) { return a.second > b.second; });
    std::vector<std::string> parts;
    for (const auto& [name, delta] : entries) {
        long d = util::jsRound(delta);
        parts.push_back(name + " " + (d >= 0 ? "+" : "") + std::to_string(d));
    }
    return "\n\xF0\x9F\x93\x88 **Elo:** " + join(parts, " \xC2\xB7 ");  // 📈, " · "
}

}  // namespace

std::string formatLeaderboard(const std::vector<StoredMatch>& matches, EloOptions elo) {
    std::map<int, std::vector<StoredMatch>> byCat;  // key = Category as int
    for (const auto& m : matches) byCat[static_cast<int>(categorize(m))].push_back(m);

    std::vector<std::string> parts = {"**Halo 3 Customs " + std::string(EMDASH) +
                                      " ELO Standings**"};
    for (Category c : BOARD_CATEGORIES) {
        auto it = byCat.find(static_cast<int>(c));
        std::vector<StoredMatch> ms = it != byCat.end() ? it->second : std::vector<StoredMatch>{};
        std::string title = std::string(TROPHY) + " " + categoryLabel(c) + " Leaderboard";
        parts.push_back(formatSection(title, computeRatings(ms, elo)));
    }
    return join(parts, "\n\n");
}

std::string formatMatchCaption(const CarnageReport& r) {
    Category cat = categorize(r);
    std::string tag = cat == Category::Other
                          ? std::string("_Off-format ") + EMDASH + " not counted toward a leaderboard._"
                          : std::string("_Counted toward **") + categoryLabel(cat) +
                                "** leaderboard._";
    std::string map = r.mapName;
    if (!r.mapVariant.empty())
        map += (map.empty() ? "" : std::string(" ") + EMDASH + " ") + r.mapVariant;
    return (map.empty() ? "" : "\xF0\x9F\x97\xBA\xEF\xB8\x8F **" + map + "**\n") + tag;
}

std::string formatMatchResult(const CarnageReport& r,
                              const std::map<std::string, double>* eloDeltas) {
    Category cat = categorize(r);
    std::string tag = cat == Category::Other
                          ? std::string("_Off-format ") + EMDASH + " not counted toward a leaderboard._"
                          : std::string("_Counted toward **") + categoryLabel(cat) +
                                "** leaderboard._";
    std::string gt = r.gameTypeName.empty() ? "Custom Game" : r.gameTypeName;
    std::string map = r.mapName;
    if (!r.mapVariant.empty())
        map += (map.empty() ? "" : std::string(" ") + EMDASH + " ") + r.mapVariant;
    std::string header = std::string(GAMEPAD) + " **" + gt + "** \xC2\xB7 " +
                         std::to_string(r.players.size()) + " " +
                         (r.players.size() == 1 ? "player" : "players") +
                         (map.empty() ? "" : "\n\xF0\x9F\x97\xBA\xEF\xB8\x8F " + map) + "\n" + tag;

    if (!r.teamsEnabled) {
        // FFA — rank by standing (0 = best).
        std::vector<CarnagePlayer> ordered = r.players;
        std::stable_sort(ordered.begin(), ordered.end(),
                         [](const CarnagePlayer& a, const CarnagePlayer& b) {
                             return a.standing < b.standing;
                         });
        std::vector<std::string> names;
        size_t nameW = 6;
        for (const auto& p : ordered) {
            names.push_back(displayName(p.gamertag));
            nameW = std::max(nameW, names.back().size());
        }
        std::string head = padEnd("#", 5) + padEnd("Player", nameW) + " " + padStart("Kills", 5) +
                           " " + padStart("Deaths", 6) + " " + padStart("Assists", 7) + " " +
                           padStart("K/D", 6);
        std::vector<std::string> lines;
        for (size_t i = 0; i < ordered.size(); ++i) {
            const CarnagePlayer& p = ordered[i];
            std::string marker = i == 0 ? TROPHY : "  ";
            std::string rank = marker + padEnd(std::to_string(i + 1), 2);
            lines.push_back(rank + " " + padEnd(names[i], nameW) + " " +
                            padStart(std::to_string(p.kills), 5) + " " +
                            padStart(std::to_string(p.deaths), 6) + " " +
                            padStart(std::to_string(p.assists), 7) + " " +
                            padStart(kdStr(p.kills, p.deaths), 6));
        }
        std::vector<std::string> out = {header, "```", head};
        out.insert(out.end(), lines.begin(), lines.end());
        out.push_back("```");
        return join(out, "\n") + formatEloLine(r, eloDeltas);
    }

    // Team game — group, winning team first, players in each team by score desc.
    std::map<int, std::vector<CarnagePlayer>> byTeam;
    for (const auto& p : r.players) byTeam[p.teamId].push_back(p);

    std::vector<int> teamIds;
    for (auto& [tid, _] : byTeam) teamIds.push_back(tid);
    int winning = r.winningTeamId.value_or(-2147483647);
    std::sort(teamIds.begin(), teamIds.end(), [&](int a, int b) {
        if (a == winning && b != winning) return true;
        if (b == winning && a != winning) return false;
        return a < b;
    });

    size_t nameW = 6;
    for (const auto& p : r.players) nameW = std::max(nameW, displayName(p.gamertag).size());

    std::string colHead = std::string(2 + nameW + 1, ' ') + padStart("Kills", 5) + " " +
                          padStart("Deaths", 6) + " " + padStart("Assists", 7) + " " +
                          padStart("K/D", 6);
    std::vector<std::string> blocks = {colHead};
    for (int tid : teamIds) {
        std::vector<CarnagePlayer> members = byTeam[tid];
        std::stable_sort(members.begin(), members.end(),
                         [](const CarnagePlayer& a, const CarnagePlayer& b) {
                             return a.score > b.score;
                         });
        std::string label = tid == winning
                                ? std::string(TROPHY) + " " + teamName(tid) + " " + EMDASH + " Winner"
                                : teamName(tid);
        long long totalScore = 0;
        for (const auto& p : members) totalScore += p.score;
        blocks.push_back(label + "  (score " + std::to_string(totalScore) + ")");
        for (const auto& p : members) {
            blocks.push_back("  " + padEnd(displayName(p.gamertag), nameW) + " " +
                             padStart(std::to_string(p.kills), 5) + " " +
                             padStart(std::to_string(p.deaths), 6) + " " +
                             padStart(std::to_string(p.assists), 7) + " " +
                             padStart(kdStr(p.kills, p.deaths), 6));
        }
        blocks.push_back("");
    }
    std::vector<std::string> out = {header, "```"};
    out.insert(out.end(), blocks.begin(), blocks.end());
    out.push_back("```");
    return rstrip(join(out, "\n")) + formatEloLine(r, eloDeltas);
}
