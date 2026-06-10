// Live folder watcher over ReadDirectoryChangesW, with chokidar's
// awaitWriteFinish behaviour reproduced by hand: a file is only reported once
// its size+mtime have stayed unchanged for `stabilityThreshold`. MCC writes the
// XML incrementally, so ingesting a half-written file would fail to parse.
// Mirrors the watch loop in src/watch.ts.
#pragma once
#include <atomic>
#include <functional>
#include <string>

inline constexpr int WATCH_STABILITY_MS = 1500;
inline constexpr int WATCH_POLL_MS = 200;

// Watch `dir` (non-recursive) until `stop` becomes true. Calls `onStableFile`
// with the full path of each carnage *.xml once it has finished being written.
void watchDirectory(const std::string& dir, std::atomic<bool>& stop,
                    const std::function<void(const std::string&)>& onStableFile);
