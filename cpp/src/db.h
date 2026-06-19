// Storage interface. Players are keyed by XUID (stable across Gamertag
// changes); the latest Gamertag is kept for display. Matches dedupe on
// GameUniqueId. Two backends implement this: db_sqlite (local file:) and
// db_hrana (remote libsql://). recordMatch() doubles as the cross-instance
// guard — it returns true ONLY for the instance whose insert created the row,
// so a match is recorded and announced exactly once. Mirrors src/db.ts.
#pragma once
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "carnage.h"

struct StoredPlayer {
    std::string xuid;
    std::string gamertag;
    int teamId = 0;
    int standing = 0;
    long long score = 0;
    long long kills = 0;
    long long deaths = 0;
    long long assists = 0;
};

struct StoredMatch {
    std::string matchId;
    std::string gameTypeName;
    bool teamsEnabled = false;
    long long playedAt = 0;  // epoch ms — chronological key for ELO replay
    std::optional<int> winningTeamId;
    std::string mapName;     // "" if unknown
    std::string mapVariant;  // "" if unknown
    std::optional<long long> durationSeconds;  // empty on pre-tracking rows (= always count)
    std::vector<StoredPlayer> players;
};

// A tracked #game-results post that may need re-styling: its match + message id.
struct RestyleTarget {
    std::string matchId;
    std::string msgId;
};

class Db {
public:
    virtual ~Db() = default;

    virtual std::optional<std::string> kvGet(const std::string& k) = 0;
    virtual void kvSet(const std::string& k, const std::string& v) = 0;
    virtual void kvDelete(const std::string& k) = 0;
    // Insert only if absent. True if THIS call created the row.
    virtual bool kvClaim(const std::string& k, const std::string& v) = 0;
    // Set to `next` only if it currently equals `expected`. True if swapped.
    virtual bool kvCas(const std::string& k, const std::string& expected,
                       const std::string& next) = 0;

    virtual bool hasMatch(const std::string& matchId) = 0;
    // Insert a tracked carnage report. False if already recorded (here or by
    // another instance sharing the DB).
    virtual bool recordMatch(const CarnageReport& r) = 0;

    // Every match with its players, oldest first — the input to ELO replay.
    virtual std::vector<StoredMatch> matchesChrono() = 0;
    // Current display Gamertag per XUID.
    virtual std::unordered_map<std::string, std::string> displayNames() = 0;
    virtual long long matchCount() = 0;

    // Record the Discord #game-results message id for a match, so it can later
    // be voided by referencing its post (see the /delete slash command).
    virtual void setMatchResultsMsg(const std::string& matchId, const std::string& msgId) = 0;
    // Resolve a #game-results message id back to its match_id (empty if untracked).
    virtual std::optional<std::string> matchIdByResultsMsg(const std::string& msgId) = 0;
    // Delete a match and its players (match_players cascades). Returns rows removed.
    virtual long long deleteMatch(const std::string& matchId) = 0;

    // Stamp the layout version a match's #game-results post was last rendered at.
    virtual void setMatchResultsFmt(const std::string& matchId, int version) = 0;
    // Forget a match's #game-results post id (e.g. the message was deleted / 404).
    virtual void clearMatchResultsMsg(const std::string& matchId) = 0;
    // #game-results posts whose layout is behind `version` (or, when `force`,
    // every post with a known message id) — the work list for the startup heal.
    virtual std::vector<RestyleTarget> resultsRestyleTargets(int version, bool force) = 0;
    // match_id -> recorded_at (epoch ms). The pairing key for adopting legacy posts.
    virtual std::unordered_map<std::string, long long> recordedAtByMatch() = 0;

    // Wipe all matches/players (used by the `clear` command). Keeps the kv row
    // holding the leaderboard message id so the same Discord message is reused.
    virtual void clearAll() = 0;
};

// Open the local (file:) or remote (libsql://) backend based on the URL.
std::unique_ptr<Db> openDb(const std::string& url,
                           const std::optional<std::string>& authToken);
