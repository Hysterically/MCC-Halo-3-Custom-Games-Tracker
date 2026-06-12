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

// Plain POST — fire and forget. Throws std::runtime_error on a non-2xx.
void postWebhook(const std::string& url, const std::string& content);

// Post a per-match summary to the results channel (no-op if no URL).
// `eloChanges` (xuid -> post-match rating + change, nullable) shows per-player
// ELO ratings in the scoreboard.
void postMatchResult(const std::optional<std::string>& url, const CarnageReport& report,
                     const std::map<std::string, EloChange>* eloChanges = nullptr);

// Refresh the live leaderboard by editing a single persistent message in place.
// The message id is held in the shared DB (kv lb_msg:<webhook>) so every
// instance edits the SAME message. No-op if no URL.
void upsertLeaderboard(const std::optional<std::string>& url, Db& db, EloOptions elo);
