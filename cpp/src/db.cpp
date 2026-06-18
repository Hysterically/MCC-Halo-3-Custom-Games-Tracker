#include "db.h"

#include <stdexcept>

#include "db_sqlite.h"

namespace {

// "file:///C:/path/h3.db" (or "file:relative") -> a native filesystem path.
std::string fileUrlToPath(const std::string& url) {
    std::string s = url;
    if (s.rfind("file://", 0) == 0)
        s = s.substr(7);
    else if (s.rfind("file:", 0) == 0)
        s = s.substr(5);
    // Drop the leading slash before a drive letter: "/C:/x" -> "C:/x".
    if (s.size() >= 3 && s[0] == '/' && s[2] == ':') s = s.substr(1);
    // Percent-decode (Node's pathToFileURL encodes spaces etc.).
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size()) {
            auto hex = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return -1;
            };
            int hi = hex(s[i + 1]), lo = hex(s[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(static_cast<char>(hi * 16 + lo));
                i += 2;
                continue;
            }
        }
        out.push_back(s[i] == '/' ? '\\' : s[i]);
    }
    return out;
}

bool isRemote(const std::string& url) {
    return url.rfind("libsql:", 0) == 0 || url.rfind("http:", 0) == 0 ||
           url.rfind("https:", 0) == 0 || url.rfind("wss:", 0) == 0 ||
           url.rfind("ws:", 0) == 0;
}

}  // namespace

// db_hrana.cpp provides this in Phase 3.
std::unique_ptr<Db> openHrana(const std::string& url, const std::optional<std::string>& authToken);

std::unique_ptr<Db> openDb(const std::string& url, const std::optional<std::string>& authToken) {
    if (isRemote(url)) return openHrana(url, authToken);
    return std::make_unique<DbSqlite>(fileUrlToPath(url));
}

#ifndef H3_HAVE_HRANA
// Phase 1/2 stub so the local-only build links. Replaced by the real remote
// backend in Phase 3 (db_hrana.cpp, which defines H3_HAVE_HRANA).
std::unique_ptr<Db> openHrana(const std::string&, const std::optional<std::string>&) {
    throw std::runtime_error(
        "remote libSQL/Turso DB (DB_URL=libsql://...) is not supported in this build yet");
}
#endif
