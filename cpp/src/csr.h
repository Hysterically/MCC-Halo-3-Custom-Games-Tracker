// CSR (Competitive Skill Rank) — a Halo-5-style *display* of the TrueSkill 2
// rating. The engine ranks on the conservative skill `mu - 3*sigma`; this maps
// that single number onto the familiar Halo 5 tier ladder (Bronze..Onyx, with a
// Champion accolade on top). Purely a view; it changes nothing in the engine.
// Mirrors src/csr.ts — keep the constants byte-identical so the C++ ladder
// matches the TS one.
#pragma once
#include <string>

// CSR = max(0, round(CSR_SCALE * (mu - 3*sigma))).
inline constexpr double CSR_SCALE = 63;
// Champion = a top-3 player on a board who has also cleared this CSR floor (up to 3).
inline constexpr int CHAMPION_THRESHOLD = 1600;
inline constexpr int ONYX_THRESHOLD = 1500;

struct Csr {
    int value = 0;            // raw display number
    std::string tier;         // "Bronze".."Diamond" or "Onyx"
    int sub = 0;              // sub-rank 1..6 (0 + !hasSub for Onyx)
    bool hasSub = false;
    std::string label;        // "Diamond 5" / "Onyx"
    std::string color;        // tier colour (hex)
    std::string emblem;       // "diamond-5" / "onyx" — assets/csr-<emblem>.png
    bool isOnyx = false;
};

// Map a conservative-skill value (mu - 3*sigma) to its CSR display.
Csr csrFromSkill(double skill);

// "Diamond 5 1427" / "Onyx 1623" — the tier label followed by the raw number.
std::string csrText(const Csr& c);
