#include "cli.h"

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <iostream>
#include <map>
#include <thread>
#include <unordered_map>

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include "carnage.h"
#include "category.h"
#include "config.h"
#include "db.h"
#include "discord_gateway.h"
#include "discord_webhook.h"
#include "elo.h"
#include "format.h"
#include "heal.h"
#include "http.h"
#include "mapinfo.h"
#include "render_carnage.h"
#include "render_csr_leaderboard.h"
#include "render_leaderboard.h"
#include "status_bar.h"
#include "trueskill2.h"
#include "update_check.h"
#include "util.h"
#include "version.h"
#include "watcher.h"

namespace fs = std::filesystem;

namespace {

EloOptions eloOpt() { return {config().eloStart, config().eloK}; }

bool containsCarnage(const std::string& name) {
    return util::toLower(name).find("carnage") != std::string::npos;
}
bool hasXmlExt(const std::string& name) {
    auto dot = name.find_last_of('.');
    return dot != std::string::npos && util::toLower(name.substr(dot)) == ".xml";
}

// backfill: name matches /carnage/i AND ends in .xml.
std::vector<std::string> listCarnageXml(const std::string& dir) {
    std::vector<std::string> out;
    std::error_code ec;
    for (auto& e : fs::directory_iterator(dir, ec)) {
        if (!e.is_regular_file()) continue;
        std::string name = e.path().filename().string();
        if (containsCarnage(name) && hasXmlExt(name)) out.push_back(e.path().string());
    }
    return out;
}

// parse/inspect: name matches /carnage/i OR ends in .xml.
std::vector<std::string> listCarnageOrXml(const std::string& dir) {
    std::vector<std::string> out;
    std::error_code ec;
    for (auto& e : fs::directory_iterator(dir, ec)) {
        if (!e.is_regular_file()) continue;
        std::string name = e.path().filename().string();
        if (containsCarnage(name) || hasXmlExt(name)) out.push_back(e.path().string());
    }
    return out;
}

std::string baseName(const std::string& p) {
    auto i = p.find_last_of("\\/");
    return i == std::string::npos ? p : p.substr(i + 1);
}

nlohmann::json reportToJson(const CarnageReport& r) {
    nlohmann::json players = nlohmann::json::array();
    for (const auto& p : r.players) {
        players.push_back({{"gamertag", p.gamertag},
                           {"xuid", p.xuid},
                           {"teamId", p.teamId},
                           {"score", p.score},
                           {"standing", p.standing},
                           {"kills", p.kills},
                           {"deaths", p.deaths},
                           {"assists", p.assists},
                           {"betrayals", p.betrayals},
                           {"suicides", p.suicides},
                           {"secondsPlayed", p.secondsPlayed},
                           {"completedGame", p.completedGame}});
    }
    nlohmann::json j = {{"matchId", r.matchId},
                        {"gameEnum", r.gameEnum},
                        {"isHalo3", r.isHalo3},
                        {"isMatchmaking", r.isMatchmaking},
                        {"isCustom", r.isCustom},
                        {"teamsEnabled", r.teamsEnabled},
                        {"completed", r.completed},
                        {"gameTypeName", r.gameTypeName},
                        {"hopperName", r.hopperName},
                        {"playedAtMs", r.playedAtMs},
                        {"players", players},
                        {"winners", r.winners},
                        {"tracked", r.tracked}};
    j["winningTeamId"] = r.winningTeamId.has_value() ? nlohmann::json(*r.winningTeamId)
                                                     : nlohmann::json(nullptr);
    return j;
}

}  // namespace

int cmdBoard() {
    auto db = openDb(config().dbUrl, config().dbAuthToken);
    std::cout << db->matchCount() << " tracked matches in " << config().dbUrl << "\n\n";
    std::cout << formatCsrLeaderboard(db->matchesChrono()) << "\n";
    return 0;
}

int cmdBackfill(const std::vector<std::string>& args) {
    std::string dir = !args.empty() ? args[0] : config().carnageDir;
    auto db = openDb(config().dbUrl, config().dbAuthToken);

    std::vector<std::string> files = listCarnageXml(dir);
    int added = 0;
    for (const auto& f : files) {
        try {
            CarnageReport r = parseCarnageFile(f);
            if (!r.tracked) continue;
            // No waiting here — old films have usually rotated away.
            MapInfo map = findMapInfo(dir, r.playedAtMs);
            r.mapName = map.mapName;
            r.mapVariant = map.mapVariant;
            if (db->recordMatch(r)) added++;
        } catch (const std::exception& e) {
            std::cerr << "skip " << baseName(f) << ": " << e.what() << "\n";
        }
    }

    std::cout << "Scanned " << files.size() << " reports in " << dir << ": +" << added
              << " new, " << db->matchCount() << " total.\n\n";
    std::cout << formatCsrLeaderboard(db->matchesChrono()) << "\n";
    return 0;
}

int cmdParse(const std::vector<std::string>& args) {
    std::vector<std::string> files;
    bool single = false;

    if (!args.empty()) {
        std::error_code ec;
        if (fs::is_regular_file(args[0], ec)) {
            files = {args[0]};
            single = true;
        } else if (fs::is_directory(args[0], ec)) {
            files = listCarnageOrXml(args[0]);
        } else {
            std::cerr << "Not found: " << args[0] << "\n";
            return 1;
        }
    } else {
        if (fs::is_directory("samples")) files = listCarnageOrXml("samples");
        if (files.empty()) files = listCarnageOrXml(config().carnageDir);
    }

    if (files.empty()) {
        std::cerr << "No carnage reports found.\n";
        return 1;
    }

    if (single) {
        std::cout << reportToJson(parseCarnageFile(files[0])).dump(2) << "\n";
        return 0;
    }

    // Compact classification table.
    std::printf("%-28s %-6s %-11s %-22s %3s %-24s %s\n", "file", "game", "kind", "type",
                "ply", "winner", "TRACKED");
    int tracked = 0;
    for (const auto& f : files) {
        try {
            CarnageReport r = parseCarnageFile(f);
            std::string game = r.isHalo3 ? "H3" : "enum" + std::to_string(r.gameEnum);
            std::string kind = r.isCustom ? "CUSTOM" : "matchmaking";
            std::string winner = util::join(r.winners, ",");
            if (winner.size() > 24) winner = winner.substr(0, 24);
            if (r.tracked) tracked++;
            std::printf("%-28s %-6s %-11s %-22s %3zu %-24s %s\n", baseName(f).c_str(), game.c_str(),
                        kind.c_str(), r.gameTypeName.c_str(), r.players.size(), winner.c_str(),
                        r.tracked ? "YES" : "-");
        } catch (const std::exception& e) {
            std::printf("%-28s %-6s %s\n", baseName(f).c_str(), "ERR", e.what());
        }
    }
    std::cout << "\n" << files.size() << " reports, " << tracked
              << " are Halo 3 customs we'd track.\n";
    std::cout << "Detail for one:  h3-tracker parse \"<full path to that .xml>\"\n";
    return 0;
}

int cmdInspect(const std::vector<std::string>& args) {
    std::string target;
    if (!args.empty())
        target = args[0];
    else if (fs::is_directory("samples"))
        target = "samples";
    else
        target = config().carnageDir;

    std::string file;
    std::error_code ec;
    if (fs::is_regular_file(target, ec)) {
        file = target;
    } else if (fs::is_directory(target, ec)) {
        auto xmls = listCarnageOrXml(target);
        if (xmls.empty()) {
            std::cerr << "No carnage/.xml files in " << target << "\n";
            return 1;
        }
        // newest by mtime
        file = *std::max_element(xmls.begin(), xmls.end(), [](const std::string& a,
                                                              const std::string& b) {
            std::error_code e1, e2;
            return fs::last_write_time(a, e1) < fs::last_write_time(b, e2);
        });
    } else {
        std::cerr << "Not found: " << target << "\n";
        return 1;
    }

    std::cout << "Inspecting: " << file << "\n\n";
    auto xml = util::readFile(file);
    if (!xml) {
        std::cerr << "cannot read file\n";
        return 1;
    }
    std::cout << "=== RAW HEAD (first 1500 chars of XML) ===\n";
    std::cout << xml->substr(0, std::min<size_t>(1500, xml->size())) << "\n";
    return 0;
}

int cmdGwProbe() {
    // Verify the wss transport (Schannel TLS handshake + frame recv) against the
    // real Discord gateway. HELLO (op 10) is sent before any auth, so this works
    // without a bot token and proves the gateway plumbing end-to-end.
    CURL* c = curl_easy_init();
    if (!c) return 1;
    std::string url = "wss://gateway.discord.gg/?v=10&encoding=json";
    curl_easy_setopt(c, CURLOPT_URL, url.c_str());
    curl_easy_setopt(c, CURLOPT_CONNECT_ONLY, 2L);
    curl_easy_setopt(c, CURLOPT_USERAGENT, "h3-tracker");
    CURLcode rc = curl_easy_perform(c);
    if (rc != CURLE_OK) {
        std::cerr << "wss handshake failed: " << curl_easy_strerror(rc) << "\n";
        curl_easy_cleanup(c);
        return 1;
    }
    std::cout << "wss handshake OK (Schannel)\n";
    std::string msg;
    for (int i = 0; i < 50; ++i) {
        char buf[8192];
        size_t rlen = 0;
        const struct curl_ws_frame* meta = nullptr;
        CURLcode r = curl_ws_recv(c, buf, sizeof(buf), &rlen, &meta);
        if (r == CURLE_OK) {
            msg.append(buf, rlen);
            if (meta && meta->bytesleft == 0) break;
        } else if (r == CURLE_AGAIN) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        } else {
            std::cerr << "ws recv error: " << curl_easy_strerror(r) << "\n";
            break;
        }
    }
    curl_easy_cleanup(c);
    if (msg.empty()) {
        std::cerr << "no frame received\n";
        return 1;
    }
    try {
        auto j = nlohmann::json::parse(msg);
        std::cout << "received op=" << j.value("op", -1)
                  << " heartbeat_interval=" << j["d"].value("heartbeat_interval", 0) << "\n";
        std::cout << (j.value("op", -1) == 10 ? "HELLO received — gateway transport OK ✅\n"
                                              : "unexpected first frame\n");
    } catch (...) {
        std::cout << "raw: " << msg.substr(0, 200) << "\n";
    }
    return 0;
}

int cmdCurlInfo() {
    curl_version_info_data* d = curl_version_info(CURLVERSION_NOW);
    std::cout << "curl " << d->version << " ssl=" << (d->ssl_version ? d->ssl_version : "none")
              << "\nprotocols: ";
    bool wss = false;
    for (const char* const* p = d->protocols; p && *p; ++p) {
        std::cout << *p << " ";
        if (std::string(*p) == "wss") wss = true;
    }
    std::cout << "\nwss supported: " << (wss ? "YES" : "NO") << "\n";
    return 0;
}

int cmdPingWebhook(const std::vector<std::string>& args) {
    std::string url = !args.empty() ? args[0]
                      : config().discordLeaderboardWebhookUrl
                          ? *config().discordLeaderboardWebhookUrl
                      : config().discordResultsWebhookUrl ? *config().discordResultsWebhookUrl
                                                          : "";
    if (url.empty()) {
        std::cerr << "no webhook URL (pass one or set it in .env)\n";
        return 1;
    }
    HttpResponse r = httpRequest("GET", url);  // GET returns metadata, posts nothing
    if (r.networkError) {
        std::cerr << "network/TLS error: " << r.error << "\n";
        return 1;
    }
    std::cout << "HTTP " << r.status << "\n";
    if (r.ok()) {
        try {
            auto j = nlohmann::json::parse(r.body);
            std::cout << "webhook OK — name=" << j.value("name", "?")
                      << " channel_id=" << j.value("channel_id", "?") << "\n";
        } catch (...) {
            std::cout << r.body.substr(0, 200) << "\n";
        }
    } else {
        std::cout << r.body.substr(0, 200) << "\n";
    }
    return 0;
}

int cmdShow(const std::vector<std::string>& args) {
    if (args.empty()) {
        std::cerr << "usage: h3-tracker show <carnage.xml>\n";
        return 1;
    }
    CarnageReport r = parseCarnageFile(args[0]);
    MapInfo map = findMapInfo(fs::path(args[0]).parent_path().string(), r.playedAtMs);
    r.mapName = map.mapName;
    r.mapVariant = map.mapVariant;
    std::cout << formatMatchResult(r) << "\n";
    return 0;
}

// Synthetic 4v4 report used by `render --sample` (same data as the Node
// preview in src/renderPreview.ts) so the look can be checked without an XML.
CarnageReport sampleReport() {
    CarnageReport r;
    r.matchId = "preview";
    r.gameEnum = GAME_HALO3;
    r.isHalo3 = r.isCustom = r.completed = r.tracked = true;
    r.teamsEnabled = true;
    r.gameTypeName = "Hardcore King";
    r.winningTeamId = 0;
    auto add = [&](const char* gt, int team, long long score, long long k, long long a,
                   long long d, int standing) {
        CarnagePlayer p;
        p.gamertag = gt;
        p.xuid = std::string("0x") + gt;
        p.teamId = team;
        p.score = score;
        p.kills = k;
        p.assists = a;
        p.deaths = d;
        p.standing = standing;
        p.secondsPlayed = 600;
        p.completedGame = true;
        r.players.push_back(p);
        if (standing == 0) r.winners.push_back(gt);
    };
    add("Blopped", 0, 113, 33, 18, 18, 0);
    add("a1chess", 0, 85, 12, 14, 26, 0);
    add("l23LO4D3D", 0, 32, 42, 19, 21, 0);
    add("Topher", 0, 20, 32, 17, 20, 0);
    add("iRoKchevy", 1, 61, 15, 21, 32, 1);
    add("TRauMa L5p", 1, 49, 16, 16, 31, 1);
    add("oWhittaker", 1, 42, 34, 19, 26, 1);
    add("Hysterically", 1, 31, 20, 18, 30, 1);
    return r;
}

namespace {
// Plausible post-match ratings + changes so the sample render/post show the
// ELO column (mirrors sampleEloChanges in src/sampleReports.ts).
std::map<std::string, EloChange> sampleEloChanges(const CarnageReport& r) {
    const double winnerRatings[4] = {1342, 1318, 1296, 1275};
    const double loserRatings[4] = {1289, 1263, 1241, 1210};
    std::map<std::string, EloChange> d;
    int w = 0, l = 0;
    for (const auto& p : r.players) {
        if (p.teamId == r.winningTeamId.value_or(-1))
            d[p.xuid] = {winnerRatings[w++ % 4], 16};
        else
            d[p.xuid] = {loserRatings[l++ % 4], -16};
    }
    return d;
}

// Plausible CSR ratings + changes so the sample render/post show the CSR column
// across a spread of tiers (and emblems).
std::map<std::string, CsrChange> sampleCsrChanges(const CarnageReport& r) {
    const double winnerSkills[4] = {25.6, 22.4, 20.1, 18.0};  // ~onyx .. platinum
    const double loserSkills[4] = {19.5, 16.8, 13.4, 9.2};    // ~gold .. bronze
    const int winnerDelta[4] = {31, 24, 18, 12};
    const int loserDelta[4] = {-14, -19, -23, -28};
    std::map<std::string, CsrChange> d;
    int w = 0, l = 0;
    for (const auto& p : r.players) {
        bool won = p.teamId == r.winningTeamId.value_or(-1);
        double skill = won ? winnerSkills[w % 4] : loserSkills[l % 4];
        int delta = won ? winnerDelta[w % 4] : loserDelta[l % 4];
        (won ? w : l)++;
        d[p.xuid] = {skill, csrFromSkill(skill), delta};
    }
    return d;
}

// Plausible per-team win bar (avg CSR from the sample CSR changes) for the sample
// render/post. Mirrors sampleWinChances in src/sampleReports.ts.
std::optional<MatchWinChances> sampleWinChances(const CarnageReport& r) {
    if (!r.teamsEnabled || !r.winningTeamId) return std::nullopt;
    std::map<std::string, CsrChange> csr = sampleCsrChanges(r);
    struct Agg {
        long long sum = 0;
        int n = 0;
    };
    std::map<int, Agg> agg;
    for (const auto& p : r.players) {
        auto it = csr.find(p.xuid);
        if (it == csr.end()) continue;
        Agg& a = agg[p.teamId];
        a.sum += it->second.csr.value;
        a.n += 1;
    }
    if (agg.size() != 2) return std::nullopt;
    int winId = *r.winningTeamId;
    std::vector<std::pair<int, Agg>> arr(agg.begin(), agg.end());
    std::stable_sort(arr.begin(), arr.end(), [&](const auto& x, const auto& y) {
        if (x.first == winId) return true;
        if (y.first == winId) return false;
        return x.first < y.first;
    });
    auto avg = [](const Agg& a) { return static_cast<int>((a.sum + a.n / 2) / a.n); };
    MatchWinChances out;
    out.teams[0] = {arr[0].first, avg(arr[0].second), 0.55};
    out.teams[1] = {arr[1].first, avg(arr[1].second), 0.45};
    return out;
}
}  // namespace

int cmdRender(const std::vector<std::string>& args) {
    if (args.empty()) {
        std::cerr << "usage: h3-tracker render <carnage.xml|--sample> [out.png]\n";
        return 1;
    }
    CarnageReport r;
    if (args[0] == "--sample") {
        r = sampleReport();
    } else {
        r = parseCarnageFile(args[0]);
        MapInfo map = findMapInfo(fs::path(args[0]).parent_path().string(), r.playedAtMs);
        r.mapName = map.mapName;
        r.mapVariant = map.mapVariant;
    }
    std::string out = args.size() > 1 ? args[1] : "carnage.png";
    std::map<std::string, CsrChange> changes;
    std::optional<MatchWinChances> win;
    if (args[0] == "--sample") {
        changes = sampleCsrChanges(r);
        win = sampleWinChances(r);
    }
    std::vector<unsigned char> png =
        renderCarnageCsrPng(r, changes.empty() ? nullptr : &changes, win ? &*win : nullptr);
    if (!util::writeFile(out, std::string(png.begin(), png.end()))) {
        std::cerr << "could not write " << out << "\n";
        return 1;
    }
    std::cout << "wrote " << out << " (" << png.size() << " bytes)\n";
    return 0;
}

// Sample standings (same data as src/renderLeaderboardPreview.ts) so the
// leaderboard look can be checked without a live DB.
std::vector<BoardSection> sampleBoardSections() {
    // (gamertag, elo, wins, losses, draws, kd) — kills/deaths chosen to match kd.
    struct Row {
        const char* gt;
        double elo;
        long w, l, d;
        double kd;
    };
    const Row rows[] = {
        {"MK5 Phantom", 1247, 7, 3, 0, 0.94},  {"QB14GhOsT14QB", 1230, 5, 4, 0, 1.22},
        {"oWhittaker", 1217, 5, 3, 0, 1.10},   {"mike domination", 1216, 1, 0, 0, 0.67},
        {"Blopped", 1214, 2, 1, 0, 1.08},      {"Topher", 1214, 5, 5, 0, 0.87},
        {"Hysterically", 1186, 5, 5, 0, 0.94}, {"I23L04D3D", 1184, 4, 4, 0, 1.11},
        {"B7ENDEN", 1169, 0, 2, 0, 1.04},      {"MK5 FRAG", 1169, 3, 6, 0, 1.00},
        {"iwreckshop91", 1153, 3, 7, 0, 0.85},
    };
    std::vector<Rating> ratings;
    for (const Row& r : rows) {
        Rating rt;
        rt.xuid = std::string("0x") + r.gt;
        rt.gamertag = r.gt;
        rt.rating = r.elo;
        rt.wins = r.w;
        rt.losses = r.l;
        rt.draws = r.d;
        rt.games = r.w + r.l + r.d;
        rt.kills = util::jsRound(r.kd * 100);
        rt.deaths = 100;
        ratings.push_back(rt);
    }
    return {{"2V2 LEADERBOARD", {}}, {"4V4 LEADERBOARD", ratings}, {"FFA LEADERBOARD", {}}};
}

// Sample CSR standings (a 4v4 board across a spread of tiers) so the leaderboard
// look can be checked without a live DB.
std::vector<CsrBoardSection> sampleCsrBoardSections() {
    struct Row {
        const char* gt;
        double skill;
        long w, l, d;
        double kd;
    };
    const Row rows[] = {
        {"MK5 Phantom", 26.4, 7, 3, 0, 1.34},  {"QB14GhOsT14QB", 24.1, 5, 4, 0, 1.22},
        {"oWhittaker", 22.0, 5, 3, 0, 1.10},   {"mike domination", 20.6, 1, 0, 0, 1.67},
        {"Blopped", 19.2, 2, 1, 0, 1.08},      {"Topher", 17.5, 5, 5, 0, 0.87},
        {"Hysterically", 15.1, 5, 5, 0, 0.94}, {"I23L04D3D", 12.8, 4, 4, 0, 1.11},
        {"B7ENDEN", 9.4, 0, 2, 0, 1.04},       {"MK5 FRAG", 6.0, 3, 6, 0, 1.00},
        {"iwreckshop91", 2.1, 3, 7, 0, 0.85},
    };
    std::vector<CsrRow> csrRows;
    for (const Row& r : rows) {
        CsrRow rt;
        rt.gamertag = r.gt;
        rt.skill = r.skill;
        rt.peakSkill = r.skill;
        rt.wins = r.w;
        rt.losses = r.l;
        rt.draws = r.d;
        rt.games = r.w + r.l + r.d;
        rt.kills = util::jsRound(r.kd * 100);
        rt.deaths = 100;
        csrRows.push_back(rt);
    }
    return {{"2V2 LEADERBOARD", {}}, {"4V4 LEADERBOARD", csrRows}, {"FFA LEADERBOARD", {}}};
}

int cmdRenderBoard(const std::vector<std::string>& args) {
    std::vector<CsrBoardSection> sections;
    if (!args.empty() && args[0] == "--sample") {
        sections = sampleCsrBoardSections();
    } else {
        auto db = openDb(config().dbUrl, config().dbAuthToken);
        sections = buildCsrBoardSections(db->matchesChrono());
    }
    std::string out = "leaderboard.png";
    for (const auto& a : args)
        if (a != "--sample") out = a;
    std::vector<unsigned char> png = renderCsrLeaderboardPng(sections);
    if (!util::writeFile(out, std::string(png.begin(), png.end()))) {
        std::cerr << "could not write " << out << "\n";
        return 1;
    }
    std::cout << "wrote " << out << " (" << png.size() << " bytes)\n";
    return 0;
}

int cmdPostSample() {
    if (!config().discordResultsWebhookUrl) {
        std::cerr << "No DISCORD_RESULTS_WEBHOOK_URL in .env \xE2\x80\x94 nothing to post to.\n";
        return 1;
    }
    CarnageReport sample = sampleReport();
    std::map<std::string, CsrChange> changes = sampleCsrChanges(sample);
    postCsrMatchResult(config().discordResultsWebhookUrl, sample, &changes);
    std::cout << "Posted a sample carnage image to the results webhook.\n"
                 "(It is a fake match \xE2\x80\x94 delete the Discord message when done looking.)\n";
    return 0;
}

int cmdClear() {
    auto db = openDb(config().dbUrl, config().dbAuthToken);
    long long before = db->matchCount();
    std::cout << "Clearing " << before << " matches in " << config().dbUrl << " ...\n";
    db->clearAll();
    std::cout << "Done. " << db->matchCount() << " matches remain.\n";

    if (config().discordLeaderboardWebhookUrl) {
        upsertCsrLeaderboard(config().discordLeaderboardWebhookUrl, *db);
        std::cout << "[discord] leaderboard message refreshed (empty).\n";
    }
    return 0;
}

// --- entry points completed in later phases --------------------------------

int cmdAnnounce() {
    if (!config().discordLeaderboardWebhookUrl) {
        std::cerr << "No DISCORD_LEADERBOARD_WEBHOOK_URL configured — set it in .env first.\n";
        return 1;
    }
    auto db = openDb(config().dbUrl, config().dbAuthToken);
    upsertCsrLeaderboard(config().discordLeaderboardWebhookUrl, *db);
    std::cout << "[discord] leaderboard message refreshed.\n";
    return 0;
}

namespace {
std::atomic<bool> g_watchStop{false};
BOOL WINAPI watchCtrlHandler(DWORD) {
    g_watchStop.store(true);
    return TRUE;
}
std::string matchLabel(const CarnageReport& r) {
    std::string w = util::join(r.winners, ", ");
    if (w.empty()) w = "\xE2\x80\x94";  // em dash
    std::string on = r.mapName.empty() ? "" : " on " + r.mapName;
    return r.gameTypeName + on + " \xC2\xB7 " + std::to_string(r.players.size()) +
           "p \xC2\xB7 winner: " + w;
}
}  // namespace

int cmdRestyle(const std::vector<std::string>& args) {
    bool apply = std::find(args.begin(), args.end(), "--apply") != args.end();
    if (!config().discordResultsWebhookUrl) {
        std::cerr << "No DISCORD_RESULTS_WEBHOOK_URL configured — set it in .env first.\n";
        return 1;
    }
    auto db = openDb(config().dbUrl, config().dbAuthToken);
    if (!apply) {
        long long tracked = static_cast<long long>(db->resultsRestyleTargets(0, true).size());
        std::cout << "[db] " << db->matchCount() << " matches recorded\n"
                  << "[db] " << tracked << " matches already have a stored message id\n"
                  << "\nDry run. Re-run with --apply to adopt orphan posts and re-style every "
                     "#game-results post.\n";
        return 0;
    }
    HealStats s = healStaleResults(*db, /*force=*/true);
    std::cout << "\nDone: adopted " << s.adopted << ", re-styled " << s.restyled
              << (s.gone ? ", " + std::to_string(s.gone) + " had vanished" : "") << ".\n";
    return 0;
}

int cmdExclude(const std::vector<std::string>& args) {
    bool confirm = std::find(args.begin(), args.end(), "--confirm") != args.end();
    bool restore = std::find(args.begin(), args.end(), "--restore") != args.end();
    std::string matchId;
    for (const auto& a : args)
        if (a.rfind("--", 0) != 0) {
            matchId = a;
            break;
        }
    if (matchId.empty()) {
        std::cerr << "Usage: h3-tracker exclude <match_id> [--restore] [--confirm]\n";
        return 1;
    }

    auto db = openDb(config().dbUrl, config().dbAuthToken);
    std::vector<StoredMatch> matches = db->matchesChrono();
    const StoredMatch* target = nullptr;
    for (const auto& m : matches)
        if (m.matchId == matchId) {
            target = &m;
            break;
        }
    if (!target) {
        std::cout << "No match with id " << matchId << " found (of " << matches.size()
                  << " total).\n";
        return 1;
    }

    std::cout << "Target match (of " << matches.size() << " total):\n"
              << "  match_id : " << target->matchId << "\n"
              << "  gametype : " << target->gameTypeName << " (structural "
              << categoryLabel(categorize(*target)) << ")\n"
              << "  excluded : " << (target->excluded ? "true" : "false") << " -> "
              << (!restore ? "true" : "false") << "\n"
              << "  board    : " << categoryLabel(boardCategory(*target)) << " -> ";
    StoredMatch preview = *target;
    preview.excluded = !restore;
    std::cout << categoryLabel(boardCategory(preview)) << "\n";

    if (!confirm) {
        std::cout << "\nDry run. Re-run with --confirm to " << (restore ? "re-include" : "exclude")
                  << " this game and refresh the leaderboard.\n";
        return 0;
    }

    db->setMatchExcluded(matchId, !restore);
    std::cout << "\n" << (restore ? "Re-included" : "Excluded") << " match. " << db->matchCount()
              << " matches recorded.\n";

    // Re-style the #game-results post in place if its message id is tracked.
    std::string msgId;
    for (const auto& t : db->resultsRestyleTargets(0, /*force=*/true))
        if (t.matchId == matchId) {
            msgId = t.msgId;
            break;
        }
    if (!msgId.empty()) {
        std::cout << "[discord] result post " << restyleResultPost(*db, matchId, msgId) << ".\n";
    } else {
        std::cout << "[discord] no tracked #game-results post id \xE2\x80\x94 re-style by hand if "
                     "needed.\n";
    }

    if (config().discordLeaderboardWebhookUrl) {
        upsertCsrLeaderboard(config().discordLeaderboardWebhookUrl, *db);
        std::cout << "[discord] leaderboard message refreshed.\n";
    }
    return 0;
}

int cmdWatch() {
    auto db = openDb(config().dbUrl, config().dbAuthToken);
    long long before = db->matchCount();

    // Live dashboard: a boxed config summary up top, then a self-updating footer.
    // The banner reports which channels/bot are active, so no per-channel preamble.
    term::init();
    term::statusBar().start();
    term::banner(
        "Halo 3 Customs Tracker",
        {{"Database", config().dbUrl},
         {"Watching", config().carnageDir},
         {"Results", config().discordResultsWebhookUrl ? term::green("on") : term::dim("off")},
         {"Leaderboard",
          config().discordLeaderboardWebhookUrl ? term::green("on") : term::dim("off")},
         {"Bot", config().discordBotToken ? term::green("on") : term::dim("off")},
         {"Matches", std::to_string(before) + " recorded"}});
    term::statusBar().setTotal(before);

    startBotIfConfigured(*db);

    // Tell the user if their build is behind the latest release (best-effort,
    // off the main thread so a slow GitHub doesn't delay startup).
    std::thread updateThread(checkForUpdate);

    // Refresh once on startup so the board survives DB edits / a deleted message.
    if (config().discordLeaderboardWebhookUrl) {
        try {
            upsertCsrLeaderboard(config().discordLeaderboardWebhookUrl, *db);
        } catch (const std::exception& e) {
            std::cerr << "[discord] startup leaderboard refresh failed: " << e.what() << "\n";
        }
    }

    // Self-heal: re-style any #game-results posts left in an older layout by an
    // outdated build. Off the main thread so the watcher goes live immediately;
    // joined before exit so it never outlives the DB.
    std::thread healThread;
    if (config().discordResultsWebhookUrl) {
        healThread = std::thread([&db] {
            try {
                healStaleResults(*db, /*force=*/false);
            } catch (const std::exception& e) {
                std::cerr << "[heal] startup re-style failed: " << e.what() << "\n";
            }
        });
    }

    std::unordered_map<std::string, long long> seen;

    auto ingest = [&](const std::string& path) -> std::optional<CarnageReport> {
        CarnageReport report;
        try {
            report = parseCarnageFile(path);
        } catch (const std::exception& e) {
            term::statusBar().logErr("[skip] " + path + ": " + e.what());
            return std::nullopt;
        }
        if (!report.tracked) return std::nullopt;
        // Best-effort map lookup: the theater film lands a few seconds after
        // the XML, so poll for it briefly before recording.
        try {
            MapInfo map = findMapInfo(config().carnageDir, report.playedAtMs, 45'000);
            report.mapName = map.mapName;
            report.mapVariant = map.mapVariant;
        } catch (...) {
            // no map info — the post and the DB row just omit it
        }
        try {
            if (!db->recordMatch(report)) return std::nullopt;  // dupe — already recorded
        } catch (const std::exception& e) {
            term::statusBar().logErr("[db] record failed for " + path + ": " + e.what());
            return std::nullopt;
        }
        return report;
    };

    auto onFile = [&](const std::string& path) {
        long long m = fileMtimeMs(path);
        auto it = seen.find(path);
        if (it != seen.end() && it->second == m) return;
        seen[path] = m;

        auto report = ingest(path);
        if (!report) return;
        term::statusBar().log("[match] " + matchLabel(*report));
        {
            std::string winner = report->winners.empty() ? "\xE2\x80\x94" : report->winners[0];
            std::string on = report->mapName.empty() ? "" : " on " + report->mapName;
            term::statusBar().recordMatch(report->gameTypeName + on + " \xE2\x80\x94 " + winner);
        }

        // Per-player CSR rating + change for the result post — replayed from
        // the recorded history, so it matches exactly what the leaderboard
        // will apply. Best effort: a DB hiccup just posts without the ratings.
        std::map<std::string, CsrChange> csrChanges;
        std::optional<MatchWinChances> winChances;
        try {
            std::vector<StoredMatch> chrono = db->matchesChrono();
            csrChanges = matchCsrChanges(chrono, report->matchId);
            winChances = matchWinChances(chrono, report->matchId);
        } catch (const std::exception& e) {
            term::statusBar().logErr(std::string("[ts2] CSR change computation failed: ") +
                                     e.what());
        }

        try {
            // Capture the #game-results message id so the game can later be voided via /delete
            // or the Void button. Posts with buttons when the bot's app-owned webhook is
            // available, else a plain post to the configured webhook.
            std::string msgId = postCsrMatchResultWithControls(
                *db, *report, csrChanges.empty() ? nullptr : &csrChanges,
                winChances ? &*winChances : nullptr);
            if (!msgId.empty()) {
                db->setMatchResultsMsg(report->matchId, msgId);
                // Stamp the layout version so the startup heal never re-styles a fresh post.
                db->setMatchResultsFmt(report->matchId, RESULTS_FMT_VERSION);
            }
        } catch (const std::exception& e) {
            term::statusBar().logErr(std::string("[discord] result post failed: ") + e.what());
        }
        try {
            upsertCsrLeaderboard(config().discordLeaderboardWebhookUrl, *db);
        } catch (const std::exception& e) {
            term::statusBar().logErr(std::string("[discord] leaderboard upsert failed: ") +
                                     e.what());
        }
    };

    SetConsoleCtrlHandler(watchCtrlHandler, TRUE);
    term::statusBar().setWatching(true);
    term::statusBar().log(term::dim("[watch] live \xE2\x80\x94 waiting for matches\xE2\x80\xA6"));
    std::cout.flush();
    watchDirectory(config().carnageDir, g_watchStop, onFile);
    term::statusBar().stop();
    std::cout << "\n[exit] closing\xE2\x80\xA6\n";
    // Let the background tasks finish before the DB (which they hold by ref) dies.
    if (updateThread.joinable()) updateThread.join();
    if (healThread.joinable()) healThread.join();
    return 0;
}

// cmdSetup is implemented in setup.cpp.

#ifndef H3_HAVE_GATEWAY
// Stub used only when the gateway bot isn't linked (discord_gateway.cpp defines
// H3_HAVE_GATEWAY target-wide, excluding this).
void startBotIfConfigured(Db&) {
    if (!config().discordBotToken)
        std::cout << "[discord] no DISCORD_BOT_TOKEN \xE2\x80\x94 slash commands disabled\n";
    else
        std::cout << "[discord] slash-command bot not built into this binary\n";
}
#endif
