// First-launch setup wizard. Walks a non-technical user through creating two
// Discord webhooks (#game-results, #leaderboard) and writes the URLs to a local
// `.env` next to the executable. Skips silently if both URLs are already
// configured; run with --force to reconfigure. Mirrors src/setup.ts.
#include <iostream>
#include <map>
#include <regex>
#include <string>
#include <vector>

#include "cli.h"
#include "config.h"
#include "util.h"

namespace {

const std::regex WEBHOOK_RE(R"(^https://discord\.com/api/webhooks/\d+/[A-Za-z0-9_-]+$)");

struct EnvVars {
    std::string results;
    std::string leaderboard;
    std::vector<std::pair<std::string, std::string>> others;  // preserved order
};

EnvVars readEnv() {
    EnvVars out;
    auto text = util::readFile(envPath());
    if (!text) return out;
    static const std::regex line(R"(^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$)");
    for (const auto& raw : util::splitLines(*text)) {
        std::smatch m;
        if (!std::regex_match(raw, m, line)) continue;
        std::string k = m[1].str();
        std::string v = util::trim(m[2].str());
        if (v.empty()) continue;
        if (k == "DISCORD_RESULTS_WEBHOOK_URL")
            out.results = v;
        else if (k == "DISCORD_LEADERBOARD_WEBHOOK_URL")
            out.leaderboard = v;
        else
            out.others.emplace_back(k, v);
    }
    return out;
}

void writeEnv(const EnvVars& vars) {
    std::string out;
    out += "# Halo 3 Customs Tracker - local config.\r\n";
    out += "# Edit by running 'Setup.bat' again, or delete this file to start over.\r\n";
    out += "\r\n";
    out += "DISCORD_RESULTS_WEBHOOK_URL=" + vars.results + "\r\n";
    out += "DISCORD_LEADERBOARD_WEBHOOK_URL=" + vars.leaderboard + "\r\n";
    for (const auto& [k, v] : vars.others)
        if (!v.empty()) out += k + "=" + v + "\r\n";
    util::writeFile(envPath(), out);
}

// Prompt until a valid webhook URL (or 'skip'/empty -> ""). EOF -> "".
std::string askUrl(const std::string& label) {
    while (true) {
        std::cout << "Paste the " << label
                  << " webhook URL (or 'skip' to set later):\n> ";
        std::cout.flush();
        std::string v;
        if (!std::getline(std::cin, v)) return "";  // EOF
        v = util::trim(v);
        if (v.empty() || util::toLower(v) == "skip") return "";
        if (std::regex_match(v, WEBHOOK_RE)) return v;
        std::cout << "  That doesn't look like a Discord webhook URL. It should start with\n"
                     "  https://discord.com/api/webhooks/ and have no trailing spaces. Try "
                     "again.\n\n";
    }
}

}  // namespace

int cmdSetup(bool force) {
    EnvVars existing = readEnv();
    bool needsResults = existing.results.empty();
    bool needsLeaderboard = existing.leaderboard.empty();

    if (!force && !needsResults && !needsLeaderboard) {
        std::cout << "Discord is already configured. (Run Setup.bat again if you want to change "
                     "it.)\n";
        return 0;
    }

    std::cout << "=====================================================\n";
    std::cout << "  Halo 3 Customs Tracker - First-time Discord setup  \n";
    std::cout << "=====================================================\n\n";
    std::cout << "The tracker posts to two Discord channels:\n";
    std::cout << "  1. #game-results  - one message per match (who won, K/D, etc.)\n";
    std::cout << "  2. #leaderboard   - one always-current standings message\n\n";
    std::cout << "You'll need to make a 'webhook' for each channel. Here's how:\n\n";
    std::cout << "  In Discord:\n";
    std::cout << "    a) Right-click the channel name -> Edit Channel\n";
    std::cout << "    b) Left sidebar: Integrations -> Webhooks -> New Webhook\n";
    std::cout << "    c) Name it (e.g. 'H3 Tracker') -> Copy Webhook URL\n";
    std::cout << "    d) Save Changes\n\n";
    std::cout << "Do this for BOTH channels, then paste the URLs below.\n";
    std::cout << "(You can also type 'skip' to set one later.)\n\n";

    std::string results = needsResults ? askUrl("#game-results") : existing.results;
    std::string leaderboard = needsLeaderboard ? askUrl("#leaderboard") : existing.leaderboard;

    EnvVars next = existing;
    next.results = results;
    next.leaderboard = leaderboard;
    writeEnv(next);

    std::cout << "\nSaved to .env.\n";
    if (results.empty())
        std::cout << "  (No #game-results URL set - per-match posts will be disabled.)\n";
    if (leaderboard.empty())
        std::cout << "  (No #leaderboard URL set - live leaderboard will be disabled.)\n";
    std::cout << "\n"
              << (force ? "All set. Run Start.bat to begin tracking.\n"
                        : "All set. The tracker will start now.\n");
    return 0;
}
