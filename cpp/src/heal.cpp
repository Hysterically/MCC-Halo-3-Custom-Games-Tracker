#include "heal.h"

#include <algorithm>
#include <chrono>
#include <iostream>
#include <map>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <nlohmann/json.hpp>

#include "carnage.h"
#include "config.h"
#include "format.h"
#include "http.h"
#include "render_carnage.h"
#include "trueskill2.h"
#include "version.h"

using nlohmann::json;

namespace {

constexpr const char* API = "https://discord.com/api/v10";
// Max |message time − recorded_at| for a post to count as that match's.
constexpr long long PAIR_TOLERANCE_MS = 10 * 60'000;
// Pause between edits — webhook buckets allow ~5 requests per 2 s.
constexpr int EDIT_DELAY_MS = 450;

void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

void log(const std::string& m) { std::cout << "[heal] " << m << "\n"; std::cout.flush(); }

// Creation time encoded in a Discord snowflake id.
long long snowflakeMs(const std::string& id) {
    try {
        return static_cast<long long>((std::stoull(id) >> 22) + 1420070400000ULL);
    } catch (...) {
        return 0;
    }
}

// retry_after (seconds) from a 429 body, defaulting to 1s.
int retryAfterMs(const std::string& body) {
    try {
        json j = json::parse(body);
        if (j.contains("retry_after")) return static_cast<int>(j["retry_after"].get<double>() * 1000);
    } catch (...) {
    }
    return 1000;
}

// --- StoredMatch -> CarnageReport (mirrors toReport in src/heal.ts) ----------

CarnageReport fromStoredMatch(const StoredMatch& m) {
    CarnageReport r;
    r.matchId = m.matchId;
    r.gameEnum = GAME_HALO3;
    r.isHalo3 = true;
    r.isMatchmaking = false;
    r.isCustom = true;
    r.teamsEnabled = m.teamsEnabled;
    r.completed = true;
    r.gameTypeName = m.gameTypeName;
    r.playedAtMs = m.playedAt;
    r.mapName = m.mapName;
    r.mapVariant = m.mapVariant;
    r.durationSeconds = m.durationSeconds;
    r.winningTeamId = m.teamsEnabled ? m.winningTeamId : std::nullopt;
    r.tracked = true;
    r.excluded = m.excluded;

    int bestStanding = 1'000'000;
    for (const auto& p : m.players) bestStanding = std::min(bestStanding, p.standing);
    for (const auto& p : m.players) {
        CarnagePlayer cp;
        cp.gamertag = p.gamertag;
        cp.xuid = p.xuid;
        cp.teamId = p.teamId;
        cp.score = p.score;
        cp.standing = p.standing;
        cp.kills = p.kills;
        cp.deaths = p.deaths;
        cp.assists = p.assists;
        cp.completedGame = true;
        r.players.push_back(std::move(cp));
        // Winners: the stored winning team, or in FFA whoever holds the best
        // (lowest) standing — same rule as parseCarnage.decideWinner.
        bool isWinner = m.teamsEnabled ? (m.winningTeamId && p.teamId == *m.winningTeamId)
                                       : (p.standing == bestStanding);
        if (isWinner) r.winners.push_back(p.gamertag);
    }
    return r;
}

// --- Discord plumbing --------------------------------------------------------

struct ChannelMessage {
    std::string id;
};

// Bot-authenticated GET with 429 retry. Throws on 403 / other errors.
HttpResponse botGet(const std::string& path, const std::string& botToken) {
    for (;;) {
        HttpResponse r =
            httpRequest("GET", std::string(API) + path, {"Authorization: Bot " + botToken});
        if (r.status == 429) {
            sleepMs(retryAfterMs(r.body));
            continue;
        }
        if (r.status == 403)
            throw std::runtime_error(
                "bot lacks access to the results channel — give it View Channel + Read Message "
                "History there");
        if (r.networkError) throw std::runtime_error("GET " + path + ": " + r.error);
        if (!r.ok())
            throw std::runtime_error("GET " + path + " -> " + std::to_string(r.status) + ": " +
                                     r.body);
        return r;
    }
}

// All messages the results webhook posted in its channel, oldest first.
std::vector<ChannelMessage> fetchWebhookMessages(const std::string& webhookUrl,
                                                 const std::string& botToken) {
    // The webhook URL itself (GET, no auth beyond its token) yields id + channel.
    HttpResponse hookRes = httpRequest("GET", webhookUrl);
    if (hookRes.networkError || !hookRes.ok())
        throw std::runtime_error("webhook lookup failed: " + std::to_string(hookRes.status));
    json hook = json::parse(hookRes.body);
    std::string hookId = hook.at("id").get<std::string>();
    std::string channelId = hook.at("channel_id").get<std::string>();

    std::vector<ChannelMessage> ours;
    std::string before;
    for (;;) {
        std::string path = "/channels/" + channelId + "/messages?limit=100";
        if (!before.empty()) path += "&before=" + before;
        json page = json::parse(botGet(path, botToken).body);
        if (!page.is_array() || page.empty()) break;
        for (const auto& mEntry : page) {
            std::string author =
                mEntry.contains("author") && mEntry["author"].contains("id")
                    ? mEntry["author"]["id"].get<std::string>()
                    : "";
            if (author == hookId) ours.push_back({mEntry.at("id").get<std::string>()});
        }
        before = page.back().at("id").get<std::string>();
    }
    std::sort(ours.begin(), ours.end(), [](const ChannelMessage& a, const ChannelMessage& b) {
        return std::stoull(a.id) < std::stoull(b.id);
    });
    return ours;
}

// PATCH one result post: new caption, old attachment replaced by the fresh PNG.
// Returns false if the message vanished since we listed it (404).
bool editResultMessage(const std::string& webhookUrl, const std::string& messageId,
                       const std::string& caption, const std::vector<std::uint8_t>& png) {
    json payload;
    payload["content"] = caption;
    payload["attachments"] = json::array({json{{"id", 0}}});  // keep ONLY files[0]
    payload["allowed_mentions"] = {{"parse", json::array()}};
    std::string msgUrl = webhookUrl + "/messages/" + messageId;
    for (;;) {
        HttpResponse r = httpPostMultipart(msgUrl, payload.dump(), "files[0]", "carnage.png",
                                           "image/png", png, "PATCH");
        if (r.status == 429) {
            sleepMs(retryAfterMs(r.body));
            continue;
        }
        if (r.status == 404) return false;
        if (r.networkError) throw std::runtime_error("edit " + messageId + ": " + r.error);
        if (!r.ok())
            throw std::runtime_error("edit " + messageId + " -> " + std::to_string(r.status) + ": " +
                                     r.body);
        return true;
    }
}

// --- Tier B: adopt orphan posts ----------------------------------------------

// Pair the webhook's channel history to matches by recorded_at (two-pointer) and
// backfill results_msg_id on each newly-paired row. Needs the bot token; a no-op
// without it. Returns how many were adopted.
int adoptOrphanPosts(Db& db, const std::vector<StoredMatch>& chrono) {
    const auto& webhook = config().discordResultsWebhookUrl;
    const auto& botToken = config().discordBotToken;
    if (!webhook || !botToken) return 0;

    std::vector<ChannelMessage> messages = fetchWebhookMessages(*webhook, *botToken);
    std::unordered_map<std::string, long long> recordedAt = db.recordedAtByMatch();
    std::unordered_set<std::string> haveMsg;
    for (const auto& t : db.resultsRestyleTargets(0, /*force=*/true)) haveMsg.insert(t.matchId);

    std::vector<const StoredMatch*> byRecorded;
    byRecorded.reserve(chrono.size());
    for (const auto& m : chrono) byRecorded.push_back(&m);
    std::sort(byRecorded.begin(), byRecorded.end(),
              [&](const StoredMatch* a, const StoredMatch* b) {
                  long long ra = recordedAt.count(a->matchId) ? recordedAt[a->matchId] : 0;
                  long long rb = recordedAt.count(b->matchId) ? recordedAt[b->matchId] : 0;
                  return ra < rb;
              });

    int adopted = 0;
    size_t i = 0, j = 0;
    while (i < messages.size() && j < byRecorded.size()) {
        long long msgMs = snowflakeMs(messages[i].id);
        const StoredMatch* match = byRecorded[j];
        long long recMs = recordedAt.count(match->matchId) ? recordedAt[match->matchId] : 0;
        if (std::llabs(msgMs - recMs) <= PAIR_TOLERANCE_MS) {
            if (!haveMsg.count(match->matchId)) {
                db.setMatchResultsMsg(match->matchId, messages[i].id);
                ++adopted;
            }
            ++i;
            ++j;
        } else if (recMs < msgMs) {
            ++j;
        } else {
            ++i;
        }
    }
    if (adopted)
        log("adopted " + std::to_string(adopted) + " legacy post" + (adopted == 1 ? "" : "s") +
            " (backfilled message ids)");
    return adopted;
}

}  // namespace

HealStats healStaleResults(Db& db, bool force) {
    HealStats stats;
    const auto& webhook = config().discordResultsWebhookUrl;
    if (!webhook) return stats;

    std::vector<StoredMatch> chrono = db.matchesChrono();
    std::unordered_map<std::string, const StoredMatch*> byId;
    for (const auto& m : chrono) byId[m.matchId] = &m;

    try {
        stats.adopted = adoptOrphanPosts(db, chrono);
    } catch (const std::exception& e) {
        log(std::string("history scan failed: ") + e.what());
    }

    std::vector<RestyleTarget> targets = db.resultsRestyleTargets(RESULTS_FMT_VERSION, force);
    if (targets.empty()) return stats;

    log("re-styling " + std::to_string(targets.size()) + " post" +
        (targets.size() == 1 ? "" : "s") + " to format v" + std::to_string(RESULTS_FMT_VERSION) +
        "\xE2\x80\xA6");
    for (const auto& t : targets) {
        auto it = byId.find(t.matchId);
        if (it == byId.end()) continue;  // match deleted between query and now
        std::map<std::string, CsrChange> changes = matchCsrChanges(chrono, t.matchId);
        try {
            CarnageReport report = fromStoredMatch(*it->second);
            std::vector<std::uint8_t> png =
                renderCarnageCsrPng(report, changes.empty() ? nullptr : &changes);
            bool ok = editResultMessage(*webhook, t.msgId, formatMatchCaption(report), png);
            if (ok) {
                db.setMatchResultsFmt(t.matchId, RESULTS_FMT_VERSION);
                ++stats.restyled;
            } else {
                db.clearMatchResultsMsg(t.matchId);  // 404 — the post is gone
                ++stats.gone;
            }
        } catch (const std::exception& e) {
            log("failed to re-style " + t.matchId + ": " + e.what());
        }
        sleepMs(EDIT_DELAY_MS);
    }
    log("re-styled " + std::to_string(stats.restyled) + " post" +
        (stats.restyled == 1 ? "" : "s") +
        (stats.gone ? ", " + std::to_string(stats.gone) + " had vanished" : "") + ".");
    return stats;
}

std::string restyleResultPost(Db& db, const std::string& matchId, const std::string& msgId) {
    const auto& webhook = config().discordResultsWebhookUrl;
    if (!webhook) return "skipped";

    std::vector<StoredMatch> chrono = db.matchesChrono();
    const StoredMatch* match = nullptr;
    for (const auto& m : chrono)
        if (m.matchId == matchId) {
            match = &m;
            break;
        }
    if (!match) return "skipped";

    std::map<std::string, CsrChange> changes = matchCsrChanges(chrono, matchId);
    CarnageReport report = fromStoredMatch(*match);
    std::vector<std::uint8_t> png =
        renderCarnageCsrPng(report, changes.empty() ? nullptr : &changes);
    bool ok = editResultMessage(*webhook, msgId, formatMatchCaption(report), png);
    if (ok) {
        db.setMatchResultsFmt(matchId, RESULTS_FMT_VERSION);
        return "restyled";
    }
    db.clearMatchResultsMsg(matchId);
    return "gone";
}
