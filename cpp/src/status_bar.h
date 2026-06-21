// Terminal presentation: ANSI color helpers, a boxed startup banner, and a
// persistent live status footer with a spinner. Everything degrades to plain
// text when stdout isn't a console (redirected to a file), so captured output
// stays clean. Mirror of src/term.ts — keep the look and the tag colors in step.
#pragma once

#include <string>
#include <utility>
#include <vector>

namespace term {

// Enable ANSI/VT on the console; if stdout is redirected (not a console) we fall
// back to plain mode (no escapes, no footer). Call once before using the bar.
void init();
bool isPlain();

// ANSI color helpers (no-ops in plain mode).
std::string dim(const std::string&);
std::string bold(const std::string&);
std::string red(const std::string&);
std::string green(const std::string&);
std::string yellow(const std::string&);
std::string blue(const std::string&);
std::string cyan(const std::string&);
std::string gray(const std::string&);

// Boxed startup panel: title between two rules, then aligned label/value rows.
void banner(const std::string& title,
            const std::vector<std::pair<std::string, std::string>>& rows);

// The bot's gateway state, for the footer's `bot ●` indicator.
enum class Bot { Off, Connecting, Online };

// The live status footer (mirror of src/term.ts StatusBar). log()/logErr() print
// a line (timestamped + footer-safe) with the footer wiped and redrawn around it;
// recordMatch()/setWatching()/setTotal()/setBot()/setLastPost() update the strip
// and the console window title. Thread-safe: a background ticker animates the spinner.
class StatusBar {
public:
    void start();   // begin the spinner ticker (console only)
    void stop();    // wipe the footer and stop the ticker
    void setWatching(bool on);
    void setTotal(long long n);
    void setBot(Bot state);
    void setLastPost(bool ok);
    void recordMatch(const std::string& label, const std::string& category = "");
    void log(const std::string& line);     // info line, footer-safe
    void logErr(const std::string& line);  // error line (red tag), footer-safe
};

StatusBar& statusBar();

}  // namespace term
