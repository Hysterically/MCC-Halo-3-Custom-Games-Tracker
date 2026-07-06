"""Adapter: replay this repo's Halo 3 tracker database through TrueSkill 2.

Reads the tracker's SQLite/libSQL file (see src/db.ts for the schema), maps
each stored match onto the paper's match-result shape, and replays a
leaderboard category through the Python engine — online (§3) or batch
(TrueSkill Through Time). The category rules and the CSR display mapping are
faithful ports of src/category.ts and src/csr.ts so the output is directly
comparable to the production TypeScript ladder.

What the tracker records vs. what the full model can consume:

  * kills / deaths        -> eq (9) count observations (durations from the
                             match row; per-player play time isn't stored, so
                             everyone gets timePlayed = match length).
  * squads, quit status   -> not recorded; those features stay off here but
                             are fully implemented in the engine.
  * modes                 -> board categories (4v4 / 2v2 / ffa). §11 mode
                             correlation can be enabled across them.

Run `python3 -m trueskill2.halo3 --help` from the python/ directory.
"""

from __future__ import annotations

import argparse
import math
import sqlite3
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .batch import batch_rate
from .fitting import FITTABLE, RpropOptions, fit_mode_params
from .match import Match, PlayerResult, Team
from .metrics import evaluate_online, win_rate_by
from .online import OnlineTrueSkill2
from .params import CountModel, ModeParams, Params, exponential_experience_offsets

# -----------------------------------------------------------------------------
# Category rules — port of src/category.ts.
# -----------------------------------------------------------------------------

BOARD_CATEGORIES = ("4v4",)
ALL_CATEGORIES = ("4v4", "2v2", "ffa")
MIN_LEADERBOARD_SECONDS = 60


@dataclass
class StoredPlayer:
    xuid: str
    gamertag: str
    team_id: int
    standing: int
    score: int
    kills: int
    deaths: int
    assists: int


@dataclass
class StoredMatch:
    match_id: str
    game_type: str
    teams_enabled: bool
    played_at: int  # epoch ms
    winning_team_id: Optional[int]
    duration_seconds: Optional[int]
    excluded: bool
    players: List[StoredPlayer]


def categorize(m: StoredMatch) -> str:
    """Structural category — port of category.ts categorize()."""
    real = [p for p in m.players if p.xuid]
    if not m.teams_enabled:
        return "ffa" if len(real) >= 2 else "other"
    sizes: Dict[int, int] = {}
    for p in real:
        if p.team_id < 0:
            continue
        sizes[p.team_id] = sizes.get(p.team_id, 0) + 1
    counts = list(sizes.values())
    if len(counts) != 2 or counts[0] != counts[1]:
        return "other"
    if counts[0] == 2:
        return "2v2"
    if counts[0] == 4:
        return "4v4"
    return "other"


def board_category(m: StoredMatch, min_seconds: int = MIN_LEADERBOARD_SECONDS) -> str:
    """Leaderboard category — port of category.ts boardCategory()."""
    if m.excluded:
        return "other"
    if m.duration_seconds is not None and m.duration_seconds < min_seconds:
        return "other"
    return categorize(m)


# -----------------------------------------------------------------------------
# CSR display — port of src/csr.ts.
# -----------------------------------------------------------------------------

CSR_SCALE = 63  # CSR = round(CSR_SCALE * (mu - 3*sigma)), floored at 0
_CSR_TIERS = ("Bronze", "Silver", "Gold", "Platinum", "Diamond")
_ONYX_THRESHOLD = 1500
_CSR_PER_TIER = 300
_CSR_PER_SUB = 50


def csr_from_skill(skill: float, scale: float = CSR_SCALE) -> Tuple[int, str]:
    """(csr value, tier label) for a conservative skill mu - 3*sigma."""
    value = max(0, round(skill * scale))
    if value >= _ONYX_THRESHOLD:
        return value, "Onyx"
    tier = min(len(_CSR_TIERS) - 1, value // _CSR_PER_TIER)
    sub = (value % _CSR_PER_TIER) // _CSR_PER_SUB + 1
    return value, f"{_CSR_TIERS[tier]} {sub}"


# -----------------------------------------------------------------------------
# DB loading — the two bulk queries of src/db.ts matchesChrono().
# -----------------------------------------------------------------------------

def load_matches(db_path: str) -> List[StoredMatch]:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cur = con.execute(
            """SELECT match_id, game_type, teams_enabled, played_at, winning_team_id,
                      duration_seconds, excluded
                 FROM matches ORDER BY played_at ASC, recorded_at ASC"""
        )
        matches = {
            row[0]: StoredMatch(
                match_id=row[0],
                game_type=row[1],
                teams_enabled=bool(row[2]),
                played_at=int(row[3]),
                winning_team_id=row[4],
                duration_seconds=row[5],
                excluded=bool(row[6]),
                players=[],
            )
            for row in cur.fetchall()
        }
        order = list(matches)
        cur = con.execute(
            """SELECT match_id, xuid, gamertag, team_id, standing, score, kills, deaths, assists
                 FROM match_players"""
        )
        for row in cur.fetchall():
            m = matches.get(row[0])
            if m is not None:
                m.players.append(StoredPlayer(*row[1:]))
    finally:
        con.close()
    return [matches[k] for k in order]


def display_names(stored: Sequence[StoredMatch]) -> Dict[str, str]:
    names: Dict[str, str] = {}
    for m in stored:  # chronological — the last gamertag seen wins
        for p in m.players:
            names[p.xuid] = p.gamertag
    return names


# -----------------------------------------------------------------------------
# StoredMatch -> Match.
# -----------------------------------------------------------------------------

DEFAULT_LENGTH_MINUTES = 10.0  # pre-duration-tracking rows have no duration


def to_ts2_match(m: StoredMatch, mode: str, use_counts: bool = True) -> Optional[Match]:
    """Convert one stored match; None if it can't be rated (< 2 teams)."""
    rated = [p for p in m.players if p.xuid]
    if len(rated) < 2:
        return None
    length = (
        m.duration_seconds / 60.0
        if m.duration_seconds is not None and m.duration_seconds > 0
        else DEFAULT_LENGTH_MINUTES
    )

    def player(p: StoredPlayer) -> PlayerResult:
        return PlayerResult(
            player_id=p.xuid,
            kills=float(p.kills) if use_counts else None,
            deaths=float(p.deaths) if use_counts else None,
        )

    teams: List[Team]
    if m.teams_enabled:
        by_team: Dict[int, List[StoredPlayer]] = {}
        for p in rated:
            by_team.setdefault(p.team_id, []).append(p)
        teams = [
            Team(rank=min(p.standing for p in members), players=[player(p) for p in members])
            for members in by_team.values()
        ]
    else:
        teams = [Team(rank=p.standing, players=[player(p)]) for p in rated]
    if len(teams) < 2:
        return None
    return Match(
        mode=mode,
        start_time=m.played_at / 60000.0,
        length=length,
        teams=teams,
        match_id=m.match_id,
    )


def category_matches(
    stored: Sequence[StoredMatch], category: str, use_counts: bool = True
) -> List[Match]:
    out = []
    for m in stored:
        if board_category(m) != category:
            continue
        conv = to_ts2_match(m, mode=category, use_counts=use_counts)
        if conv is not None:
            out.append(conv)
    return out


# -----------------------------------------------------------------------------
# Default parameters for this tracker's data.
#
# The skill-class constants (m0, v0, beta, gamma, draw probability, experience
# curve, sigma floor, pre-match drift) mirror src/trueskill2.ts so the two
# engines are directly comparable on the same history. The count models are
# the full paper feature (eq 9) — which the TypeScript engine approximates
# with lobby z-scores — with hand-picked defaults on this scale, meant to be
# refined with `fit` once the group has history (the paper itself says to fall
# back to fixed parameters below ~1000 matches per mode).
# -----------------------------------------------------------------------------

MU0 = 25.0
SIGMA0 = 25.0 / 3.0
BETA = SIGMA0 / 2.0


def halo3_mode_params(use_counts: bool = True) -> ModeParams:
    count_kwargs = {}
    if use_counts:
        # Baseline lobby (~perf 25) kill/death rate ~1.2/min; +1 beta of
        # relative performance ~= +0.5 kills/min. Variance ~2x the per-minute
        # mean, matching the over-dispersion the paper measured (§8).
        count_kwargs = dict(
            kill=CountModel(weight_perf=0.12, weight_opp=-0.072, variance=2.5),
            death=CountModel(weight_perf=-0.072, weight_opp=0.12, variance=2.5),
        )
    return ModeParams(
        m0=MU0,
        v0=SIGMA0 * SIGMA0,
        beta=BETA,
        gamma=SIGMA0 / 100.0,  # matches the TS engine's TAU (constant per-match drift)
        tau=0.0,  # the TS engine has no wall-clock drift
        draw_probability=0.1,
        experience_offsets=exponential_experience_offsets(0.15, 8.0),
        **count_kwargs,
    )


def halo3_params(use_counts: bool = True, mode_correlation: bool = False) -> Params:
    return Params(
        default_mode=halo3_mode_params(use_counts),
        mode_correlation=mode_correlation,
        sigma_min=1.0,  # the TS engine's operational floor
        drift_pre_match=True,  # the TS engine inflates the prior, not the posterior
    )


# -----------------------------------------------------------------------------
# CLI.
# -----------------------------------------------------------------------------

@dataclass
class LadderRow:
    xuid: str
    gamertag: str
    mu: float
    sigma: float
    games: int
    csr: int
    tier: str


def compute_ladder(
    stored: Sequence[StoredMatch],
    category: str,
    use_counts: bool = True,
    use_batch: bool = False,
) -> List[LadderRow]:
    matches = category_matches(stored, category, use_counts)
    names = display_names(stored)
    params = halo3_params(use_counts)
    rows: List[LadderRow] = []
    if use_batch:
        result = batch_rate(matches, params)
        games: Dict[str, int] = {}
        for match in matches:
            for p in match.all_players():
                games[p.player_id] = games.get(p.player_id, 0) + 1
        for (pid, _mode), g in result.final.items():
            skill = g.mu - 3.0 * g.sigma
            value, tier = csr_from_skill(skill)
            rows.append(LadderRow(pid, names.get(pid, pid), g.mu, g.sigma, games.get(pid, 0), value, tier))
    else:
        rater = OnlineTrueSkill2(params)
        for match in matches:
            rater.update(match)
        for r in rater.leaderboard(category):
            value, tier = csr_from_skill(r.conservative)
            rows.append(LadderRow(r.player_id, names.get(r.player_id, r.player_id), r.mu, r.sigma, r.games, value, tier))
    rows.sort(key=lambda r: r.mu - 3.0 * r.sigma, reverse=True)
    return rows


def _cmd_ladder(args: argparse.Namespace) -> None:
    stored = load_matches(args.db)
    rows = compute_ladder(stored, args.category, not args.no_counts, args.batch)
    engine = "batch (TrueSkill Through Time)" if args.batch else "online"
    print(f"{args.category} ladder — TrueSkill 2 ({engine})"
          f"{', win/loss only' if args.no_counts else ', with kill/death observations'}")
    print(f"{'#':>3} {'Gamertag':<20} {'CSR':>5}  {'Tier':<11} {'mu':>7} {'sigma':>6} {'games':>5}")
    for i, r in enumerate(rows, 1):
        print(f"{i:>3} {r.gamertag:<20} {r.csr:>5}  {r.tier:<11} {r.mu:>7.2f} {r.sigma:>6.2f} {r.games:>5}")


def _cmd_eval(args: argparse.Namespace) -> None:
    stored = load_matches(args.db)
    matches = category_matches(stored, args.category, not args.no_counts)
    ev = evaluate_online(matches, halo3_params(not args.no_counts))
    print(f"{args.category}: {ev.n_matches} matches")
    print(f"predictive accuracy: {100.0 * ev.accuracy:.1f}%   (paper §5 protocol)")
    print(f"predictive log-loss: {ev.log_loss:.4f}")
    table = win_rate_by(ev.records, lambda r: min(r.experience, 10))
    print("\nWin rate by experience (actual% / expected% / n):")
    for k in sorted(table):
        a, e, n = table[k]
        label = f"{k}" if k < 10 else ">=10"
        print(f"  {label:>4}: {a:5.1f} / {e:5.1f} / {n}")


def _cmd_fit(args: argparse.Namespace) -> None:
    stored = load_matches(args.db)
    matches = category_matches(stored, args.category, not args.no_counts)
    params = halo3_params(not args.no_counts)
    names = args.names.split(",") if args.names else ["gamma", "kill.weight_perf", "kill.weight_opp", "death.weight_perf", "death.weight_opp"]
    print(f"Fitting {names} on {len(matches)} {args.category} matches (Rprop, §4)...")
    fitted, best = fit_mode_params(
        matches, params, args.category, names,
        options=RpropOptions(iterations=args.iterations), verbose=True,
    )
    mp = fitted.mode(args.category)
    print(f"\nBest objective (−log-loss): {best:.5f}")
    for n in names:
        print(f"  {n} = {_field_value(mp, n):.6g}")


def _field_value(mp: ModeParams, name: str) -> float:
    obj = mp
    for part in name.split("."):
        obj = getattr(obj, part)
    return obj


def main(argv: Optional[Sequence[str]] = None) -> None:
    ap = argparse.ArgumentParser(
        prog="python3 -m trueskill2.halo3",
        description="Replay the Halo 3 tracker DB through the Python TrueSkill 2 engine.",
    )
    ap.add_argument("--db", default="../data/tracker.db", help="path to the tracker SQLite DB")
    ap.add_argument("--category", default="4v4", choices=ALL_CATEGORIES)
    ap.add_argument("--no-counts", action="store_true", help="ignore kill/death observations (classic win/loss only)")
    sub = ap.add_subparsers(dest="cmd")
    lad = sub.add_parser("ladder", help="print the CSR ladder (default)")
    lad.add_argument("--batch", action="store_true", help="use batch inference (TrueSkill Through Time)")
    sub.add_parser("eval", help="predictive accuracy per the paper's §5 protocol")
    fit = sub.add_parser("fit", help="fit parameters by Rprop (§4)")
    fit.add_argument("--names", help=f"comma-separated parameters; choices: {', '.join(FITTABLE)}")
    fit.add_argument("--iterations", type=int, default=20)
    args = ap.parse_args(argv)
    if args.cmd in (None, "ladder"):
        if not hasattr(args, "batch"):
            args.batch = False
        _cmd_ladder(args)
    elif args.cmd == "eval":
        _cmd_eval(args)
    elif args.cmd == "fit":
        _cmd_fit(args)


if __name__ == "__main__":
    main()
