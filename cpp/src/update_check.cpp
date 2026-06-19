#include "update_check.h"

#include <array>
#include <iostream>
#include <optional>
#include <regex>
#include <string>

#include <nlohmann/json.hpp>

#include "http.h"
#include "version.h"

using nlohmann::json;

namespace {

constexpr const char* REPO = "Hysterically/MCC-Halo-3-Custom-Games-Tracker";

// [major, minor, patch] from the first X.Y.Z in a string, or empty if none.
std::optional<std::array<int, 3>> semver(const std::string& v) {
    std::smatch m;
    static const std::regex re(R"((\d+)\.(\d+)\.(\d+))");
    if (!std::regex_search(v, m, re)) return std::nullopt;
    return std::array<int, 3>{std::stoi(m[1]), std::stoi(m[2]), std::stoi(m[3])};
}

// True if `a` is strictly older than `b` (both X.Y.Z).
bool isOlder(const std::string& a, const std::string& b) {
    auto x = semver(a);
    auto y = semver(b);
    if (!x || !y) return false;
    for (int i = 0; i < 3; ++i) {
        if ((*x)[i] < (*y)[i]) return true;
        if ((*x)[i] > (*y)[i]) return false;
    }
    return false;
}

// Latest release tag from GitHub, or empty on any error.
std::optional<std::string> latestTag() {
    HttpResponse r = httpRequest(
        "GET", std::string("https://api.github.com/repos/") + REPO + "/releases/latest",
        {"Accept: application/vnd.github+json"});
    if (r.networkError || !r.ok()) return std::nullopt;
    try {
        json body = json::parse(r.body);
        if (body.contains("tag_name") && body["tag_name"].is_string())
            return body["tag_name"].get<std::string>();
    } catch (...) {
    }
    return std::nullopt;
}

}  // namespace

void checkForUpdate() {
    std::string local = H3_VERSION;
    if (!semver(local)) return;  // dev / unknown — don't nag
    auto latest = latestTag();
    if (!latest || !isOlder(local, *latest)) return;

    // A rule drawn with the U+2500 box-drawing dash (UTF-8 E2 94 80), repeated.
    std::string rule;
    for (int i = 0; i < 54; ++i) rule += "\xE2\x94\x80";

    std::cout << "\n"
              << rule << "\n"
              << " Your tracker is OUTDATED (" << local << " \xE2\x86\x92 " << *latest << ").\n"
              << " Download the latest from #tracker-download (or the\n"
              << " README link). Old builds post out-of-date results\n"
              << " and miss fixes.\n"
              << rule << "\n\n";
    std::cout.flush();
}
