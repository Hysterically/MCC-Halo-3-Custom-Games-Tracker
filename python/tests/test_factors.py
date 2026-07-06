"""The moment-matched likelihood factors, verified against numerical quadrature."""

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from trueskill2.factorgraph import (
    LinearLikelihood,
    Variable,
    gaussian_obs_derivs,
    probit_nonpositive_derivs,
    quit_derivs,
)
from trueskill2.gaussian import Gaussian, cdf, pdf


def _prior_var(mu, sigma):
    v = Variable()
    f = object()
    v.attach(f)
    v.update_value(f, Gaussian.from_mu_sigma(mu, sigma))
    return v


def _tilted_1d(mu, sigma, lik, n=200_001, span=12.0):
    lo, hi = mu - span * sigma, mu + span * sigma
    step = (hi - lo) / (n - 1)
    z0 = m1 = m2 = 0.0
    for i in range(n):
        x = lo + i * step
        w = pdf((x - mu) / sigma) / sigma * lik(x)
        z0 += w
        m1 += w * x
        m2 += w * x * x
    mean = m1 / z0
    return mean, m2 / z0 - mean * mean


class TestSingleVariableFactors(unittest.TestCase):
    def _check(self, mu, sigma, derivs, lik, places=4):
        var = _prior_var(mu, sigma)
        fac = LinearLikelihood([var], [1.0], derivs)
        fac.update()
        mean, variance = _tilted_1d(mu, sigma, lik)
        self.assertAlmostEqual(var.mu, mean, places=places)
        self.assertAlmostEqual(var.sigma, math.sqrt(variance), places=places)

    def test_gaussian_observation(self):
        y, noise = 7.0, 2.0
        self._check(
            5.0, 1.5, gaussian_obs_derivs(y, noise),
            lambda d: pdf((y - d) / math.sqrt(noise)),
            places=6,
        )

    def test_probit_nonpositive(self):
        noise = 0.8
        self._check(
            0.7, 1.2, probit_nonpositive_derivs(noise),
            lambda d: cdf(-d / math.sqrt(noise)),
        )

    def test_quit_true(self):
        mq, vq, pu, pr = -0.5, 1.5, 0.05, 0.9
        self._check(
            0.4, 1.1, quit_derivs(True, mq, vq, pu, pr),
            lambda d: pu + (1 - pu) * pr * cdf((mq - d) / math.sqrt(vq)),
        )

    def test_quit_false(self):
        mq, vq, pu, pr = -0.5, 1.5, 0.05, 0.9
        self._check(
            0.4, 1.1, quit_derivs(False, mq, vq, pu, pr),
            lambda d: 1 - pu - (1 - pu) * pr * cdf((mq - d) / math.sqrt(vq)),
        )


class TestMultiVariableFactor(unittest.TestCase):
    def test_two_variable_probit_marginals(self):
        """Marginal moments of each variable under a probit tilt on a1*x1+a2*x2."""
        m1, s1 = 1.0, 0.8
        m2, s2 = -0.5, 1.4
        a1, a2 = 1.0, -0.3
        noise = 0.7

        v1 = _prior_var(m1, s1)
        v2 = _prior_var(m2, s2)
        fac = LinearLikelihood([v1, v2], [a1, a2], probit_nonpositive_derivs(noise))
        fac.update()

        # 2-D quadrature for the tilted marginals.
        n = 601
        span = 8.0
        xs = [m1 - span * s1 + i * (2 * span * s1) / (n - 1) for i in range(n)]
        ys = [m2 - span * s2 + i * (2 * span * s2) / (n - 1) for i in range(n)]
        z0 = e1 = e11 = e2 = e22 = 0.0
        for x in xs:
            wx = pdf((x - m1) / s1) / s1
            for y in ys:
                w = wx * pdf((y - m2) / s2) / s2 * cdf(-(a1 * x + a2 * y) / math.sqrt(noise))
                z0 += w
                e1 += w * x
                e11 += w * x * x
                e2 += w * y
                e22 += w * y * y
        mean1, var1 = e1 / z0, e11 / z0 - (e1 / z0) ** 2
        mean2, var2 = e2 / z0, e22 / z0 - (e2 / z0) ** 2

        self.assertAlmostEqual(v1.mu, mean1, places=3)
        self.assertAlmostEqual(v1.sigma, math.sqrt(var1), places=3)
        self.assertAlmostEqual(v2.mu, mean2, places=3)
        self.assertAlmostEqual(v2.sigma, math.sqrt(var2), places=3)

    def test_positive_count_is_exact_conditioning(self):
        """A positive count is a linear-Gaussian observation — EP is exact."""
        m1, s1 = 2.0, 1.0
        a1 = 3.0
        noise = 4.0
        y = 9.0
        v1 = _prior_var(m1, s1)
        LinearLikelihood([v1], [a1], gaussian_obs_derivs(y, noise)).update()
        # Conjugate update for y = a1*x + N(0, noise):
        prec = 1 / s1**2 + a1**2 / noise
        mean = (m1 / s1**2 + a1 * y / noise) / prec
        self.assertAlmostEqual(v1.mu, mean, places=9)
        self.assertAlmostEqual(v1.sigma, math.sqrt(1 / prec), places=9)


if __name__ == "__main__":
    unittest.main()
