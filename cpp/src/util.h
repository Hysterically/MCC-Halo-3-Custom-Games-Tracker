// Small shared helpers. Kept header-only and dependency-free so every module
// can use them. Where a helper mirrors a JS built-in (Math.round, toFixed,
// padStart/padEnd) it reproduces that built-in's exact behaviour so the C++
// port's text output matches the Node app byte-for-byte.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace util {

inline std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

inline std::string toLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

inline bool fileExists(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    return f.good();
}

inline std::optional<std::string> readFile(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f.good()) return std::nullopt;
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

inline bool writeFile(const std::string& path, const std::string& content) {
    std::ofstream f(path, std::ios::binary);
    if (!f.good()) return false;
    f.write(content.data(), static_cast<std::streamsize>(content.size()));
    return f.good();
}

inline std::vector<std::string> splitLines(const std::string& s) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == '\n') {
            if (!cur.empty() && cur.back() == '\r') cur.pop_back();
            out.push_back(cur);
            cur.clear();
        } else {
            cur.push_back(c);
        }
    }
    out.push_back(cur);
    return out;
}

// JS Math.round: round half toward +Infinity (NOT away-from-zero). Elo and
// win% are always >= 0 here, so floor(x + 0.5) matches exactly.
inline long jsRound(double x) { return static_cast<long>(std::floor(x + 0.5)); }

// JS Number.prototype.toFixed(2): fixed 2 decimals. printf rounds half-to-even
// while toFixed rounds half-up, but K/D ratios landing exactly on a 3rd-decimal
// .5 are vanishingly rare; verified against the Node output during parity tests.
inline std::string toFixed2(double x) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.2f", x);
    return std::string(buf);
}

// String.prototype.padEnd / padStart with a space fill (byte/char count; the
// leaderboard names are ASCII Gamertags so .size() == visible width).
inline std::string padEnd(const std::string& s, size_t w) {
    return s.size() >= w ? s : s + std::string(w - s.size(), ' ');
}
inline std::string padStart(const std::string& s, size_t w) {
    return s.size() >= w ? s : std::string(w - s.size(), ' ') + s;
}

inline std::string join(const std::vector<std::string>& parts, const std::string& sep) {
    std::string out;
    for (size_t i = 0; i < parts.size(); ++i) {
        if (i) out += sep;
        out += parts[i];
    }
    return out;
}

}  // namespace util
