#include "aliases.h"

#include <mutex>
#include <unordered_map>

#include <nlohmann/json.hpp>

#include "config.h"
#include "util.h"

namespace {

const std::unordered_map<std::string, std::string>& load() {
    static std::once_flag once;
    static std::unordered_map<std::string, std::string> cache;
    std::call_once(once, [] {
        auto text = util::readFile(config().aliasesPath);
        if (!text) return;  // no file -> no aliases
        try {
            auto obj = nlohmann::json::parse(*text);
            if (!obj.is_object()) return;
            for (auto& [gamertag, label] : obj.items()) {
                if (label.is_string()) {
                    std::string l = label.get<std::string>();
                    if (!util::trim(l).empty()) cache[util::toLower(gamertag)] = l;
                }
            }
        } catch (...) {
            // invalid JSON -> no aliases, everyone shown as-is
        }
    });
    return cache;
}

}  // namespace

std::string displayName(const std::string& gamertag) {
    const auto& m = load();
    auto it = m.find(util::toLower(gamertag));
    return it != m.end() ? it->second : gamertag;
}
