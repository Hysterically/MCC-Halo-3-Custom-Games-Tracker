#include "carnage.h"

#include <windows.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <stdexcept>

#include <pugixml.hpp>

#include "util.h"

namespace {

// Number(v) semantics: parse as a double, NaN/inf -> default.
double num(const char* v, double d = 0) {
    if (!v || !*v) return d;
    char* end = nullptr;
    double n = std::strtod(v, &end);
    if (end == v || !std::isfinite(n)) return d;
    return n;
}

bool toBool(const char* v) { return v && util::toLower(v) == "true"; }

}  // namespace

long long fileMtimeMs(const std::string& path) {
    WIN32_FILE_ATTRIBUTE_DATA fa{};
    int wlen = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
    std::wstring wpath(wlen > 0 ? wlen - 1 : 0, L'\0');
    if (wlen > 0)
        MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wpath.data(), wlen);
    if (!GetFileAttributesExW(wpath.c_str(), GetFileExInfoStandard, &fa)) return 0;
    ULARGE_INTEGER t;
    t.LowPart = fa.ftLastWriteTime.dwLowDateTime;
    t.HighPart = fa.ftLastWriteTime.dwHighDateTime;
    // FILETIME is 100ns ticks since 1601-01-01; convert to Unix epoch ms.
    return static_cast<long long>((t.QuadPart - 116444736000000000ULL) / 10000ULL);
}

namespace {

struct WinnerResult {
    std::optional<int> winningTeamId;
    std::vector<std::string> winners;
};

// Winner = best (lowest) standing. Team games: the whole winning team shares
// standing 0; tie-break on total team score. FFA: the standing-0 player(s).
WinnerResult decideWinner(const std::vector<CarnagePlayer>& players, bool teamsEnabled) {
    if (players.empty()) return {std::nullopt, {}};

    if (!teamsEnabled) {
        int best = std::numeric_limits<int>::max();
        for (const auto& p : players) best = std::min(best, p.standing);
        std::vector<std::string> winners;
        for (const auto& p : players)
            if (p.standing == best) winners.push_back(p.gamertag);
        return {std::nullopt, winners};
    }

    struct TeamAgg {
        int bestStanding = std::numeric_limits<int>::max();
        long long totalScore = 0;
        int order = 0;  // first-seen order, to mirror JS Map insertion order
    };
    std::map<int, TeamAgg> teams;
    std::vector<int> order;
    for (const auto& p : players) {
        auto it = teams.find(p.teamId);
        if (it == teams.end()) {
            TeamAgg a;
            a.order = static_cast<int>(order.size());
            teams.emplace(p.teamId, a);
            order.push_back(p.teamId);
            it = teams.find(p.teamId);
        }
        it->second.bestStanding = std::min(it->second.bestStanding, p.standing);
        it->second.totalScore += p.score;
    }

    // Sort by bestStanding asc, then totalScore desc; ties keep insertion order.
    std::vector<int> ranked = order;
    std::stable_sort(ranked.begin(), ranked.end(), [&](int a, int b) {
        const auto& A = teams.at(a);
        const auto& B = teams.at(b);
        if (A.bestStanding != B.bestStanding) return A.bestStanding < B.bestStanding;
        return A.totalScore > B.totalScore;
    });

    int winningTeamId = ranked.front();
    std::vector<std::string> winners;
    for (const auto& p : players)
        if (p.teamId == winningTeamId) winners.push_back(p.gamertag);
    return {winningTeamId, winners};
}

}  // namespace

CarnageReport parseCarnageXml(const std::string& xml, long long playedAtMs) {
    pugi::xml_document doc;
    pugi::xml_parse_result pr = doc.load_buffer(xml.data(), xml.size());
    if (!pr) throw std::runtime_error(std::string("XML parse error: ") + pr.description());

    pugi::xml_node root = doc.child("MultiplayerCarnageReport");
    if (!root) throw std::runtime_error("Not a MultiplayerCarnageReport (unexpected XML root).");

    auto attr = [](pugi::xml_node n, const char* child, const char* a) -> const char* {
        return n.child(child).attribute(a).value();
    };

    int gameEnum = static_cast<int>(num(attr(root, "GameEnum", "mGameEnum"), -1));
    bool isMatchmaking = toBool(attr(root, "IsMatchmaking", "IsMatchmaking"));
    bool teamsEnabled = toBool(attr(root, "IsTeamsEnabled", "IsTeamsEnabled"));
    bool completed = !toBool(attr(root, "mLastMatchIncomplete", "mLastMatchIncomplete"));

    CarnageReport r;
    for (pugi::xml_node pn : root.child("Players").children("Player")) {
        CarnagePlayer p;
        p.gamertag = pn.attribute("mGamertagText").value();
        p.xuid = pn.attribute("mXboxUserId").value();
        p.teamId = static_cast<int>(num(pn.attribute("mTeamId").value(), -1));
        p.score = static_cast<long long>(num(pn.attribute("Score").value()));
        p.standing = static_cast<int>(num(pn.attribute("mStanding").value(), 999));
        p.kills = static_cast<long long>(num(pn.attribute("mKills").value()));
        p.deaths = static_cast<long long>(num(pn.attribute("mDeaths").value()));
        p.assists = static_cast<long long>(num(pn.attribute("mAssists").value()));
        p.betrayals = static_cast<long long>(num(pn.attribute("mBetrayals").value()));
        p.suicides = static_cast<long long>(num(pn.attribute("mSuicides").value()));
        p.secondsPlayed = static_cast<long long>(num(pn.attribute("mSecondsPlayed").value()));
        p.completedGame = static_cast<int>(num(pn.attribute("mCompletedGame").value())) == 1;
        r.players.push_back(std::move(p));
    }

    WinnerResult w = decideWinner(r.players, teamsEnabled);

    long long durationSeconds = 0;
    for (const auto& p : r.players) durationSeconds = std::max(durationSeconds, p.secondsPlayed);
    r.durationSeconds = durationSeconds;

    r.matchId = attr(root, "GameUniqueId", "GameUniqueId");
    r.gameEnum = gameEnum;
    r.isHalo3 = gameEnum == GAME_HALO3;
    r.isMatchmaking = isMatchmaking;
    r.isCustom = !isMatchmaking;
    r.teamsEnabled = teamsEnabled;
    r.completed = completed;
    r.gameTypeName = attr(root, "GameTypeName", "GameTypeName");
    r.hopperName = attr(root, "HopperName", "HopperName");
    r.playedAtMs = playedAtMs;
    r.winningTeamId = w.winningTeamId;
    r.winners = std::move(w.winners);
    r.tracked = r.isHalo3 && r.isCustom && completed && !r.players.empty();
    return r;
}

CarnageReport parseCarnageFile(const std::string& path) {
    auto xml = util::readFile(path);
    if (!xml) throw std::runtime_error("cannot read file: " + path);
    return parseCarnageXml(*xml, fileMtimeMs(path));
}
