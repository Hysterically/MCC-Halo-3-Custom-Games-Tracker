// Renders a carnage report as a PNG styled after Halo 3's post-game carnage
// screen (team-coloured rows, Score / Kills / Assists / Deaths columns).
// Mirrors src/renderCarnage.ts. Uses GDI+ (ships with Windows) — no deps.
#pragma once
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "carnage.h"
#include "elo.h"

// Returns PNG bytes. Throws std::runtime_error if GDI+ rendering fails.
// `eloChanges` (xuid -> post-match rating + change, nullable) adds a neutral
// "ELO" column right of Deaths showing e.g. "1318 +16".
std::vector<std::uint8_t> renderCarnagePng(
    const CarnageReport& report, const std::map<std::string, EloChange>* eloChanges = nullptr);
