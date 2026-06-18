// Central config. Everything is overridable via environment variables (a local
// `.env` next to the exe is loaded automatically). Sensible defaults mean the
// watcher runs with zero config on the gaming PC; Discord is opt-in.
// Mirrors src/config.ts.
#pragma once
#include <optional>
#include <string>

struct Config {
    std::string carnageDir;   // folder MCC writes mpcarnagereport*.xml to
    std::string dbPath;       // local SQLite file (used when dbUrl is a file)
    std::string dbUrl;        // libSQL URL; "file:..." for local, "libsql://..." for remote
    std::optional<std::string> dbAuthToken;
    std::string aliasesPath;  // JSON map Gamertag -> display name
    double eloStart = 1200;
    double eloK = 32;
    std::optional<std::string> discordResultsWebhookUrl;
    std::optional<std::string> discordLeaderboardWebhookUrl;
    std::optional<std::string> discordBotToken;
    std::optional<std::string> discordGuildId;
};

// Loads .env (if present) then builds the config with defaults/overrides.
const Config& config();

// Absolute path to the .env file the app reads/writes (next to the cwd).
std::string envPath();
