// Map detection. The carnage XML has no map field, but MCC leaves two
// breadcrumbs in sibling folders under the same Temporary dir:
//  - UserContent\Halo3\Movie\asq_<scenario>_<crc>_<hexts>.mov — temporary
//    theater film, written seconds AFTER the game ends, base map scenario
//    name (truncated to 7 chars) in the filename.
//  - UserContent\Halo3\Map\<hexts>.mvar — the map variant loaded for the
//    game, written at game START; its display name is the first UTF-16BE
//    string in the blob.
// Both are best-effort: films rotate quickly and built-in variants may not
// write an .mvar, so either field can come back empty. Mirrors src/mapInfo.ts.
#pragma once
#include <string>

struct MapInfo {
    std::string mapName;     // e.g. "Construct" ("" if unknown)
    std::string mapVariant;  // e.g. "MLG CStruct TS8" ("" if unknown)
};

// Find the map for a report by its mtime. The film lands ~7s after the XML,
// so the live watcher passes waitMs to poll for it; backfill passes 0 and
// takes whatever survived rotation.
MapInfo findMapInfo(const std::string& carnageDir, long long playedAtMs, int waitMs = 0);
