// Best-effort "your tracker is outdated" notice, printed on startup. Compares
// this build's H3_VERSION (version.h) against the latest GitHub release tag and
// prints a notice if behind. Silent when offline, rate-limited, or the local
// version is unknown ("dev"). Mirrors src/updateCheck.ts.
#pragma once

void checkForUpdate();
