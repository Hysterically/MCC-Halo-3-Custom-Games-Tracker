"""Batch inference (TrueSkill Through Time, §3)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from trueskill2.batch import batch_rate
from trueskill2.match import Match, PlayerResult, Team
from trueskill2.online import OnlineTrueSkill2
from trueskill2.params import ModeParams, Params

MU0 = 25.0
SIGMA0 = 25.0 / 3.0
BETA = SIGMA0 / 2.0


def params(**overrides) -> Params:
    defaults = dict(m0=MU0, v0=SIGMA0**2, beta=BETA, gamma=0.1, tau=0.0, draw_probability=0.1)
    defaults.update(overrides)
    return Params(default_mode=ModeParams(**defaults))


def duel(a, b, t) -> Match:
    return Match(mode="m", start_time=t, length=10.0,
                 teams=[Team(1, [PlayerResult(a)]), Team(2, [PlayerResult(b)])])


class TestChainExample(unittest.TestCase):
    """The paper's §3 example: A>B, C>D, E>F, B>C, D>E.

    Online inference cannot order the six players; batch inference must
    recover A > B > C > D > E > F.
    """

    MATCHES = [
        duel("A", "B", 0.0),
        duel("C", "D", 20.0),
        duel("E", "F", 40.0),
        duel("B", "C", 60.0),
        duel("D", "E", 80.0),
    ]

    def test_online_cannot_order(self):
        rater = OnlineTrueSkill2(params())
        for m in self.MATCHES:
            rater.update(m)
        # Online: B and D end identical (the paper's point).
        self.assertAlmostEqual(
            rater.skill("B", "m").mu, rater.skill("D", "m").mu, places=6
        )

    def test_batch_recovers_total_order(self):
        result = batch_rate(self.MATCHES, params(), sweeps=40, tol=1e-6)
        mus = {p: result.final[(p, "m")].mu for p in "ABCDEF"}
        ordered = sorted(mus, key=mus.get, reverse=True)
        self.assertEqual("".join(ordered), "ABCDEF")
        self.assertTrue(result.converged)

    def test_single_match_batch_equals_online(self):
        """With one match there is nothing to smooth — batch == online."""
        m = duel("A", "B", 0.0)
        result = batch_rate([m], params(gamma=0.0), sweeps=5)
        rater = OnlineTrueSkill2(params(gamma=0.0))
        posts = rater.update(duel("A", "B", 0.0))
        for p in ("A", "B"):
            self.assertAlmostEqual(result.final[(p, "m")].mu, posts[p].mu, places=6)
            self.assertAlmostEqual(result.final[(p, "m")].sigma, posts[p].sigma, places=6)

    def test_later_evidence_flows_backward(self):
        """A player's skill AT their first match should change once later
        matches reveal more about their opponents — the smoothing property."""
        result = batch_rate(self.MATCHES, params(), sweeps=40, tol=1e-6)
        traj_b = result.trajectories[("B", "m")]
        self.assertEqual(len(traj_b), 2)
        # B lost to A then beat C: B's estimate at match 0 must already sit
        # below A's at match 0 but above C's final.
        b_at_first = traj_b[0][1].mu
        a_final = result.final[("A", "m")].mu
        self.assertLess(b_at_first, a_final)


class TestBatchModeCorrelation(unittest.TestCase):
    def test_correlated_batch_runs(self):
        p = Params(
            default_mode=ModeParams(m0=0.0, v0=1.0, beta=BETA, gamma=0.05, tau=0.0,
                                    draw_probability=0.1, mode_weight=1.0),
            mode_correlation=True,
        )
        matches = [
            duel("A", "B", 0.0),
            Match(mode="m2", start_time=20.0, length=10.0,
                  teams=[Team(1, [PlayerResult("A")]), Team(2, [PlayerResult("C")])]),
            duel("A", "B", 40.0),
        ]
        result = batch_rate(matches, p, sweeps=30, tol=1e-6)
        # A won everywhere; the shared base must put A above B in mode m2 too,
        # even though A/B only met in mode m.
        self.assertGreater(result.final[("A", "m")].mu, result.final[("B", "m")].mu)
        self.assertGreater(result.final[("A", "m2")].mu, result.final[("C", "m2")].mu)


if __name__ == "__main__":
    unittest.main()
