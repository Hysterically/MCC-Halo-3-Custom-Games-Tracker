"""Gaussian primitives for expectation propagation.

Everything in the TrueSkill 2 paper (Minka, Cleven & Zaykov 2018) is built out
of one-dimensional Gaussians. This module provides:

  * the standard-normal pdf / cdf / inverse-cdf,
  * `Gaussian` — a 1-D Gaussian in natural (precision, precision-mean) form,
    which makes the EP message operations (multiply, divide) trivial,
  * the truncated-Gaussian correction terms v/w for "greater than" (win) and
    "within margin" (draw) observations, exactly as in Herbrich et al. 2007
    (classic TrueSkill), which the paper reuses unchanged for team orderings.

Pure standard library — no numpy.
"""

from __future__ import annotations

import math

SQRT2 = math.sqrt(2.0)
SQRT2PI = math.sqrt(2.0 * math.pi)

# Below this, a cdf denominator is treated as zero and the stable asymptotic
# form is used instead (same guard value classic TrueSkill implementations use).
_TINY = 2.222758749e-162


def pdf(x: float) -> float:
    """Standard normal density."""
    return math.exp(-0.5 * x * x) / SQRT2PI


def cdf(x: float) -> float:
    """Standard normal cumulative distribution (via math.erf — exact to ulp)."""
    return 0.5 * (1.0 + math.erf(x / SQRT2))


def ppf(p: float) -> float:
    """Inverse standard-normal cdf (Acklam's rational approximation, ~1e-9)."""
    if p <= 0.0:
        return -math.inf
    if p >= 1.0:
        return math.inf
    a = (-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
         1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0)
    b = (-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
         6.680131188771972e1, -1.328068155288572e1)
    c = (-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
         -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0)
    d = (7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
         3.754408661907416e0)
    plow = 0.02425
    phigh = 1.0 - plow
    if p < plow:
        q = math.sqrt(-2.0 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
    if p <= phigh:
        q = p - 0.5
        r = q * q
        return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / \
               (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)
    q = math.sqrt(-2.0 * math.log(1.0 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)


def hazard(z: float) -> float:
    """phi(z)/Phi(z), computed stably far into the left tail."""
    denom = cdf(z)
    if denom > _TINY:
        return pdf(z) / denom
    # Asymptotic: phi(z)/Phi(z) -> -z as z -> -inf.
    return -z


class Gaussian:
    """A 1-D Gaussian in natural form: pi = 1/sigma^2, tau = mu/sigma^2.

    pi == 0 encodes the (improper) uniform distribution, which is what an EP
    message starts out as. Multiplication and division of densities are then
    just addition and subtraction of (pi, tau).
    """

    __slots__ = ("pi", "tau")

    def __init__(self, pi: float = 0.0, tau: float = 0.0) -> None:
        self.pi = pi
        self.tau = tau

    # -- constructors ---------------------------------------------------------
    @staticmethod
    def from_mu_sigma(mu: float, sigma: float) -> "Gaussian":
        pi = 1.0 / (sigma * sigma)
        return Gaussian(pi, pi * mu)

    @staticmethod
    def from_mu_var(mu: float, var: float) -> "Gaussian":
        pi = 1.0 / var
        return Gaussian(pi, pi * mu)

    # -- moments --------------------------------------------------------------
    @property
    def mu(self) -> float:
        return 0.0 if self.pi == 0.0 else self.tau / self.pi

    @property
    def var(self) -> float:
        return math.inf if self.pi == 0.0 else 1.0 / self.pi

    @property
    def sigma(self) -> float:
        return math.inf if self.pi == 0.0 else math.sqrt(1.0 / self.pi)

    # -- density algebra ------------------------------------------------------
    def mul(self, other: "Gaussian") -> "Gaussian":
        return Gaussian(self.pi + other.pi, self.tau + other.tau)

    def div(self, other: "Gaussian") -> "Gaussian":
        return Gaussian(self.pi - other.pi, self.tau - other.tau)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        if self.pi == 0.0:
            return "N(uniform)"
        return f"N(mu={self.mu:.4f}, sigma={self.sigma:.4f})"


def delta(a: Gaussian, b: Gaussian) -> float:
    """Convergence metric between two messages (as in Herbrich's TrueSkill)."""
    pi_delta = abs(a.pi - b.pi)
    if pi_delta == math.inf:
        return 0.0
    return max(abs(a.tau - b.tau), math.sqrt(pi_delta))


# -----------------------------------------------------------------------------
# Truncated-Gaussian corrections for the team-ordering observations
# (Herbrich et al. 2007; reused unchanged by TrueSkill 2 for wins and draws).
# -----------------------------------------------------------------------------

def v_win(t: float, margin: float) -> float:
    """Additive mean correction for the observation `diff > margin`."""
    return hazard(t - margin)


def w_win(t: float, margin: float) -> float:
    """Multiplicative variance correction for `diff > margin`."""
    x = t - margin
    if cdf(x) < _TINY:
        return 1.0 if x < 0.0 else 0.0
    v = v_win(t, margin)
    return v * (v + x)


def v_draw(t: float, margin: float) -> float:
    """Additive mean correction for the observation `|diff| <= margin`."""
    at = abs(t)
    a = margin - at
    b = -margin - at
    denom = cdf(a) - cdf(b)
    numer = pdf(b) - pdf(a)
    v = numer / denom if abs(denom) > _TINY else a
    return -v if t < 0.0 else v


def w_draw(t: float, margin: float) -> float:
    """Multiplicative variance correction for `|diff| <= margin`."""
    at = abs(t)
    a = margin - at
    b = -margin - at
    denom = cdf(a) - cdf(b)
    if abs(denom) < _TINY:
        return 1.0
    v = v_draw(at, margin)
    return v * v + (a * pdf(a) - b * pdf(b)) / denom
