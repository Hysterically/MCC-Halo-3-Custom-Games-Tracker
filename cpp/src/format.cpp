#include "format.h"

#include <algorithm>
#include <chrono>
#include <ctime>
#include <map>
#include <unordered_map>

#include "aliases.h"
#include "category.h"
#include "csr.h"
#include "trueskill2.h"
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

// One line of per-player ELO ratings + changes appended under the scoreboard
// table, biggest gain first. Empty when there are no changes. Mirrors
// formatEloLine in src/discord.ts (byte-identical output).
std::string formatEloLine(const CarnageReport& r, const std::map<std::string, EloChange>* changes) {
    if (!changes || changes->empty()) return "";
    std::vector<std::pair<std::string, EloChange>> entries;  // display name, change
    for (const auto& p : r.players) {
        auto it = changes->find(p.xuid);
        if (it != changes->end()) entries.emplace_back(displayName(p.gamertag), it->second);
    }
    if (entries.empty()) return "";
    std::stable_sort(entries.begin(), entries.end(),
                     [](const auto& a, const auto& b) { return a.second.delta > b.second.delta; });
    std::vector<std::string> parts;
    for (const auto& [name, c] : entries) {
        long d = util::jsRound(c.delta);
        parts.push_back(name + " " + std::to_string(util::jsRound(c.rating)) + " (" +
                        (d >= 0 ? "+" : "") + std::to_string(d) + ")");
    }
    return "\n\xF0\x9F\x93\x88 **Elo:** " + join(parts, " \xC2\xB7 ");  // 📈, " · "
}

}  // namespace

std::string formatLeaderboard(const std::vector<StoredMatch>& matches, EloOptions elo) {
    std::map<int, std::vector<StoredMatch>> byCat;  // key = Category as int
    for (const auto& m : matches) byCat[static_cast<int>(boardCategory(m))].push_back(m);

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

std::string formatLeaderboardSection(const std::vector<StoredMatch>& matches, EloOptions elo,
                                     Category cat) {
    std::vector<StoredMatch> ms;
    for (const auto& m : matches)
        if (boardCategory(m) == cat) ms.push_back(m);
    std::string title = std::string(TROPHY) + " " + categoryLabel(cat) + " Leaderboard";
    return formatSection(title, computeRatings(ms, elo));
}

// --- CSR (TrueSkill 2) text (mirror the CSR formatters in src/discord.ts) ----
namespace {

const char* MEDAL_EMOJI_TS2 = "\xF0\x9F\x8E\x96\xEF\xB8\x8F";  // 🎖️

// One category's CSR ratings, ranked best-first, only players with games.
std::vector<MMR> csrRowsFor(const std::vector<StoredMatch>& matches, Category cat) {
    std::vector<StoredMatch> ms;
    for (const auto& m : matches)
        if (boardCategory(m) == cat) ms.push_back(m);
    std::vector<MMR> all = rateCategory(ms);
    std::vector<MMR> out;
    for (const auto& r : all)
        if (r.games > 0) out.push_back(r);
    std::stable_sort(out.begin(), out.end(),
                     [](const MMR& a, const MMR& b) { return a.skill > b.skill; });
    return out;
}

// One CSR board section (mirrors formatCsrSection in src/discord.ts).
std::string formatCsrSection(Category cat, const std::vector<StoredMatch>& matches,
                             size_t limit = 20) {
    std::string heading = std::string("__**") + MEDAL_EMOJI_TS2 + " " + categoryLabel(cat) + " " +
                          EMDASH + " TrueSkill 2**__";
    std::vector<MMR> rows = csrRowsFor(matches, cat);
    if (rows.size() > limit) rows.resize(limit);
    if (rows.empty()) return heading + "\n_No matches yet._";

    std::vector<std::string> names;
    size_t nameW = 6;
    for (const auto& r : rows) {
        names.push_back(displayName(r.gamertag));
        nameW = std::max(nameW, names.back().size());
    }
    std::string head = padEnd("#", 5) + padEnd("Player", nameW) + "  " + padEnd("CSR", 16) +
                       " W-L-D    Win%   K/D";
    std::vector<std::string> lines;
    for (size_t i = 0; i < rows.size(); ++i) {
        const MMR& r = rows[i];
        Csr cell = csrFromSkill(r.skill);
        std::string label = cell.label + " (" + std::to_string(cell.value) + ")";
        std::string wld = std::to_string(r.wins) + "-" + std::to_string(r.losses) + "-" +
                          std::to_string(r.draws);
        std::string winPct = r.games ? std::to_string(util::jsRound(static_cast<double>(r.wins) /
                                                                    static_cast<double>(r.games) *
                                                                    100.0)) +
                                           "%"
                                     : EMDASH;
        std::string kd = kdStr(r.kills, r.deaths);
        std::string marker = i < 3 ? MEDALS[i] : "  ";
        lines.push_back(marker + padEnd(std::to_string(i + 1), 2) + " " + padEnd(names[i], nameW) +
                        "  " + padEnd(label, 16) + " " + padEnd(wld, 7) + " " + padStart(winPct, 4) +
                        "  " + kd);
    }
    std::vector<std::string> out = {heading, "```", head};
    out.insert(out.end(), lines.begin(), lines.end());
    out.push_back("```");
    return join(out, "\n");
}

}  // namespace

std::string formatCsrLeaderboard(const std::vector<StoredMatch>& matches) {
    std::vector<std::string> parts = {"**Halo 3 Customs " + std::string(EMDASH) +
                                      " CSR Standings**"};
    for (Category c : BOARD_CATEGORIES) parts.push_back(formatCsrSection(c, matches));
    return join(parts, "\n\n");
}

std::string formatCsrLeaderboardSection(const std::vector<StoredMatch>& matches, Category cat) {
    return formatCsrSection(cat, matches);
}

std::string formatCsrLine(const CarnageReport& r,
                          const std::map<std::string, CsrChange>* changes) {
    if (!changes || changes->empty()) return "";
    std::vector<std::pair<std::string, CsrChange>> entries;
    for (const auto& p : r.players) {
        auto it = changes->find(p.xuid);
        if (it != changes->end()) entries.emplace_back(displayName(p.gamertag), it->second);
    }
    if (entries.empty()) return "";
    std::stable_sort(entries.begin(), entries.end(),
                     [](const auto& a, const auto& b) { return a.second.delta > b.second.delta; });
    std::vector<std::string> parts;
    for (const auto& [name, c] : entries)
        parts.push_back(name + " " + csrText(c.csr) + " (" + (c.delta >= 0 ? "+" : "") +
                        std::to_string(c.delta) + ")");
    return std::string("\n") + MEDAL_EMOJI_TS2 + " **CSR:** " + join(parts, " \xC2\xB7 ");
}

std::string formatMatchCaption(const CarnageReport& r) {
    Category cat = boardCategory(r);
    std::string tag = cat == Category::Other
                          ? std::string("_Off-format ") + EMDASH + " not counted toward a leaderboard._"
                          : std::string("_Counted toward **") + categoryLabel(cat) +
                                "** leaderboard._";
    std::string mapLabel = !r.mapVariant.empty() ? r.mapVariant : r.mapName;
    std::string gt = r.gameTypeName.empty() ? "Custom Game" : r.gameTypeName;
    std::string header = gt + (mapLabel.empty() ? "" : " on " + mapLabel);
    return "**" + header + "**\n" + tag;
}

std::string formatMatchResult(const CarnageReport& r,
                              const std::map<std::string, EloChange>* eloChanges) {
    Category cat = boardCategory(r);
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
                         (map.empty() ? "" : "\n" + map) + "\n" + tag;

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
        return join(out, "\n") + formatEloLine(r, eloChanges);
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
    return rstrip(join(out, "\n")) + formatEloLine(r, eloChanges);
}

// --- rich embeds (gateway bot) ----------------------------------------------
namespace {

using nlohmann::json;

const char* MAGNIFIER = "\xF0\x9F\x94\x8D";   // 🔍
const char* CHART = "\xF0\x9F\x93\x8A";       // 📊
const char* CALENDAR = "\xF0\x9F\x93\x85";    // 📅
const char* MIDDOT = "\xC2\xB7";              // ·

// Wall-clock now, epoch ms — the recap window + embed timestamps.
long long nowMsWall() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

// ISO-8601 UTC timestamp ("YYYY-MM-DDTHH:MM:SS.sssZ") — matches new Date().toISOString().
std::string isoTimestamp(long long ms) {
    std::time_t t = static_cast<std::time_t>(ms / 1000);
    std::tm tm{};
    gmtime_s(&tm, &t);
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &tm);
    char out[40];
    std::snprintf(out, sizeof(out), "%s.%03dZ", buf, static_cast<int>(ms % 1000));
    return out;
}

// "YYYY-MM-DD HH:MM" UTC from epoch ms — the autocomplete label minute stamp.
std::string isoMinuteUtc(long long ms) {
    std::time_t t = static_cast<std::time_t>(ms / 1000);
    std::tm tm{};
    gmtime_s(&tm, &t);
    char buf[20];
    std::strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M", &tm);
    return buf;
}

// Resolve a free-text query (Gamertag or display alias, partial) to a single
// player: xuid + display label, or nullopt. Mirrors resolvePlayer in
// src/discord.ts (exact > prefix > substring, against both keys).
std::optional<std::pair<std::string, std::string>> resolvePlayer(
    const std::vector<StoredMatch>& matches, const std::string& query) {
    std::string q = util::toLower(util::trim(query));
    if (q.empty()) return std::nullopt;

    // xuid -> most-recent Gamertag (chronological, last wins).
    std::unordered_map<std::string, std::string> names;
    std::vector<std::string> order;  // first-seen xuid order, for a stable scan
    for (const auto& m : matches)
        for (const auto& p : m.players)
            if (!p.xuid.empty()) {
                if (!names.count(p.xuid)) order.push_back(p.xuid);
                names[p.xuid] = p.gamertag;
            }

    struct Cand {
        std::string xuid;
        std::string label;
        std::string k0;  // gamertag lower
        std::string k1;  // displayName lower
    };
    std::vector<Cand> cands;
    for (const auto& xuid : order) {
        const std::string& gt = names[xuid];
        std::string label = displayName(gt);
        cands.push_back({xuid, label, util::toLower(gt), util::toLower(label)});
    }

    auto find = [&](int mode) -> const Cand* {
        for (const auto& c : cands) {
            for (const std::string& k : {c.k0, c.k1}) {
                bool hit = mode == 0 ? (k == q)
                                     : mode == 1 ? (k.rfind(q, 0) == 0)
                                                 : (k.find(q) != std::string::npos);
                if (hit) return &c;
            }
        }
        return nullptr;
    };
    const Cand* hit = find(0);
    if (!hit) hit = find(1);
    if (!hit) hit = find(2);
    if (!hit) return std::nullopt;
    return std::make_pair(hit->xuid, hit->label);
}

struct CsrStatRow {
    std::string mode;
    std::string rank;
    std::string csr;
    std::string wld;
    std::string win;
    std::string kd;
};
struct CsrStatsResult {
    enum Kind { None, Unranked, Ok } kind = None;
    std::string label;  // resolved display label (Unranked/Ok)
    std::vector<CsrStatRow> rows;
    long long games = 0, wins = 0, losses = 0, draws = 0, kills = 0, deaths = 0;
};

std::string winPctStr(long long wins, long long games) {
    return games ? std::to_string(util::jsRound(static_cast<double>(wins) /
                                                static_cast<double>(games) * 100.0)) +
                       "%"
                 : EMDASH;
}

// Per-player CSR stats, computed once. Mirrors computeCsrPlayerStats in src/discord.ts.
CsrStatsResult computeCsrPlayerStats(const std::vector<StoredMatch>& matches,
                                     const std::string& query) {
    CsrStatsResult res;
    auto who = resolvePlayer(matches, query);
    if (!who) {
        res.kind = CsrStatsResult::None;
        return res;
    }
    res.label = who->second;

    for (Category c : BOARD_CATEGORIES) {
        std::vector<MMR> ranked = csrRowsFor(matches, c);  // games>0, skill desc
        int idx = -1;
        for (size_t i = 0; i < ranked.size(); ++i)
            if (ranked[i].xuid == who->first) {
                idx = static_cast<int>(i);
                break;
            }
        if (idx < 0) continue;
        const MMR& r = ranked[idx];
        res.games += r.games;
        res.wins += r.wins;
        res.losses += r.losses;
        res.draws += r.draws;
        res.kills += r.kills;
        res.deaths += r.deaths;
        CsrStatRow row;
        row.mode = categoryLabel(c);
        row.rank = "#" + std::to_string(idx + 1) + "/" + std::to_string(ranked.size());
        row.csr = csrText(csrFromSkill(r.skill));
        row.wld = std::to_string(r.wins) + "-" + std::to_string(r.losses) + "-" +
                  std::to_string(r.draws);
        row.win = winPctStr(r.wins, r.games);
        row.kd = kdStr(r.kills, r.deaths);
        res.rows.push_back(std::move(row));
    }

    res.kind = res.rows.empty() ? CsrStatsResult::Unranked : CsrStatsResult::Ok;
    return res;
}

}  // namespace

nlohmann::json csrPlayerStatsEmbed(const std::vector<StoredMatch>& matches,
                                   const std::string& query) {
    CsrStatsResult res = computeCsrPlayerStats(matches, query);
    if (res.kind == CsrStatsResult::None)
        return json{{"content",
                     std::string(MAGNIFIER) + " No player matching **" + query + "** found."}};
    if (res.kind == CsrStatsResult::Unranked)
        return json{{"content",
                     std::string(CHART) + " **" + res.label +
                         "** hasn't played any ranked (2v2 / 4v4 / FFA) matches yet."}};

    json fields = json::array();
    for (const auto& r : res.rows)
        fields.push_back({{"name", r.mode},
                          {"value", "**" + r.csr + "**\nRank " + r.rank + " " + MIDDOT + " " +
                                        r.wld + " (" + r.win + ") " + MIDDOT + " K/D " + r.kd},
                          {"inline", true}});
    std::string overallKd = kdStr(res.kills, res.deaths);
    std::string overallWin = winPctStr(res.wins, res.games);
    std::string footer = std::to_string(res.games) + " games " + MIDDOT + " " +
                         std::to_string(res.wins) + "-" + std::to_string(res.losses) + "-" +
                         std::to_string(res.draws) + " (" + overallWin + ") " + MIDDOT + " K/D " +
                         overallKd;
    json embed = {{"title", std::string(CHART) + " " + res.label + " " + EMDASH +
                                " Halo 3 Customs CSR"},
                  {"color", Embed::NEUTRAL},
                  {"fields", fields},
                  {"footer", {{"text", footer}}},
                  {"timestamp", isoTimestamp(nowMsWall())}};
    return json{{"embed", embed}};
}

nlohmann::json leaderboardEmbed() {
    return json{{"title", std::string(TROPHY) + " Halo 3 Customs " + EMDASH + " CSR Standings"},
                {"color", Embed::NEUTRAL},
                {"image", {{"url", "attachment://leaderboard.png"}}},
                {"footer", {{"text", std::string("2v2 ") + MIDDOT + " FFA " + MIDDOT +
                                         " 4v4 " + EMDASH + " TrueSkill 2"}}},
                {"timestamp", isoTimestamp(nowMsWall())}};
}

std::optional<nlohmann::json> recapEmbed(const std::vector<StoredMatch>& matches) {
    constexpr long long WINDOW_MS = 7LL * 86'400'000LL;
    long long since = nowMsWall() - WINDOW_MS;

    std::vector<const StoredMatch*> week;
    for (const auto& m : matches)
        if (m.playedAt >= since && !m.excluded) week.push_back(&m);
    if (week.empty()) return std::nullopt;

    struct PlayerAgg {
        std::string name;
        long long games = 0, kills = 0, deaths = 0;
    };
    std::unordered_map<std::string, PlayerAgg> byPlayer;
    std::vector<std::string> order;  // first-seen xuid order (stable tie-breaks)
    for (const auto* m : week)
        for (const auto& p : m->players) {
            if (p.xuid.empty()) continue;
            auto it = byPlayer.find(p.xuid);
            if (it == byPlayer.end()) {
                order.push_back(p.xuid);
                it = byPlayer.emplace(p.xuid, PlayerAgg{displayName(p.gamertag), 0, 0, 0}).first;
            }
            it->second.games++;
            it->second.kills += p.kills;
            it->second.deaths += p.deaths;
        }

    auto kdOf = [](const PlayerAgg& p) {
        return static_cast<double>(p.kills) / static_cast<double>(std::max<long long>(1, p.deaths));
    };

    // Most active: highest games (first-seen order is the stable tie-break, as in
    // the TS sort over the insertion-ordered Map values).
    const PlayerAgg* mostActive = nullptr;
    for (const auto& x : order) {
        const PlayerAgg& p = byPlayer[x];
        if (!mostActive || p.games > mostActive->games) mostActive = &p;
    }
    // MVP: best K/D among players with >=2 games.
    const PlayerAgg* mvp = nullptr;
    for (const auto& x : order) {
        const PlayerAgg& p = byPlayer[x];
        if (p.games < 2) continue;
        if (!mvp || kdOf(p) > kdOf(*mvp)) mvp = &p;
    }

    std::vector<std::string> leaders;
    for (Category cat : BOARD_CATEGORIES) {
        std::vector<MMR> ranked = csrRowsFor(matches, cat);  // games>0, skill desc
        if (!ranked.empty()) {
            const MMR& top = ranked.front();
            leaders.push_back("**" + std::string(categoryLabel(cat)) + "** " + EMDASH + " " +
                              displayName(top.gamertag) + " (" + csrText(csrFromSkill(top.skill)) +
                              ")");
        }
    }

    json fields = json::array();
    fields.push_back({{"name", "Games this week"}, {"value", std::to_string(week.size())},
                      {"inline", true}});
    if (mostActive)
        fields.push_back({{"name", "Most active"},
                          {"value", mostActive->name + " (" + std::to_string(mostActive->games) +
                                        ")"},
                          {"inline", true}});
    if (mvp)
        fields.push_back({{"name", "MVP (K/D)"},
                          {"value", mvp->name + " (" + util::toFixed2(kdOf(*mvp)) + ")"},
                          {"inline", true}});
    if (!leaders.empty())
        fields.push_back({{"name", "Current leaders"}, {"value", util::join(leaders, "\n")}});

    return json{{"title", std::string(CALENDAR) + " Weekly Recap " + EMDASH + " Halo 3 Customs"},
                {"color", Embed::GOLD},
                {"fields", fields},
                {"timestamp", isoTimestamp(nowMsWall())}};
}

std::string matchChoiceLabel(const StoredMatch& m) {
    std::vector<const StoredPlayer*> ps;
    for (const auto& p : m.players) ps.push_back(&p);
    std::sort(ps.begin(), ps.end(), [](const StoredPlayer* a, const StoredPlayer* b) {
        return a->teamId != b->teamId ? a->teamId < b->teamId : a->standing < b->standing;
    });
    std::string roster;
    for (size_t i = 0; i < ps.size(); ++i) {
        if (i) roster += ", ";
        roster += displayName(ps[i]->gamertag);
    }
    std::string s = m.gameTypeName + " (" + categoryLabel(categorize(m)) + ") " + EMDASH + " " +
                    isoMinuteUtc(m.playedAt) + " " + EMDASH + " " + roster;
    // ≤100 chars; trim on a code-unit boundary (best-effort, as the TS slice(97)).
    if (s.size() > 100) s = s.substr(0, 97) + "\xE2\x80\xA6";  // …
    return s;
}
