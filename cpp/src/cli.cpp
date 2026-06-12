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
#include "config.h"
#include "db.h"
#include "discord_gateway.h"
#include "discord_webhook.h"
#include "elo.h"
#include "format.h"
#include "http.h"
#include "mapinfo.h"
#include "render_carnage.h"
#include "util.h"
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
    std::cout << formatLeaderboard(db->matchesChrono(), eloOpt()) << "\n";
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
    std::cout << formatLeaderboard(db->matchesChrono(), eloOpt()) << "\n";
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
// Plausible per-player ELO changes so the sample render/post show the
// scoreboard footer (mirrors sampleEloDeltas in src/sampleReports.ts).
std::map<std::string, double> sampleEloDeltas(const CarnageReport& r) {
    std::map<std::string, double> d;
    for (const auto& p : r.players)
        d[p.xuid] = p.teamId == r.winningTeamId.value_or(-1) ? 16 : -16;
    return d;
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
    std::map<std::string, double> deltas;
    if (args[0] == "--sample") deltas = sampleEloDeltas(r);
    std::vector<unsigned char> png = renderCarnagePng(r, deltas.empty() ? nullptr : &deltas);
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
    std::map<std::string, double> deltas = sampleEloDeltas(sample);
    postMatchResult(config().discordResultsWebhookUrl, sample, &deltas);
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
        upsertLeaderboard(config().discordLeaderboardWebhookUrl, *db, eloOpt());
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
    upsertLeaderboard(config().discordLeaderboardWebhookUrl, *db, eloOpt());
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

int cmdWatch() {
    auto db = openDb(config().dbUrl, config().dbAuthToken);
    std::cout << "[db] " << config().dbUrl << " \xE2\x80\x94 " << db->matchCount()
              << " matches before this run\n";
    std::cout << "[watch] tracking new matches in " << config().carnageDir << "\n";

    startBotIfConfigured(*db, eloOpt());  // no-op until Phase 5 links the gateway bot

    if (!config().discordResultsWebhookUrl)
        std::cout << "[discord] no DISCORD_RESULTS_WEBHOOK_URL \xE2\x80\x94 per-match posts "
                     "disabled\n";
    if (!config().discordLeaderboardWebhookUrl)
        std::cout << "[discord] no DISCORD_LEADERBOARD_WEBHOOK_URL \xE2\x80\x94 live leaderboard "
                     "disabled\n";

    // Refresh once on startup so the board survives DB edits / a deleted message.
    if (config().discordLeaderboardWebhookUrl) {
        try {
            upsertLeaderboard(config().discordLeaderboardWebhookUrl, *db, eloOpt());
        } catch (const std::exception& e) {
            std::cerr << "[discord] startup leaderboard refresh failed: " << e.what() << "\n";
        }
    }

    std::unordered_map<std::string, long long> seen;

    auto ingest = [&](const std::string& path) -> std::optional<CarnageReport> {
        CarnageReport report;
        try {
            report = parseCarnageFile(path);
        } catch (const std::exception& e) {
            std::cerr << "[skip] " << path << ": " << e.what() << "\n";
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
            std::cerr << "[db] record failed for " << path << ": " << e.what() << "\n";
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
        std::cout << "[match] " << matchLabel(*report) << "\n";

        // Per-player ELO change for the result post — replayed from the
        // recorded history, so it matches exactly what the leaderboard will
        // apply. Best effort: a DB hiccup just posts without the deltas.
        std::map<std::string, double> eloDeltas;
        try {
            eloDeltas = matchEloDeltas(db->matchesChrono(), report->matchId, eloOpt());
        } catch (const std::exception& e) {
            std::cerr << "[elo] delta computation failed: " << e.what() << "\n";
        }

        try {
            postMatchResult(config().discordResultsWebhookUrl, *report,
                            eloDeltas.empty() ? nullptr : &eloDeltas);
        } catch (const std::exception& e) {
            std::cerr << "[discord] result post failed: " << e.what() << "\n";
        }
        try {
            upsertLeaderboard(config().discordLeaderboardWebhookUrl, *db, eloOpt());
        } catch (const std::exception& e) {
            std::cerr << "[discord] leaderboard upsert failed: " << e.what() << "\n";
        }
    };

    SetConsoleCtrlHandler(watchCtrlHandler, TRUE);
    std::cout << "[watch] live on " << config().carnageDir << " \xE2\x80\x94 waiting for matches\xE2\x80\xA6\n";
    std::cout.flush();
    watchDirectory(config().carnageDir, g_watchStop, onFile);
    std::cout << "\n[exit] closing\xE2\x80\xA6\n";
    return 0;
}

// cmdSetup is implemented in setup.cpp.

#ifndef H3_HAVE_GATEWAY
// Phase 4 stub. Replaced by the real gateway bot in Phase 5 (discord_gateway.cpp
// defines H3_HAVE_GATEWAY target-wide, excluding this).
void startBotIfConfigured(Db&, EloOptions) {
    if (!config().discordBotToken)
        std::cout << "[discord] no DISCORD_BOT_TOKEN \xE2\x80\x94 slash commands disabled\n";
    else
        std::cout << "[discord] slash-command bot not built into this binary yet (Phase 5)\n";
}
#endif
