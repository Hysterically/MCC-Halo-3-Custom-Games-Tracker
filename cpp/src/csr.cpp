#include "csr.h"

#include <algorithm>

#include "util.h"

namespace {

const char* CSR_TIERS[5] = {"Bronze", "Silver", "Gold", "Platinum", "Diamond"};
// bronze..diamond, then onyx.
const char* CSR_COLORS[5] = {"#c07a44", "#cfd8df", "#f3c84a", "#56d3bf", "#82b8ff"};
const char* ONYX_COLOR = "#b274ff";

constexpr int CSR_PER_TIER = 300;  // 6 sub-ranks * 50 CSR
constexpr int CSR_PER_SUB = 50;

std::string toLowerAscii(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

}  // namespace

Csr csrFromSkill(double skill) {
    int value = std::max(0L, util::jsRound(skill * CSR_SCALE));
    Csr c;
    c.value = value;
    if (value >= ONYX_THRESHOLD) {
        c.tier = "Onyx";
        c.sub = 0;
        c.hasSub = false;
        c.label = "Onyx";
        c.color = ONYX_COLOR;
        c.emblem = "onyx";
        c.isOnyx = true;
        return c;
    }
    int tier = std::min(4, value / CSR_PER_TIER);
    int sub = (value % CSR_PER_TIER) / CSR_PER_SUB + 1;  // 1..6
    c.tier = CSR_TIERS[tier];
    c.sub = sub;
    c.hasSub = true;
    c.label = std::string(CSR_TIERS[tier]) + " " + std::to_string(sub);
    c.color = CSR_COLORS[tier];
    c.emblem = toLowerAscii(CSR_TIERS[tier]) + "-" + std::to_string(sub);
    c.isOnyx = false;
    return c;
}

std::string csrText(const Csr& c) { return c.label + " " + std::to_string(c.value); }
