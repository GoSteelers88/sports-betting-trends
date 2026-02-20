"""
Walk-forward backtesting harness for NBA player prop models.

Evaluates distributional accuracy against actual stat outcomes using the
75-day ESPN game log (no historical prop lines required).

Metrics:
  - MAE: mean absolute error of modelMean vs actual
  - RMSE: root mean squared error
  - NLL: negative log-likelihood of actual outcome under predicted distribution
  - Brier: (P(actual > median_line) - y_over)^2, averaged

Output: data/processed/backtest-results.json
"""

from __future__ import annotations
import json
import math
import os
import sys
import time
import traceback
from pathlib import Path
from datetime import datetime

import numpy as np
from scipy import stats

# Adjust path to import sibling modules
_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE))

from minutes_model import estimate_minutes
from stat_models import model_stat
from distributions import fit_nb, fit_zip

# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------
REPO_ROOT = Path(__file__).parent.parent.parent
DATA_DIR = REPO_ROOT / "data" / "processed"
OUT_FILE = DATA_DIR / "backtest-results.json"

MIN_TOTAL_GAMES = 25      # player must have this many games total
HOLDOUT_WINDOW = 15       # evaluate on last N games per player
MIN_TRAIN_GAMES = 10      # must have this many games before each prediction

MARKETS = [
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_threes",
    "player_blocks",
    "player_steals",
    "player_turnovers",
]

STAT_KEY = {
    "player_points": "points",
    "player_rebounds": "rebounds",
    "player_assists": "assists",
    "player_threes": "threes",
    "player_blocks": "blocks",
    "player_steals": "steals",
    "player_turnovers": "turnovers",
}


# ------------------------------------------------------------------
# Load player game history from latest-player-props.json or ESPN cache
# ------------------------------------------------------------------

def load_player_history() -> dict[str, list[dict]]:
    """
    Load player game histories. We rebuild from the ESPN data embedded in
    the latest-player-props run (if available) or read the raw processed file.
    """
    # Try to find a player history snapshot if the ingest script wrote one
    snapshot = DATA_DIR / "player-history-snapshot.json"
    if snapshot.exists():
        with open(snapshot) as f:
            return json.load(f)

    print("[backtest] No player history snapshot found.", file=sys.stderr)
    print("[backtest] Run 'npm run ingest:props' first to generate it.", file=sys.stderr)
    print("[backtest] Falling back to empty dataset — run ingest:props first.", file=sys.stderr)
    return {}


# ------------------------------------------------------------------
# Distribution NLL helpers
# ------------------------------------------------------------------

def nb_nll(actual: float, mean: float, dispersion: float) -> float:
    """NLL of actual under NB(mean, dispersion). Lower is better."""
    if mean <= 0 or dispersion <= 0:
        return 10.0
    n = dispersion
    p = n / (n + mean)
    k = int(actual)
    logpmf = stats.nbinom.logpmf(k, n, p)
    return float(-logpmf) if np.isfinite(logpmf) else 10.0


def zip_nll(actual: float, pi: float, lambda_: float) -> float:
    """NLL of actual under ZIP(pi, lambda_). Lower is better."""
    k = int(actual)
    if k == 0:
        log_p = math.log(pi + (1 - pi) * math.exp(-lambda_) + 1e-12)
    else:
        log_p = math.log(1 - pi + 1e-12) + stats.poisson.logpmf(k, lambda_)
    return float(-log_p) if np.isfinite(-log_p) else 10.0


# ------------------------------------------------------------------
# Walk-forward evaluation
# ------------------------------------------------------------------

def evaluate_player_market(
    games: list[dict],
    market: str,
    stat: str,
) -> list[dict]:
    """
    Walk-forward: for each game in the holdout window, fit on prior games and
    predict the distribution. Evaluate against the actual outcome.
    """
    # games sorted newest-first (index 0 = most recent)
    records = []
    n = len(games)

    for i in range(min(HOLDOUT_WINDOW, n - MIN_TRAIN_GAMES)):
        held_out = games[i]
        train_games = games[i + 1:]  # older games only

        actual = held_out.get(stat)
        if actual is None:
            continue

        if len(train_games) < MIN_TRAIN_GAMES:
            continue

        try:
            rest_days = None
            if i + 1 < n and held_out.get("date") and games[i + 1].get("date"):
                from datetime import date
                d1 = date.fromisoformat(held_out["date"][:10])
                d2 = date.fromisoformat(games[i + 1]["date"][:10])
                rest_days = (d1 - d2).days

            minutes_dist = estimate_minutes(train_games, rest_days)

            # Use median of actual values as a proxy "line" for Brier scoring
            train_vals = [g.get(stat) for g in train_games if g.get(stat) is not None]
            median_line = float(np.median(train_vals)) if train_vals else actual

            result = model_stat(train_games, market, median_line, minutes_dist)

            model_mean = result.get("modelMean", 0.0)
            model_std = result.get("modelStd", 1.0)
            p_over = result.get("modelPOver", 0.5)
            dist_family = result.get("distributionFamily", "fallback")
            actual_over = 1 if actual > median_line else 0

            # NLL
            if dist_family == "NB":
                from distributions import fit_nb as _fit_nb
                train_vals_f = [float(v) for v in train_vals if v is not None]
                mean_h, disp_h = _fit_nb(train_vals_f)
                # Scale by minutes ratio
                mins_train = [g.get("minutes") for g in train_games if g.get("minutes") is not None]
                mm = minutes_dist.get("minutesMean", 30)
                if mins_train and mm:
                    ratio = mm / max(float(np.mean(mins_train)), 1)
                    mean_h = mean_h * float(np.clip(ratio, 0.3, 2.0))
                nll = nb_nll(actual, mean_h, disp_h)
            elif dist_family == "ZIP":
                from distributions import fit_zip as _fit_zip
                train_vals_f = [float(v) for v in train_vals if v is not None]
                pi_h, lam_h = _fit_zip(train_vals_f)
                nll = zip_nll(actual, pi_h, lam_h)
            else:
                # Use normal approximation for MC-based models
                if model_std > 0:
                    logpdf = stats.norm.logpdf(actual, loc=model_mean, scale=model_std)
                    nll = float(-logpdf) if np.isfinite(logpdf) else 10.0
                else:
                    nll = 10.0

            records.append({
                "market": market,
                "actual": float(actual),
                "modelMean": model_mean,
                "modelStd": model_std,
                "pOver": p_over,
                "medianLine": median_line,
                "actualOver": actual_over,
                "nll": nll,
                "distFamily": dist_family,
            })

        except Exception:
            pass  # skip games that error

    return records


# ------------------------------------------------------------------
# Aggregate metrics
# ------------------------------------------------------------------

def aggregate_records(records: list[dict]) -> dict:
    if not records:
        return {}

    maes, rmses, nlls, briers, p_overs, actuals_over = [], [], [], [], [], []
    for r in records:
        mae = abs(r["modelMean"] - r["actual"])
        maes.append(mae)
        rmses.append(mae ** 2)
        nlls.append(r["nll"])
        p_over = r["pOver"]
        y_over = r["actualOver"]
        brier = (p_over - y_over) ** 2
        briers.append(brier)
        p_overs.append(p_over)
        actuals_over.append(y_over)

    # Calibration curve (10 bins)
    bins = np.linspace(0, 1, 11)
    calib = []
    for b0, b1 in zip(bins[:-1], bins[1:]):
        mask = [(b0 <= p < b1) for p in p_overs]
        bin_p = [p for p, m in zip(p_overs, mask) if m]
        bin_y = [y for y, m in zip(actuals_over, mask) if m]
        if bin_p:
            calib.append({
                "predBin": round((b0 + b1) / 2, 2),
                "actualFreq": round(float(np.mean(bin_y)), 3),
                "n": len(bin_p),
            })

    return {
        "n": len(records),
        "mae": round(float(np.mean(maes)), 3),
        "rmse": round(float(np.sqrt(np.mean(rmses))), 3),
        "nll": round(float(np.mean(nlls)), 3),
        "brier": round(float(np.mean(briers)), 4),
        "calibrationCurve": calib,
    }


# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------

def main():
    print("[backtest] Loading player history...", file=sys.stderr)
    history = load_player_history()

    if not history:
        print("[backtest] No data. Exiting.", file=sys.stderr)
        sys.exit(1)

    all_records: dict[str, list[dict]] = {m: [] for m in MARKETS}
    n_players = 0
    t0 = time.time()

    for player, games in history.items():
        if len(games) < MIN_TOTAL_GAMES:
            continue
        n_players += 1

        for market in MARKETS:
            stat = STAT_KEY[market]
            try:
                recs = evaluate_player_market(games, market, stat)
                all_records[market].extend(recs)
            except Exception:
                pass

    elapsed = time.time() - t0
    print(f"[backtest] Evaluated {n_players} players in {elapsed:.1f}s", file=sys.stderr)

    by_market = {}
    all_recs_flat = []
    for market, recs in all_records.items():
        all_recs_flat.extend(recs)
        by_market[market] = aggregate_metrics_for(recs)

    overall = aggregate_metrics_for(all_recs_flat)
    # Aggregate calibration across all markets
    overall_calib = aggregate_records(all_recs_flat).get("calibrationCurve", [])

    output = {
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "nPlayers": n_players,
        "nPredictions": len(all_recs_flat),
        "elapsedSeconds": round(elapsed, 1),
        "overall": {**overall, "calibrationCurve": overall_calib},
        "byMarket": by_market,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w") as f:
        json.dump(output, f, indent=2)

    print(f"[backtest] Wrote results to {OUT_FILE}", file=sys.stderr)
    print(f"[backtest] Overall: MAE={overall.get('mae', '?')}, "
          f"Brier={overall.get('brier', '?')}, NLL={overall.get('nll', '?')}", file=sys.stderr)


def aggregate_metrics_for(records: list[dict]) -> dict:
    agg = aggregate_records(records)
    return {k: v for k, v in agg.items() if k != "calibrationCurve"}


if __name__ == "__main__":
    main()
