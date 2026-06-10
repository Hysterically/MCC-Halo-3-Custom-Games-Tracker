#include "db_sqlite.h"

#include <sqlite3.h>

#include <chrono>
#include <filesystem>
#include <stdexcept>
#include <variant>

namespace fs = std::filesystem;

namespace {

long long nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

using Arg = std::variant<std::nullptr_t, long long, std::string>;

// Minimal prepared-statement helper.
class Stmt {
public:
    Stmt(sqlite3* db, const std::string& sql) : db_(db) {
        if (sqlite3_prepare_v2(db, sql.c_str(), -1, &st_, nullptr) != SQLITE_OK)
            throw std::runtime_error(std::string("sqlite prepare: ") + sqlite3_errmsg(db));
    }
    ~Stmt() {
        if (st_) sqlite3_finalize(st_);
    }
    Stmt& bind(const std::vector<Arg>& args) {
        for (size_t i = 0; i < args.size(); ++i) {
            int idx = static_cast<int>(i + 1);
            const Arg& a = args[i];
            if (std::holds_alternative<std::nullptr_t>(a))
                sqlite3_bind_null(st_, idx);
            else if (std::holds_alternative<long long>(a))
                sqlite3_bind_int64(st_, idx, std::get<long long>(a));
            else {
                const std::string& s = std::get<std::string>(a);
                sqlite3_bind_text(st_, idx, s.c_str(), -1, SQLITE_TRANSIENT);
            }
        }
        return *this;
    }
    bool step() {
        int rc = sqlite3_step(st_);
        if (rc == SQLITE_ROW) return true;
        if (rc == SQLITE_DONE) return false;
        throw std::runtime_error(std::string("sqlite step: ") + sqlite3_errmsg(db_));
    }
    std::string text(int col) {
        const unsigned char* p = sqlite3_column_text(st_, col);
        return p ? reinterpret_cast<const char*>(p) : "";
    }
    long long i64(int col) { return sqlite3_column_int64(st_, col); }
    bool isNull(int col) { return sqlite3_column_type(st_, col) == SQLITE_NULL; }

private:
    sqlite3* db_;
    sqlite3_stmt* st_ = nullptr;
};

void execOrThrow(sqlite3* db, const std::string& sql) {
    char* err = nullptr;
    if (sqlite3_exec(db, sql.c_str(), nullptr, nullptr, &err) != SQLITE_OK) {
        std::string msg = err ? err : "unknown";
        sqlite3_free(err);
        throw std::runtime_error("sqlite exec: " + msg);
    }
}

}  // namespace

DbSqlite::DbSqlite(const std::string& path) {
    fs::path p(path);
    if (p.has_parent_path()) {
        std::error_code ec;
        fs::create_directories(p.parent_path(), ec);
    }
    if (sqlite3_open(path.c_str(), &db_) != SQLITE_OK)
        throw std::runtime_error(std::string("cannot open db: ") +
                                 (db_ ? sqlite3_errmsg(db_) : path));

    // WAL + busy_timeout for a local file; foreign keys on.
    sqlite3_exec(db_, "PRAGMA journal_mode = WAL", nullptr, nullptr, nullptr);
    sqlite3_exec(db_, "PRAGMA busy_timeout = 5000", nullptr, nullptr, nullptr);
    sqlite3_exec(db_, "PRAGMA foreign_keys = ON", nullptr, nullptr, nullptr);

    execOrThrow(db_,
                "CREATE TABLE IF NOT EXISTS players ("
                "  xuid TEXT PRIMARY KEY,"
                "  gamertag TEXT NOT NULL,"
                "  first_seen INTEGER NOT NULL,"
                "  last_seen INTEGER NOT NULL)");
    execOrThrow(db_,
                "CREATE TABLE IF NOT EXISTS matches ("
                "  match_id TEXT PRIMARY KEY,"
                "  game_type TEXT NOT NULL,"
                "  teams_enabled INTEGER NOT NULL,"
                "  played_at INTEGER NOT NULL,"
                "  winning_team_id INTEGER,"
                "  recorded_at INTEGER NOT NULL,"
                "  map_name TEXT,"
                "  map_variant TEXT)");
    execOrThrow(db_,
                "CREATE TABLE IF NOT EXISTS match_players ("
                "  match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,"
                "  xuid TEXT NOT NULL,"
                "  gamertag TEXT NOT NULL,"
                "  team_id INTEGER NOT NULL,"
                "  standing INTEGER NOT NULL,"
                "  score INTEGER NOT NULL,"
                "  kills INTEGER NOT NULL,"
                "  deaths INTEGER NOT NULL,"
                "  assists INTEGER NOT NULL,"
                "  PRIMARY KEY (match_id, xuid))");
    execOrThrow(db_, "CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at)");
    execOrThrow(db_,
                "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    // Migrate pre-map databases in place; "duplicate column" just means done.
    sqlite3_exec(db_, "ALTER TABLE matches ADD COLUMN map_name TEXT", nullptr, nullptr, nullptr);
    sqlite3_exec(db_, "ALTER TABLE matches ADD COLUMN map_variant TEXT", nullptr, nullptr, nullptr);
}

DbSqlite::~DbSqlite() {
    if (db_) sqlite3_close(db_);
}

std::optional<std::string> DbSqlite::kvGet(const std::string& k) {
    Stmt s(db_, "SELECT v FROM kv WHERE k = ?");
    s.bind({k});
    if (s.step()) return s.text(0);
    return std::nullopt;
}

void DbSqlite::kvSet(const std::string& k, const std::string& v) {
    std::lock_guard<std::mutex> lk(writeMtx_);
    Stmt s(db_, "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
    s.bind({k, v});
    s.step();
}

void DbSqlite::kvDelete(const std::string& k) {
    std::lock_guard<std::mutex> lk(writeMtx_);
    Stmt s(db_, "DELETE FROM kv WHERE k = ?");
    s.bind({k});
    s.step();
}

bool DbSqlite::kvClaim(const std::string& k, const std::string& v) {
    std::lock_guard<std::mutex> lk(writeMtx_);
    Stmt s(db_, "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING");
    s.bind({k, v});
    s.step();
    return sqlite3_changes(db_) == 1;
}

bool DbSqlite::kvCas(const std::string& k, const std::string& expected, const std::string& next) {
    std::lock_guard<std::mutex> lk(writeMtx_);
    Stmt s(db_, "UPDATE kv SET v = ? WHERE k = ? AND v = ?");
    s.bind({next, k, expected});
    s.step();
    return sqlite3_changes(db_) == 1;
}

bool DbSqlite::hasMatch(const std::string& matchId) {
    Stmt s(db_, "SELECT 1 FROM matches WHERE match_id = ?");
    s.bind({matchId});
    return s.step();
}

bool DbSqlite::recordMatch(const CarnageReport& r) {
    std::lock_guard<std::mutex> lk(writeMtx_);
    long long playedAt = r.playedAtMs;
    long long now = nowMs();

    execOrThrow(db_, "BEGIN IMMEDIATE");
    try {
        {
            Stmt s(db_,
                   "INSERT INTO matches (match_id, game_type, teams_enabled, played_at, "
                   "winning_team_id, recorded_at, map_name, map_variant) "
                   "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                   "ON CONFLICT(match_id) DO NOTHING");
            Arg winning = r.winningTeamId.has_value()
                              ? Arg(static_cast<long long>(*r.winningTeamId))
                              : Arg(nullptr);
            Arg mapName = r.mapName.empty() ? Arg(nullptr) : Arg(r.mapName);
            Arg mapVariant = r.mapVariant.empty() ? Arg(nullptr) : Arg(r.mapVariant);
            s.bind({r.matchId, r.gameTypeName, static_cast<long long>(r.teamsEnabled ? 1 : 0),
                    playedAt, winning, now, mapName, mapVariant});
            s.step();
        }
        if (sqlite3_changes(db_) == 0) {
            execOrThrow(db_, "ROLLBACK");
            return false;  // already recorded (by us or another instance)
        }

        for (const auto& p : r.players) {
            if (p.xuid.empty()) continue;  // guests/bots have no XUID — not rateable
            {
                Stmt s(db_,
                       "INSERT INTO match_players (match_id, xuid, gamertag, team_id, standing, "
                       "score, kills, deaths, assists) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
                s.bind({r.matchId, p.xuid, p.gamertag, static_cast<long long>(p.teamId),
                        static_cast<long long>(p.standing), p.score, p.kills, p.deaths, p.assists});
                s.step();
            }
            {
                Stmt s(db_,
                       "INSERT INTO players (xuid, gamertag, first_seen, last_seen) "
                       "VALUES (?, ?, ?, ?) ON CONFLICT(xuid) DO UPDATE SET "
                       "gamertag = excluded.gamertag, last_seen = excluded.last_seen");
                s.bind({p.xuid, p.gamertag, playedAt, playedAt});
                s.step();
            }
        }

        execOrThrow(db_, "COMMIT");
        return true;
    } catch (...) {
        sqlite3_exec(db_, "ROLLBACK", nullptr, nullptr, nullptr);
        throw;
    }
}

std::vector<StoredMatch> DbSqlite::matchesChrono() {
    std::unordered_map<std::string, std::vector<StoredPlayer>> byMatch;
    {
        Stmt s(db_,
               "SELECT match_id, xuid, gamertag, team_id, standing, score, kills, deaths, assists "
               "FROM match_players");
        while (s.step()) {
            StoredPlayer p;
            std::string id = s.text(0);
            p.xuid = s.text(1);
            p.gamertag = s.text(2);
            p.teamId = static_cast<int>(s.i64(3));
            p.standing = static_cast<int>(s.i64(4));
            p.score = s.i64(5);
            p.kills = s.i64(6);
            p.deaths = s.i64(7);
            p.assists = s.i64(8);
            byMatch[id].push_back(std::move(p));
        }
    }

    std::vector<StoredMatch> out;
    Stmt s(db_,
           "SELECT match_id, game_type, teams_enabled, played_at, winning_team_id, "
           "map_name, map_variant "
           "FROM matches ORDER BY played_at ASC, recorded_at ASC");
    while (s.step()) {
        StoredMatch m;
        m.matchId = s.text(0);
        m.gameTypeName = s.text(1);
        m.teamsEnabled = s.i64(2) != 0;
        m.playedAt = s.i64(3);
        if (!s.isNull(4)) m.winningTeamId = static_cast<int>(s.i64(4));
        m.mapName = s.text(5);
        m.mapVariant = s.text(6);
        auto it = byMatch.find(m.matchId);
        if (it != byMatch.end()) m.players = it->second;
        out.push_back(std::move(m));
    }
    return out;
}

std::unordered_map<std::string, std::string> DbSqlite::displayNames() {
    std::unordered_map<std::string, std::string> out;
    Stmt s(db_, "SELECT xuid, gamertag FROM players");
    while (s.step()) out[s.text(0)] = s.text(1);
    return out;
}

long long DbSqlite::matchCount() {
    Stmt s(db_, "SELECT COUNT(*) AS n FROM matches");
    return s.step() ? s.i64(0) : 0;
}

void DbSqlite::clearAll() {
    std::lock_guard<std::mutex> lk(writeMtx_);
    execOrThrow(db_, "BEGIN IMMEDIATE");
    try {
        execOrThrow(db_, "DELETE FROM match_players");
        execOrThrow(db_, "DELETE FROM matches");
        execOrThrow(db_, "DELETE FROM players");
        execOrThrow(db_, "COMMIT");
    } catch (...) {
        sqlite3_exec(db_, "ROLLBACK", nullptr, nullptr, nullptr);
        throw;
    }
}
