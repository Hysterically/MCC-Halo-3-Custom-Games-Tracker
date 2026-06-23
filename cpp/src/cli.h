// Subcommand entry points (board, backfill, parse, inspect, clear, announce,
// watch, setup). Each returns a process exit code. Mirrors the per-script
// tools under src/ in the Node app.
#pragma once
#include <string>
#include <vector>

int cmdBoard();
int cmdBackfill(const std::vector<std::string>& args);
int cmdParse(const std::vector<std::string>& args);
int cmdInspect(const std::vector<std::string>& args);
int cmdShow(const std::vector<std::string>& args);         // debug: print formatMatchResult
int cmdRender(const std::vector<std::string>& args);       // debug: write the carnage PNG
int cmdRenderBoard(const std::vector<std::string>& args);  // debug: write the leaderboard PNG
int cmdPostSample();                                        // debug: post sample image to webhook
int cmdPingWebhook(const std::vector<std::string>& args);  // debug: GET a webhook (no post)
int cmdCurlInfo();                                          // debug: curl/TLS/protocol info
int cmdGwProbe();                                          // debug: probe Discord gateway (HELLO)
int cmdClear();
int cmdAnnounce();
int cmdRestyle(const std::vector<std::string>& args);  // force re-style all #game-results posts
int cmdExclude(const std::vector<std::string>& args);     // exclude/restore a match from the boards
int cmdHidePlayer(const std::vector<std::string>& args);  // hide/show a player on the leaderboards
int cmdWatch();
int cmdSetup(bool force);
