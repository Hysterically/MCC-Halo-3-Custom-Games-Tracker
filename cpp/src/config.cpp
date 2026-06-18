#include "config.h"

#include <windows.h>
#include <shlobj.h>

#include <cstdlib>
#include <filesystem>
#include <map>
#include <mutex>

#include "util.h"

namespace fs = std::filesystem;

namespace {

// Parsed .env contents. Like dotenv, these do NOT override variables already
// present in the real process environment.
std::map<std::string, std::string> g_dotenv;

std::string cwd() { return fs::current_path().string(); }

// Resolve %LOCALLOW% (it has no environment variable) -> ...\AppData\LocalLow.
std::string localLow() {
    PWSTR p = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppDataLow, 0, nullptr, &p)) && p) {
        int len = WideCharToMultiByte(CP_UTF8, 0, p, -1, nullptr, 0, nullptr, nullptr);
        std::string out(len > 0 ? len - 1 : 0, '\0');
        if (len > 0)
            WideCharToMultiByte(CP_UTF8, 0, p, -1, out.data(), len, nullptr, nullptr);
        CoTaskMemFree(p);
        return out;
    }
    if (p) CoTaskMemFree(p);
    return "";
}

void loadDotEnv() {
    auto text = util::readFile(envPath());
    if (!text) return;
    for (const auto& line : util::splitLines(*text)) {
        // ^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$  (same shape as setup.ts)
        std::string s = line;
        size_t i = s.find_first_not_of(" \t");
        if (i == std::string::npos) continue;
        if (s[i] == '#') continue;
        size_t eq = s.find('=', i);
        if (eq == std::string::npos) continue;
        std::string key = util::trim(s.substr(i, eq - i));
        std::string val = util::trim(s.substr(eq + 1));
        bool keyOk = !key.empty();
        for (char c : key)
            if (!(std::isupper((unsigned char)c) || std::isdigit((unsigned char)c) || c == '_'))
                keyOk = false;
        if (keyOk) g_dotenv[key] = val;
    }
}

// Real env wins over .env; empty/whitespace counts as unset (mirrors config.ts
// + dotenv). dotenv never overrides a key already present in the real
// environment, so if the key exists in the real env (even set to ""), that is
// authoritative and we do NOT fall through to the .env value.
std::optional<std::string> env(const std::string& k) {
    if (const char* v = std::getenv(k.c_str())) {
        std::string t = util::trim(v);
        return t.empty() ? std::nullopt : std::optional<std::string>(t);
    }
    auto it = g_dotenv.find(k);
    if (it != g_dotenv.end()) {
        std::string t = util::trim(it->second);
        if (!t.empty()) return t;
    }
    return std::nullopt;
}

std::string toFileUrl(const std::string& path) {
    std::string p = path;
    for (char& c : p)
        if (c == '\\') c = '/';
    return "file:///" + p;
}

Config build() {
    loadDotEnv();

    Config c;
    auto legacyWebhook = env("DISCORD_WEBHOOK_URL");

    c.dbPath = env("DB_PATH").value_or((fs::path(cwd()) / "data" / "h3.db").string());

    std::string ll = localLow();
    std::string defaultCarnage =
        ll.empty() ? "" : (fs::path(ll) / "MCC" / "Temporary").string();
    c.carnageDir = env("MCC_CARNAGE_DIR").value_or(defaultCarnage);

    c.dbUrl = env("DB_URL").value_or(toFileUrl(c.dbPath));
    c.dbAuthToken = env("DB_AUTH_TOKEN");
    c.aliasesPath = env("ALIASES_PATH").value_or((fs::path(cwd()) / "aliases.json").string());

    if (auto v = env("ELO_START")) c.eloStart = std::atof(v->c_str());
    if (auto v = env("ELO_K")) c.eloK = std::atof(v->c_str());

    c.discordResultsWebhookUrl = env("DISCORD_RESULTS_WEBHOOK_URL");
    if (!c.discordResultsWebhookUrl) c.discordResultsWebhookUrl = legacyWebhook;
    c.discordLeaderboardWebhookUrl = env("DISCORD_LEADERBOARD_WEBHOOK_URL");
    c.discordBotToken = env("DISCORD_BOT_TOKEN");
    c.discordGuildId = env("DISCORD_GUILD_ID");
    return c;
}

}  // namespace

std::string envPath() { return (fs::path(cwd()) / ".env").string(); }

const Config& config() {
    static std::once_flag once;
    static Config c;
    std::call_once(once, [] { c = build(); });
    return c;
}
