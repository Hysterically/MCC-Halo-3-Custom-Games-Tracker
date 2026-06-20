// Discord delivery over plain webhooks (no gateway): a per-match summary to the
// results channel, and a single leaderboard message edited in place. All
// no-ops if the URL is not configured. Mirrors the webhook half of
// src/discord.ts.
#pragma once
#include <map>
#include <optional>
#include <string>

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
std::string postCsrMatchResult(const std::optional<std::string>& url, const CarnageReport& report,
                               const std::map<std::string, CsrChange>* csrChanges = nullptr,
                               const MatchWinChances* win = nullptr);

// DELETE an existing webhook message. Best-effort.
void deleteWebhookMessage(const std::string& url, const std::string& messageId);

// Refresh the live ELO leaderboard (legacy — dormant).
void upsertLeaderboard(const std::optional<std::string>& url, Db& db, EloOptions elo);

// Refresh the live CSR leaderboard as THREE persistent messages (one per board
// category) edited in place, reusing the lb_msg:<webhook>:<cat> slots the ELO
// board used so CSR takes over the existing #leaderboard messages. No-op if no
// URL. Mirrors upsertCsrLeaderboard in src/discord.ts.
void upsertCsrLeaderboard(const std::optional<std::string>& url, Db& db);
