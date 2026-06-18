// Renders the ELO standings as a PNG styled after the carnage-screen renderer
// (render_carnage.cpp): same canvas width, gradient, fonts, light-blue column
// headers and row treatment, with baked 🥇🥈🥉 medal images on a background
// gutter left of the table. Mirrors src/renderLeaderboard.ts.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "category.h"
#include "db.h"
#include "elo.h"

// One leaderboard table, e.g. { "4V4 LEADERBOARD", ratings }.
struct BoardSection {
    std::string title;
    std::vector<Rating> ratings;
};

// One category's rating table, titled "<CAT> LEADERBOARD" — the unit a single
// per-category leaderboard message renders from.
BoardSection buildBoardSection(const std::vector<StoredMatch>& matches, EloOptions elo,
                               Category cat);

// Per-category rating tables in display order (2v2 / 4v4 / FFA), as the PNG
// renderer wants them. Mirrors buildBoardSections in src/discord.ts.
std::vector<BoardSection> buildBoardSections(const std::vector<StoredMatch>& matches,
                                             EloOptions elo);

// Throws on any GDI+ failure; callers fall back to the text leaderboard.
std::vector<std::uint8_t> renderLeaderboardPng(const std::vector<BoardSection>& sections,
                                               size_t limit = 20);
