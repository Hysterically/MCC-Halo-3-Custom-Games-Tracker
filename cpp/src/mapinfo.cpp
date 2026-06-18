#include "mapinfo.h"

#include <chrono>
#include <cmath>
#include <filesystem>
#include <thread>
#include <unordered_map>
#include <vector>

#include "carnage.h"  // fileMtimeMs
#include "util.h"

namespace fs = std::filesystem;

namespace {

// Halo 3 scenario stems as MCC truncates them in film filenames (7 chars).
const std::unordered_map<std::string, std::string> MAP_NAMES = {
    {"armory", "Rat's Nest"},   {"bunkerw", "Standoff"},   {"chill", "Narrows"},
    {"chillou", "Cold Storage"}, {"constru", "Construct"},  {"cyberdy", "The Pit"},
    {"deadloc", "High Ground"},  {"descent", "Assembly"},   {"docks", "Longshore"},
    {"fortres", "Citadel"},      {"ghostto", "Ghost Town"}, {"guardia", "Guardian"},
    {"isolati", "Isolation"},    {"lockout", "Blackout"},   {"midship", "Heretic"},
    {"riverwo", "Valhalla"},     {"salvati", "Epitaph"},    {"sandbox", "Sandbox"},
    {"shrine", "Sandtrap"},      {"sidewin", "Avalanche"},  {"snowbou", "Snowbound"},
    {"spaceca", "Orbital"},      {"warehou", "Foundry"},    {"zanziba", "Last Resort"},
};

// Film written within a minute before the report up to this long after it.
constexpr long long FILM_BEFORE_MS = 60'000;
constexpr long long FILM_AFTER_MS = 5 * 60'000;
// An .mvar older than this is assumed stale (different variant replayed).
constexpr long long MVAR_MAX_AGE_MS = 4LL * 60 * 60'000;
constexpr int POLL_MS = 3'000;

struct Entry {
    std::string name;  // filename only
    std::string path;
    long long mtimeMs = 0;
};

// Every file with `ext` in `dir` (empty on a missing dir).
std::vector<Entry> listWithExt(const std::string& dir, const std::string& ext) {
    std::vector<Entry> out;
    std::error_code ec;
    for (auto& e : fs::directory_iterator(dir, ec)) {
        if (!e.is_regular_file()) continue;
        std::string name = e.path().filename().string();
        std::string l = util::toLower(name);
        if (l.size() < ext.size() || l.compare(l.size() - ext.size(), ext.size(), ext) != 0)
            continue;
        std::string path = e.path().string();
        long long m = fileMtimeMs(path);
        if (m) out.push_back({name, path, m});
    }
    return out;
}

// Base map from the film closest in time to the report, or "".
std::string filmMapName(const std::string& movieDir, long long playedAtMs) {
    std::string best;
    long long bestDist = -1;
    for (const Entry& f : listWithExt(movieDir, ".mov")) {
        if (f.mtimeMs < playedAtMs - FILM_BEFORE_MS || f.mtimeMs > playedAtMs + FILM_AFTER_MS)
            continue;
        long long dist = std::llabs(f.mtimeMs - playedAtMs);
        if (bestDist < 0 || dist < bestDist) {
            best = f.name;
            bestDist = dist;
        }
    }
    // asq_<stem>_<crc>_<hexts>.mov
    std::string l = util::toLower(best);
    if (l.compare(0, 4, "asq_") != 0) return "";
    size_t end = l.find('_', 4);
    if (end == std::string::npos || end == 4) return "";
    std::string stem = l.substr(4, end - 4);
    auto it = MAP_NAMES.find(stem);
    if (it != MAP_NAMES.end()) return it->second;
    stem[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(stem[0])));
    return stem;
}

// First printable UTF-16BE run of 4+ chars — the variant's display name.
std::string firstUtf16BeString(const std::string& buf) {
    std::string run;
    for (size_t i = 0; i + 1 < buf.size(); i += 2) {
        unsigned c = (static_cast<unsigned char>(buf[i]) << 8) |
                     static_cast<unsigned char>(buf[i + 1]);
        if (c >= 0x20 && c < 0x7f) {
            run += static_cast<char>(c);
        } else {
            if (run.size() >= 4) return util::trim(run);
            run.clear();
        }
    }
    return run.size() >= 4 ? util::trim(run) : "";
}

// Variant name from the newest .mvar written before (or with) the report.
std::string mvarVariant(const std::string& mapDir, long long playedAtMs) {
    std::string bestPath;
    long long bestM = -1;
    for (const Entry& f : listWithExt(mapDir, ".mvar")) {
        if (f.mtimeMs > playedAtMs + FILM_BEFORE_MS || f.mtimeMs < playedAtMs - MVAR_MAX_AGE_MS)
            continue;
        if (f.mtimeMs > bestM) {
            bestPath = f.path;
            bestM = f.mtimeMs;
        }
    }
    if (bestPath.empty()) return "";
    auto buf = util::readFile(bestPath);
    return buf ? firstUtf16BeString(*buf) : "";
}

}  // namespace

MapInfo findMapInfo(const std::string& carnageDir, long long playedAtMs, int waitMs) {
    fs::path base(carnageDir);
    std::string movieDir = (base / "UserContent" / "Halo3" / "Movie").string();
    std::string mapDir = (base / "UserContent" / "Halo3" / "Map").string();

    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(waitMs);
    std::string mapName = filmMapName(movieDir, playedAtMs);
    while (mapName.empty() && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(POLL_MS));
        mapName = filmMapName(movieDir, playedAtMs);
    }

    return {mapName, mvarVariant(mapDir, playedAtMs)};
}
