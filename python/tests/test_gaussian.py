import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from trueskill2.gaussian import (
    Gaussian, cdf, delta, pdf, ppf, v_draw, v_win, w_draw, w_win,
)


class TestNormal(unittest.TestCase):
    def test_pdf_cdf(self):
        self.assertAlmostEqual(pdf(0.0), 1.0 / math.sqrt(2 * math.pi), places=12)
        self.assertAlmostEqual(cdf(0.0), 0.5, places=12)
        self.assertAlmostEqual(cdf(1.96), 0.9750021048517795, places=10)
        self.assertAlmostEqual(cdf(-1.96), 1.0 - 0.9750021048517795, places=10)

    def test_ppf_roundtrip(self):
        for p in (1e-9, 1e-6, 0.001, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999):
            self.assertLess(abs(cdf(ppf(p)) - p), 1e-13 * p + 1e-16)

    def test_ppf_edges(self):
        self.assertEqual(ppf(0.0), -math.inf)
        self.assertEqual(ppf(1.0), math.inf)

    def test_cdf_left_tail_mills_bounds(self):
        # phi(z) * (-z)/(z^2+1) < Phi(z) < phi(z)/(-z) for all z < 0.
        # The naive 0.5*(1+erf) form fails this below z ~ -8 (it returns 0).
        for z in (-6.0, -8.0, -10.0, -15.0, -20.0, -30.0, -37.0):
            c = cdf(z)
            self.assertGreater(c, pdf(z) * (-z) / (z * z + 1.0))
            self.assertLess(c, pdf(z) / (-z))

    def test_hazard_mills_bounds_and_continuity(self):
        # -z < hazard(z) < -z + 1/(-z) for z < 0, arbitrarily deep.
        z = -4.0
        while z >= -200.0:
            h = v_win(z, 0.0)  # hazard via the public correction
            self.assertGreater(h, -z)
            self.assertLess(h, -z + 1.0 / (-z))
            z -= 1.7
        # The asymptotic-series branch agrees with the direct ratio at the
        # switch point (z = -30, where erfc is still exact).
        z = -30.0
        direct = pdf(z) / (0.5 * math.erfc(-z / math.sqrt(2.0)))
        self.assertLess(abs(v_win(z, 0.0) - direct) / direct, 1e-10)


class TestGaussian(unittest.TestCase):
    def test_from_mu_sigma(self):
        g = Gaussian.from_mu_sigma(25.0, 25.0 / 3.0)
        self.assertAlmostEqual(g.mu, 25.0, places=12)
        self.assertAlmostEqual(g.sigma, 25.0 / 3.0, places=12)

    def test_mul_div(self):
        a = Gaussian.from_mu_sigma(1.0, 2.0)
        b = Gaussian.from_mu_sigma(3.0, 4.0)
        prod = a.mul(b)
        # Product of Gaussians: precision-weighted mean.
        w1, w2 = 1 / 4.0, 1 / 16.0
        self.assertAlmostEqual(prod.mu, (1.0 * w1 + 3.0 * w2) / (w1 + w2), places=12)
        back = prod.div(b)
        self.assertAlmostEqual(back.mu, a.mu, places=12)
        self.assertAlmostEqual(back.sigma, a.sigma, places=12)

    def test_uniform(self):
        u = Gaussian()
        self.assertEqual(u.mu, 0.0)
        self.assertEqual(u.sigma, math.inf)
        a = Gaussian.from_mu_sigma(5.0, 1.0)
        self.assertAlmostEqual(a.mul(u).mu, 5.0, places=12)


def _num_trunc_moments(mu, sigma, margin, drawn, n=400_001, span=10.0):
    """Numerical moments of N(mu, sigma^2) truncated to the win/draw region."""
    lo, hi = mu - span * sigma, mu + span * sigma
    step = (hi - lo) / (n - 1)
    z0 = m1 = m2 = 0.0
    for i in range(n):
        x = lo + i * step
        w = pdf((x - mu) / sigma) / sigma
        keep = (abs(x) <= margin) if drawn else (x > margin)
        if keep:
            z0 += w
            m1 += w * x
            m2 += w * x * x
    mean = m1 / z0
    var = m2 / z0 - mean * mean
    return mean, var


class TestTruncCorrections(unittest.TestCase):
    def test_v_w_win_match_numeric(self):
        for mu, sigma, margin in ((0.5, 1.0, 0.2), (-1.0, 2.0, 0.74), (2.0, 0.7, 0.0)):
            t = mu / sigma
            m = margin / sigma
            mean, var = _num_trunc_moments(mu, sigma, margin, drawn=False)
            self.assertAlmostEqual(mean, mu + sigma * v_win(t, m), places=4)
            self.assertAlmostEqual(var, sigma * sigma * (1.0 - w_win(t, m)), places=4)

    def test_v_w_draw_match_numeric(self):
        for mu, sigma, margin in ((0.3, 1.0, 0.9), (-0.8, 1.5, 1.2)):
            t = mu / sigma
            m = margin / sigma
            mean, var = _num_trunc_moments(mu, sigma, margin, drawn=True)
            self.assertAlmostEqual(mean, mu + sigma * v_draw(t, m), places=4)
            self.assertAlmostEqual(var, sigma * sigma * (1.0 - w_draw(t, m)), places=4)

    def test_win_tail_stability(self):
        # Deep in the losing tail the corrections must stay finite, with w
        # strictly below 1 (w == 1 makes the EP update divide by zero) and
        # sigma^2 * (1 - w) -> the exponential-tail variance 1/x^2.
        for x in (-8.0, -20.0, -40.0, -100.0, -1e4, -1e8):
            v = v_win(x, 0.0)
            w = w_win(x, 0.0)
            self.assertTrue(math.isfinite(v))
            self.assertLess(w, 1.0)
            self.assertGreater(w, 0.0)
            if -1e4 <= x <= -20.0:  # asymptote holds; 1-w still resolvable
                self.assertAlmostEqual((1.0 - w) * x * x, 1.0, delta=0.02)

    def test_draw_tail_matches_direct_formula(self):
        # At at=28, margin=0.5 the denominator Phi(a)-Phi(b) ~ 1e-166 is below
        # the guard, so the Mills-ratio tail path runs; the direct formula is
        # still representable in doubles here and serves as the reference.
        at, margin = 28.0, 0.5
        a, b = margin - at, -margin - at
        phi = lambda x: 0.5 * math.erfc(-x / math.sqrt(2.0))
        z0 = phi(a) - phi(b)
        v_ref = (pdf(b) - pdf(a)) / z0
        w_ref = v_ref * v_ref + (a * pdf(a) - b * pdf(b)) / z0
        self.assertLess(abs(v_draw(at, margin) - v_ref) / abs(v_ref), 1e-9)
        self.assertLess(abs(w_draw(at, margin) - w_ref) / (1.0 - w_ref), 1e-6)
        self.assertAlmostEqual(v_draw(-at, margin), -v_draw(at, margin), places=12)

    def test_draw_tail_stability(self):
        # Far beyond double range for the direct formula: finite, w < 1, and
        # the mean correction pulls the difference back to the near boundary.
        for t, margin in ((45.0, 1.0), (-45.0, 1.0), (60.0, 0.25), (300.0, 2.0)):
            v = v_draw(t, margin)
            w = w_draw(t, margin)
            self.assertTrue(math.isfinite(v))
            self.assertLess(w, 1.0)
            # posterior mean ~ t + v lands within the margin (near the boundary)
            self.assertLess(abs(t + v), margin + 0.1)


if __name__ == "__main__":
    unittest.main()
