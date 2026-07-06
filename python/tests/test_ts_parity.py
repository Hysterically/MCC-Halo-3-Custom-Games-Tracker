"""Cross-check against the production TypeScript engine (src/trueskill2.ts).

The fixture (ts_parity.json) is real output of `rateCategory` on synthetic
histories — regenerate with `npx tsx python/tests/fixtures/generate-ts-fixture.ts`
from the repo root. Configured to the TS engine's conventions (constant
per-match drift folded into the prior, sigma floor 1.0, exponential experience
curve, draw-probability margins, no wall-clock drift, no count observations),
the Python engine must reproduce its numbers.

The only expected numerical daylight is the TS engine's erf approximation
(Abramowitz & Stegun, ~1e-7) versus Python's exact math.erf, so the tolerance
is a few 1e-4 rating points rather than machine precision.
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from trueskill2.gaussian import Gaussian
from trueskill2.match import Match, PlayerResult, Team
from trueskill2.online import OnlineTrueSkill2
from trueskill2.params import ModeParams, Params, exponential_experience_offsets

FIXTURE = Path(__file__).parent / "fixtures" / "ts_parity.json"

MU0 = 25.0
SIGMA0 = 25.0 / 3.0


def ts_engine_params() -> Params:
    """The exact configuration of src/trueskill2.ts."""
    return Params(
        default_mode=ModeParams(
            m0=MU0,
            v0=SIGMA0 * SIGMA0,
            beta=SIGMA0 / 2.0,  # BETA
            gamma=SIGMA0 / 100.0,  # the TS engine's TAU (constant per-match drift)
            tau=0.0,  # no wall-clock drift in the TS engine
            draw_probability=0.1,  # DRAW_PROB
            experience_offsets=exponential_experience_offsets(0.15, 8.0),  # EXP_OFFSET_*
        ),
        sigma_min=1.0,  # SIGMA_MIN
        drift_pre_match=True,  # TS folds TAU into the prior, not the posterior
    )


def convert(stored: dict, index: int) -> Match:
    """StoredMatch JSON -> engine Match, mirroring rateCategory's grouping."""
    players = [p for p in stored["players"] if p["xuid"]]
    if stored["teamsEnabled"]:
        by_team: dict = {}
        for p in players:  # dict preserves first-appearance order, like the TS Map
            by_team.setdefault(p["teamId"], []).append(p)
        teams = [
            Team(
                rank=min(p["standing"] for p in members),
                players=[PlayerResult(p["xuid"]) for p in members],
            )
            for members in by_team.values()
        ]
    else:
        teams = [Team(rank=p["standing"], players=[PlayerResult(p["xuid"])]) for p in players]
    return Match(
        mode="4v4",
        start_time=stored["playedAt"] / 60000.0,
        length=(stored.get("durationSeconds") or 600) / 60.0,
        teams=teams,
        match_id=stored["matchId"],
    )


class TestTsParity(unittest.TestCase):
    def test_replay_matches_typescript_engine(self):
        with open(FIXTURE) as f:
            fixture = json.load(f)

        rater = OnlineTrueSkill2(ts_engine_params())
        for i, stored in enumerate(fixture["matches"]):
            rater.update(convert(stored, i))

        self.assertGreater(len(fixture["expected"]), 0)
        for xuid, exp in fixture["expected"].items():
            got = rater.skill(xuid, "4v4")
            self.assertAlmostEqual(
                got.mu, exp["mu"], delta=2e-3,
                msg=f"mu mismatch for {xuid}: python {got.mu} vs ts {exp['mu']}",
            )
            self.assertAlmostEqual(
                got.sigma, exp["sigma"], delta=2e-3,
                msg=f"sigma mismatch for {xuid}: python {got.sigma} vs ts {exp['sigma']}",
            )
            self.assertEqual(rater.experience.get((xuid, "4v4"), 0), exp["games"])


if __name__ == "__main__":
    unittest.main()
