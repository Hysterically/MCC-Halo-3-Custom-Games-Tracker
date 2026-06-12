// Classic ELO, team-average. Ratings are recomputed from scratch over the full
// match history every time (deterministic, no drift, retunable). A "team" is
// the set of players sharing teamId; in FFA each player is a team of one. Team
// rating = mean of member ratings; each team scored pairwise against every
// other (1 / 0.5 / 0 by finishing rank), per-opponent deltas averaged and
// applied to every member. Mirrors src/elo.ts.
#pragma once
#include <map>
#include <string>
#include <vector>

#include "db.h"

struct Rating {
    std::string xuid;
    std::string gamertag;
    double rating = 0;
    long games = 0;
    long wins = 0;
    long losses = 0;
    long draws = 0;
    long long kills = 0;
    long long deaths = 0;
};

struct EloOptions {
    double start = 1200;
    double k = 32;
};

// Ratings sorted by rating descending (stable: ties keep first-seen order).
std::vector<Rating> computeRatings(const std::vector<StoredMatch>& matches, EloOptions opt);

// Per-player rating change (xuid -> delta) produced by one specific match,
// computed against the same per-category history the leaderboard uses. Empty
// for off-format matches or if the match isn't in `matches`. Mirrors
// matchEloDeltas in src/elo.ts.
std::map<std::string, double> matchEloDeltas(const std::vector<StoredMatch>& matches,
                                             const std::string& matchId, EloOptions opt);
