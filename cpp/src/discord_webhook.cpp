#include "discord_webhook.h"

#include <regex>
#include <stdexcept>

#include <nlohmann/json.hpp>

#include <iostream>

#include "category.h"
#include "format.h"
#include "http.h"
#include "render_carnage.h"
#include "render_csr_leaderboard.h"
#include "render_leaderboard.h"

using nlohmann::json;

namespace {

const std::vector<std::string> JSON_HDR = {"Content-Type: application/json"};

std::string messageBody(const std::string& content) {
    json j;
    j["content"] = content;
    j["allowed_mentions"] = {{"parse", json::array()}};
    return j.dump();
}

// Edit payload: `attachments: []` drops any previous image, so a text
// fallback also clears a stale PNG (the file part re-adds the new one).
std::string editBody(const std::string& content) {
    json j;
    j["content"] = content;
    j["allowed_mentions"] = {{"parse", json::array()}};
    j["attachments"] = json::array();
    return j.dump();
}

std::string withWait(const std::string& url) {
    return url + (url.find('?') != std::string::npos ? "&" : "?") + "wait=true";
}

// POST with ?wait=true so Discord returns the created message (incl. id).
// With `png` the message is the attachment instead of text content.
std::string postAndReturnId(const std::string& url, const std::string& content,
                            const std::vector<unsigned char>* png = nullptr) {
    HttpResponse r = png ? httpPostMultipart(withWait(url), messageBody(content), "files[0]",
                                             "leaderboard.png", "image/png", *png)
                         : httpRequest("POST", withWait(url), JSON_HDR, messageBody(content));
    if (r.networkError) throw std::runtime_error("Discord webhook POST: " + r.error);
    if (!r.ok())
        throw std::runtime_error("Discord webhook " + std::to_string(r.status) + ": " + r.body);
    return json::parse(r.body).at("id").get<std::string>();
}

// DELETE an existing message. Best-effort; never throws.
void deleteMessage(const std::string& url, const std::string& messageId) {
    httpRequest("DELETE", url + "/messages/" + messageId);
}

// PATCH an existing webhook message. False if it's gone (404); throws on other
// errors; true on success. With `png` the new attachment replaces the old one.
bool editMessage(const std::string& url, const std::string& messageId, const std::string& content,
                 const std::vector<unsigned char>* png = nullptr) {
    std::string msgUrl = url + "/messages/" + messageId;
    HttpResponse r = png ? httpPostMultipart(msgUrl, editBody(content), "files[0]",
                                             "leaderboard.png", "image/png", *png, "PATCH")
                         : httpRequest("PATCH", msgUrl, JSON_HDR, editBody(content));
    if (r.networkError) throw std::runtime_error("Discord webhook edit: " + r.error);
    if (r.status == 404) return false;
    if (!r.ok())
        throw std::runtime_error("Discord webhook edit " + std::to_string(r.status) + ": " + r.body);
    return true;
}

// Stable per-webhook key so changing the URL implicitly resets stored state.
std::string webhookId(const std::string& url) {
    std::smatch m;
    static const std::regex re(R"(/webhooks/(\d+)/)");
    if (std::regex_search(url, m, re)) return m[1].str();
    return url;
}

// Render a single board section to PNG; empty vector if rendering fails.
std::vector<unsigned char> tryRenderSection(const BoardSection& section) {
    try {
        return renderLeaderboardPng({section});
    } catch (const std::exception& e) {
        std::cerr << "[discord] leaderboard render failed, falling back to text: " << e.what()
                  << "\n";
        return {};
    }
}

// Render a single CSR board section to PNG; empty vector if rendering fails.
std::vector<unsigned char> tryRenderCsrSection(const CsrBoardSection& section) {
    try {
        return renderCsrLeaderboardPng({section});
    } catch (const std::exception& e) {
        std::cerr << "[discord] CSR leaderboard render failed, falling back to text: " << e.what()
                  << "\n";
        return {};
    }
}

// Create-or-edit one persistent webhook message tracked under `key`, with the
// same last-writer-wins + atomic-claim race handling the single board used.
void upsertOneMessage(const std::string& url, Db& db, const std::string& key,
                      const std::string& content, const std::vector<unsigned char>* png) {
    std::optional<std::string> existing = db.kvGet(key);

    // Happy path: edit the message we already track.
    if (existing) {
        if (editMessage(url, *existing, content, png)) return;
        // Tracked message is gone (deleted by hand). Recreate and CAS the id.
        std::string replacement = postAndReturnId(url, content, png);
        if (db.kvCas(key, *existing, replacement)) return;
        // Another instance already replaced it — drop ours, edit the survivor.
        deleteMessage(url, replacement);
        if (auto winner = db.kvGet(key)) editMessage(url, *winner, content, png);
        return;
    }

    // No message yet: create one and atomically claim the slot.
    std::string created = postAndReturnId(url, content, png);
    if (db.kvClaim(key, created)) return;
    // Lost the create race — delete our duplicate, edit the one that won.
    deleteMessage(url, created);
    if (auto winner = db.kvGet(key)) editMessage(url, *winner, content, png);
}

// Retire the old single combined-board message (pre-split layout). One-time
// cleanup: delete it and drop its kv slot so a stale all-in-one board doesn't
// linger above the three per-category boards.
void retireCombinedLeaderboard(const std::string& url, Db& db) {
    std::string key = "lb_msg:" + webhookId(url);
    if (auto old = db.kvGet(key)) {
        deleteMessage(url, *old);
        db.kvDelete(key);
    }
}

}  // namespace

void postWebhook(const std::string& url, const std::string& content) {
    HttpResponse r = httpRequest("POST", url, JSON_HDR, messageBody(content));
    if (r.networkError) throw std::runtime_error("Discord webhook POST: " + r.error);
    if (!r.ok())
        throw std::runtime_error("Discord webhook " + std::to_string(r.status) + ": " + r.body);
}

void deleteWebhookMessage(const std::string& url, const std::string& messageId) {
    deleteMessage(url, messageId);
}

// Primary form is the rendered carnage-screen PNG with a short caption; if
// rendering fails for any reason we fall back to the old text table. ?wait=true
// so we capture the created message id — the handle /delete uses to void a game.
std::string postMatchResult(const std::optional<std::string>& url, const CarnageReport& report,
                            const std::map<std::string, EloChange>* eloChanges) {
    if (!url) return "";

    std::vector<unsigned char> png;
    try {
        png = renderCarnagePng(report, eloChanges);
    } catch (const std::exception& e) {
        std::cerr << "[discord] carnage render failed, falling back to text: " << e.what() << "\n";
    }
    if (png.empty()) return postAndReturnId(*url, formatMatchResult(report, eloChanges));

    HttpResponse r = httpPostMultipart(withWait(*url), messageBody(formatMatchCaption(report)),
                                       "files[0]", "carnage.png", "image/png", png);
    if (r.networkError) throw std::runtime_error("Discord webhook POST: " + r.error);
    if (!r.ok())
        throw std::runtime_error("Discord webhook " + std::to_string(r.status) + ": " + r.body);
    return json::parse(r.body).at("id").get<std::string>();
}

// Refresh the live ELO leaderboard (legacy — ELO is retired from the live
// tracker; kept for the dormant analysis path).
void upsertLeaderboard(const std::optional<std::string>& url, Db& db, EloOptions elo) {
    if (!url) return;
    std::vector<StoredMatch> matches = db.matchesChrono();
    // Drop the old single combined message if this webhook still tracks one.
    retireCombinedLeaderboard(*url, db);

    std::string base = webhookId(*url);
    for (Category cat : LEADERBOARD_POST_ORDER) {
        // Primary form is the rendered standings PNG; text section on failure.
        std::vector<unsigned char> pngData = tryRenderSection(buildBoardSection(matches, elo, cat));
        const std::vector<unsigned char>* png = pngData.empty() ? nullptr : &pngData;
        std::string content = png ? "" : formatLeaderboardSection(matches, elo, cat);
        upsertOneMessage(*url, db, "lb_msg:" + base + ":" + categoryKey(cat), content, png);
    }
}

// Primary form is the rendered CSR carnage PNG with a short caption; if rendering
// fails we fall back to the text scoreboard + a CSR line. ?wait=true captures the
// created message id — the handle /delete uses to void a game.
std::string postCsrMatchResult(const std::optional<std::string>& url, const CarnageReport& report,
                               const std::map<std::string, CsrChange>* csrChanges) {
    if (!url) return "";

    std::vector<unsigned char> png;
    try {
        png = renderCarnageCsrPng(report, csrChanges);
    } catch (const std::exception& e) {
        std::cerr << "[discord] CSR carnage render failed, falling back to text: " << e.what()
                  << "\n";
    }
    if (png.empty())
        return postAndReturnId(*url, formatMatchResult(report) + formatCsrLine(report, csrChanges));

    HttpResponse r = httpPostMultipart(withWait(*url), messageBody(formatMatchCaption(report)),
                                       "files[0]", "carnage-csr.png", "image/png", png);
    if (r.networkError) throw std::runtime_error("Discord webhook POST: " + r.error);
    if (!r.ok())
        throw std::runtime_error("Discord webhook " + std::to_string(r.status) + ": " + r.body);
    return json::parse(r.body).at("id").get<std::string>();
}

// Refresh the live CSR leaderboard as THREE persistent messages (one per board
// category), reusing the lb_msg:<webhook>:<cat> slots the ELO board used so CSR
// takes over the existing #leaderboard messages in place. Posted 2v2 -> FFA ->
// 4v4 so the 4v4 board lands at the bottom of the channel. Mirrors
// upsertCsrLeaderboard in src/discord.ts.
void upsertCsrLeaderboard(const std::optional<std::string>& url, Db& db) {
    if (!url) return;
    std::vector<StoredMatch> matches = db.matchesChrono();
    retireCombinedLeaderboard(*url, db);

    std::string base = webhookId(*url);
    for (Category cat : LEADERBOARD_POST_ORDER) {
        std::vector<unsigned char> pngData = tryRenderCsrSection(buildCsrBoardSection(matches, cat));
        const std::vector<unsigned char>* png = pngData.empty() ? nullptr : &pngData;
        std::string content = png ? "" : formatCsrLeaderboardSection(matches, cat);
        upsertOneMessage(*url, db, "lb_msg:" + base + ":" + categoryKey(cat), content, png);
    }
}
