"""
Per-stat model dispatch for NBA player props.

Routes each market to the appropriate distribution family:
  - player_points / rebounds / assists / turnovers → Negative Binomial
  - player_blocks / steals → Zero-Inflated Poisson
  - player_threes → Beta-Binomial Monte Carlo
  - combos (PRA, PR, PA, RA) → Latent-factor NB Monte Carlo
"""

from __future__ import annotations
import numpy as np
from distributions import (
    fit_nb, nb_p_over, nb_mean_std,
    fit_zip, zip_p_over, zip_mean_std,
    monte_carlo_3pm, monte_carlo_combo,
    mc_p_over, mc_mean_std,
)

# Shared RNG for reproducibility within a run
_RNG = np.random.default_rng(seed=42)

_MARKET_STAT: dict[str, str | list[str]] = {
    "player_points": "points",
    "player_rebounds": "rebounds",
    "player_assists": "assists",
    "player_turnovers": "turnovers",
    "player_blocks": "blocks",
    "player_steals": "steals",
    "player_threes": "threes",
    "player_points_rebounds_assists": ["points", "rebounds", "assists"],
    "player_points_rebounds": ["points", "rebounds"],
    "player_points_assists": ["points", "assists"],
    "player_rebounds_assists": ["rebounds", "assists"],
}

_MIN_GAMES = 8  # minimum games to fit a model; below this, return fallback


def _extract_stat(games: list[dict], stat: str, min_games: bool = True) -> list[float]:
    vals = []
    for g in games:
        v = g.get(stat)
        if v is not None and v >= 0:
            vals.append(float(v))
    return vals


def _scale_mean_by_minutes(base_mean: float, minutes_mean: float, games: list[dict]) -> float:
    """Scale stat mean by predicted minutes vs. historical average."""
    mins = [g.get("minutes") for g in games if g.get("minutes") is not None and g.get("minutes") > 0]
    if not mins or minutes_mean <= 0:
        return base_mean
    hist_min_avg = float(np.mean(mins))
    if hist_min_avg <= 0:
        return base_mean
    ratio = float(np.clip(minutes_mean / hist_min_avg, 0.3, 2.0))
    return base_mean * ratio


def model_stat(
    games: list[dict],
    market: str,
    line: float,
    minutes_dist: dict,
) -> dict:
    """
    Fit the appropriate distribution for a player-market pair and return
    probabilistic outputs.

    Returns:
        {
            modelMean: float,
            modelStd: float,
            modelPOver: float,   # raw P(X > line)
            distributionFamily: str,
        }
    """
    minutes_mean = minutes_dist.get("minutesMean", 30.0) or 30.0

    stat_key = _MARKET_STAT.get(market)
    if stat_key is None:
        return _fallback(market)

    # ------------------------------------------------------------------
    # Combo props — latent-factor NB Monte Carlo
    # ------------------------------------------------------------------
    if isinstance(stat_key, list):
        return _model_combo(games, stat_key, line, minutes_mean)

    # ------------------------------------------------------------------
    # Blocks / Steals — Zero-Inflated Poisson
    # ------------------------------------------------------------------
    if stat_key in ("blocks", "steals"):
        return _model_zip(games, stat_key, line, minutes_mean)

    # ------------------------------------------------------------------
    # 3-Pointers — Beta-Binomial Monte Carlo
    # ------------------------------------------------------------------
    if stat_key == "threes":
        return _model_threes(games, line, minutes_mean)

    # ------------------------------------------------------------------
    # Core stats: Points / Rebounds / Assists / Turnovers — Negative Binomial
    # ------------------------------------------------------------------
    return _model_nb(games, stat_key, line, minutes_mean)


# ---------------------------------------------------------------------------
# NB model (points, rebounds, assists, turnovers)
# ---------------------------------------------------------------------------

def _model_nb(games: list[dict], stat: str, line: float, minutes_mean: float) -> dict:
    vals = _extract_stat(games, stat)
    if len(vals) < _MIN_GAMES:
        return _fallback(f"NB-{stat}")

    mean, disp = fit_nb(vals)
    scaled_mean = _scale_mean_by_minutes(mean, minutes_mean, games)
    # Re-fit dispersion using same ratio (keep var/mean ratio constant)
    if mean > 0:
        scaled_disp = disp * (scaled_mean / mean)
        scaled_disp = max(scaled_disp, 0.1)
    else:
        scaled_disp = disp

    p_over = nb_p_over(scaled_mean, scaled_disp, line)
    m, s = nb_mean_std(scaled_mean, scaled_disp)
    return {
        "modelMean": round(m, 3),
        "modelStd": round(s, 3),
        "modelPOver": round(p_over, 4),
        "distributionFamily": "NB",
    }


# ---------------------------------------------------------------------------
# ZIP model (blocks, steals)
# ---------------------------------------------------------------------------

def _model_zip(games: list[dict], stat: str, line: float, minutes_mean: float) -> dict:
    vals = _extract_stat(games, stat)
    if len(vals) < _MIN_GAMES:
        return _fallback(f"ZIP-{stat}")

    pi, lambda_ = fit_zip(vals)
    # Scale lambda by minutes ratio (zero-inflation pi stays fixed)
    mins = [g.get("minutes") for g in games if g.get("minutes") is not None and g.get("minutes") > 0]
    if mins and minutes_mean > 0:
        hist_avg = float(np.mean(mins))
        ratio = float(np.clip(minutes_mean / hist_avg, 0.3, 2.0))
        lambda_ = lambda_ * ratio

    p_over = zip_p_over(pi, lambda_, line)
    m, s = zip_mean_std(pi, lambda_)
    return {
        "modelMean": round(m, 3),
        "modelStd": round(s, 3),
        "modelPOver": round(p_over, 4),
        "distributionFamily": "ZIP",
    }


# ---------------------------------------------------------------------------
# Beta-Binomial MC model (3-pointers)
# ---------------------------------------------------------------------------

def _model_threes(games: list[dict], line: float, minutes_mean: float) -> dict:
    threes = [g.get("threes") for g in games if g.get("threes") is not None]
    if len(threes) < _MIN_GAMES:
        return _fallback("BetaBinomial-threes")

    samples = monte_carlo_3pm(games, minutes_mean, n=5000, rng=_RNG)
    p_over = mc_p_over(samples, line)
    m, s = mc_mean_std(samples)
    return {
        "modelMean": round(m, 3),
        "modelStd": round(s, 3),
        "modelPOver": round(p_over, 4),
        "distributionFamily": "BetaBinomial",
    }


# ---------------------------------------------------------------------------
# Latent-factor NB MC model (combo props)
# ---------------------------------------------------------------------------

def _model_combo(games: list[dict], stats: list[str], line: float, minutes_mean: float) -> dict:
    component_params = []
    any_data = False

    for stat in stats:
        vals = _extract_stat(games, stat)
        if len(vals) < _MIN_GAMES:
            # Use a rough default so the combo still runs
            component_params.append((1.0, 1.0))
            continue
        any_data = True
        mean, disp = fit_nb(vals)
        scaled_mean = _scale_mean_by_minutes(mean, minutes_mean, games)
        scaled_disp = max(disp * (scaled_mean / max(mean, 0.01)), 0.1)
        component_params.append((scaled_mean, scaled_disp))

    if not any_data:
        return _fallback(f"NB-Latent-{'+'.join(stats)}")

    samples = monte_carlo_combo(component_params, loading=0.4, n=5000, rng=_RNG)
    p_over = mc_p_over(samples, line)
    m, s = mc_mean_std(samples)
    return {
        "modelMean": round(m, 3),
        "modelStd": round(s, 3),
        "modelPOver": round(p_over, 4),
        "distributionFamily": "NB-Latent",
    }


# ---------------------------------------------------------------------------
# Fallback
# ---------------------------------------------------------------------------

def _fallback(label: str) -> dict:
    return {
        "modelMean": 0.0,
        "modelStd": 0.0,
        "modelPOver": 0.5,
        "distributionFamily": "fallback",
    }
