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
#include "trueskill2.h"

// Returns PNG bytes. Throws std::runtime_error if GDI+ rendering fails.
// `eloChanges` (xuid -> post-match rating + change, nullable) adds a neutral
// "ELO" column right of Deaths showing e.g. "1318 +16". (Legacy — ELO is retired
// from the live tracker; kept for the dormant analysis path.)
std::vector<std::uint8_t> renderCarnagePng(
    const CarnageReport& report, const std::map<std::string, EloChange>* eloChanges = nullptr);

// CSR (TrueSkill 2) variant: a neutral "CSR" column right of Deaths showing the
// post-match rank as its Halo 5 division emblem + the CSR number + a green/red
// change, e.g. "[◆] 1427 +31". Uses the embedded Blender Pro typeface.
// `csrChanges` (xuid -> post-match CSR + change, nullable); with none/empty it
// renders without the column. Mirrors renderCarnageCsrPng in src/renderCarnage.ts.
std::vector<std::uint8_t> renderCarnageCsrPng(
    const CarnageReport& report, const std::map<std::string, CsrChange>* csrChanges = nullptr);
