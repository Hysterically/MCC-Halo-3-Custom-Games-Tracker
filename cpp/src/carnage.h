// Parser for MCC `mpcarnagereport*.xml`. Tracked game = Halo 3
// (mGameEnum == 2) AND a custom game (IsMatchmaking == false) AND completed
// (mLastMatchIncomplete == false) AND players > 0. Mirrors src/parseCarnage.ts.
#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

inline constexpr int GAME_HALO3 = 2;

struct CarnagePlayer {
    std::string gamertag;
    std::string xuid;  // e.g. "0x0009000001486F86"
    int teamId = -1;   // -1 if FFA / no team
    long long score = 0;
    int standing = 999;  // 0 = best place
    long long kills = 0;
    long long deaths = 0;
    long long assists = 0;
    long long betrayals = 0;
    long long suicides = 0;
    long long secondsPlayed = 0;
    bool completedGame = false;
};

struct CarnageReport {
    std::string matchId;  // GameUniqueId — dedupe key
    int gameEnum = -1;
    bool isHalo3 = false;
    bool isMatchmaking = false;
    bool isCustom = false;
    bool teamsEnabled = false;
    bool completed = false;
    std::string gameTypeName;
    std::string hopperName;
    long long playedAtMs = 0;  // file mtime (no timestamp in the XML)
    std::string mapName;       // base map (e.g. "Construct") — attached from mapinfo
    std::string mapVariant;    // variant name (e.g. "MLG CStruct TS8") — attached from mapinfo
    std::vector<CarnagePlayer> players;
    std::optional<int> winningTeamId;  // empty for FFA / undecided
    std::vector<std::string> winners;  // gamertags credited with the win
    bool tracked = false;              // Halo 3 custom that completed
};

// Parse a file (uses its mtime as playedAt). Throws std::runtime_error on a
// non-carnage / unreadable file.
CarnageReport parseCarnageFile(const std::string& path);

// Parse raw XML with an explicit playedAt (epoch ms).
CarnageReport parseCarnageXml(const std::string& xml, long long playedAtMs);

// File last-write time as Unix epoch ms (0 if the file is missing).
long long fileMtimeMs(const std::string& path);
