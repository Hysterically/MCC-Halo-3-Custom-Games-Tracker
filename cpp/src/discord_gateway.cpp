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
#include <cmath>
#include <cstdio>
#include <ctime>
#include <iostream>
#include <optional>
#include <regex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <nlohmann/json.hpp>

#include "aliases.h"
#include "category.h"
#include "config.h"
#include "discord_webhook.h"
#include "format.h"
#include "heal.h"
#include "http.h"
#include "render_csr_leaderboard.h"
#include "status_bar.h"
#include "util.h"

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

// ISO-8601 week ("W01".."W53") of `t`, using the date's LOCAL calendar Y/M/D
// reinterpreted at UTC midnight — byte-identical to isoWeek in src/discord.ts
// (which builds Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).
std::string isoWeek(std::time_t t) {
    std::tm local{};
    localtime_s(&local, &t);
    std::tm utcMidnight{};
    utcMidnight.tm_year = local.tm_year;
    utcMidnight.tm_mon = local.tm_mon;
    utcMidnight.tm_mday = local.tm_mday;
    // UTC-midnight epoch for that calendar day.
    std::time_t dayT = _mkgmtime(&utcMidnight);

    std::tm day{};
    gmtime_s(&day, &dayT);
    int wday = day.tm_wday == 0 ? 7 : day.tm_wday;  // Sun(0)->7

    // Shift to the Thursday of this ISO week (UTC date + 4 - day).
    std::tm thursTm = utcMidnight;
    thursTm.tm_mday += 4 - wday;
    std::time_t thursT = _mkgmtime(&thursTm);
    std::tm thurs{};
    gmtime_s(&thurs, &thursT);

    std::tm yearStartTm{};
    yearStartTm.tm_year = thurs.tm_year;
    yearStartTm.tm_mon = 0;
    yearStartTm.tm_mday = 1;
    std::time_t yearStartT = _mkgmtime(&yearStartTm);

    double days = static_cast<double>(thursT - yearStartT) / 86400.0;
    int week = static_cast<int>(std::ceil((days + 1.0) / 7.0));
    char buf[8];
    std::snprintf(buf, sizeof(buf), "W%02d", week);
    return buf;
}

// Local-time ISO-ish stamp stored as the recap-claim value (only its presence
// matters; the TS stores now.toISOString()).
std::string isoTimestampLocal(std::time_t t) {
    std::tm tm{};
    gmtime_s(&tm, &t);
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buf;
}

// Split a webhook URL into its id + token (the two path segments after
// /webhooks/). Empty strings if it doesn't match. Mirrors parseWebhookUrl in
// src/discord.ts.
bool parseWebhookUrl(const std::string& url, std::string& id, std::string& token) {
    static const std::regex re(R"(/webhooks/(\d+)/([\w-]+))");
    std::smatch m;
    if (!std::regex_search(url, m, re)) return false;
    id = m[1].str();
    token = m[2].str();
    return true;
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
    bool recapStarted_ = false;  // recap scheduler thread launched once

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
             {{"name", "stats"},
              {"description",
               "Per-player CSR, rank, W-L-D and K/D \xE2\x80\x94 or the match count if no player "
               "given"},
              {"type", 1},
              {"options",
               json::array({{{"name", "player"},
                             {"description", "Gamertag or display name (partial works)"},
                             {"type", 3},
                             {"required", false},
                             {"autocomplete", true}}})}},
             {{"name", "delete"},
              {"description",
               "Void a game so it stops counting \xE2\x80\x94 pick it or give its message id"},
              {"type", 1},
              // ManageGuild (0x20) — admins/owner only. Configurable in Server Settings.
              {"default_member_permissions", "32"},
              {"options",
               json::array({{{"name", "game"},
                             {"description",
                              "Pick a recent game, or paste its #game-results message id / link"},
                             {"type", 3},
                             {"required", true},
                             {"autocomplete", true}}})}},
             {{"name", "exclude"},
              {"description",
               "Drop a game from the boards but keep its post (off-format) \xE2\x80\x94 pick it or "
               "give its id"},
              {"type", 1},
              {"default_member_permissions", "32"},
              {"options",
               json::array({{{"name", "game"},
                             {"description",
                              "Pick a recent game, or paste its #game-results message id / link"},
                             {"type", 3},
                             {"required", true},
                             {"autocomplete", true}},
                            {{"name", "restore"},
                             {"description", "Undo: count the game again (default false)"},
                             {"type", 5},
                             {"required", false}}})}}});
        std::string path = config().discordGuildId
                               ? "/applications/" + appId_ + "/guilds/" +
                                     *config().discordGuildId + "/commands"
                               : "/applications/" + appId_ + "/commands";
        HttpResponse r = rest("PUT", path, cmds.dump());
        if (!r.ok())
            std::cerr << "[discord] command registration HTTP " << r.status << ": " << r.body
                      << "\n";
    }

    // --- app-owned results webhook (buttons) -----------------------------
    // Interactive components (Void/Exclude) are dropped by Discord on a plain
    // incoming webhook — only an application-owned webhook carries them. Find-or-
    // create our own webhook in the results channel; cache its URL in shared kv
    // (results_app_webhook) so every instance + the watcher converge. Idempotent.
    // Mirrors ensureAppResultsWebhook in src/discord.ts. Returns true if usable.
    bool ensureAppResultsWebhook() {
        if (db_.kvGet(APP_WEBHOOK_KEY)) return true;
        const auto& base = config().discordResultsWebhookUrl;
        if (!base) return false;
        std::string id, token;
        if (!parseWebhookUrl(*base, id, token)) return false;
        try {
            // The token route needs no auth and tells us which channel to target.
            HttpResponse metaRes = httpRequest("GET", API + "/webhooks/" + id + "/" + token);
            if (!metaRes.ok()) return false;
            std::string channelId =
                json::parse(metaRes.body).value("channel_id", std::string());
            if (channelId.empty()) return false;

            // Reuse our existing app-owned webhook in that channel, else create one.
            HttpResponse listRes = rest("GET", "/channels/" + channelId + "/webhooks");
            if (!listRes.ok()) return false;
            json hooks = json::parse(listRes.body);
            json hook;
            if (hooks.is_array())
                for (const auto& h : hooks)
                    if (h.value("application_id", std::string()) == appId_ &&
                        h.contains("token") && !h["token"].is_null()) {
                        hook = h;
                        break;
                    }
            if (hook.is_null()) {
                HttpResponse createRes =
                    rest("POST", "/channels/" + channelId + "/webhooks",
                         json{{"name", "H3 Tracker"}}.dump());
                if (!createRes.ok()) return false;
                hook = json::parse(createRes.body);
            }
            if (!hook.contains("token") || hook["token"].is_null()) return false;
            std::string url = API + "/webhooks/" + hook.value("id", std::string()) + "/" +
                              hook["token"].get<std::string>();
            db_.kvClaim(APP_WEBHOOK_KEY, url);  // converge across instances
            return db_.kvGet(APP_WEBHOOK_KEY).has_value();
        } catch (...) {
            return false;  // best-effort: no buttons, fall back to the plain webhook
        }
    }

    // --- weekly recap ----------------------------------------------------
    // Post the weekly recap on Sundays from 20:00 local, once per ISO week (a
    // detached thread waking hourly). Mirrors startRecapScheduler in src/discord.ts.
    void startRecapScheduler() {
        if (!config().discordResultsWebhookUrl) return;
        std::thread([&db = db_] {
            for (;;) {
                try {
                    std::time_t now = std::time(nullptr);
                    std::tm local{};
                    localtime_s(&local, &now);
                    if (local.tm_wday == 0 && local.tm_hour >= 20) {  // Sunday evening
                        std::optional<json> embed = recapEmbed(db.matchesChrono());
                        if (embed) {
                            std::tm utc{};
                            gmtime_s(&utc, &now);
                            char weekKey[48];
                            std::snprintf(weekKey, sizeof(weekKey), "recap:%d-%s",
                                          1900 + utc.tm_year, isoWeek(now).c_str());
                            // kvClaim is atomic: only one instance posts per week.
                            if (db.kvClaim(weekKey, isoTimestampLocal(now))) {
                                json body = {{"embeds", json::array({*embed})},
                                             {"allowed_mentions", {{"parse", json::array()}}}};
                                httpRequest("POST", *config().discordResultsWebhookUrl,
                                            {"Content-Type: application/json"}, body.dump());
                                std::cout << "[recap] posted weekly recap\n";
                            }
                        }
                    }
                } catch (const std::exception& e) {
                    std::cerr << "[recap] weekly recap failed: " << e.what() << "\n";
                }
                std::this_thread::sleep_for(std::chrono::hours(1));
            }
        }).detach();
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
                term::statusBar().setBot(term::Bot::Online);
                // Provision our own webhook in the results channel so per-match
                // posts can carry the Void/Exclude buttons (plain webhooks strip
                // components). Idempotent (kv-cached); safe to call each READY.
                if (config().discordResultsWebhookUrl) {
                    if (ensureAppResultsWebhook())
                        std::cout
                            << "[discord] results buttons enabled (app-owned webhook)\n";
                }
                if (!recapStarted_) {
                    recapStarted_ = true;
                    startRecapScheduler();
                }
            } else if (t == "INTERACTION_CREATE") {
                handleInteraction(p["d"]);
            }
        }
    }

    // One-line summary for the void/exclude confirmation, or a fallback if the
    // match isn't in history.
    std::string summaryFor(const std::string& matchId) {
        for (const auto& m : db_.matchesChrono())
            if (m.matchId == matchId) return matchSummary(m);
        return "match `" + matchId + "`";
    }

    // Void a match: drop it from the DB (CSR/leaderboard recompute from history),
    // delete its #game-results post (trying each candidate webhook), refresh the
    // live leaderboard, and force-restyle later posts in the background (a deleted
    // game shifts every later CSR change). Returns the confirmation text. Shared by
    // the /delete command and the Void button. Mirrors voidMatch in src/discord.ts.
    std::string voidMatch(const std::string& matchId, const std::string& msgId) {
        std::string summary = summaryFor(matchId);

        db_.deleteMatch(matchId);
        for (const auto& url : resultsWebhookCandidates(db_)) deleteWebhookMessage(url, msgId);
        try {
            upsertCsrLeaderboard(config().discordLeaderboardWebhookUrl, db_);
        } catch (const std::exception& e) {
            std::cerr << "[discord] leaderboard refresh after delete failed: " << e.what() << "\n";
        }

        // Deleting a game shifts the CSR timeline for every later match, so the
        // frozen change labels on those #game-results posts are now stale.
        // Force-re-style all tracked posts in the background so they resync with
        // the recomputed CSR — no manual `restyle` needed. Best-effort; detached
        // so the interaction reply isn't held up by the rate-limited edits.
        std::thread([&db = db_] {
            try {
                healStaleResults(db, /*force=*/true);
            } catch (const std::exception& e) {
                std::cerr << "[discord] post-delete restyle failed: " << e.what() << "\n";
            }
        }).detach();

        return "\xF0\x9F\x97\x91\xEF\xB8\x8F Voided " + summary + ". " +
               std::to_string(db_.matchCount()) + " matches remain.";
    }

    // Exclude (or, with restore=true, re-include) a match: flip its excluded flag
    // so it drops off / rejoins every board (CSR recomputes from history), re-style
    // its post in place, and refresh the live leaderboard. The match + post are
    // kept. Shared by /exclude and the Exclude button. Mirrors excludeMatch in
    // src/discord.ts.
    std::string excludeMatch(const std::string& matchId, const std::string& msgId, bool restore) {
        std::string summary = summaryFor(matchId);

        db_.setMatchExcluded(matchId, !restore);
        try {
            restyleResultPost(db_, matchId, msgId);
        } catch (const std::exception& e) {
            std::cerr << "[discord] result re-style after exclude failed: " << e.what() << "\n";
        }
        try {
            upsertCsrLeaderboard(config().discordLeaderboardWebhookUrl, db_);
        } catch (const std::exception& e) {
            std::cerr << "[discord] leaderboard refresh after exclude failed: " << e.what() << "\n";
        }

        return restore ? "\xE2\x9C\x85 Restored " + summary +
                             " \xE2\x80\x94 it counts toward the leaderboard again."
                       : "\xF0\x9F\x9A\xAB Excluded " + summary +
                             " from the leaderboards (kept as an off-format post).";
    }

    // Void a game referenced by its #game-results message: resolve the post to a
    // match, then run the shared core. Returns the reply text. Gated to Manage
    // Server at registration.
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
        return voidMatch(*matchId, msgId);
    }

    // Exclude (or, with restore=true, re-include) a game referenced by its
    // #game-results post: resolve it to a match, then run the shared core.
    std::string handleExclude(const json& d) {
        std::string raw;
        bool restore = false;
        if (d.contains("data") && d["data"].contains("options"))
            for (const auto& o : d["data"]["options"]) {
                if (o.value("name", "") == "game") raw = o.value("value", "");
                if (o.value("name", "") == "restore") restore = o.value("value", false);
            }
        std::string msgId = extractMessageId(raw);
        if (msgId.empty()) return "That doesn't look like a message id or link.";

        std::optional<std::string> matchId = db_.matchIdByResultsMsg(msgId);
        if (!matchId)
            return "No tracked game found for that post \xE2\x80\x94 it may predate message "
                   "tracking. Use the `exclude-match` CLI on the host for older games.";
        return excludeMatch(*matchId, msgId, restore);
    }

    // POST a type-4 (CHANNEL_MESSAGE_WITH_SOURCE) JSON reply. `ephemeral` adds the
    // MessageFlags.Ephemeral (64) bit so only the invoker sees it.
    void replyText(const std::string& callback, const std::string& content, bool ephemeral) {
        json data = {{"content", content}, {"allowed_mentions", {{"parse", json::array()}}}};
        if (ephemeral) data["flags"] = 64;
        json reply = {{"type", 4}, {"data", data}};
        httpRequest("POST", callback, {"Content-Type: application/json"}, reply.dump());
    }

    // The focused option's current value (the text the user has typed so far).
    std::string focusedValue(const json& d) {
        if (d.contains("data") && d["data"].contains("options"))
            for (const auto& o : d["data"]["options"])
                if (o.value("focused", false)) return o.value("value", "");
        return "";
    }
    std::string focusedName(const json& d) {
        if (d.contains("data") && d["data"].contains("options"))
            for (const auto& o : d["data"]["options"])
                if (o.value("focused", false)) return o.value("name", "");
        return "";
    }

    // type 4 = APPLICATION_COMMAND_AUTOCOMPLETE. Reply with up to 25 choices
    // (callback type 8). Mirrors handleAutocomplete in src/discord.ts.
    void handleAutocomplete(const json& d, const std::string& callback) {
        std::string field = focusedName(d);
        std::string q = util::toLower(focusedValue(d));
        std::vector<StoredMatch> matches = db_.matchesChrono();
        json choices = json::array();

        if (field == "player") {
            // Distinct display names, substring-filtered, ≤25, first-seen order.
            std::unordered_set<std::string> seen;
            for (const auto& m : matches) {
                if (choices.size() >= 25) break;
                for (const auto& p : m.players) {
                    if (p.xuid.empty()) continue;
                    std::string n = displayName(p.gamertag);
                    if (seen.count(n)) continue;
                    seen.insert(n);
                    if (util::toLower(n).find(q) == std::string::npos) continue;
                    choices.push_back({{"name", n}, {"value", n}});
                    if (choices.size() >= 25) break;
                }
            }
        } else if (field == "game") {
            // Recent tracked games (have a results msg id), newest-first by
            // playedAt, labelled + substring-filtered, ≤25. Value is the msg id.
            std::unordered_map<std::string, std::string> msgByMatch;
            for (const auto& t : db_.resultsRestyleTargets(0, /*force=*/true))
                msgByMatch[t.matchId] = t.msgId;
            std::vector<const StoredMatch*> tracked;
            for (const auto& m : matches)
                if (msgByMatch.count(m.matchId)) tracked.push_back(&m);
            std::sort(tracked.begin(), tracked.end(),
                      [](const StoredMatch* a, const StoredMatch* b) {
                          return a->playedAt > b->playedAt;  // newest first
                      });
            for (const auto* m : tracked) {
                std::string label = matchChoiceLabel(*m);
                if (util::toLower(label).find(q) == std::string::npos) continue;
                choices.push_back({{"name", label}, {"value", msgByMatch[m->matchId]}});
                if (choices.size() >= 25) break;
            }
        }

        json reply = {{"type", 8}, {"data", {{"choices", choices}}}};
        httpRequest("POST", callback, {"Content-Type: application/json"}, reply.dump());
    }

    // type 3 = MESSAGE_COMPONENT (a Void/Exclude button click). Gated to Manage
    // Server (component interactions carry no default_member_permissions, so we
    // check member.permissions manually). Replies ephemerally. Mirrors handleButton
    // in src/discord.ts.
    void handleButton(const json& d, const std::string& callback) {
        // member.permissions is a decimal-string bitfield; 0x20 = ManageGuild.
        unsigned long long perms = 0;
        if (d.contains("member") && d["member"].contains("permissions")) {
            try {
                perms = std::stoull(d["member"]["permissions"].get<std::string>());
            } catch (...) {
                perms = 0;
            }
        }
        if (!(perms & 0x20ULL)) {
            replyText(callback, "You need the Manage Server permission to do that.", true);
            return;
        }

        std::string customId = d.contains("data") ? d["data"].value("custom_id", "") : "";
        auto colon = customId.find(':');
        std::string action = colon == std::string::npos ? customId : customId.substr(0, colon);
        std::string matchId = colon == std::string::npos ? "" : customId.substr(colon + 1);
        std::string msgId = d.contains("message") ? d["message"].value("id", "") : "";

        std::string reply;
        try {
            reply = action == "void" ? voidMatch(matchId, msgId)
                                     : excludeMatch(matchId, msgId, /*restore=*/false);
        } catch (const std::exception& e) {
            std::cerr << "[discord] button error: " << e.what() << "\n";
            reply = "Something went wrong.";
        }
        replyText(callback, reply, true);
    }

    void handleInteraction(const json& d) {
        std::string callback =
            API + "/interactions/" + d.value("id", "") + "/" + d.value("token", "") + "/callback";
        int type = d.value("type", 0);
        if (type == 4) {  // APPLICATION_COMMAND_AUTOCOMPLETE
            try {
                handleAutocomplete(d, callback);
            } catch (const std::exception& e) {
                std::cerr << "[discord] autocomplete error: " << e.what() << "\n";
            }
            return;
        }
        if (type == 3) {  // MESSAGE_COMPONENT (button)
            handleButton(d, callback);
            return;
        }
        if (type != 2) return;  // APPLICATION_COMMAND

        std::string name = d.contains("data") ? d["data"].value("name", "") : "";
        try {
            if (name == "leaderboard") {
                std::vector<StoredMatch> matches = db_.matchesChrono();
                std::vector<unsigned char> png;
                // PNG standings like the #leaderboard channel; text on failure.
                try {
                    png = renderCsrLeaderboardPng(buildCsrBoardSections(matches));
                } catch (const std::exception& e) {
                    std::cerr << "[discord] leaderboard render failed, falling back to text: "
                              << e.what() << "\n";
                }
                if (!png.empty()) {
                    json reply = {
                        {"type", 4},
                        {"data",
                         {{"embeds", json::array({leaderboardEmbed()})},
                          {"allowed_mentions", {{"parse", json::array()}}}}}};
                    httpPostMultipart(callback, reply.dump(), "files[0]", "leaderboard.png",
                                      "image/png", png);
                } else {
                    replyText(callback, formatCsrLeaderboard(matches), false);
                }
            } else if (name == "stats") {
                std::string query;
                if (d.contains("data") && d["data"].contains("options"))
                    for (const auto& o : d["data"]["options"])
                        if (o.value("name", "") == "player") query = o.value("value", "");
                if (!query.empty()) {
                    json out = csrPlayerStatsEmbed(db_.matchesChrono(), query);
                    json data = {{"allowed_mentions", {{"parse", json::array()}}}};
                    if (out.contains("embed"))
                        data["embeds"] = json::array({out["embed"]});
                    else
                        data["content"] = out.value("content", "");
                    json reply = {{"type", 4}, {"data", data}};
                    httpRequest("POST", callback, {"Content-Type: application/json"}, reply.dump());
                } else {
                    replyText(callback,
                              "\xF0\x9F\x93\x8A " + std::to_string(db_.matchCount()) +
                                  " tracked Halo 3 custom matches recorded.",
                              false);
                }
            } else if (name == "delete") {
                replyText(callback, handleDelete(d), true);  // admin reply — ephemeral
            } else if (name == "exclude") {
                replyText(callback, handleExclude(d), true);
            }
        } catch (const std::exception& e) {
            std::cerr << "[discord] command error: " << e.what() << "\n";
            replyText(callback, "Something went wrong.", true);
        }
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
