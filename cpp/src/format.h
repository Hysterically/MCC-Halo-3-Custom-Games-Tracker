// Discord/console text formatting: the combined leaderboard message and the
// per-match summary. Kept separate from the webhook plumbing so the board CLI,
// announce, and the gateway bot can all reuse it. Mirrors the formatters in
// src/discord.ts.
#pragma once
#include <map>
#include <string>
#include <vector>

#include "carnage.h"
#include "category.h"
#include "db.h"
#include "elo.h"
#include "trueskill2.h"

// The combined ELO leaderboard (legacy — ELO is retired from the live tracker;
// kept for the dormant analysis path).
std::string formatLeaderboard(const std::vector<StoredMatch>& matches, EloOptions elo);

// One category's ELO leaderboard section as standalone text (legacy).
std::string formatLeaderboardSection(const std::vector<StoredMatch>& matches, EloOptions elo,
                                     Category cat);

// The combined CSR (TrueSkill 2) leaderboard: one section per board category.
// The PNG fallback and the console `board` output.
std::string formatCsrLeaderboard(const std::vector<StoredMatch>& matches);

// One category's CSR leaderboard section as standalone text (the 🎖️ heading +
// code block), the per-message fallback when its PNG fails to render.
std::string formatCsrLeaderboardSection(const std::vector<StoredMatch>& matches, Category cat);

// Detailed per-match summary: gametype, teams or FFA, K/D/A, winner.
// `eloChanges` (xuid -> post-match rating + change, nullable) appends a
// per-player ELO line under the scoreboard table.
std::string formatMatchResult(const CarnageReport& r,
                              const std::map<std::string, EloChange>* eloChanges = nullptr);

// One line of per-player CSR ratings + changes, biggest gain first — appended to
// the scoreboard text when a CSR PNG render fails. Mirrors formatCsrLine in
// src/discord.ts.
std::string formatCsrLine(const CarnageReport& r,
                          const std::map<std::string, CsrChange>* csrChanges);

// Short caption posted above the rendered carnage image.
std::string formatMatchCaption(const CarnageReport& r);
