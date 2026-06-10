// Display-name aliases. Some Gamertags render badly on the board (e.g. a
// capital "I" that reads like a lowercase "l"). This maps the in-game Gamertag
// to a preferred display label without rewriting any match history (matches
// stay keyed by XUID). Loaded once from a JSON file, matched case-insensitively;
// unknown names pass through unchanged. Mirrors src/aliases.ts.
#pragma once
#include <string>

std::string displayName(const std::string& gamertag);
