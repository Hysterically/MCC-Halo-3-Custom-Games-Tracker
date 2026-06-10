// How a match gets classified for leaderboard purposes.
//   "2v2"   teams on, two teams of two human players.
//   "4v4"   teams on, two teams of three or four human players (3v3 shares it).
//   "ffa"   teams off (any non-team custom).
//   "other" everything else (1v1, asymmetric, 3+ teams, 5v5+); still recorded
//           and posted, just not on any leaderboard.
// Mirrors src/category.ts.
#pragma once
#include <array>
#include <map>
#include <string>
#include <vector>

enum class Category { TwoV2, FourV4, FFA, Other };

inline const char* categoryLabel(Category c) {
    switch (c) {
        case Category::TwoV2: return "2v2";
        case Category::FourV4: return "4v4";
        case Category::FFA: return "FFA";
        default: return "—";
    }
}

// Categories that get a leaderboard section, in display order.
inline constexpr std::array<Category, 3> BOARD_CATEGORIES = {
    Category::TwoV2, Category::FourV4, Category::FFA};

// Works for any match-like type exposing `.teamsEnabled` and `.players` whose
// elements have `.teamId` and `.xuid` (CarnageReport and StoredMatch both do).
template <class M>
Category categorize(const M& m) {
    // Guests / bots have no XUID and aren't rateable — ignore them when shaping
    // the match (so e.g. a 2v2-with-a-guest still classifies as 2v2).
    size_t realCount = 0;
    for (const auto& p : m.players)
        if (!p.xuid.empty()) ++realCount;

    if (!m.teamsEnabled) return realCount >= 2 ? Category::FFA : Category::Other;

    std::map<int, int> sizes;
    for (const auto& p : m.players) {
        if (p.xuid.empty()) continue;
        if (p.teamId < 0) continue;
        sizes[p.teamId]++;
    }
    std::vector<int> counts;
    for (auto& [k, v] : sizes) counts.push_back(v);
    if (counts.size() != 2 || counts[0] != counts[1]) return Category::Other;
    if (counts[0] == 2) return Category::TwoV2;
    if (counts[0] == 3 || counts[0] == 4) return Category::FourV4;
    return Category::Other;
}
