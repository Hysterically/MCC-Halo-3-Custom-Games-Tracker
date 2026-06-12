// Renders a carnage report as a PNG styled after Halo 3's post-game carnage
// screen (team-coloured rows, Score / Kills / Assists / Deaths columns).
// Mirrors src/renderCarnage.ts. Uses GDI+ (ships with Windows) — no deps.
#pragma once
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "carnage.h"

// Returns PNG bytes. Throws std::runtime_error if GDI+ rendering fails.
// `eloDeltas` (xuid -> rating change, nullable) adds an "ELO CHANGE" footer
// under the scoreboard.
std::vector<std::uint8_t> renderCarnagePng(const CarnageReport& report,
                                           const std::map<std::string, double>* eloDeltas = nullptr);
