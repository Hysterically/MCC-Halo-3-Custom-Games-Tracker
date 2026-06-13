// Remote libSQL/Turso backend over the Hrana v2 HTTP protocol. Each operation
// is a POST to {https-base}/v2/pipeline carrying a list of requests; a `baton`
// returned by one pipeline continues the same server-side stream (used to span
// a transaction across two round-trips). affected_row_count gives the same
// rowsAffected signal the SQLite backend uses, so recordMatch()/kvClaim()/
// kvCas() keep identical cross-instance dedupe semantics. Mirrors the remote
// path of src/db.ts.
#include <chrono>
#include <mutex>
#include <optional>
#include <stdexcept>

#include <nlohmann/json.hpp>

#include "db.h"
#include "http.h"

using nlohmann::json;

namespace {

using Arg = json;  // already a Hrana value object

// --- Hrana value helpers ---------------------------------------------------

json vNull() { return json{{"type", "null"}}; }
json vInt(long long n) { return json{{"type", "integer"}, {"value", std::to_string(n)}}; }
json vText(const std::string& s) { return json{{"type", "text"}, {"value", s}}; }
json vOptInt(const std::optional<int>& n) { return n ? vInt(*n) : vNull(); }

// Read a returned cell.
bool cellNull(const json& cell) { return cell.value("type", "null") == "null"; }
std::string cellText(const json& cell) {
    std::string t = cell.value("type", "null");
    if (t == "null") return "";
    if (t == "text" || t == "integer") return cell.value("value", "");  // integer value is a string
    if (t == "float") {
        if (cell.contains("value") && cell["value"].is_number())
            return std::to_string(cell["value"].get<double>());
    }
    return "";
}
long long cellInt(const json& cell) {
    std::string t = cell.value("type", "null");
    if (t == "integer" || t == "text") {
        try {
            return std::stoll(cell.value("value", "0"));
        } catch (...) {
            return 0;
        }
    }
    if (t == "float" && cell.contains("value") && cell["value"].is_number())
        return static_cast<long long>(cell["value"].get<double>());
    return 0;
}

long long affectedOf(const json& result) {
    if (!result.contains("affected_row_count")) return 0;
    const json& a = result["affected_row_count"];
    if (a.is_number()) return a.get<long long>();
    if (a.is_string()) {
        try {
            return std::stoll(a.get<std::string>());
        } catch (...) {
            return 0;
        }
    }
    return 0;
}

// --- request builders ------------------------------------------------------

json execReq(const std::string& sql, const std::vector<Arg>& args = {}, bool wantRows = false) {
    json stmt = {{"sql", sql}, {"want_rows", wantRows}};
    stmt["args"] = json::array();
    for (const auto& a : args) stmt["args"].push_back(a);
    return json{{"type", "execute"}, {"stmt", stmt}};
}
json closeReq() { return json{{"type", "close"}}; }

std::string toHttpsBase(const std::string& url) {
    std::string b;
    if (url.rfind("libsql://", 0) == 0)
        b = "https://" + url.substr(9);
    else if (url.rfind("wss://", 0) == 0)
        b = "https://" + url.substr(6);
    else if (url.rfind("ws://", 0) == 0)
        b = "http://" + url.substr(5);
    else
        b = url;  // already http(s)
    while (!b.empty() && b.back() == '/') b.pop_back();
    return b;
}

class DbHrana : public Db {
public:
    DbHrana(const std::string& url, const std::optional<std::string>& authToken)
        : pipelineUrl_(toHttpsBase(url) + "/v2/pipeline") {
        if (authToken) authHeader_ = "Authorization: Bearer " + *authToken;
        ensureSchema();
    }

    std::optional<std::string> kvGet(const std::string& k) override {
        auto res = run({execReq("SELECT v FROM kv WHERE k = ?", {vText(k)}, true), closeReq()});
        const json& rows = res[0]["rows"];
        if (rows.empty()) return std::nullopt;
        return cellText(rows[0][0]);
    }

    void kvSet(const std::string& k, const std::string& v) override {
        std::lock_guard<std::mutex> lk(writeMtx_);
        run({execReq("INSERT INTO kv (k, v) VALUES (?, ?) "
                     "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                     {vText(k), vText(v)}),
             closeReq()});
    }

    void kvDelete(const std::string& k) override {
        std::lock_guard<std::mutex> lk(writeMtx_);
        run({execReq("DELETE FROM kv WHERE k = ?", {vText(k)}), closeReq()});
    }

    bool kvClaim(const std::string& k, const std::string& v) override {
        std::lock_guard<std::mutex> lk(writeMtx_);
        auto res = run({execReq("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING",
                                {vText(k), vText(v)}),
                        closeReq()});
        return affectedOf(res[0]) == 1;
    }

    bool kvCas(const std::string& k, const std::string& expected,
               const std::string& next) override {
        std::lock_guard<std::mutex> lk(writeMtx_);
        auto res = run({execReq("UPDATE kv SET v = ? WHERE k = ? AND v = ?",
                                {vText(next), vText(k), vText(expected)}),
                        closeReq()});
        return affectedOf(res[0]) == 1;
    }

    bool hasMatch(const std::string& matchId) override {
        auto res =
            run({execReq("SELECT 1 FROM matches WHERE match_id = ?", {vText(matchId)}, true),
                 closeReq()});
        return !res[0]["rows"].empty();
    }

    bool recordMatch(const CarnageReport& r) override {
        std::lock_guard<std::mutex> lk(writeMtx_);
        long long playedAt = r.playedAtMs;
        long long now = nowMs();

        // Pipeline 1: open a stream, BEGIN, claim the match row. Keep the stream
        // open (no close) so the baton can continue the transaction.
        std::optional<std::string> baton;
        auto res1 = run(
            {
                execReq("BEGIN"),
                execReq("INSERT INTO matches (match_id, game_type, teams_enabled, played_at, "
                        "winning_team_id, recorded_at, map_name, map_variant, duration_seconds) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
                        "ON CONFLICT(match_id) DO NOTHING",
                        {vText(r.matchId), vText(r.gameTypeName), vInt(r.teamsEnabled ? 1 : 0),
                         vInt(playedAt), vOptInt(r.winningTeamId), vInt(now),
                         r.mapName.empty() ? vNull() : vText(r.mapName),
                         r.mapVariant.empty() ? vNull() : vText(r.mapVariant),
                         r.durationSeconds.has_value() ? vInt(*r.durationSeconds) : vNull()}),
            },
            baton, /*close=*/false);

        if (affectedOf(res1[1]) == 0) {
            run({execReq("ROLLBACK"), closeReq()}, baton, false);
            return false;  // already recorded (by us or another instance)
        }

        std::vector<json> reqs;
        for (const auto& p : r.players) {
            if (p.xuid.empty()) continue;  // guests/bots — not rateable
            reqs.push_back(execReq(
                "INSERT INTO match_players (match_id, xuid, gamertag, team_id, standing, score, "
                "kills, deaths, assists) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                {vText(r.matchId), vText(p.xuid), vText(p.gamertag), vInt(p.teamId),
                 vInt(p.standing), vInt(p.score), vInt(p.kills), vInt(p.deaths), vInt(p.assists)}));
            reqs.push_back(execReq("INSERT INTO players (xuid, gamertag, first_seen, last_seen) "
                                   "VALUES (?, ?, ?, ?) ON CONFLICT(xuid) DO UPDATE SET "
                                   "gamertag = excluded.gamertag, last_seen = excluded.last_seen",
                                   {vText(p.xuid), vText(p.gamertag), vInt(playedAt),
                                    vInt(playedAt)}));
        }
        reqs.push_back(execReq("COMMIT"));
        reqs.push_back(closeReq());
        run(reqs, baton, /*close already in list=*/true);
        return true;
    }

    std::vector<StoredMatch> matchesChrono() override {
        auto res = run({execReq("SELECT match_id, xuid, gamertag, team_id, standing, score, kills, "
                                "deaths, assists FROM match_players",
                                {}, true),
                        execReq("SELECT match_id, game_type, teams_enabled, played_at, "
                                "winning_team_id, map_name, map_variant, duration_seconds "
                                "FROM matches ORDER BY played_at ASC, "
                                "recorded_at ASC",
                                {}, true),
                        closeReq()});

        std::unordered_map<std::string, std::vector<StoredPlayer>> byMatch;
        for (const auto& row : res[0]["rows"]) {
            StoredPlayer p;
            std::string id = cellText(row[0]);
            p.xuid = cellText(row[1]);
            p.gamertag = cellText(row[2]);
            p.teamId = static_cast<int>(cellInt(row[3]));
            p.standing = static_cast<int>(cellInt(row[4]));
            p.score = cellInt(row[5]);
            p.kills = cellInt(row[6]);
            p.deaths = cellInt(row[7]);
            p.assists = cellInt(row[8]);
            byMatch[id].push_back(std::move(p));
        }

        std::vector<StoredMatch> out;
        for (const auto& row : res[1]["rows"]) {
            StoredMatch m;
            m.matchId = cellText(row[0]);
            m.gameTypeName = cellText(row[1]);
            m.teamsEnabled = cellInt(row[2]) != 0;
            m.playedAt = cellInt(row[3]);
            if (!cellNull(row[4])) m.winningTeamId = static_cast<int>(cellInt(row[4]));
            if (!cellNull(row[5])) m.mapName = cellText(row[5]);
            if (!cellNull(row[6])) m.mapVariant = cellText(row[6]);
            if (!cellNull(row[7])) m.durationSeconds = cellInt(row[7]);
            auto it = byMatch.find(m.matchId);
            if (it != byMatch.end()) m.players = it->second;
            out.push_back(std::move(m));
        }
        return out;
    }

    std::unordered_map<std::string, std::string> displayNames() override {
        auto res = run({execReq("SELECT xuid, gamertag FROM players", {}, true), closeReq()});
        std::unordered_map<std::string, std::string> out;
        for (const auto& row : res[0]["rows"]) out[cellText(row[0])] = cellText(row[1]);
        return out;
    }

    long long matchCount() override {
        auto res = run({execReq("SELECT COUNT(*) AS n FROM matches", {}, true), closeReq()});
        const json& rows = res[0]["rows"];
        return rows.empty() ? 0 : cellInt(rows[0][0]);
    }

    void clearAll() override {
        std::lock_guard<std::mutex> lk(writeMtx_);
        run({execReq("BEGIN"), execReq("DELETE FROM match_players"), execReq("DELETE FROM matches"),
             execReq("DELETE FROM players"), execReq("COMMIT"), closeReq()});
    }

private:
    static long long nowMs() {
        using namespace std::chrono;
        return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
    }

    void ensureSchema() {
        run({execReq("CREATE TABLE IF NOT EXISTS players (xuid TEXT PRIMARY KEY, gamertag TEXT NOT "
                     "NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)"),
             execReq("CREATE TABLE IF NOT EXISTS matches (match_id TEXT PRIMARY KEY, game_type TEXT "
                     "NOT NULL, teams_enabled INTEGER NOT NULL, played_at INTEGER NOT NULL, "
                     "winning_team_id INTEGER, recorded_at INTEGER NOT NULL, map_name TEXT, "
                     "map_variant TEXT, duration_seconds INTEGER)"),
             execReq("CREATE TABLE IF NOT EXISTS match_players (match_id TEXT NOT NULL REFERENCES "
                     "matches(match_id) ON DELETE CASCADE, xuid TEXT NOT NULL, gamertag TEXT NOT "
                     "NULL, team_id INTEGER NOT NULL, standing INTEGER NOT NULL, score INTEGER NOT "
                     "NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL, assists INTEGER NOT "
                     "NULL, PRIMARY KEY (match_id, xuid))"),
             execReq("CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at)"),
             execReq("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
             closeReq()});
        // Migrate pre-map databases in place; a "duplicate column" error just
        // means the migration already ran.
        for (const char* sql : {"ALTER TABLE matches ADD COLUMN map_name TEXT",
                                "ALTER TABLE matches ADD COLUMN map_variant TEXT",
                                "ALTER TABLE matches ADD COLUMN duration_seconds INTEGER"}) {
            try {
                run({execReq(sql), closeReq()});
            } catch (...) {
            }
        }
    }

    // Send one pipeline. Returns the `result` object of every execute request,
    // in order (close requests are skipped). Throws on HTTP or statement error.
    std::vector<json> run(const std::vector<json>& requests) {
        std::optional<std::string> throwaway;
        return run(requests, throwaway, /*close=*/true);
    }

    std::vector<json> run(const std::vector<json>& requests, std::optional<std::string>& baton,
                          bool /*close*/) {
        json body;
        body["baton"] = baton ? json(*baton) : json(nullptr);
        body["requests"] = requests;

        std::vector<std::string> headers = {"Content-Type: application/json"};
        if (!authHeader_.empty()) headers.push_back(authHeader_);

        HttpResponse http = httpRequest("POST", pipelineUrl_, headers, body.dump());
        if (http.networkError) throw std::runtime_error("libSQL pipeline: " + http.error);
        if (!http.ok())
            throw std::runtime_error("libSQL pipeline HTTP " + std::to_string(http.status) + ": " +
                                     http.body);

        json resp = json::parse(http.body);
        if (resp.contains("baton") && resp["baton"].is_string())
            baton = resp["baton"].get<std::string>();
        else
            baton = std::nullopt;

        std::vector<json> out;
        for (const auto& result : resp.at("results")) {
            std::string type = result.value("type", "");
            if (type == "error") {
                std::string msg = result.contains("error") ? result["error"].value("message", "")
                                                           : "unknown libSQL error";
                throw std::runtime_error("libSQL: " + msg);
            }
            const json& response = result.at("response");
            if (response.value("type", "") == "execute") out.push_back(response.at("result"));
        }
        return out;
    }

    std::string pipelineUrl_;
    std::string authHeader_;
    std::mutex writeMtx_;
};

}  // namespace

std::unique_ptr<Db> openHrana(const std::string& url, const std::optional<std::string>& authToken) {
    return std::make_unique<DbHrana>(url, authToken);
}
