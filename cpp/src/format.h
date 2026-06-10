// Discord/console text formatting: the combined leaderboard message and the
// per-match summary. Kept separate from the webhook plumbing so the board CLI,
// announce, and the gateway bot can all reuse it. Mirrors the formatters in
// src/discord.ts.
#pragma once
#include <string>
#include <vector>

#include "carnage.h"
#include "db.h"
#include "elo.h"

// The combined leaderboard: one section per board category, each computed from
// only that category's matches.
std::string formatLeaderboard(const std::vector<StoredMatch>& matches, EloOptions elo);

// Detailed per-match summary: gametype, teams or FFA, K/D/A, winner.
std::string formatMatchResult(const CarnageReport& r);

// Short caption posted above the rendered carnage image.
std::string formatMatchCaption(const CarnageReport& r);
