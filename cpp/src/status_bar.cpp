#include "status_bar.h"

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <iostream>
#include <mutex>
#include <regex>
#include <sstream>
#include <thread>

namespace term {
namespace {

// Start in plain mode; init() flips it off once we confirm a real console.
bool g_plain = true;

std::string sgr(const char* code, const std::string& s) {
    if (g_plain) return s;
    return std::string("\x1b[") + code + "m" + s + "\x1b[0m";
}

// Braille spinner frames (UTF-8), matching src/term.ts.
const char* SPINNER[] = {"\xE2\xA0\x8B", "\xE2\xA0\x99", "\xE2\xA0\xB9", "\xE2\xA0\xB8",
                         "\xE2\xA0\xBC", "\xE2\xA0\xB4", "\xE2\xA0\xA6", "\xE2\xA0\xA7",
                         "\xE2\xA0\x87", "\xE2\xA0\x8F"};
constexpr int SPINNER_N = 10;

long long nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

std::string ago(long long ms) {
    long long s = std::max(0LL, (nowMs() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return std::to_string(s / 60) + "m ago";
    if (s < 86400) return std::to_string(s / 3600) + "h ago";
    return std::to_string(s / 86400) + "d ago";
}

// Compact uptime: "45s" / "12m" / "1h3m".
std::string uptimeStr(long long startMs) {
    long long s = std::max(0LL, (nowMs() - startMs) / 1000);
    if (s < 60) return std::to_string(s) + "s";
    long long m = s / 60;
    if (m < 60) return std::to_string(m) + "m";
    return std::to_string(m / 60) + "h" + std::to_string(m % 60) + "m";
}

// Local HH:MM:SS for log-line timestamps.
std::string hhmmss() {
    std::time_t t = std::time(nullptr);
    std::tm lt{};
    localtime_s(&lt, &t);
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%02d:%02d:%02d", lt.tm_hour, lt.tm_min, lt.tm_sec);
    return buf;
}

// Color a leading "[tag]" token. `force` (e.g. "31" for errors) overrides the
// per-tag map. Mirrors src/term.ts colorizeTag.
std::string colorizeTag(const std::string& line, const char* force = nullptr) {
    if (g_plain) return line;
    static const std::regex re(R"(^(\s*)\[(\w+)\])");
    std::smatch m;
    if (!std::regex_search(line, m, re)) return line;
    std::string tag = m[2].str();
    std::string lower = tag;
    for (auto& ch : lower) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    const char* code = force;
    if (!code) {
        if (lower == "match")
            code = "32";
        else if (lower == "discord" || lower == "heal" || lower == "recap" || lower == "ts2")
            code = "36";
        else if (lower == "skip" || lower == "warn")
            code = "33";
        else
            code = "90";
    }
    std::string colored = std::string("\x1b[") + code + "m[" + tag + "]\x1b[0m";
    return m[1].str() + colored + line.substr(m[0].length());
}

// --- shared footer state ---------------------------------------------------
struct BarState {
    std::mutex mu;
    long long matchesThisSession = 0;
    long long totalMatches = 0;
    std::string lastMatch;
    long long lastMatchAtMs = 0;
    bool watching = false;
    long long startedAtMs = 0;
    int bot = 0;       // 0 off, 1 connecting, 2 online
    int lastPost = 0;  // 0 none, 1 ok, 2 fail
    long long cat2v2 = 0, catFFA = 0, cat4v4 = 0;  // per-category this session
    int frame = 0;
    bool footerVisible = false;
    std::string lastTitle;
    std::atomic<bool> running{false};
    std::thread ticker;
};
BarState g;

// Keep the console window title in sync (only calls the API on change).
void updateTitleLocked() {
    if (g_plain) return;
    std::string title = "H3 Tracker \xE2\x80\x94 " + std::to_string(g.totalMatches) +
                        " matches \xC2\xB7 " + (g.watching ? "watching" : "idle");
    if (title == g.lastTitle) return;
    g.lastTitle = title;
    int n = MultiByteToWideChar(CP_UTF8, 0, title.data(), (int)title.size(), nullptr, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, title.data(), (int)title.size(), w.data(), n);
    SetConsoleTitleW(w.c_str());
}

void clearFooterLocked() {
    if (g.footerVisible) {
        std::cout << "\r\x1b[K";
        g.footerVisible = false;
    }
}

void drawFooterLocked() {
    if (g_plain || !g.watching) return;
    const std::string sep = gray(" \xC2\xB7 ");  // " · "
    std::ostringstream p;
    p << cyan(SPINNER[g.frame % SPINNER_N]) << " " << bold("watching");
    p << sep << "up " << uptimeStr(g.startedAtMs);

    // matches this run + per-category tally (only nonzero categories shown).
    std::string tally;
    auto addCat = [&](const char* name, long long n) {
        if (n <= 0) return;
        if (!tally.empty()) tally += "\xC2\xB7";  // "·"
        tally += std::string(name) + " " + std::to_string(n);
    };
    addCat("2v2", g.cat2v2);
    addCat("FFA", g.catFFA);
    addCat("4v4", g.cat4v4);
    p << sep << green(std::to_string(g.matchesThisSession)) << " run"
      << (tally.empty() ? "" : " (" + tally + ")");
    p << sep << g.totalMatches << " total";

    if (g.bot != 0) {
        std::string dot = g.bot == 2 ? green("\xE2\x97\x8F") : gray("\xE2\x97\x8B");  // ● / ○
        p << sep << "bot " << dot << (g.bot == 2 ? "online" : "connecting");
    }
    if (g.lastPost != 0)
        p << sep << "post " << (g.lastPost == 1 ? green("\xE2\x9C\x93")   // ✓
                                                : yellow("\xE2\x9A\xA0"));  // ⚠
    if (!g.lastMatch.empty()) {
        p << sep << "last: " << g.lastMatch;
        if (g.lastMatchAtMs) p << " " << gray("(" + ago(g.lastMatchAtMs) + ")");
    }
    std::cout << "\r\x1b[K" << dim(p.str());
    g.footerVisible = true;
}

}  // namespace

void init() {
    HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD mode = 0;
    if (h != INVALID_HANDLE_VALUE && GetConsoleMode(h, &mode)) {
        SetConsoleMode(h, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
        g_plain = false;
    } else {
        g_plain = true;  // redirected / not a console
    }
}

bool isPlain() { return g_plain; }

std::string dim(const std::string& s) { return sgr("2", s); }
std::string bold(const std::string& s) { return sgr("1", s); }
std::string red(const std::string& s) { return sgr("31", s); }
std::string green(const std::string& s) { return sgr("32", s); }
std::string yellow(const std::string& s) { return sgr("33", s); }
std::string blue(const std::string& s) { return sgr("34", s); }
std::string cyan(const std::string& s) { return sgr("36", s); }
std::string gray(const std::string& s) { return sgr("90", s); }

void banner(const std::string& title,
            const std::vector<std::pair<std::string, std::string>>& rows) {
    size_t labelW = 0;
    for (const auto& r : rows) labelW = std::max(labelW, r.first.size());
    size_t width = title.size();
    for (const auto& r : rows) width = std::max(width, labelW + r.second.size() + 3);
    width += 1;
    std::string rule;
    for (size_t i = 0; i < width; ++i) rule += "\xE2\x94\x80";  // ─
    std::ostringstream out;
    out << rule << "\n " << bold(cyan(title)) << "\n" << rule << "\n";
    for (const auto& r : rows) {
        std::string label = r.first;
        label.resize(labelW, ' ');
        out << " " << gray(label) << "  " << r.second << "\n";
    }
    out << rule << "\n";
    std::cout << out.str();
}

void hint(const std::vector<std::string>& lines) {
    for (const auto& l : lines) std::cout << dim(" " + l) << "\n";
}

// Colorize the tag and, on tagged lines only, prefix a dim timestamp.
std::string decorate(const std::string& line, const char* force = nullptr) {
    std::string out = colorizeTag(line, force);
    if (g_plain) return out;
    static const std::regex tagged(R"(^\s*\[\w+\])");
    if (std::regex_search(line, tagged)) return dim(hhmmss()) + " " + out;
    return out;
}

void StatusBar::start() {
    if (g_plain || g.running.load()) return;
    g.startedAtMs = nowMs();
    g.running.store(true);
    g.ticker = std::thread([] {
        while (g.running.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            std::lock_guard<std::mutex> lk(g.mu);
            g.frame = (g.frame + 1) % SPINNER_N;
            drawFooterLocked();
        }
    });
}

void StatusBar::stop() {
    if (g.running.exchange(false) && g.ticker.joinable()) g.ticker.join();
    std::lock_guard<std::mutex> lk(g.mu);
    clearFooterLocked();
}

void StatusBar::setWatching(bool on) {
    std::lock_guard<std::mutex> lk(g.mu);
    g.watching = on;
    updateTitleLocked();
    drawFooterLocked();
}

void StatusBar::setTotal(long long n) {
    std::lock_guard<std::mutex> lk(g.mu);
    g.totalMatches = n;
    updateTitleLocked();
    drawFooterLocked();
}

void StatusBar::setBot(Bot state) {
    std::lock_guard<std::mutex> lk(g.mu);
    g.bot = static_cast<int>(state);
    drawFooterLocked();
}

void StatusBar::setLastPost(bool ok) {
    std::lock_guard<std::mutex> lk(g.mu);
    g.lastPost = ok ? 1 : 2;
    drawFooterLocked();
}

void StatusBar::recordMatch(const std::string& label, const std::string& category) {
    std::lock_guard<std::mutex> lk(g.mu);
    g.matchesThisSession++;
    g.totalMatches++;
    if (category == "2v2")
        g.cat2v2++;
    else if (category == "FFA")
        g.catFFA++;
    else if (category == "4v4")
        g.cat4v4++;
    g.lastMatch = label;
    g.lastMatchAtMs = nowMs();
    if (!g_plain && std::getenv("H3_BELL")) std::cout << "\a";  // opt-in bell
    updateTitleLocked();
    drawFooterLocked();
}

void StatusBar::log(const std::string& line) {
    std::lock_guard<std::mutex> lk(g.mu);
    clearFooterLocked();
    std::cout << decorate(line) << "\n";
    drawFooterLocked();
}

void StatusBar::logErr(const std::string& line) {
    std::lock_guard<std::mutex> lk(g.mu);
    clearFooterLocked();
    std::cout << decorate(line, "31") << "\n";
    drawFooterLocked();
}

StatusBar& statusBar() {
    static StatusBar s;
    return s;
}

}  // namespace term
