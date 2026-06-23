// Discord/console text formatting: the combined leaderboard message and the
// per-match summary. Kept separate from the webhook plumbing so the board CLI,
// announce, and the gateway bot can all reuse it. Mirrors the formatters in
// src/discord.ts.
#pragma once
#include <map>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "carnage.h"
#include "category.h"
#include "db.h"
#include "elo.h"
#include "trueskill2.h"

// Embed accent colors, shared with the TS build (src/discord.ts EMBED). Used by
// the gateway bot (/stats, /leaderboard) and the weekly recap.
namespace Embed {
constexpr int NEUTRAL = 0x5865f2;  // blurple — leaderboards, stats, recap
constexpr int WIN = 0x57f287;      // green — restored / counted
constexpr int DANGER = 0xed4245;   // red — voided / off-format
constexpr int GOLD = 0xfee75c;     // recap highlights
}  // namespace Embed

// The combined ELO leaderboard (legacy — ELO is retired from the live tracker;
// kept for the dormant analysis path).
std::string formatLeaderboard(const std::vector<StoredMatch>& matches, EloOptions elo);

// One category's ELO leaderboard section as standalone text (legacy).
std::string formatLeaderboardSection(const std::vector<StoredMatch>& matches, EloOptions elo,
                                     Category cat);

// The combined CSR (TrueSkill 2) leaderboard: one section per board category.
// The PNG fallback and the console `board` output. Players in `hidden` (by XUID)
// are suppressed from every section.
std::string formatCsrLeaderboard(const std::vector<StoredMatch>& matches,
                                 const std::unordered_set<std::string>& hidden = {});

// One category's CSR leaderboard section as standalone text (the 🎖️ heading +
// code block), the per-message fallback when its PNG fails to render.
std::string formatCsrLeaderboardSection(const std::vector<StoredMatch>& matches, Category cat,
                                        const std::unordered_set<std::string>& hidden = {});

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

// --- rich embeds (gateway bot) ----------------------------------------------

// Per-player CSR stats as a rich embed for the /stats reply. Returns an object
// with EITHER "embed" (the stats card) for a resolved + ranked player, or
// "content" (a plain line) for the not-found / unranked cases. Mirrors
// buildCsrPlayerStatsEmbed in src/discord.ts.
nlohmann::json csrPlayerStatsEmbed(const std::vector<StoredMatch>& matches,
                                   const std::string& query);

// Embed wrapper around the /leaderboard standings PNG (attachment://…). Mirrors
// leaderboardEmbed in src/discord.ts.
nlohmann::json leaderboardEmbed();

// The weekly recap embed: games played, most active player, MVP (best K/D, ≥2
// games) over the last 7 days, and the current per-category CSR leaders. Returns
// std::nullopt if no counted matches fell in the window. Mirrors buildRecapEmbed
// in src/discord.ts.
std::optional<nlohmann::json> recapEmbed(const std::vector<StoredMatch>& matches);

// A ≤100-char plain-text label for one match, for the /delete autocomplete list.
// Mirrors matchChoiceLabel in src/discord.ts.
std::string matchChoiceLabel(const StoredMatch& m);
