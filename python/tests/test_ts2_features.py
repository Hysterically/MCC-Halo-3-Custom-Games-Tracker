"""Behavioural tests for each TrueSkill 2 model addition (paper §§6-9, 11)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from trueskill2.factorgraph import MemberPrior, rate_match
from trueskill2.gaussian import Gaussian
from trueskill2.match import Match, PlayerResult, Team
from trueskill2.online import OnlineTrueSkill2
from trueskill2.params import (
    BaseSkillParams, CountModel, ModeParams, Params, QuitModel,
    exponential_experience_offsets,
)

MU0 = 25.0
SIGMA0 = 25.0 / 3.0
BETA = SIGMA0 / 2.0


def mode_params(**overrides) -> ModeParams:
    defaults = dict(m0=MU0, v0=SIGMA0**2, beta=BETA, gamma=0.0, tau=0.0, draw_probability=0.1)
    defaults.update(overrides)
    return ModeParams(**defaults)


def team_match(players_a, players_b, rank_a=1, rank_b=2, length=10.0) -> Match:
    return Match(
        mode="m", start_time=0.0, length=length,
        teams=[Team(rank=rank_a, players=players_a), Team(rank=rank_b, players=players_b)],
    )


def equal_priors(ids):
    g = Gaussian.from_mu_sigma(MU0, SIGMA0)
    return {i: MemberPrior(skill=Gaussian(g.pi, g.tau)) for i in ids}


class TestSquadOffset(unittest.TestCase):
    """§6, eq (7): squad members are expected to perform above their skill."""

    def test_squad_win_credits_less(self):
        params = mode_params(squad_offsets=(0.0, 2.0, 3.0, 4.0))
        # A four-stack beats solo players: the win is partly explained by the
        # squad advantage, so the squad gains less skill than a solo team would.
        squad = [PlayerResult(f"s{i}", squad_size=4) for i in range(4)]
        solos = [PlayerResult(f"o{i}") for i in range(4)]
        posts_squad = rate_match(
            team_match(squad, solos), equal_priors([p.player_id for p in squad + solos]),
            params,
        )
        solo_team = [PlayerResult(f"s{i}") for i in range(4)]
        posts_solo = rate_match(
            team_match(solo_team, solos), equal_priors([p.player_id for p in solo_team + solos]),
            params,
        )
        self.assertLess(posts_squad["s0"].skill.mu, posts_solo["s0"].skill.mu)

    def test_prediction_favours_squad(self):
        params = Params(default_mode=mode_params(squad_offsets=(0.0, 2.0, 3.0, 4.0)))
        rater = OnlineTrueSkill2(params)
        squad = [PlayerResult(f"s{i}", squad_size=4) for i in range(4)]
        solos = [PlayerResult(f"o{i}") for i in range(4)]
        pred = rater.predict(team_match(squad, solos))
        self.assertGreater(pred.teams[0].win_prob, pred.teams[1].win_prob)


class TestExperienceOffset(unittest.TestCase):
    """§7, eq (8): the skill random walk is biased upward for new players."""

    def test_offset_added_after_each_match(self):
        offsets = exponential_experience_offsets(0.15, 8.0)
        params = Params(default_mode=mode_params(experience_offsets=offsets))
        rater = OnlineTrueSkill2(params)
        m = team_match([PlayerResult("a")], [PlayerResult("b")])
        posts = rater.update(m)
        # Stored mean = posterior mean + experienceOffset(0).
        self.assertAlmostEqual(rater.skill("a", "m").mu, posts["a"].mu + 0.15, places=9)
        self.assertAlmostEqual(rater.skill("b", "m").mu, posts["b"].mu + 0.15, places=9)

    def test_offset_decays_with_experience(self):
        offsets = exponential_experience_offsets(0.15, 8.0)
        mp = mode_params(experience_offsets=offsets)
        self.assertAlmostEqual(mp.experience_offset(0), 0.15, places=12)
        self.assertLess(mp.experience_offset(20), mp.experience_offset(0))
        # Capped at 200 (paper §7).
        self.assertEqual(mp.experience_offset(500), mp.experience_offset(200))


class TestIndividualStatistics(unittest.TestCase):
    """§8, eqs (9)-(11): kills and deaths are noisy readouts of performance."""

    KILL = CountModel(weight_perf=0.12, weight_opp=-0.072, variance=2.5)
    DEATH = CountModel(weight_perf=-0.072, weight_opp=0.12, variance=2.5)

    def test_carry_gains_more_than_passenger(self):
        """Same won match: the high-kill player must gain more skill."""
        params = mode_params(kill=self.KILL, death=self.DEATH)
        winners = [PlayerResult("carry", kills=25, deaths=5),
                   PlayerResult("passenger", kills=2, deaths=14)]
        losers = [PlayerResult("l1", kills=9, deaths=13), PlayerResult("l2", kills=9, deaths=14)]
        posts = rate_match(
            team_match(winners, losers),
            equal_priors(["carry", "passenger", "l1", "l2"]),
            params,
        )
        self.assertGreater(posts["carry"].skill.mu, posts["passenger"].skill.mu)
        # Classic TrueSkill can't tell them apart — that's the paper's point.
        posts_classic = rate_match(
            team_match(
                [PlayerResult("carry"), PlayerResult("passenger")],
                [PlayerResult("l1"), PlayerResult("l2")],
            ),
            equal_priors(["carry", "passenger", "l1", "l2"]),
            mode_params(),
        )
        self.assertAlmostEqual(
            posts_classic["carry"].skill.mu, posts_classic["passenger"].skill.mu, places=9
        )

    def test_deaths_pull_down(self):
        params = mode_params(kill=self.KILL, death=self.DEATH)
        winners = [PlayerResult("feeder", kills=10, deaths=25),
                   PlayerResult("anchor", kills=10, deaths=3)]
        losers = [PlayerResult("l1", kills=10, deaths=10), PlayerResult("l2", kills=8, deaths=10)]
        posts = rate_match(
            team_match(winners, losers), equal_priors(["feeder", "anchor", "l1", "l2"]), params
        )
        self.assertGreater(posts["anchor"].skill.mu, posts["feeder"].skill.mu)

    def test_counts_scale_with_match_length(self):
        """eq (9): the same kill total over a longer match is a weaker signal
        of high performance (rates, not totals, carry the information)."""
        params = mode_params(kill=self.KILL, death=self.DEATH)

        def run(length):
            winners = [PlayerResult("carry", kills=20, deaths=5),
                       PlayerResult("mate", kills=5, deaths=5)]
            losers = [PlayerResult("l1", kills=5, deaths=12), PlayerResult("l2", kills=5, deaths=13)]
            m = team_match(winners, losers, length=length)
            return rate_match(m, equal_priors(["carry", "mate", "l1", "l2"]), params)

        short = run(8.0)
        long_ = run(20.0)
        gap_short = short["carry"].skill.mu - short["mate"].skill.mu
        gap_long = long_["carry"].skill.mu - long_["mate"].skill.mu
        self.assertGreater(gap_short, gap_long)

    def test_zero_count_is_informative(self):
        """A zero kill count is a (truncated) observation, not missing data."""
        params = mode_params(kill=self.KILL)
        winners = [PlayerResult("zero", kills=0), PlayerResult("scorer", kills=20)]
        losers = [PlayerResult("l1", kills=8), PlayerResult("l2", kills=8)]
        posts = rate_match(
            team_match(winners, losers), equal_priors(["zero", "scorer", "l1", "l2"]), params
        )
        self.assertGreater(posts["scorer"].skill.mu, posts["zero"].skill.mu)


class TestQuitModel(unittest.TestCase):
    """§9, eqs (12)-(13): quitting implies under-performance."""

    QUIT = QuitModel(mean=-0.5, variance=2.0, p_unrelated=0.05, p_related=0.9)

    def test_quitter_rated_below_completer(self):
        params = mode_params(quit=self.QUIT)
        winners = [PlayerResult("w1"), PlayerResult("w2")]
        losers = [PlayerResult("quitter", quit=True), PlayerResult("stayer", quit=False)]
        posts = rate_match(
            team_match(winners, losers), equal_priors(["w1", "w2", "quitter", "stayer"]), params
        )
        self.assertLess(posts["quitter"].skill.mu, posts["stayer"].skill.mu)

    def test_unnormalized_no_quit_matches_classic(self):
        """§9: with no quitters, the (unnormalized) online model must cost and
        behave exactly like classic TrueSkill."""
        params = mode_params(quit=self.QUIT)  # normalized=False (default)
        winners = [PlayerResult("w1", quit=False), PlayerResult("w2", quit=False)]
        losers = [PlayerResult("l1", quit=False), PlayerResult("l2", quit=False)]
        posts = rate_match(
            team_match(winners, losers), equal_priors(["w1", "w2", "l1", "l2"]), params
        )
        classic = rate_match(
            team_match(
                [PlayerResult("w1"), PlayerResult("w2")],
                [PlayerResult("l1"), PlayerResult("l2")],
            ),
            equal_priors(["w1", "w2", "l1", "l2"]),
            mode_params(),
        )
        for pid in ("w1", "l1"):
            self.assertAlmostEqual(posts[pid].skill.mu, classic[pid].skill.mu, places=9)
            self.assertAlmostEqual(posts[pid].skill.sigma, classic[pid].skill.sigma, places=9)

    def test_normalized_completion_rewards(self):
        """§9: 'to penalize players that quit, the model must reward players
        that complete' — under the normalized model completing is evidence of
        NOT under-performing."""
        params = mode_params(
            quit=QuitModel(mean=-0.5, variance=2.0, p_unrelated=0.05, p_related=0.9, normalized=True)
        )
        winners = [PlayerResult("w1", quit=False), PlayerResult("w2", quit=False)]
        losers = [PlayerResult("l1", quit=False), PlayerResult("l2", quit=False)]
        posts = rate_match(
            team_match(winners, losers), equal_priors(["w1", "w2", "l1", "l2"]), params
        )
        classic = rate_match(
            team_match(
                [PlayerResult("w1"), PlayerResult("w2")],
                [PlayerResult("l1"), PlayerResult("l2")],
            ),
            equal_priors(["w1", "w2", "l1", "l2"]),
            mode_params(),
        )
        # Completing a loss is mild positive evidence relative to classic.
        self.assertGreater(posts["l1"].skill.mu, classic["l1"].skill.mu)


class TestModeCorrelation(unittest.TestCase):
    """§11, eqs (14)-(20): skill in a new mode is borrowed from other modes."""

    def _params(self) -> Params:
        return Params(
            default_mode=mode_params(m0=0.0, v0=1.0, beta=BETA, mode_weight=1.0),
            mode_correlation=True,
            base=BaseSkillParams(vb=SIGMA0**2, gamma=0.0, tau=0.0),
        )

    def test_skill_transfers_to_new_mode(self):
        rater = OnlineTrueSkill2(self._params())
        # "a" beats "b" repeatedly in mode 1.
        for _ in range(10):
            rater.update(
                Match(mode="mode1", start_time=0.0, length=10.0,
                      teams=[Team(1, [PlayerResult("a")]), Team(2, [PlayerResult("b")])])
            )
        # Never played mode2, but the base skill carries over (eq 20).
        self.assertGreater(rater.skill("a", "mode2").mu, rater.skill("b", "mode2").mu)
        # And the transferred belief is weaker than the practiced one.
        self.assertGreater(rater.skill("a", "mode2").sigma, rater.skill("a", "mode1").sigma)

    def test_zero_weight_isolates_modes(self):
        params = self._params()
        params.default_mode = mode_params(m0=0.0, v0=1.0, mode_weight=0.0)
        rater = OnlineTrueSkill2(params)
        for _ in range(5):
            rater.update(
                Match(mode="mode1", start_time=0.0, length=10.0,
                      teams=[Team(1, [PlayerResult("a")]), Team(2, [PlayerResult("b")])])
            )
        # w_d = 0: "mode has no correlation with any other mode" (§11).
        self.assertAlmostEqual(rater.skill("a", "mode2").mu, rater.skill("b", "mode2").mu, places=9)


if __name__ == "__main__":
    unittest.main()
