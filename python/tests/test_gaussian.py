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
        for p in (0.001, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999):
            self.assertAlmostEqual(cdf(ppf(p)), p, places=8)

    def test_ppf_edges(self):
        self.assertEqual(ppf(0.0), -math.inf)
        self.assertEqual(ppf(1.0), math.inf)


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
        # Deep in the losing tail the corrections must stay finite.
        v = v_win(-40.0, 0.0)
        w = w_win(-40.0, 0.0)
        self.assertTrue(math.isfinite(v))
        self.assertTrue(0.0 <= w <= 1.0)


if __name__ == "__main__":
    unittest.main()
