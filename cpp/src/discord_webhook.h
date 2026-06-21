// Discord delivery over plain webhooks (no gateway): a per-match summary to the
// results channel, and a single leaderboard message edited in place. All
// no-ops if the URL is not configured. Mirrors the webhook half of
// src/discord.ts.
#pragma once
#include <map>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "carnage.h"
#include "db.h"
#include "elo.h"
#include "trueskill2.h"

// Plain POST — fire and forget. Throws std::runtime_error on a non-2xx.
void postWebhook(const std::string& url, const std::string& content);

// Post a per-match ELO summary (legacy — ELO is retired from the live tracker).
std::string postMatchResult(const std::optional<std::string>& url, const CarnageReport& report,
                            const std::map<std::string, EloChange>* eloChanges = nullptr);

// Post a per-match CSR (TrueSkill 2) summary to the results channel (no-op if no
// URL): the carnage-screen PNG with the CSR column, text fallback otherwise.
// Returns the created Discord message id so the match can be voided via /delete.
// `components` (a Discord components array, e.g. the Void/Exclude action row) is
// attached only when non-null — a plain incoming webhook silently drops them, so
// only the app-owned webhook should pass them.
std::string postCsrMatchResult(const std::optional<std::string>& url, const CarnageReport& report,
                               const std::map<std::string, CsrChange>* csrChanges = nullptr,
                               const MatchWinChances* win = nullptr,
                               const nlohmann::json* components = nullptr);

// Post a per-match result with the Void/Exclude buttons when an app-owned webhook
// is available (it carries components; a plain webhook can't), else a plain post
// to the configured results webhook. The watcher's entry point — resolves the
// right webhook + buttons. Returns the created message id. Mirrors
// postCsrMatchResultWithControls in src/discord.ts.
std::string postCsrMatchResultWithControls(Db& db, const CarnageReport& report,
                                           const std::map<std::string, CsrChange>* csrChanges = nullptr,
                                           const MatchWinChances* win = nullptr);

// The kv key under which the app-owned results webhook URL is cached. MUST stay
// byte-identical to src/discord.ts (APP_WEBHOOK_KEY).
inline constexpr const char* APP_WEBHOOK_KEY = "results_app_webhook";

// The Void / Exclude action row for a results post, keyed by match id. Mirrors
// matchButtons in src/discord.ts.
nlohmann::json matchButtons(const std::string& matchId);

// Webhook URLs that may have authored a results post, app-owned first, then the
// user webhook from config (if different). An edit/delete tries each (404 →
// next). Mirrors resultsWebhookCandidates in src/discord.ts.
std::vector<std::string> resultsWebhookCandidates(Db& db);

// DELETE an existing webhook message. Best-effort.
void deleteWebhookMessage(const std::string& url, const std::string& messageId);

// Refresh the live ELO leaderboard (legacy — dormant).
void upsertLeaderboard(const std::optional<std::string>& url, Db& db, EloOptions elo);

// Refresh the live CSR leaderboard as THREE persistent messages (one per board
// category) edited in place, reusing the lb_msg:<webhook>:<cat> slots the ELO
// board used so CSR takes over the existing #leaderboard messages. No-op if no
// URL. Mirrors upsertCsrLeaderboard in src/discord.ts.
void upsertCsrLeaderboard(const std::optional<std::string>& url, Db& db);
