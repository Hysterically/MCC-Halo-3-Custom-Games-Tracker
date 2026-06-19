// Local file: backend over the SQLite C API. A std::mutex serializes writes
// (mirrors the TS serializeWrite promise-chain) so two near-simultaneous
// matches don't collide as SQLITE_BUSY. Mirrors the file path in src/db.ts.
#pragma once
#include <mutex>
#include <string>

#include "db.h"

struct sqlite3;

class DbSqlite : public Db {
public:
    explicit DbSqlite(const std::string& path);
    ~DbSqlite() override;

    std::optional<std::string> kvGet(const std::string& k) override;
    void kvSet(const std::string& k, const std::string& v) override;
    void kvDelete(const std::string& k) override;
    bool kvClaim(const std::string& k, const std::string& v) override;
    bool kvCas(const std::string& k, const std::string& expected,
               const std::string& next) override;
    bool hasMatch(const std::string& matchId) override;
    bool recordMatch(const CarnageReport& r) override;
    std::vector<StoredMatch> matchesChrono() override;
    std::unordered_map<std::string, std::string> displayNames() override;
    long long matchCount() override;
    void setMatchResultsMsg(const std::string& matchId, const std::string& msgId) override;
    std::optional<std::string> matchIdByResultsMsg(const std::string& msgId) override;
    long long deleteMatch(const std::string& matchId) override;
    void setMatchResultsFmt(const std::string& matchId, int version) override;
    void clearMatchResultsMsg(const std::string& matchId) override;
    std::vector<RestyleTarget> resultsRestyleTargets(int version, bool force) override;
    std::unordered_map<std::string, long long> recordedAtByMatch() override;
    void clearAll() override;

private:
    sqlite3* db_ = nullptr;
    std::mutex writeMtx_;
};
