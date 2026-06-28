// Version constants. Mirrors src/version.ts (RESULTS_FMT_VERSION) and is the
// C++ side of the startup outdated-build check (H3_VERSION).
#pragma once

// Layout/caption version of a #game-results post. Bump by one whenever the
// rendered carnage image or its caption changes in a way that should
// retroactively re-style older posts. The watcher stamps each post it makes
// with this value (matches.results_fmt) and, on startup, re-renders any post
// whose stamp is behind (see heal.cpp). Keep equal to RESULTS_FMT_VERSION in
// src/version.ts.
inline constexpr int RESULTS_FMT_VERSION = 3;

// This build's version string, stamped at compile time from the git tag by
// build.bat (-DH3_VERSION_STR="vX.Y.Z"). "dev" for an unstamped local build —
// the update check stays silent then.
#ifndef H3_VERSION_STR
#define H3_VERSION_STR "dev"
#endif
inline constexpr const char* H3_VERSION = H3_VERSION_STR;
