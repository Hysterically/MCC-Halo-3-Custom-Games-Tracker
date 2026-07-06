# TrueSkill 2 — Python, from the original paper

A from-scratch, pure-standard-library Python implementation of the **complete**
TrueSkill 2 model and inference from:

> Tom Minka, Ryan Cleven, Yordan Zaykov.
> *TrueSkill 2: An improved Bayesian skill rating system.*
> Microsoft Research technical report MSR-TR-2018-8, March 22, 2018.

Unlike `src/trueskill2.ts` (the production ladder engine, which implements a
deliberately simplified TrueSkill 2 — win/loss plus lobby-z-scored K/D at a
fixed spread), this package implements the paper's full generative model, each
piece switchable and tunable. No dependencies beyond the Python 3.9+ standard
library.

## Paper → code map

| Paper | Feature | Where |
| --- | --- | --- |
| §2 eq (1) | Skill prior `N(m0, v0)` | `params.ModeParams`, `online.py` |
| §2 eq (2) | Per-match skill drift `gamma` | `online.py` step (d), `batch.py` chains |
| §2 eq (3) | Between-match drift `tau^2 * elapsed` | `online._State.decayed`, `batch.py` |
| §2 eq (4) | Performance `N(skill, beta^2)` | `factorgraph.likelihood_down/up` |
| §2 eq (5) | Team perf = play-time-weighted sum | `factorgraph.rate_match` (team factors) |
| §2 | Win/draw margins, multi-team ordering chain | `gaussian.v_win/w_win/v_draw/w_draw`, `rate_match.chain_iterate` |
| §3 | Online updater (steps 1–2e) | `online.OnlineTrueSkill2` |
| §3 | Batch mode / TrueSkill Through Time | `batch.batch_rate` |
| §4 | Parameter estimation (Rprop, point-mass params) | `fitting.py` |
| §5 | Metric-driven evaluation protocol | `metrics.evaluate_online`, `win_rate_by` |
| §6 eq (7) | Squad offsets | `ModeParams.squad_offsets`, perf likelihood mean shift |
| §7 eq (8) | Experience-biased random walk (cap 200) | `ModeParams.experience_offsets`, `online.py`/`batch.py` |
| §8 eqs (9)–(11) | Kill/death counts as truncated-Gaussian readouts of performance, scaled by play time and opposing perf | `factorgraph` count factors (`gaussian_obs_derivs`, `probit_nonpositive_derivs`) |
| §9 eqs (12)–(13) | Quit model (normalized + unnormalized variants) | `factorgraph.quit_derivs`, `params.QuitModel` |
| §11 eqs (14)–(20) | Mode correlation: base skill + per-mode offsets | `Params.mode_correlation`, `online.py`, `batch.py` |
| §12 | Constant-skill baseline players (bots) | set `gamma=tau=0`, empty experience offsets |

Inference is Expectation Propagation on the per-match factor graph
(`factorgraph.rate_match`), exactly the algorithm family the paper uses via
Infer.NET. With only win/loss observations the graph is a tree and the result
is identical to classic TrueSkill (verified against the closed-form 1v1
update in the tests); the count/quit observations add moment-matched
likelihood factors on the performance variables, and the schedule sweeps until
convergence.

## Using the library

```python
from trueskill2 import (
    Match, PlayerResult, Team, Params, ModeParams, CountModel,
    OnlineTrueSkill2, batch_rate,
)

params = Params(default_mode=ModeParams(
    kill=CountModel(weight_perf=0.5, weight_opp=-0.1, variance=2.0),
    death=CountModel(weight_perf=-0.1, weight_opp=0.5, variance=2.0),
))
rater = OnlineTrueSkill2(params)

match = Match(
    mode="slayer", start_time=0.0, length=10.0,  # minutes
    teams=[
        Team(rank=1, players=[PlayerResult("alice", kills=18, deaths=6),
                              PlayerResult("bob", kills=9, deaths=10)]),
        Team(rank=2, players=[PlayerResult("carol", kills=8, deaths=11),
                              PlayerResult("dave", kills=7, deaths=15)]),
    ],
)
print(rater.predict(match))   # pre-match win probabilities (§5 protocol)
rater.update(match)           # Bayesian update with all end-of-match info
print(rater.leaderboard("slayer"))  # ranked by conservative skill mu - 3*sigma
```

Batch mode (most accurate; smooths information backward through time):

```python
result = batch_rate(matches, params)          # matches sorted by start time
result.final[("alice", "slayer")]             # posterior at her last match
```

## Replaying the tracker's database

`trueskill2.halo3` maps the tracker's SQLite DB (see `src/db.ts`) onto the
model — board categories become modes, kills/deaths become eq-(9) count
observations — and prints the CSR ladder using the same display mapping as
`src/csr.ts`:

```
cd python
python3 -m trueskill2.halo3 --db ../data/tracker.db ladder
python3 -m trueskill2.halo3 --db ../data/tracker.db ladder --batch   # TrueSkill Through Time
python3 -m trueskill2.halo3 --db ../data/tracker.db eval             # §5 predictive accuracy
python3 -m trueskill2.halo3 --db ../data/tracker.db fit              # §4 Rprop fitting
```

The tracker doesn't record squads, per-player play time, or quit status, so
those features stay off in the adapter (they're fully implemented in the
engine). Kill/death counts use the full paper model rather than the TypeScript
engine's z-score approximation, so the two ladders are close but intentionally
not identical when counts are on; with `--no-counts` the engines agree to
~1e-4 rating points (see `tests/test_ts_parity.py`).

## Tests

```
cd python && python3 -m unittest discover -s tests        # or: npm run test:py
```

The suite verifies every EP factor against numerical quadrature, the classic
core against the Herbrich et al. closed forms, each TrueSkill 2 feature's
qualitative behaviour from the paper (squads, experience, counts, quits, mode
correlation, the §3 batch-vs-online ordering example), and number-for-number
parity with the production TypeScript engine on fixture histories
(`tests/fixtures/ts_parity.json`; regenerate with
`npx tsx python/tests/fixtures/generate-ts-fixture.ts` from the repo root).

## Faithfulness notes (deliberate deviations, all documented in-code)

1. **Inference** is hand-written EP rather than Infer.NET-generated code —
   same algorithm, same factor graph, same fixed point (the paper's §3).
2. **Parameter estimation** keeps the paper's outer loop (Rprop on point-mass
   parameters over batch replays, with the paper's constraints: `beta` fixed,
   `w_d >= 0`, `m_q <= 0`, `squadOffset(1) = 0`) but obtains gradient *signs*
   by finite differences of the §5 predictive log-loss instead of
   accumulating EP messages into parameter nodes. Rprop only consumes signs;
   for the dataset sizes this repo sees (hundreds of matches, not 23 million)
   a full replay per probe is cheap and the machinery stays simple. The paper
   itself notes its estimator breaks down under ~1000 matches per mode.
3. **Multi-team draws** use the Herbrich et al. factor-graph treatment — as
   does the paper: "Since the approach in Herbrich et al. [2007] is simpler to
   implement, we used their approach."
4. **Experience offsets** are a free array exactly as in eq (8); a helper
   provides the decaying-exponential shape used by this repo when you don't
   have the data to learn 200 free values.
5. **Quits**: the intro's "treated as a surrender" is realized, as in the
   paper's §9, through the performance-based observation model (eqs 12–13),
   in both its normalized (learning) and unnormalized (online) variants.
6. **Multi-team win prediction** uses a normalized pairwise-product
   approximation (§5 only ever needs "who wins"; exact for two teams).
7. The Halo 3 adapter's default count weights are hand-picked seeds on the
   tracker's rating scale, meant to be refined with `fit` — the paper
   publishes no count parameters.
