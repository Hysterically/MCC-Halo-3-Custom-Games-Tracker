// How a match gets classified for leaderboard purposes.
//   "2v2"   teams on, two teams of two human players.
//   "4v4"   teams on, two teams of exactly four human players.
//   "ffa"   teams off (any non-team custom).
//   "other" everything else (1v1, 3v3, asymmetric, 3+ teams, 5v5+); still recorded
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

// Stable category key matching the TS Category string union ("2v2" | "4v4" |
// "ffa" | "other"). Used in shared kv keys (lb_msg:<webhook>:<cat>), so it MUST
// stay byte-identical to the TS side — distinct from categoryLabel(), which
// upper-cases FFA for display.
inline const char* categoryKey(Category c) {
    switch (c) {
        case Category::TwoV2: return "2v2";
        case Category::FourV4: return "4v4";
        case Category::FFA: return "ffa";
        default: return "other";
    }
}

// Categories that get a leaderboard section, in display order.
inline constexpr std::array<Category, 3> BOARD_CATEGORIES = {
    Category::TwoV2, Category::FourV4, Category::FFA};

// Order the per-category leaderboard messages are posted to Discord, top to
// bottom. 4v4 goes LAST so it lands at the bottom of the channel — the newest /
// most in-focus message. Mirrors LEADERBOARD_POST_ORDER in src/category.ts.
inline constexpr std::array<Category, 3> LEADERBOARD_POST_ORDER = {
    Category::TwoV2, Category::FFA, Category::FourV4};

// A game shorter than this (seconds) didn't really happen — it was ended/aborted
// before a result (e.g. a 0-0 no-contest that lands as a tie). Such games are
// still recorded and posted, but kept off every leaderboard. Mirrors
// MIN_LEADERBOARD_SECONDS in src/category.ts.
inline constexpr long long MIN_LEADERBOARD_SECONDS = 60;

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
    if (counts[0] == 4) return Category::FourV4;
    return Category::Other;
}

// Leaderboard classification: structural categorize(), except a game shorter
// than minSeconds is forced to Other so aborted / no-contest games never reach a
// board. The categorizer every board and per-match tag goes through; categorize()
// stays the pure structural one. Works for CarnageReport and StoredMatch (both
// expose an optional `.durationSeconds`). Mirrors boardCategory in src/category.ts.
template <class M>
Category boardCategory(const M& m, long long minSeconds = MIN_LEADERBOARD_SECONDS) {
    if (m.durationSeconds.has_value() && *m.durationSeconds < minSeconds) return Category::Other;
    return categorize(m);
}
