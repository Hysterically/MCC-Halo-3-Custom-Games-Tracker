"""§5 evaluation protocol and §4 Rprop parameter estimation."""

import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from trueskill2.fitting import RpropOptions, fit_mode_params, rprop_maximize
from trueskill2.match import Match, PlayerResult, Team
from trueskill2.metrics import evaluate_online, win_rate_by
from trueskill2.params import ModeParams, Params

MU0 = 25.0
SIGMA0 = 25.0 / 3.0
BETA = SIGMA0 / 2.0


def synthetic_history(n=60, seed=7):
    """Duels between a strong and a weak pool with a known upset rate."""
    rng = random.Random(seed)
    strong = [f"s{i}" for i in range(4)]
    weak = [f"w{i}" for i in range(4)]
    matches = []
    for k in range(n):
        a = rng.choice(strong)
        b = rng.choice(weak)
        upset = rng.random() < 0.2
        ra, rb = (2, 1) if upset else (1, 2)
        matches.append(
            Match(mode="m", start_time=k * 20.0, length=10.0,
                  teams=[Team(ra, [PlayerResult(a)]), Team(rb, [PlayerResult(b)])])
        )
    return matches


def base_params(**overrides) -> Params:
    defaults = dict(m0=MU0, v0=SIGMA0**2, beta=BETA, gamma=0.1, tau=0.0, draw_probability=0.1)
    defaults.update(overrides)
    return Params(default_mode=ModeParams(**defaults))


class TestEvaluate(unittest.TestCase):
    def test_learns_to_predict(self):
        matches = synthetic_history()
        ev = evaluate_online(matches, base_params())
        self.assertEqual(ev.n_matches, len(matches))
        # After warm-up the model should beat coin-flipping on an 80/20 pool.
        late = [r for r in ev.records if r.match_index >= 30 and r.player_id.startswith("s")]
        expected = sum(r.predicted_team_win_prob for r in late) / len(late)
        self.assertGreater(expected, 0.55)

    def test_win_rate_by_buckets(self):
        matches = synthetic_history()
        ev = evaluate_online(matches, base_params())
        table = win_rate_by(ev.records, lambda r: r.player_id[0])  # "s" vs "w"
        actual_s, expected_s, n_s = table["s"]
        actual_w, expected_w, n_w = table["w"]
        self.assertGreater(actual_s, actual_w)
        self.assertGreater(expected_s, expected_w)
        self.assertEqual(n_s + n_w, 2 * len(matches))


class TestRprop(unittest.TestCase):
    def test_maximizes_quadratic(self):
        best, val = rprop_maximize(
            lambda x: -((x[0] - 3.0) ** 2) - (x[1] + 1.0) ** 2,
            [0.0, 0.0],
            options=RpropOptions(iterations=80, step_init=0.3),
        )
        self.assertAlmostEqual(best[0], 3.0, delta=0.05)
        self.assertAlmostEqual(best[1], -1.0, delta=0.05)

    def test_respects_bounds(self):
        best, _ = rprop_maximize(
            lambda x: x[0],  # unbounded ascent
            [0.0],
            upper=[2.0],
            options=RpropOptions(iterations=40),
        )
        self.assertLessEqual(best[0], 2.0 + 1e-9)

    def test_fit_improves_objective(self):
        matches = synthetic_history(n=40)
        params = base_params(gamma=2.0)  # deliberately bad drift
        fitted, best = fit_mode_params(
            matches, params, "m", ["gamma"],
            options=RpropOptions(iterations=8, step_init=0.5),
        )
        from trueskill2.metrics import evaluate_online as ev
        before = -ev(matches, params).log_loss
        self.assertGreaterEqual(best, before)
        self.assertGreaterEqual(fitted.mode("m").gamma, 0.0)

    def test_unknown_name_rejected(self):
        with self.assertRaises(ValueError):
            fit_mode_params([], base_params(), "m", ["nonsense"])


if __name__ == "__main__":
    unittest.main()
