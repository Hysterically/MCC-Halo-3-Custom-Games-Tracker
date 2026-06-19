// Self-healing of #game-results posts. Older builds (e.g. the retired ELO exe,
// or any pre-format change) post carnage images in an out-of-date layout; the
// current watcher re-styles them on startup so the channel converges to one
// style. Mirrors src/heal.ts.
//
// Two tiers, because the rating data is never the problem (CSR is recomputed
// from the matches table) — only the rendered images:
//   - Tier A (everyone): matches whose results_msg_id is stored and whose
//     results_fmt is behind RESULTS_FMT_VERSION are re-rendered and PATCHed by
//     id (a webhook edits its own messages with no auth — works for friends).
//   - Tier B (needs a bot token): scan channel history, pair orphan posts (no
//     stored id) to their match by timestamp, and backfill results_msg_id so
//     Tier A then renders them. Converges to a no-op.
#pragma once
#include "db.h"

struct HealStats {
    int adopted = 0;   // legacy posts whose id we backfilled (Tier B)
    int restyled = 0;  // posts re-rendered + edited (Tier A)
    int gone = 0;      // posts that had vanished (404)
};

// Re-style #game-results posts. force => every post with a known id regardless
// of version (the manual `restyle` path); otherwise only those behind
// RESULTS_FMT_VERSION. Best-effort; logs progress to stdout with a [heal] tag.
HealStats healStaleResults(Db& db, bool force);

// Re-render + PATCH a single #game-results post to the current layout — used
// right after toggling a match's excluded flag so its caption flips to/from
// "Off-format". Returns "restyled", "gone" (the post 404'd — its id is cleared),
// or "skipped" (no webhook / match not found). Mirrors restyleResultPost in
// src/heal.ts.
std::string restyleResultPost(Db& db, const std::string& matchId, const std::string& msgId);
