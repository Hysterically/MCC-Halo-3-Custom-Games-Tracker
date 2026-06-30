// Renders the TrueSkill 2 (CSR) standings as a PNG in the SAME style as the old
// ELO leaderboard (render_leaderboard.cpp): dark carnage-screen background,
// centred headline, light-blue column headers, neutral steel rows with a darker
// rank cell, and the 🥇🥈🥉 podium medals in the left gutter. The rating column
// shows the rank LABEL ("diamond 5") + the Halo 5 division EMBLEM + the CSR
// number; the rest (W-L-D / Win% / K/D / Peak CSR) follow. Uses the embedded
// Blender Pro typeface. Mirrors src/renderCsrLeaderboard.ts.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "category.h"
#include "db.h"

// One row of a CSR board (already ranked best-first by the caller).
struct CsrRow {
    std::string gamertag;
    double skill = 0;      // mu - 3*sigma
    double peakSkill = 0;  // highest skill ever held (peak CSR)
    long wins = 0;
    long losses = 0;
    long draws = 0;
    long games = 0;
    long long kills = 0;
    long long deaths = 0;
};

// One CSR board table, e.g. { "4V4 LEADERBOARD", rows }.
struct CsrBoardSection {
    std::string title;
    std::vector<CsrRow> rows;
};

// One category's CSR table, titled "<CAT> LEADERBOARD" — ranked best-first,
// only players with games, minus any in `hidden` (by XUID). Mirrors csrRows in
// src/discord.ts.
CsrBoardSection buildCsrBoardSection(const std::vector<StoredMatch>& matches, Category cat,
                                     const std::unordered_set<std::string>& hidden = {});

// Per-category CSR tables in display order (just 4v4 now), for the combined
// /leaderboard PNG. Mirrors buildCsrBoardSections in src/discord.ts.
std::vector<CsrBoardSection> buildCsrBoardSections(
    const std::vector<StoredMatch>& matches,
    const std::unordered_set<std::string>& hidden = {});

// Throws on any GDI+ failure; callers fall back to the text leaderboard.
std::vector<std::uint8_t> renderCsrLeaderboardPng(const std::vector<CsrBoardSection>& sections,
                                                  size_t limit = 20);
