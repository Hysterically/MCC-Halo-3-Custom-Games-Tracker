// Discord Gateway bot over the WebSocket protocol, implemented on libcurl's WS
// API (wss over Schannel — same TLS as the rest of the app, no extra library or
// CA bundle). Reproduces what discord.js does for us: connect, HELLO ->
// heartbeat loop, IDENTIFY, register /leaderboard + /stats, and answer
// INTERACTION_CREATE. Single-threaded event loop (one curl handle is not safe
// for concurrent send/recv) with select()-driven timing for heartbeats.
// Mirrors the bot half of src/discord.ts. First version is IDENTIFY-only with
// reconnect+backoff; RESUME is a later hardening step (see the plan).

#include "discord_gateway.h"

#include <winsock2.h>

#include <curl/curl.h>
#include <curl/websockets.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <ctime>
#include <iostream>
#include <regex>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "aliases.h"
#include "category.h"
#include "config.h"
#include "discord_webhook.h"
#include "format.h"
#include "http.h"
#include "render_csr_leaderboard.h"

using nlohmann::json;

namespace {

const std::string API = "https://discord.com/api/v10";

long long nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

// UTC "YYYY-MM-DD HH:MM" from epoch ms, for the void confirmation.
std::string isoMinute(long long ms) {
    std::time_t t = static_cast<std::time_t>(ms / 1000);
    std::tm tm{};
    gmtime_s(&tm, &t);
    char buf[20];
    std::strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M", &tm);
    return buf;
}

// One-line description of a match for the void confirmation.
std::string matchSummary(const StoredMatch& m) {
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
    return "**" + m.gameTypeName + "** (" + categoryLabel(categorize(m)) + ") \xE2\x80\x94 " +
           roster + " \xE2\x80\x94 played " + isoMinute(m.playedAt) + "Z";
}

// Pull the trailing message id out of a raw id or a "Copy Message Link" URL.
std::string extractMessageId(const std::string& raw) {
    static const std::regex re(R"(\d{5,})");
    std::string last;
    for (auto it = std::sregex_iterator(raw.begin(), raw.end(), re); it != std::sregex_iterator();
         ++it)
        last = it->str();
    return last;
}

class GatewayBot {
public:
    GatewayBot(Db& db, std::string token) : db_(db), token_(std::move(token)) {}

    // Runs forever (until the process exits), reconnecting with backoff.
    void run() {
        int backoff = 1000;
        while (true) {
            try {
                std::string url = getGatewayUrl();
                if (connect(url)) {
                    backoff = 1000;  // healthy connection resets backoff
                    eventLoop();
                }
            } catch (const std::exception& e) {
                std::cerr << "[discord] bot error: " << e.what() << "\n";
            }
            cleanup();
            std::this_thread::sleep_for(std::chrono::milliseconds(backoff));
            backoff = std::min(backoff * 2, 30000);
        }
    }

private:
    Db& db_;
    std::string token_;
    CURL* curl_ = nullptr;

    std::string appId_;
    long long lastSeq_ = 0;
    bool haveSeq_ = false;
    long long heartbeatIntervalMs_ = 0;
    long long nextHeartbeatMs_ = 0;
    long long lastHeartbeatSentMs_ = 0;
    bool heartbeatAcked_ = true;
    bool reconnect_ = false;

    // --- REST -------------------------------------------------------------
    HttpResponse rest(const std::string& method, const std::string& path,
                      const std::string& body = "") {
        return httpRequest(method, API + path,
                           {"Content-Type: application/json", "Authorization: Bot " + token_},
                           body);
    }

    std::string getGatewayUrl() {
        HttpResponse r = rest("GET", "/gateway/bot");
        if (!r.ok()) throw std::runtime_error("GET /gateway/bot HTTP " + std::to_string(r.status));
        std::string url = json::parse(r.body).at("url").get<std::string>();
        return url + "?v=10&encoding=json";
    }

    void registerCommands() {
        json cmds = json::array(
            {{{"name", "leaderboard"}, {"description", "Show the Halo 3 customs CSR leaderboard"},
              {"type", 1}},
             {{"name", "stats"}, {"description", "How many tracked matches are recorded"},
              {"type", 1}},
             {{"name", "delete"},
              {"description",
               "Void a game so it stops counting \xE2\x80\x94 give its #game-results message id"},
              {"type", 1},
              // ManageGuild (0x20) — admins/owner only. Configurable in Server Settings.
              {"default_member_permissions", "32"},
              {"options",
               json::array({{{"name", "game"},
                             {"description", "The #game-results message id (or its link)"},
                             {"type", 3},
                             {"required", true}}})}}});
        std::string path = config().discordGuildId
                               ? "/applications/" + appId_ + "/guilds/" +
                                     *config().discordGuildId + "/commands"
                               : "/applications/" + appId_ + "/commands";
        HttpResponse r = rest("PUT", path, cmds.dump());
        if (!r.ok())
            std::cerr << "[discord] command registration HTTP " << r.status << ": " << r.body
                      << "\n";
    }

    // --- WebSocket transport ---------------------------------------------
    bool connect(const std::string& url) {
        curl_ = curl_easy_init();
        if (!curl_) return false;
        curl_easy_setopt(curl_, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl_, CURLOPT_CONNECT_ONLY, 2L);  // WebSocket handshake, then manual I/O
        curl_easy_setopt(curl_, CURLOPT_USERAGENT, "h3-tracker (https://github.com, 1.0)");
        CURLcode rc = curl_easy_perform(curl_);
        if (rc != CURLE_OK) {
            std::cerr << "[discord] gateway connect failed: " << curl_easy_strerror(rc) << "\n";
            return false;
        }
        // Reset per-connection state.
        appId_.clear();
        heartbeatIntervalMs_ = 0;
        nextHeartbeatMs_ = 0;
        lastHeartbeatSentMs_ = 0;
        heartbeatAcked_ = true;
        reconnect_ = false;
        return true;
    }

    void cleanup() {
        if (curl_) {
            curl_easy_cleanup(curl_);
            curl_ = nullptr;
        }
    }

    void wsSendText(const std::string& s) {
        size_t sent = 0;
        size_t off = 0;
        while (off < s.size()) {
            CURLcode rc = curl_ws_send(curl_, s.data() + off, s.size() - off, &sent, 0,
                                       CURLWS_TEXT);
            if (rc == CURLE_AGAIN) {
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
                continue;
            }
            if (rc != CURLE_OK) {
                reconnect_ = true;
                return;
            }
            off += sent;
        }
    }

    curl_socket_t activeSocket() {
        curl_socket_t sock = CURL_SOCKET_BAD;
        curl_easy_getinfo(curl_, CURLINFO_ACTIVESOCKET, &sock);
        return sock;
    }

    // Read all currently-available WS frames, dispatching each complete text
    // message. Returns false if the connection should be torn down.
    bool drainIncoming() {
        char buf[8192];
        for (;;) {
            size_t rlen = 0;
            const struct curl_ws_frame* meta = nullptr;
            CURLcode rc = curl_ws_recv(curl_, buf, sizeof(buf), &rlen, &meta);
            if (rc == CURLE_AGAIN) return true;  // no more data right now
            if (rc != CURLE_OK) return false;    // closed / error
            if (meta && (meta->flags & CURLWS_CLOSE)) return false;

            msg_.append(buf, rlen);
            // A complete message: nothing left in this frame and not a partial
            // continuation. Discord sends each event as a single text frame.
            if (meta && meta->bytesleft == 0 && !(meta->flags & CURLWS_CONT)) {
                std::string complete;
                complete.swap(msg_);
                handleMessage(complete);
                if (reconnect_) return false;
            }
        }
    }

    void eventLoop() {
        while (!reconnect_) {
            long long now = nowMs();
            long long waitMs = 1000;
            if (heartbeatIntervalMs_ > 0)
                waitMs = std::min<long long>(1000, std::max<long long>(0, nextHeartbeatMs_ - now));

            curl_socket_t sock = activeSocket();
            if (sock == CURL_SOCKET_BAD) return;
            fd_set rfds;
            FD_ZERO(&rfds);
            FD_SET(sock, &rfds);
            timeval tv;
            tv.tv_sec = static_cast<long>(waitMs / 1000);
            tv.tv_usec = static_cast<long>((waitMs % 1000) * 1000);
            int sel = select(0, &rfds, nullptr, nullptr, &tv);
            if (sel == SOCKET_ERROR) return;

            if (sel > 0 && FD_ISSET(sock, &rfds)) {
                if (!drainIncoming()) return;
            }

            // Heartbeat timing.
            if (heartbeatIntervalMs_ > 0 && nowMs() >= nextHeartbeatMs_) {
                if (!heartbeatAcked_) {
                    std::cerr << "[discord] heartbeat not acked — reconnecting\n";
                    return;  // zombie connection
                }
                // Hard anti-flood guard: never send faster than interval/2,
                // independent of nextHeartbeatMs_ scheduling.
                if (nowMs() - lastHeartbeatSentMs_ >= heartbeatIntervalMs_ / 2) {
                    sendHeartbeat();
                    lastHeartbeatSentMs_ = nowMs();
                    heartbeatAcked_ = false;
                }
                nextHeartbeatMs_ = nowMs() + heartbeatIntervalMs_;
            }
        }
    }

    void sendHeartbeat() {
        json hb = {{"op", 1}, {"d", haveSeq_ ? json(lastSeq_) : json(nullptr)}};
        wsSendText(hb.dump());
    }

    void sendIdentify() {
        json id = {{"op", 2},
                   {"d",
                    {{"token", token_},
                     {"intents", 1},  // GatewayIntentBits.Guilds
                     {"properties",
                      {{"os", "windows"}, {"browser", "h3-tracker"}, {"device", "h3-tracker"}}}}}};
        wsSendText(id.dump());
    }

    // --- protocol ---------------------------------------------------------
    void handleMessage(const std::string& text) {
        json p;
        try {
            p = json::parse(text);
        } catch (...) {
            return;
        }
        if (p.contains("s") && p["s"].is_number()) {
            lastSeq_ = p["s"].get<long long>();
            haveSeq_ = true;
        }
        int op = p.value("op", -1);
        if (op == 10) {  // HELLO
            heartbeatIntervalMs_ = p["d"].value("heartbeat_interval", 41250);
            heartbeatAcked_ = true;
            // First heartbeat after interval * jitter (use 0.5 — deterministic).
            nextHeartbeatMs_ = nowMs() + heartbeatIntervalMs_ / 2;
            sendIdentify();
        } else if (op == 11) {  // HEARTBEAT ACK
            heartbeatAcked_ = true;
        } else if (op == 1) {  // server asked for an immediate heartbeat
            sendHeartbeat();
        } else if (op == 7 || op == 9) {  // RECONNECT / INVALID SESSION
            reconnect_ = true;
        } else if (op == 0) {  // DISPATCH
            std::string t = p.value("t", "");
            if (t == "READY") {
                const json& d = p["d"];
                appId_ = d["user"].value("id", "");
                registerCommands();
                std::cout << "[discord] bot online as "
                          << d["user"].value("username", "?") << "; commands registered\n";
            } else if (t == "INTERACTION_CREATE") {
                handleInteraction(p["d"]);
            }
        }
    }

    // Void a game referenced by its #game-results message: drop it from the DB
    // (ELO/leaderboard recompute from history), delete the original post, and
    // refresh the live leaderboard. Returns the public reply text. Gated to
    // Manage Server at registration.
    std::string handleDelete(const json& d) {
        std::string raw;
        if (d.contains("data") && d["data"].contains("options"))
            for (const auto& o : d["data"]["options"])
                if (o.value("name", "") == "game") raw = o.value("value", "");
        std::string msgId = extractMessageId(raw);
        if (msgId.empty()) return "That doesn't look like a message id or link.";

        std::optional<std::string> matchId = db_.matchIdByResultsMsg(msgId);
        if (!matchId)
            return "No tracked game found for that post \xE2\x80\x94 it may predate message "
                   "tracking. Use the `remove-match` CLI on the host for older games.";

        std::string summary = "match `" + *matchId + "`";
        for (const auto& m : db_.matchesChrono())
            if (m.matchId == *matchId) {
                summary = matchSummary(m);
                break;
            }

        db_.deleteMatch(*matchId);
        if (config().discordResultsWebhookUrl)
            deleteWebhookMessage(*config().discordResultsWebhookUrl, msgId);
        try {
            upsertCsrLeaderboard(config().discordLeaderboardWebhookUrl, db_);
        } catch (const std::exception& e) {
            std::cerr << "[discord] leaderboard refresh after delete failed: " << e.what() << "\n";
        }

        return "\xF0\x9F\x97\x91\xEF\xB8\x8F Voided " + summary + ". " +
               std::to_string(db_.matchCount()) + " matches remain.";
    }

    void handleInteraction(const json& d) {
        if (d.value("type", 0) != 2) return;  // APPLICATION_COMMAND
        std::string name = d.contains("data") ? d["data"].value("name", "") : "";
        std::string callback =
            API + "/interactions/" + d.value("id", "") + "/" + d.value("token", "") + "/callback";

        std::string content;
        std::vector<unsigned char> png;
        try {
            if (name == "leaderboard") {
                std::vector<StoredMatch> matches = db_.matchesChrono();
                // PNG standings like the #leaderboard channel; text on failure.
                try {
                    png = renderCsrLeaderboardPng(buildCsrBoardSections(matches));
                } catch (const std::exception& e) {
                    std::cerr << "[discord] leaderboard render failed, falling back to text: "
                              << e.what() << "\n";
                }
                if (png.empty()) content = formatCsrLeaderboard(matches);
            } else if (name == "stats") {
                content = "\xF0\x9F\x93\x8A " + std::to_string(db_.matchCount()) +
                          " tracked Halo 3 custom matches recorded.";
            } else if (name == "delete") {
                content = handleDelete(d);
            }
        } catch (const std::exception& e) {
            std::cerr << "[discord] command error: " << e.what() << "\n";
            content = "Something went wrong.";
        }

        if (!png.empty()) {
            json reply = {{"type", 4},
                          {"data", {{"allowed_mentions", {{"parse", json::array()}}}}}};
            httpPostMultipart(callback, reply.dump(), "files[0]", "leaderboard.png", "image/png",
                              png);
            return;
        }
        if (content.empty()) return;
        json reply = {{"type", 4},
                      {"data", {{"content", content}, {"allowed_mentions", {{"parse", json::array()}}}}}};
        httpRequest("POST", callback, {"Content-Type: application/json"}, reply.dump());
    }

    std::string msg_;  // accumulates partial WS frames
};

}  // namespace

void startBotIfConfigured(Db& db) {
    if (!config().discordBotToken) {
        std::cout << "[discord] no DISCORD_BOT_TOKEN \xE2\x80\x94 slash commands disabled\n";
        return;
    }
    std::string token = *config().discordBotToken;
    std::thread([&db, token]() {
        GatewayBot bot(db, token);
        bot.run();
    }).detach();
}
