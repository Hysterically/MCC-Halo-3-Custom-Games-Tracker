// TrueSkill 2 — the production rating engine (the Bayesian ladder that replaced
// ELO). A DB-reading port of src/trueskill2.ts; the factor-graph math is carried
// over verbatim so the C++ ladder matches the TS one. On top of classic
// TrueSkill's team win/loss ordering it folds in each player's per-match kills
// (+) and deaths (-) as noisy performance readouts at a single fixed K/D spread
// (paper eq. 9), plus a small decaying experience bias on the mean (eq. 8). No
// objective signal — this is plain TrueSkill 2 (win/loss + K/D only).
//
// Ratings are recomputed from full match history (like ELO) — nothing stored, so
// the ladder is deterministic and retunable. The ranked value is the
// conservative skill `mu - 3*sigma`, mapped to CSR by csr.h.
#pragma once
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "csr.h"
#include "db.h"

// Seed conservative skill of a brand-new (unrated) player: mu0 - 3*sigma0 = 0.
inline constexpr double TS2_SEED_SKILL = 0.0;

struct MMR {
    std::string xuid;
    std::string gamertag;
    double mu = 0;
    double sigma = 0;
    long games = 0;
    long wins = 0;
    long losses = 0;
    long draws = 0;
    long long kills = 0;
    long long deaths = 0;
    double skill = 0;      // conservative skill mu - 3*sigma — what the ladder ranks on
    double peakSkill = 0;  // highest `skill` ever held (peak / lifetime-best CSR)
};

// Replay one category's history (oldest first) through TrueSkill 2; ratings in
// first-seen order (callers sort by skill). Mirrors rateCategory in trueskill2.ts.
std::vector<MMR> rateCategory(const std::vector<StoredMatch>& matches);

// A player's post-match CSR and the change (in CSR points) one match produced.
struct CsrChange {
    double skill = 0;  // conservative skill after this match
    Csr csr;           // CSR display after this match
    int delta = 0;     // change in CSR value this match produced (post - pre)
};

// Per-player post-match CSR + change (xuid -> CsrChange) produced by one specific
// match, computed against the same per-category history the leaderboard uses.
// Empty for off-format matches or if the match isn't in `matches`. Mirrors
// matchCsrChanges in src/trueskill2.ts.
std::map<std::string, CsrChange> matchCsrChanges(const std::vector<StoredMatch>& matches,
                                                 const std::string& matchId);

// Pre-match win probability + average CSR for one team of a rated 2-team match.
struct TeamWinChance {
    int teamId = 0;
    int avgCsr = 0;     // mean of the team's rated players' pre-match CSR (rounded)
    double winProb = 0;  // pre-match probability this team wins (the two sum to ~1)
};

// The two teams of a rated 2-team match, for the result-post win bar. Team [0] is
// the winner, so the bar's left segment matches the board's winner-first ordering.
struct MatchWinChances {
    TeamWinChance teams[2];
};

// Per-team pre-match win probability + average CSR for the result-post win bar.
// Computed from the ratings *before* this match using the TrueSkill team
// performance model. Returns nullopt unless the match is on-format, has teams,
// and groups into exactly two teams that each have a rated player. Mirrors
// matchWinChances in src/trueskill2.ts.
std::optional<MatchWinChances> matchWinChances(const std::vector<StoredMatch>& matches,
                                               const std::string& matchId);
