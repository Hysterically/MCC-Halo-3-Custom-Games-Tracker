#include "discord_webhook.h"

#include <regex>
#include <stdexcept>

#include <nlohmann/json.hpp>

#include <iostream>

#include "format.h"
#include "http.h"
#include "render_carnage.h"
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

}  // namespace

void postWebhook(const std::string& url, const std::string& content) {
    HttpResponse r = httpRequest("POST", url, JSON_HDR, messageBody(content));
    if (r.networkError) throw std::runtime_error("Discord webhook POST: " + r.error);
    if (!r.ok())
        throw std::runtime_error("Discord webhook " + std::to_string(r.status) + ": " + r.body);
}

// Primary form is the rendered carnage-screen PNG with a short caption; if
// rendering fails for any reason we fall back to the old text table.
void postMatchResult(const std::optional<std::string>& url, const CarnageReport& report,
                     const std::map<std::string, EloChange>* eloChanges) {
    if (!url) return;

    std::vector<unsigned char> png;
    try {
        png = renderCarnagePng(report, eloChanges);
    } catch (const std::exception& e) {
        std::cerr << "[discord] carnage render failed, falling back to text: " << e.what() << "\n";
    }
    if (png.empty()) {
        postWebhook(*url, formatMatchResult(report, eloChanges));
        return;
    }

    HttpResponse r = httpPostMultipart(*url, messageBody(formatMatchCaption(report)), "files[0]",
                                       "carnage.png", "image/png", png);
    if (r.networkError) throw std::runtime_error("Discord webhook POST: " + r.error);
    if (!r.ok())
        throw std::runtime_error("Discord webhook " + std::to_string(r.status) + ": " + r.body);
}

void upsertLeaderboard(const std::optional<std::string>& url, Db& db, EloOptions elo) {
    if (!url) return;
    std::vector<StoredMatch> matches = db.matchesChrono();

    // Primary form is the rendered standings PNG; if rendering fails for any
    // reason we fall back to the old text table.
    std::vector<unsigned char> pngData;
    try {
        pngData = renderLeaderboardPng(buildBoardSections(matches, elo));
    } catch (const std::exception& e) {
        std::cerr << "[discord] leaderboard render failed, falling back to text: " << e.what()
                  << "\n";
    }
    const std::vector<unsigned char>* png = pngData.empty() ? nullptr : &pngData;
    std::string content = png ? "" : formatLeaderboard(matches, elo);

    std::string key = "lb_msg:" + webhookId(*url);
    std::optional<std::string> existing = db.kvGet(key);

    // Happy path: edit the message we already track.
    if (existing) {
        if (editMessage(*url, *existing, content, png)) return;
        // Tracked message is gone (deleted by hand). Recreate and CAS the id.
        std::string replacement = postAndReturnId(*url, content, png);
        if (db.kvCas(key, *existing, replacement)) return;
        // Another instance already replaced it — drop ours, edit the survivor.
        deleteMessage(*url, replacement);
        if (auto winner = db.kvGet(key)) editMessage(*url, *winner, content, png);
        return;
    }

    // No message yet: create one and atomically claim the slot.
    std::string created = postAndReturnId(*url, content, png);
    if (db.kvClaim(key, created)) return;
    // Lost the create race — delete our duplicate, edit the one that won.
    deleteMessage(*url, created);
    if (auto winner = db.kvGet(key)) editMessage(*url, *winner, content, png);
}
