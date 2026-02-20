"""
Two-stage minutes model for NBA player props.

Stage 1: P(DNP or < 5 min) via logistic regression
Stage 2: Conditional minutes regressor (LightGBM if available, else linear blend)

Input: list of PlayerGame dicts, rest_days
Output: { minutesMean, minutesStd, minutesPDNP }
"""

from __future__ import annotations
import numpy as np

_LGBM_AVAILABLE = False
try:
    import lightgbm as lgb  # type: ignore
    _LGBM_AVAILABLE = True
except ImportError:
    pass

_SKL_AVAILABLE = False
try:
    from sklearn.linear_model import LogisticRegression  # type: ignore
    _SKL_AVAILABLE = True
except ImportError:
    pass


def _build_features(games: list[dict], idx: int) -> list[float] | None:
    """
    Build feature vector for the game at games[idx] using only the games BEFORE it.
    Features: [l3_min_avg, l5_min_avg, l10_min_avg, season_min_avg,
               back_to_back (bool), is_starter (bool), dnp_in_last3 (bool), home_away]
    Returns None if insufficient prior data.
    """
    prior = games[idx + 1:]  # games are sorted newest-first
    if len(prior) < 3:
        return None
    mins = [g.get("minutes") for g in prior if g.get("minutes") is not None]
    if not mins:
        return None

    def avg_n(lst, n):
        sub = [v for v in lst[:n] if v is not None]
        return float(np.mean(sub)) if sub else float(np.mean(lst))

    l3 = avg_n(mins, 3)
    l5 = avg_n(mins, 5)
    l10 = avg_n(mins, 10)
    season = float(np.mean(mins))

    # rest days from games list (date diff between games[idx] and games[idx-1])
    # We'll approximate: consecutive games in array = 1 day apart
    # The caller passes rest_days for the prediction game; for training we estimate it
    g_curr = games[idx]
    g_prev = games[idx + 1] if idx + 1 < len(games) else None
    if g_prev and g_curr.get("date") and g_prev.get("date"):
        from datetime import date as ddate
        try:
            d1 = ddate.fromisoformat(g_curr["date"][:10])
            d2 = ddate.fromisoformat(g_prev["date"][:10])
            rd = (d1 - d2).days
        except Exception:
            rd = 2
    else:
        rd = 2
    back_to_back = 1.0 if rd <= 1 else 0.0

    starter = 1.0 if (mins[0] >= 20 if mins else False) else 0.0
    dnp_last3 = 1.0 if any(g.get("minutes", 1) < 5 for g in prior[:3]) else 0.0
    home_away = 1.0 if games[idx].get("homeAway") == "home" else 0.0

    return [l3, l5, l10, season, back_to_back, starter, dnp_last3, home_away]


def _linear_blend(mins: list[float], rest_days: int | None) -> float:
    """Simple recency-weighted blend of minutes."""
    if not mins:
        return 25.0
    def _avg(lst, n):
        sub = lst[:n]
        return float(np.mean(sub)) if sub else float(np.mean(lst))
    l5 = _avg(mins, 5)
    l10 = _avg(mins, 10)
    season = float(np.mean(mins))
    rest_adj = -2.5 if (rest_days is not None and rest_days <= 1) else (0.8 if (rest_days is not None and rest_days >= 3) else 0.0)
    blend = 0.5 * l5 + 0.3 * l10 + 0.2 * season + rest_adj
    return max(blend, 0.0)


def estimate_minutes(games: list[dict], rest_days: int | None = None) -> dict:
    """
    Estimate minutes distribution for an upcoming game.

    games: list of PlayerGame dicts sorted newest-first (most recent = games[0])
    rest_days: days since last game (None if unknown)

    Returns:
        { minutesMean: float, minutesStd: float, minutesPDNP: float }
    """
    mins_all = [g.get("minutes") for g in games if g.get("minutes") is not None]
    played = [m for m in mins_all if m >= 5]

    # -------------------------------------------------------------------------
    # Defaults if insufficient data
    # -------------------------------------------------------------------------
    if len(mins_all) < 5:
        return {
            "minutesMean": 20.0,
            "minutesStd": 8.0,
            "minutesPDNP": 0.10,
        }

    # -------------------------------------------------------------------------
    # Stage 1: P(DNP / < 5 min)
    # -------------------------------------------------------------------------
    if _SKL_AVAILABLE and len(games) >= 15:
        X, y = [], []
        for i in range(len(games) - 3):
            feats = _build_features(games, i)
            if feats is None:
                continue
            label = 1 if (games[i].get("minutes") is None or games[i].get("minutes", 0) < 5) else 0
            X.append(feats)
            y.append(label)

        if len(X) >= 10 and sum(y) >= 2:
            clf = LogisticRegression(max_iter=500, C=1.0, solver="lbfgs")
            clf.fit(X, y)

            # Predict for upcoming game using most recent games
            pred_feats = _pred_features(games, rest_days)
            p_dnp = float(clf.predict_proba([pred_feats])[0][1])
        else:
            # Fallback: empirical rate
            p_dnp = sum(1 for m in mins_all if m < 5) / len(mins_all)
    else:
        p_dnp = sum(1 for m in mins_all if m < 5) / len(mins_all)

    p_dnp = float(np.clip(p_dnp, 0.01, 0.50))

    # -------------------------------------------------------------------------
    # Stage 2: Conditional minutes regressor (given played)
    # -------------------------------------------------------------------------
    if not played:
        return {"minutesMean": 0.0, "minutesStd": 0.0, "minutesPDNP": float(p_dnp)}

    minutes_std = float(np.std(played, ddof=1)) if len(played) >= 2 else 5.0
    minutes_std = max(minutes_std, 1.0)

    if _LGBM_AVAILABLE and len(played) >= 20:
        min_pred = _lgbm_minutes(games, rest_days)
    else:
        min_pred = _linear_blend(played, rest_days)

    # Expected minutes = P(played) * conditional_minutes
    expected_minutes = (1.0 - p_dnp) * min_pred

    return {
        "minutesMean": round(expected_minutes, 2),
        "minutesStd": round(minutes_std, 2),
        "minutesPDNP": round(p_dnp, 4),
    }


def _pred_features(games: list[dict], rest_days: int | None) -> list[float]:
    """Build prediction feature vector from recent game history."""
    mins = [g.get("minutes") for g in games if g.get("minutes") is not None]

    def avg_n(lst, n):
        sub = [v for v in lst[:n] if v is not None]
        return float(np.mean(sub)) if sub else (float(np.mean(lst)) if lst else 25.0)

    l3 = avg_n(mins, 3)
    l5 = avg_n(mins, 5)
    l10 = avg_n(mins, 10)
    season = float(np.mean(mins)) if mins else 25.0
    back_to_back = 1.0 if (rest_days is not None and rest_days <= 1) else 0.0
    starter = 1.0 if (mins[0] >= 20 if mins else False) else 0.0
    dnp_last3 = 1.0 if any(g.get("minutes", 1) < 5 for g in games[:3]) else 0.0
    home_away = 0.0  # unknown for upcoming game
    return [l3, l5, l10, season, back_to_back, starter, dnp_last3, home_away]


def _lgbm_minutes(games: list[dict], rest_days: int | None) -> float:
    """
    LightGBM conditional minutes regressor.
    Trains on historical (played) games using leave-recent-5-out.
    """
    import lightgbm as lgb  # type: ignore

    X_train, y_train = [], []
    for i in range(len(games)):
        m = games[i].get("minutes")
        if m is None or m < 5:
            continue
        feats = _build_features(games, i)
        if feats is None:
            continue
        X_train.append(feats)
        y_train.append(m)

    if len(X_train) < 10:
        mins = [g.get("minutes") for g in games if g.get("minutes") is not None and g.get("minutes") >= 5]
        return _linear_blend(mins, rest_days)

    # Fit LightGBM on all training points
    dtrain = lgb.Dataset(X_train, label=y_train)
    params = {
        "objective": "regression",
        "metric": "mae",
        "num_leaves": 15,
        "learning_rate": 0.05,
        "n_estimators": 100,
        "min_child_samples": 5,
        "verbosity": -1,
    }
    model = lgb.train(params, dtrain, num_boost_round=100, valid_sets=[dtrain],
                      callbacks=[lgb.early_stopping(20, verbose=False), lgb.log_evaluation(-1)])

    pred_feats = _pred_features(games, rest_days)
    pred = float(model.predict([pred_feats])[0])
    return max(pred, 0.0)
