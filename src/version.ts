/**
 * Version constants.
 *
 * RESULTS_FMT_VERSION is the layout/caption version of a #game-results post.
 * Bump it by one whenever the rendered carnage image or its caption changes in
 * a way that should retroactively re-style older posts. The watcher stamps each
 * post it makes with the current value (matches.results_fmt) and, on startup,
 * re-renders any post whose stamp is behind (see heal.ts). Mirror this number
 * in the C++ port (cpp/src/version.h).
 */
export const RESULTS_FMT_VERSION = 3;
