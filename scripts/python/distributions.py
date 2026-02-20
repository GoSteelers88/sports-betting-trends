"""
Statistical distribution helpers for NBA player prop modeling.
Implements: Negative Binomial, Zero-Inflated Poisson, Beta-Binomial MC,
            Latent-factor Monte Carlo for combo props.
"""

from __future__ import annotations
import math
import numpy as np
from scipy import stats


# ---------------------------------------------------------------------------
# Negative Binomial (NB)
# ---------------------------------------------------------------------------

def fit_nb(values: list[float]) -> tuple[float, float]:
    """
    Fit Negative Binomial via method of moments.
    Returns (mean, dispersion) where dispersion n = mean² / max(var - mean, eps).
    scipy NB parameterized as nbinom(n, p) with p = n / (n + mean).
    """
    arr = np.array(values, dtype=float)
    arr = arr[arr >= 0]
    if len(arr) == 0:
        return 0.0, 1.0
    mean = float(np.mean(arr))
    if mean <= 0:
        return 0.0, 1.0
    var = float(np.var(arr, ddof=1)) if len(arr) >= 2 else mean
    # Clamp var to be at least mean (Poisson baseline)
    excess_var = max(var - mean, 0.01)
    dispersion = mean ** 2 / excess_var
    dispersion = max(dispersion, 0.1)  # avoid degenerate params
    return mean, dispersion


def nb_p_over(mean: float, dispersion: float, line: float) -> float:
    """
    P(X > line) for X ~ NegBin(mean, dispersion).
    line is the sportsbook line (can be half-integer like 24.5).
    """
    if mean <= 0:
        return 0.0
    n = dispersion
    p = n / (n + mean)
    # P(X > line) = 1 - P(X <= floor(line))
    threshold = math.floor(line)
    prob = 1.0 - stats.nbinom.cdf(threshold, n, p)
    return float(np.clip(prob, 0.001, 0.999))


def nb_mean_std(mean: float, dispersion: float) -> tuple[float, float]:
    """Return mean and std of NB(mean, dispersion)."""
    n = dispersion
    p = n / (n + mean)
    nb_var = mean + mean ** 2 / n
    return mean, math.sqrt(max(nb_var, 0))


# ---------------------------------------------------------------------------
# Zero-Inflated Poisson (ZIP) — for blocks and steals
# ---------------------------------------------------------------------------

def fit_zip(values: list[float]) -> tuple[float, float]:
    """
    Fit Zero-Inflated Poisson via method of moments.
    Returns (pi, lambda_) where:
      pi = zero-inflation probability
      lambda_ = Poisson rate for the count component
    """
    arr = np.array(values, dtype=float)
    arr = arr[arr >= 0]
    if len(arr) == 0:
        return 0.5, 0.5
    n_zeros = int(np.sum(arr == 0))
    non_zero = arr[arr > 0]
    if len(non_zero) == 0:
        return 1.0, 0.5
    pi = n_zeros / len(arr)
    lambda_ = float(np.mean(non_zero))
    return float(pi), float(lambda_)


def zip_p_over(pi: float, lambda_: float, line: float) -> float:
    """
    P(X > line) for X ~ ZIP(pi, lambda_).
    ZIP: P(X=0) = pi + (1-pi)*exp(-lambda), P(X=k) = (1-pi)*Poisson(k; lambda) for k>0
    """
    if lambda_ <= 0:
        return 0.0
    threshold = math.floor(line)
    if threshold < 0:
        return 1.0
    # P(X > threshold) = (1-pi) * P(Poisson > threshold)
    poisson_p_over = 1.0 - stats.poisson.cdf(threshold, lambda_)
    prob = (1.0 - pi) * poisson_p_over
    return float(np.clip(prob, 0.001, 0.999))


def zip_mean_std(pi: float, lambda_: float) -> tuple[float, float]:
    """Return mean and std of ZIP(pi, lambda_)."""
    mean = (1 - pi) * lambda_
    var = (1 - pi) * (lambda_ + pi * lambda_ ** 2)
    return mean, math.sqrt(max(var, 0))


# ---------------------------------------------------------------------------
# Beta-Binomial Monte Carlo — for 3-pointers made
# ---------------------------------------------------------------------------

def _fit_beta_mom(values: list[float]) -> tuple[float, float]:
    """
    Fit Beta distribution via method of moments to values in [0,1].
    Returns (alpha, beta).
    """
    arr = np.array(values, dtype=float)
    arr = np.clip(arr, 1e-6, 1 - 1e-6)
    mean = float(np.mean(arr))
    var = float(np.var(arr, ddof=1)) if len(arr) >= 2 else mean * (1 - mean) * 0.5
    var = min(var, mean * (1 - mean) - 1e-6)
    if var <= 0:
        var = 1e-4
    common = mean * (1 - mean) / var - 1
    alpha = mean * common
    beta_ = (1 - mean) * common
    return max(alpha, 0.1), max(beta_, 0.1)


def monte_carlo_3pm(
    games: list[dict],
    minutes_mean: float,
    n: int = 5000,
    rng: np.random.Generator | None = None,
) -> np.ndarray:
    """
    Sample 3PM via Beta-Binomial:
      attempts (3PA) ~ NegBin, scaled by minutes ratio
      success (3P%)  ~ Beta(alpha, beta) from historical 3P%
      3PM | attempts, p ~ Binomial(attempts, p)

    games: list of PlayerGame dicts with keys: threes, fga, fta, minutes
    Returns array of shape (n,) with sampled 3PM values.
    """
    if rng is None:
        rng = np.random.default_rng()

    threes = [g["threes"] for g in games if g.get("threes") is not None and g.get("minutes", 0) > 0]
    attempts_raw = []
    pct_raw = []
    mins_raw = []

    for g in games:
        t = g.get("threes")
        m = g.get("minutes")
        fga = g.get("fga")
        if t is None or m is None or m <= 0:
            continue
        mins_raw.append(m)
        # Estimate 3PA from FGA if available, else assume ~30% of FGA are 3PA
        if fga is not None and fga > 0:
            # Rough heuristic: 3PA not directly available, estimate from threes made
            # Use made / 0.36 as a soft estimate
            est_att = max(t / 0.36, t) if t > 0 else max(fga * 0.3, 0)
        else:
            est_att = max(t / 0.36, t) if t > 0 else 0
        attempts_raw.append(est_att / m)  # per-minute rate

    if not threes or not attempts_raw:
        return np.zeros(n)

    season_min_avg = float(np.mean(mins_raw)) if mins_raw else 30.0
    minutes_ratio = minutes_mean / max(season_min_avg, 1.0)

    # Fit attempt rate (NB)
    att_mean_pm, att_disp = fit_nb(attempts_raw)
    att_mean = att_mean_pm * minutes_mean
    att_mean = max(att_mean, 0.1)

    # Fit 3P% (Beta)
    made_arr = np.array([g["threes"] for g in games if g.get("threes") is not None and g.get("minutes", 0) > 0], dtype=float)
    if len(made_arr) >= 3 and att_mean > 0:
        # Per-game pct: made / estimated attempts
        pcts = made_arr / max(att_mean, 1.0)
        pcts = pcts[pcts > 0]
        if len(pcts) >= 3:
            alpha, beta_p = _fit_beta_mom(pcts.tolist())
        else:
            alpha, beta_p = 3.0, 6.0  # prior: ~33% 3P%
    else:
        alpha, beta_p = 3.0, 6.0

    # Sample
    n_att = rng.negative_binomial(att_disp, att_disp / (att_disp + att_mean), size=n)
    p_pct = rng.beta(alpha, beta_p, size=n)
    samples = rng.binomial(n_att, p_pct)
    return samples.astype(float)


# ---------------------------------------------------------------------------
# Latent-factor Monte Carlo — for combo props (PRA, PR, PA, RA)
# ---------------------------------------------------------------------------

def monte_carlo_combo(
    component_params: list[tuple[float, float]],
    loading: float = 0.4,
    n: int = 5000,
    rng: np.random.Generator | None = None,
) -> np.ndarray:
    """
    Correlation-aware simulation for combo props (PRA, PR, PA, RA).

    Induces correlation via a shared latent Z ~ Normal(0,1):
      mu_i = base_mean_i * exp(loading * Z)  — loading scales each component together
    Each component i is sampled from NegBin(mu_i, disp_i), then summed.

    component_params: list of (mean, dispersion) tuples, one per component
      e.g. [(pts_mean, pts_disp), (reb_mean, reb_disp), (ast_mean, ast_disp)]
    loading: latent factor loading (0 = independent, 1 = fully correlated)
    Returns array of shape (n,) with combo totals.
    """
    if rng is None:
        rng = np.random.default_rng()

    Z = rng.standard_normal(size=n)
    scale = np.exp(loading * Z)  # shape (n,)

    total = np.zeros(n)
    for base_mean, disp in component_params:
        if base_mean <= 0:
            continue
        mu_i = np.clip(base_mean * scale, 0.01, None)  # shape (n,)
        p_i = disp / (disp + mu_i)
        # Sample NB with varying mean per-trial
        # scipy nbinom requires scalar params, so use vectorized approach
        u = rng.uniform(size=n)
        samples = stats.nbinom.ppf(u, disp, p_i).astype(float)
        total += samples

    return total


def mc_p_over(samples: np.ndarray, line: float) -> float:
    """Fraction of MC samples strictly greater than the sportsbook line."""
    return float(np.clip((samples > line).mean(), 0.001, 0.999))


def mc_mean_std(samples: np.ndarray) -> tuple[float, float]:
    return float(np.mean(samples)), float(np.std(samples))
