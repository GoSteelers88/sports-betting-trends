"""
Calibration and Expected Value utilities for NBA player props.

calibrate_prob: Platt-style sigmoid calibration (identity until backtesting fits a, b)
compute_ev: EV calculation from model probability + American odds
"""

from __future__ import annotations
import math


def _sigmoid(x: float) -> float:
    """Numerically stable sigmoid."""
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    ex = math.exp(x)
    return ex / (1.0 + ex)


def _logit(p: float) -> float:
    """Logit of p, clamped to avoid ±inf."""
    p = max(1e-6, min(1 - 1e-6, p))
    return math.log(p / (1.0 - p))


def calibrate_prob(raw_prob: float, a: float = 1.0, b: float = 0.0) -> float:
    """
    Platt-style calibration: calibrated = sigmoid(a * logit(raw_prob) + b).
    With a=1.0, b=0.0 this is the identity — useful once backtesting data is
    available to fit a and b via MLE on (raw_prob → outcome) pairs.
    """
    raw_prob = float(max(1e-6, min(1 - 1e-6, raw_prob)))
    calibrated = _sigmoid(a * _logit(raw_prob) + b)
    return float(max(0.001, min(0.999, calibrated)))


def american_to_payout(price: float | None) -> float | None:
    """
    Convert American odds to payout ratio (profit per $1 wagered).
    e.g. -110 → 100/110 ≈ 0.909,  +130 → 130/100 = 1.30
    Returns None if price is None or 0.
    """
    if price is None or price == 0:
        return None
    if price > 0:
        return price / 100.0
    return 100.0 / abs(price)


def compute_ev(
    model_p_over: float,
    over_price: float | None,
    under_price: float | None,
) -> tuple[float, float]:
    """
    Compute expected value (in dollars profit per $1 wagered) for over and under bets.

    model_p_over: calibrated P(stat > line) from the model
    over_price:   consensus average American odds for the over (e.g. -115)
    under_price:  consensus average American odds for the under (e.g. -105)

    EV_over  = P(over)  * payout_over  - P(under) * 1
    EV_under = P(under) * payout_under - P(over)  * 1

    A positive EV means the bet has positive expected value.
    """
    model_p_under = 1.0 - model_p_over

    payout_over = american_to_payout(over_price)
    payout_under = american_to_payout(under_price)

    # If prices not available, use breakeven assumption (-110 ≈ 0.909)
    if payout_over is None:
        payout_over = 100.0 / 110.0
    if payout_under is None:
        payout_under = 100.0 / 110.0

    ev_over = model_p_over * payout_over - model_p_under * 1.0
    ev_under = model_p_under * payout_under - model_p_over * 1.0

    return round(ev_over, 4), round(ev_under, 4)
