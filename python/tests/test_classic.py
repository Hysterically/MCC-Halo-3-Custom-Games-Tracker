"""Classic-TrueSkill correctness: with the TS2 features switched off, the
engine must reproduce Herbrich et al. 2007 exactly (the paper builds on this)."""

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from trueskill2.factorgraph import MemberPrior, rate_match
from trueskill2.gaussian import Gaussian, ppf, v_draw, v_win, w_draw, w_win
from trueskill2.match import Match, PlayerResult, Team
from trueskill2.online import OnlineTrueSkill2
from trueskill2.params import ModeParams, Params

MU0 = 25.0
SIGMA0 = 25.0 / 3.0
BETA = SIGMA0 / 2.0


def classic_params(**overrides) -> ModeParams:
    defaults = dict(
        m0=MU0, v0=SIGMA0 * SIGMA0, beta=BETA, gamma=0.0, tau=0.0,
        draw_probability=0.1,
    )
    defaults.update(overrides)
    return ModeParams(**defaults)


def match_1v1(rank_a=1, rank_b=2) -> Match:
    return Match(
        mode="m", start_time=0.0, length=10.0,
        teams=[
            Team(rank=rank_a, players=[PlayerResult("a")]),
            Team(rank=rank_b, players=[PlayerResult("b")]),
        ],
    )


def priors_equal():
    g = Gaussian.from_mu_sigma(MU0, SIGMA0)
    return {"a": MemberPrior(skill=Gaussian(g.pi, g.tau)), "b": MemberPrior(skill=Gaussian(g.pi, g.tau))}


class TestOneVsOne(unittest.TestCase):
    def test_win_matches_analytic(self):
        """The closed-form 1v1 update from Herbrich et al. 2007."""
        params = classic_params()
        posts = rate_match(match_1v1(), priors_equal(), params)
        c = math.sqrt(2 * BETA**2 + 2 * SIGMA0**2)
        eps = ppf((0.1 + 1) / 2) * math.sqrt(2.0) * BETA
        v = v_win(0.0 / c, eps / c)
        w = w_win(0.0 / c, eps / c)
        mu_w = MU0 + (SIGMA0**2 / c) * v
        mu_l = MU0 - (SIGMA0**2 / c) * v
        sig = math.sqrt(SIGMA0**2 * (1 - (SIGMA0**2 / c**2) * w))
        self.assertAlmostEqual(posts["a"].skill.mu, mu_w, places=6)
        self.assertAlmostEqual(posts["b"].skill.mu, mu_l, places=6)
        self.assertAlmostEqual(posts["a"].skill.sigma, sig, places=6)
        self.assertAlmostEqual(posts["b"].skill.sigma, sig, places=6)

    def test_draw_matches_analytic(self):
        params = classic_params()
        posts = rate_match(match_1v1(rank_a=1, rank_b=1), priors_equal(), params)
        c = math.sqrt(2 * BETA**2 + 2 * SIGMA0**2)
        eps = ppf((0.1 + 1) / 2) * math.sqrt(2.0) * BETA
        v = v_draw(0.0, eps / c)
        w = w_draw(0.0, eps / c)
        mu = MU0 + (SIGMA0**2 / c) * v
        sig = math.sqrt(SIGMA0**2 * (1 - (SIGMA0**2 / c**2) * w))
        for pid in ("a", "b"):
            self.assertAlmostEqual(posts[pid].skill.mu, mu, places=6)
            self.assertAlmostEqual(posts[pid].skill.sigma, sig, places=6)

    def test_colossal_upset_stays_finite(self):
        """A win over an opponent rated dozens of sigmas higher must produce a
        finite, direction-correct update (the naive erf-based tail collapsed
        to w = 1 here, dividing by zero inside the EP truncation update)."""
        params = classic_params(draw_probability=None, draw_margin=1e-3)
        for gap in (20.0, 40.0, 70.0):
            weak = Gaussian.from_mu_sigma(MU0, 1.0)
            strong = Gaussian.from_mu_sigma(MU0 + gap * BETA, 1.0)
            posts = rate_match(
                match_1v1(),
                {"a": MemberPrior(skill=Gaussian(weak.pi, weak.tau)),
                 "b": MemberPrior(skill=Gaussian(strong.pi, strong.tau))},
                params,
            )
            for pid in ("a", "b"):
                self.assertTrue(math.isfinite(posts[pid].skill.mu))
                self.assertTrue(math.isfinite(posts[pid].skill.sigma))
                self.assertGreater(posts[pid].skill.sigma, 0.0)
            self.assertGreater(posts["a"].skill.mu, MU0)
            self.assertLess(posts["b"].skill.mu, MU0 + gap * BETA)

    def test_upset_moves_more(self):
        """Beating a stronger player moves ratings further than the reverse."""
        params = classic_params()
        strong = Gaussian.from_mu_sigma(30.0, 4.0)
        weak = Gaussian.from_mu_sigma(20.0, 4.0)
        upset = rate_match(
            match_1v1(),
            {"a": MemberPrior(skill=Gaussian(weak.pi, weak.tau)),
             "b": MemberPrior(skill=Gaussian(strong.pi, strong.tau))},
            params,
        )
        expected = rate_match(
            match_1v1(),
            {"a": MemberPrior(skill=Gaussian(strong.pi, strong.tau)),
             "b": MemberPrior(skill=Gaussian(weak.pi, weak.tau))},
            params,
        )
        gain_upset = upset["a"].skill.mu - 20.0
        gain_expected = expected["a"].skill.mu - 30.0
        self.assertGreater(gain_upset, gain_expected)
        self.assertGreater(gain_upset, 0.0)


class TestTeamsAndMultiTeam(unittest.TestCase):
    def test_team_conservation_symmetric(self):
        """4v4 of identical priors: winners all gain equally, losers mirror."""
        params = classic_params()
        players_a = [PlayerResult(f"a{i}") for i in range(4)]
        players_b = [PlayerResult(f"b{i}") for i in range(4)]
        match = Match(
            mode="m", start_time=0.0, length=10.0,
            teams=[Team(rank=1, players=players_a), Team(rank=2, players=players_b)],
        )
        g = Gaussian.from_mu_sigma(MU0, SIGMA0)
        priors = {p.player_id: MemberPrior(skill=Gaussian(g.pi, g.tau))
                  for p in players_a + players_b}
        posts = rate_match(match, priors, params)
        win_mus = [posts[f"a{i}"].skill.mu for i in range(4)]
        lose_mus = [posts[f"b{i}"].skill.mu for i in range(4)]
        for m in win_mus[1:]:
            self.assertAlmostEqual(m, win_mus[0], places=8)
        for m in lose_mus[1:]:
            self.assertAlmostEqual(m, lose_mus[0], places=8)
        self.assertGreater(win_mus[0], MU0)
        self.assertLess(lose_mus[0], MU0)
        self.assertAlmostEqual(win_mus[0] - MU0, MU0 - lose_mus[0], places=8)

    def test_three_team_ordering(self):
        """An observed 1st > 2nd > 3rd ordering must produce ordered means."""
        params = classic_params()
        match = Match(
            mode="m", start_time=0.0, length=10.0,
            teams=[
                Team(rank=2, players=[PlayerResult("mid")]),
                Team(rank=1, players=[PlayerResult("top")]),
                Team(rank=3, players=[PlayerResult("bot")]),
            ],
        )
        g = Gaussian.from_mu_sigma(MU0, SIGMA0)
        priors = {p: MemberPrior(skill=Gaussian(g.pi, g.tau)) for p in ("mid", "top", "bot")}
        posts = rate_match(match, priors, params)
        self.assertGreater(posts["top"].skill.mu, posts["mid"].skill.mu)
        self.assertGreater(posts["mid"].skill.mu, posts["bot"].skill.mu)

    def test_partial_play_weights(self):
        """eq (5): a player present half the match gets a smaller update."""
        params = classic_params()
        match = Match(
            mode="m", start_time=0.0, length=10.0,
            teams=[
                Team(rank=1, players=[PlayerResult("full"), PlayerResult("half", time_played=5.0)]),
                Team(rank=2, players=[PlayerResult("l1"), PlayerResult("l2")]),
            ],
        )
        g = Gaussian.from_mu_sigma(MU0, SIGMA0)
        priors = {p: MemberPrior(skill=Gaussian(g.pi, g.tau)) for p in ("full", "half", "l1", "l2")}
        posts = rate_match(match, priors, params)
        self.assertGreater(posts["full"].skill.mu - MU0, posts["half"].skill.mu - MU0)
        self.assertGreater(posts["half"].skill.mu, MU0)  # still on the winning team


class TestOnlineDynamics(unittest.TestCase):
    def test_gamma_inflates_after_match(self):
        """eq (2): posterior variance gains gamma^2 when stored (paper order)."""
        gamma = 0.5
        params = Params(default_mode=classic_params(gamma=gamma))
        rater = OnlineTrueSkill2(params)
        rater.update(match_1v1())
        posts = rate_match(match_1v1(), priors_equal(), classic_params())
        stored = rater.skill("a", "m")
        self.assertAlmostEqual(stored.var, posts["a"].skill.var + gamma**2, places=8)

    def test_tau_decays_with_idle_time(self):
        """eq (3): variance grows with wall-clock minutes between matches."""
        tau = 0.01
        params = Params(default_mode=classic_params(tau=tau))
        rater = OnlineTrueSkill2(params)
        rater.update(match_1v1())
        after = rater.skill("a", "m")
        idle = 10_000.0  # minutes
        later = rater.skill("a", "m", at_time=10.0 + idle)
        self.assertAlmostEqual(later.var, after.var + tau**2 * idle, places=8)


if __name__ == "__main__":
    unittest.main()
