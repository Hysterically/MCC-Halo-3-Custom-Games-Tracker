"""Parameter estimation (§4).

The paper treats model parameters as point masses and updates them with Rprop
(Riedmiller & Braun 1993), where each gradient is accumulated from the EP
messages flowing into the parameter across a whole batch sweep, iterating
~100 sweeps over millions of matches.

This module implements the same outer loop — Rprop ascent on a batch objective
over the historical data, with the paper's constraints (beta fixed, w_d >= 0,
m_q <= 0, squadOffset(1) = 0, variances positive) — with one deliberate,
documented simplification suited to small datasets: the per-parameter gradient
SIGN is obtained by finite differences of the objective rather than by
accumulating EP messages. Rprop only consumes gradient signs, so on datasets
where a full replay is cheap (this repo's use case: hundreds of matches, not
millions) the two coincide in behaviour while this version stays independent
of inference internals. The default objective is the §5 predictive log-loss of
match outcomes, the quantity the paper's evaluation is built on.

The paper also notes the estimation "breaks down for game modes with less than
1000 matches. For such modes, we used the parameters estimated from the most
similar popular mode." — for a friends-group tracker, fit a single shared mode
or fit only a few parameters.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from .match import Match
from .metrics import evaluate_online
from .params import CountModel, ModeParams, Params, QuitModel


# -----------------------------------------------------------------------------
# Rprop (sign-based resilient propagation), maximizing.
# -----------------------------------------------------------------------------

@dataclass
class RpropOptions:
    iterations: int = 40
    step_init: float = 0.05
    step_min: float = 1e-5
    step_max: float = 1.0
    eta_plus: float = 1.2
    eta_minus: float = 0.5
    #: Relative finite-difference size for the gradient-sign probe.
    fd_rel: float = 1e-2
    fd_abs: float = 1e-4


def rprop_maximize(
    objective: Callable[[Sequence[float]], float],
    x0: Sequence[float],
    lower: Optional[Sequence[Optional[float]]] = None,
    upper: Optional[Sequence[Optional[float]]] = None,
    options: Optional[RpropOptions] = None,
    on_iteration: Optional[Callable[[int, List[float], float], None]] = None,
) -> Tuple[List[float], float]:
    """Rprop ascent. Returns (best_x, best_objective)."""
    opt = options or RpropOptions()
    x = list(x0)
    n = len(x)
    lo = list(lower) if lower is not None else [None] * n
    hi = list(upper) if upper is not None else [None] * n
    steps = [opt.step_init] * n
    prev_sign = [0] * n

    def clamp(i: int, v: float) -> float:
        if lo[i] is not None:
            v = max(v, lo[i])
        if hi[i] is not None:
            v = min(v, hi[i])
        return v

    best_x = list(x)
    best_f = objective(x)
    f = best_f
    for it in range(opt.iterations):
        for i in range(n):
            h = max(opt.fd_abs, opt.fd_rel * abs(x[i]))
            xp = list(x)
            xp[i] = clamp(i, x[i] + h)
            xm = list(x)
            xm[i] = clamp(i, x[i] - h)
            if xp[i] == xm[i]:
                continue
            g = objective(xp) - objective(xm)
            sign = (g > 0) - (g < 0)
            if sign == 0:
                prev_sign[i] = 0
                continue
            if prev_sign[i] * sign > 0:
                steps[i] = min(steps[i] * opt.eta_plus, opt.step_max)
            elif prev_sign[i] * sign < 0:
                steps[i] = max(steps[i] * opt.eta_minus, opt.step_min)
            prev_sign[i] = sign
            x[i] = clamp(i, x[i] + sign * steps[i])
        f = objective(x)
        if f > best_f:
            best_f = f
            best_x = list(x)
        if on_iteration is not None:
            on_iteration(it, list(x), f)
    return best_x, best_f


# -----------------------------------------------------------------------------
# Binding named ModeParams fields to an optimizer vector.
# -----------------------------------------------------------------------------

#: name -> (getter, setter, lower bound, upper bound). Setters return a new
#: ModeParams (they're frozen dataclasses). Count/quit entries require the
#: corresponding sub-model to be present on the params being fitted.
_FIELDS: Dict[str, Tuple[Callable, Callable, Optional[float], Optional[float]]] = {
    "gamma": (lambda m: m.gamma, lambda m, v: replace(m, gamma=v), 0.0, None),
    "tau": (lambda m: m.tau, lambda m, v: replace(m, tau=v), 0.0, None),
    "v0": (lambda m: m.v0, lambda m, v: replace(m, v0=v), 1e-6, None),
    "m0": (lambda m: m.m0, lambda m, v: replace(m, m0=v), None, None),
    "draw_margin": (lambda m: m.draw_margin, lambda m, v: replace(m, draw_margin=v), 0.0, None),
    "mode_weight": (lambda m: m.mode_weight, lambda m, v: replace(m, mode_weight=v), 0.0, None),  # w_d >= 0
    "kill.weight_perf": (
        lambda m: m.kill.weight_perf,
        lambda m, v: replace(m, kill=replace(m.kill, weight_perf=v)),
        None, None,
    ),
    "kill.weight_opp": (
        lambda m: m.kill.weight_opp,
        lambda m, v: replace(m, kill=replace(m.kill, weight_opp=v)),
        None, None,
    ),
    "kill.variance": (
        lambda m: m.kill.variance,
        lambda m, v: replace(m, kill=replace(m.kill, variance=v)),
        1e-6, None,
    ),
    "death.weight_perf": (
        lambda m: m.death.weight_perf,
        lambda m, v: replace(m, death=replace(m.death, weight_perf=v)),
        None, None,
    ),
    "death.weight_opp": (
        lambda m: m.death.weight_opp,
        lambda m, v: replace(m, death=replace(m.death, weight_opp=v)),
        None, None,
    ),
    "death.variance": (
        lambda m: m.death.variance,
        lambda m, v: replace(m, death=replace(m.death, variance=v)),
        1e-6, None,
    ),
    "quit.mean": (  # m_q <= 0 (§9)
        lambda m: m.quit.mean,
        lambda m, v: replace(m, quit=replace(m.quit, mean=v)),
        None, 0.0,
    ),
    "quit.variance": (
        lambda m: m.quit.variance,
        lambda m, v: replace(m, quit=replace(m.quit, variance=v)),
        1e-6, None,
    ),
}

FITTABLE = tuple(sorted(_FIELDS))


def fit_mode_params(
    matches: Sequence[Match],
    params: Params,
    mode: str,
    names: Sequence[str],
    objective: Optional[Callable[[Params], float]] = None,
    options: Optional[RpropOptions] = None,
    verbose: bool = False,
) -> Tuple[Params, float]:
    """Fit the named parameters of one mode by Rprop over the match history.

    The default objective is the negative §5 predictive log-loss (higher is
    better). Returns the updated Params and the best objective value.
    """
    for name in names:
        if name not in _FIELDS:
            raise ValueError(f"unknown fittable parameter {name!r}; choose from {FITTABLE}")

    if objective is None:
        def objective(p: Params) -> float:
            return -evaluate_online(matches, p).log_loss

    def params_with(vec: Sequence[float]) -> Params:
        mp = params.mode(mode)
        for name, v in zip(names, vec):
            _, setter, _, _ = _FIELDS[name]
            mp = setter(mp, v)
        return params.with_mode(mode, mp)

    mp0 = params.mode(mode)
    x0 = [_FIELDS[n][0](mp0) for n in names]
    lower = [_FIELDS[n][2] for n in names]
    upper = [_FIELDS[n][3] for n in names]

    def on_iter(it: int, x: List[float], f: float) -> None:
        if verbose:
            pretty = ", ".join(f"{n}={v:.5g}" for n, v in zip(names, x))
            print(f"  rprop iter {it + 1}: objective={f:.5f}  {pretty}")

    best_x, best_f = rprop_maximize(
        lambda v: objective(params_with(v)), x0, lower, upper, options, on_iter
    )
    return params_with(best_x), best_f


__all__ = ["rprop_maximize", "RpropOptions", "fit_mode_params", "FITTABLE"]
