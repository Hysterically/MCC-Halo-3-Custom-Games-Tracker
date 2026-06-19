// Entry point + CLI dispatch. The default (no subcommand) is `watch`, the thing
// you run on the gaming PC. Mirrors the npm scripts of the Node app:
//   h3-tracker            -> watch (live)
//   h3-tracker setup      -> first-time Discord config wizard
//   h3-tracker backfill   -> bulk-ingest a folder of reports
//   h3-tracker board      -> print standings
//   h3-tracker announce   -> force-refresh the Discord leaderboard
//   h3-tracker clear      -> wipe all matches
//   h3-tracker parse      -> classify which reports would be tracked
//   h3-tracker inspect    -> dump XML structure (debug)
#include <fcntl.h>
#include <io.h>
#include <windows.h>

#include <exception>
#include <iostream>
#include <string>
#include <vector>

#include "cli.h"
#include "config.h"
#include "util.h"

int main(int argc, char** argv) {
    // UTF-8 console + raw (binary) stdout so emoji render and the text output is
    // byte-identical to the Node app (LF, not CRLF).
    SetConsoleOutputCP(CP_UTF8);
    _setmode(_fileno(stdout), _O_BINARY);
    // Unbuffered stdout: the long-running `watch` command must stream progress
    // live (when redirected, stdout would otherwise be block-buffered). Output
    // volume is tiny, so there is no throughput cost.
    setvbuf(stdout, nullptr, _IONBF, 0);
    std::cout << std::unitbuf;  // flush std::cout after every write (live watch log)

    std::vector<std::string> args;
    for (int i = 1; i < argc; ++i) args.emplace_back(argv[i]);

    std::string cmd = args.empty() ? "watch" : args[0];
    std::vector<std::string> rest(args.begin() + (args.empty() ? 0 : 1), args.end());

    auto hasFlag = [&](const std::string& f) {
        for (const auto& a : rest)
            if (a == f) return true;
        return false;
    };

    try {
        if (cmd == "watch") {
            // Self-bootstrap: a layman double-clicks the exe with no config yet.
            // Run the first-time wizard (writes .env beside the exe), then watch.
            if (!util::fileExists(envPath())) {
                std::cout << "(no .env found \xE2\x80\x94 starting first-time setup)\n";
                cmdSetup(false);
            }
            return cmdWatch();
        }
        if (cmd == "setup") return cmdSetup(hasFlag("--force"));
        if (cmd == "backfill") return cmdBackfill(rest);
        if (cmd == "board") return cmdBoard();
        if (cmd == "announce") return cmdAnnounce();
        if (cmd == "clear") return cmdClear();
        if (cmd == "restyle") return cmdRestyle(rest);
        if (cmd == "parse") return cmdParse(rest);
        if (cmd == "inspect") return cmdInspect(rest);
        if (cmd == "show") return cmdShow(rest);
        if (cmd == "render") return cmdRender(rest);
        if (cmd == "renderboard") return cmdRenderBoard(rest);
        if (cmd == "post-sample") return cmdPostSample();
        if (cmd == "ping-webhook") return cmdPingWebhook(rest);
        if (cmd == "curl-info") return cmdCurlInfo();
        if (cmd == "gw-probe") return cmdGwProbe();

        std::cerr << "Unknown command: " << cmd << "\n"
                  << "Commands: watch setup backfill board announce clear parse inspect\n";
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "[error] " << e.what() << "\n";
        return 1;
    }
}
