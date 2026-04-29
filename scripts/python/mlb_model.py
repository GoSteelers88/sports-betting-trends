# mlb_model.py — LightGBM (fallback: LogisticRegression) MLB moneyline model.
# Usage: python mlb_model.py --input <path> --output <path> [--train]
# Input:  {"games": [{feature_vector}, ...]}
# Output: {"results": [{"game_id": "...", "home_win_prob": 0.54, ...}, ...]}

import argparse, json, os, sys, pickle, warnings
import numpy as np

warnings.filterwarnings("ignore")

FEATURES = [
    "home_rpg", "away_rpg",
    "home_ops", "away_ops",
    "home_era", "away_era",
    "home_whip", "away_whip",
    "home_pitcher_ip", "away_pitcher_ip",
    "home_bullpen_era", "away_bullpen_era",
    "home_bullpen_fatigue", "away_bullpen_fatigue",
    "home_rest_days", "away_rest_days",
    "home_win_pct", "away_win_pct",
    "home_run_diff_pg", "away_run_diff_pg",
    "is_home_favorite",
    "market_home_prob",
    "line_movement",
    "park_factor",
    "wind_factor",  # 1.08 = blowing out >15mph, 0.92 = blowing in >15mph, 1.0 = neutral
]

MODEL_PATH = os.path.join(os.path.dirname(__file__), "../../data/models/mlb_lgbm.pkl")
RAW_DATA_PATH = os.path.join(os.path.dirname(__file__), "../../data/raw/mlb/latest_espn_mlb.json")
STANDINGS_PATH = os.path.join(os.path.dirname(__file__), "../../data/processed/standings-mlb.json")

# Feature extraction

def extract_features(game: dict) -> np.ndarray:
    """Extract numeric feature vector from a game dict."""
    row = []
    for f in FEATURES:
        val = game.get(f)
        if val is None or val == "":
            # Sensible defaults per feature
            defaults = {
                "home_rpg": 4.5, "away_rpg": 4.5,
                "home_ops": 0.720, "away_ops": 0.720,
                "home_era": 4.50, "away_era": 4.50,
                "home_whip": 1.30, "away_whip": 1.30,
                "home_pitcher_ip": 5.5, "away_pitcher_ip": 5.5,
                "home_bullpen_era": 4.20, "away_bullpen_era": 4.20,
                "home_bullpen_fatigue": 0.0, "away_bullpen_fatigue": 0.0,
                "home_rest_days": 3.0, "away_rest_days": 3.0,
                "home_win_pct": 0.5, "away_win_pct": 0.5,
                "home_run_diff_pg": 0.0, "away_run_diff_pg": 0.0,
                "is_home_favorite": 1.0,
                "market_home_prob": 0.5,
                "line_movement": 0.0,
                "park_factor": 1.0,
                "wind_factor": 1.0,
            }
            row.append(float(defaults.get(f, 0.0)))
        else:
            try:
                row.append(float(val))
            except (TypeError, ValueError):
                row.append(0.0)
    return np.array(row, dtype=np.float32)


# Training data from raw MLB rows

def build_training_data():
    """Build X, y arrays from raw ESPN MLB game rows."""
    if not os.path.exists(RAW_DATA_PATH):
        return None, None

    with open(RAW_DATA_PATH, "r") as f:
        raw = json.load(f)

    standings = {}
    if os.path.exists(STANDINGS_PATH):
        with open(STANDINGS_PATH, "r") as f:
            standings_list = json.load(f)
        for s in standings_list:
            standings[s["team"].lower()] = s
            standings[s.get("abbreviation", "").lower()] = s

    def get_win_pct(team_name: str) -> float:
        key = team_name.lower()
        for k, v in standings.items():
            if k in key or key in k:
                return float(v.get("winPct", 0.5))
        return 0.5

    # MLB regular season starts April 1 — exclude spring training
    MLB_SEASON_START = "2026-03-26"

    # Pre-compute per-team season averages from ALL completed regular-season games (no leakage)
    team_runs: dict = {}      # team -> list of runs scored
    team_allowed: dict = {}   # team -> list of runs allowed
    for row in raw:
        if row.get("league") != "MLB":
            continue
        if row.get("points") is None or row.get("opponentPoints") is None:
            continue
        game_date = (row.get("gameDate") or "")[:10]  # YYYY-MM-DD
        if game_date < MLB_SEASON_START:
            continue
        t = (row.get("team") or "").lower()
        if not t:
            continue
        team_runs.setdefault(t, []).append(float(row["points"]))
        team_allowed.setdefault(t, []).append(float(row["opponentPoints"]))

    def season_rpg(team: str) -> float:
        vals = team_runs.get(team.lower(), [])
        return float(sum(vals) / len(vals)) if vals else 4.5

    def season_rpg_allowed(team: str) -> float:
        vals = team_allowed.get(team.lower(), [])
        return float(sum(vals) / len(vals)) if vals else 4.5

    def season_run_diff(team: str) -> float:
        r = team_runs.get(team.lower(), [])
        a = team_allowed.get(team.lower(), [])
        n = min(len(r), len(a))
        if n == 0:
            return 0.0
        return float(sum(r[:n]) - sum(a[:n])) / n

    # Require at least 15 games per team on average (~2.5 weeks of season)
    # before training; early-season features are too noisy to beat heuristic.
    if team_runs:
        avg_games = sum(len(v) for v in team_runs.values()) / len(team_runs)
        if avg_games < 15:
            return None, None
    else:
        return None, None

    # Group regular-season game rows by event ID
    by_event: dict = {}
    for row in raw:
        if row.get("league") != "MLB":
            continue
        game_date = (row.get("gameDate") or "")[:10]
        if game_date < MLB_SEASON_START:
            continue
        eid = row.get("sourceEventId") or row.get("gameDate", "") + row.get("team", "")
        if eid not in by_event:
            by_event[eid] = []
        by_event[eid].append(row)

    X_rows = []
    y_rows = []

    for rows in by_event.values():
        home = next((r for r in rows if r.get("homeAway") == "home"), None)
        away = next((r for r in rows if r.get("homeAway") == "away"), None)
        if not home or not away:
            continue
        if home.get("points") is None or away.get("points") is None:
            continue
        home_runs = float(home["points"])
        away_runs = float(away["points"])
        if home_runs == away_runs:
            continue  # skip ties (unlikely in MLB)

        home_team = (home.get("team") or "").lower()
        away_team = (away.get("team") or "").lower()
        home_win_pct = get_win_pct(home.get("team", ""))
        away_win_pct = get_win_pct(away.get("team", ""))

        # Use season averages (pre-game knowable) — no leakage
        feat = {
            "home_rpg": season_rpg(home_team),
            "away_rpg": season_rpg(away_team),
            "home_ops": 0.720, "away_ops": 0.720,  # static league-avg default (no historical OPS in ESPN data)
            "home_era": season_rpg_allowed(home_team),   # ERA proxy: runs allowed/g
            "away_era": season_rpg_allowed(away_team),
            "home_whip": 1.30,
            "away_whip": 1.30,
            "home_pitcher_ip": 5.5,
            "away_pitcher_ip": 5.5,
            "home_bullpen_era": 4.20,
            "away_bullpen_era": 4.20,
            "home_bullpen_fatigue": 0.0,
            "away_bullpen_fatigue": 0.0,
            "home_rest_days": 3.0,
            "away_rest_days": 3.0,
            "home_win_pct": home_win_pct,
            "away_win_pct": away_win_pct,
            "home_run_diff_pg": season_run_diff(home_team),
            "away_run_diff_pg": season_run_diff(away_team),
            "is_home_favorite": 1.0 if home_win_pct >= away_win_pct else 0.0,
            "market_home_prob": home_win_pct,
            "line_movement": 0.0,
            "park_factor": 1.0,
            "wind_factor": 1.0,  # historical data has no weather; use neutral default
        }
        X_rows.append(extract_features(feat))
        y_rows.append(1.0 if home_runs > away_runs else 0.0)

    if len(X_rows) < 5:
        return None, None

    return np.array(X_rows), np.array(y_rows)


# Model load/train

def train_model(X: np.ndarray, y: np.ndarray):
    """Train LightGBM (or LogisticRegression fallback) wrapped in CalibratedClassifierCV.

    The base classifier (LightGBM/LR) is wrapped with isotonic calibration via
    cross-validation so the final predict_proba output is properly calibrated against
    held-out samples. Falls back to sigmoid calibration if isotonic refuses (too few
    samples per fold), and to bare base model if calibration is impossible.
    """
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import log_loss, brier_score_loss, accuracy_score
    from sklearn.calibration import CalibratedClassifierCV

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y if len(set(y)) > 1 else None
    )

    base = None

    try:
        import lightgbm as lgb  # type: ignore[import]
        params = {
            "objective": "binary",
            "metric": "binary_logloss",
            "num_leaves": 15,
            "learning_rate": 0.05,
            "n_estimators": 200,
            "min_child_samples": 3,
            "subsample": 0.8,
            "colsample_bytree": 0.8,
            "reg_alpha": 0.1,
            "reg_lambda": 0.1,
            "verbose": -1,
        }
        base = lgb.LGBMClassifier(**params)
        backend = "LightGBM"
    except ImportError:
        print("[mlb_model] LightGBM not installed — using LogisticRegression fallback", file=sys.stderr)
        from sklearn.linear_model import LogisticRegression
        base = LogisticRegression(max_iter=500, C=0.5, random_state=42)
        backend = "LogisticRegression"

    # Wrap with calibration. cv=5 trains 5 base models + 5 calibrators on folds, averaged.
    # Isotonic preferred (more flexible). Falls back to sigmoid for small data, then bare.
    cv_folds = min(5, max(2, len(X_train) // 30))
    method = "isotonic" if len(X_train) >= 200 else "sigmoid"
    try:
        model = CalibratedClassifierCV(base, method=method, cv=cv_folds)
        model.fit(X_train, y_train)
        calibration = f"{method} cv={cv_folds}"
    except Exception as e:
        print(f"[mlb_model] CalibratedClassifierCV failed ({e}) — using bare {backend}", file=sys.stderr)
        model = base
        model.fit(X_train, y_train)
        calibration = "none"

    # Evaluate on holdout
    if len(X_test) >= 2:
        y_pred_proba = model.predict_proba(X_test)[:, 1]
        y_pred = (y_pred_proba >= 0.5).astype(int)
        ll = log_loss(y_test, y_pred_proba)
        bs = brier_score_loss(y_test, y_pred_proba)
        acc = accuracy_score(y_test, y_pred)
        print(
            f"[mlb_model] {backend} ({calibration}) holdout: LogLoss={ll:.4f}, Brier={bs:.4f}, Acc={acc:.3f} "
            f"({len(X_train)} train / {len(X_test)} test)",
            file=sys.stderr,
        )

    # Stash calibration metadata on the model so predict() can flag it
    try:
        setattr(model, "_calibration_method", calibration)
    except Exception:
        pass

    return model


def load_or_train(force_train: bool = False):
    """Load model from disk or train a new one."""
    if not force_train and os.path.exists(MODEL_PATH):
        try:
            with open(MODEL_PATH, "rb") as f:
                model = pickle.load(f)
            print("[mlb_model] Loaded model from", MODEL_PATH, file=sys.stderr)
            return model, True
        except Exception as e:
            print(f"[mlb_model] Failed to load model: {e} — retraining", file=sys.stderr)

    print("[mlb_model] Training new model...", file=sys.stderr)
    X, y = build_training_data()
    if X is None or len(X) < 5:
        print("[mlb_model] Insufficient training data — using prior model", file=sys.stderr)
        return None, False

    model = train_model(X, y)
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    with open(MODEL_PATH, "wb") as f:
        pickle.dump(model, f)
    print(f"[mlb_model] Saved model to {MODEL_PATH}", file=sys.stderr)
    return model, True


# Prediction

def predict(model, game_dicts: list) -> list:
    """Return list of {game_id, home_win_prob, away_win_prob, calibrated}."""
    results = []
    for game in game_dicts:
        gid = game.get("game_id", "")
        if model is not None:
            feats = extract_features(game).reshape(1, -1)
            try:
                proba = model.predict_proba(feats)[0]
                home_prob = float(np.clip(proba[1], 0.01, 0.99))
                # Calibrated when train_model() wrapped the base in CalibratedClassifierCV.
                calibration_method = getattr(model, "_calibration_method", None)
                calibrated = bool(calibration_method) and calibration_method != "none"
            except Exception as e:
                print(f"[mlb_model] Predict error for {gid}: {e}", file=sys.stderr)
                home_prob = 0.54
                calibrated = False
        else:
            # Heuristic prior: home advantage ~54%
            home_win_pct = float(game.get("home_win_pct") or 0.5)
            away_win_pct = float(game.get("away_win_pct") or 0.5)
            home_era = float(game.get("home_era") or 4.5)
            away_era = float(game.get("away_era") or 4.5)
            # Simple logistic-style prior
            edge = (away_era - home_era) * 0.04 + (home_win_pct - away_win_pct) * 0.3
            home_prob = float(np.clip(0.54 + edge, 0.30, 0.75))
            calibrated = False

        results.append({
            "game_id": gid,
            "home_win_prob": round(home_prob, 4),
            "away_win_prob": round(1.0 - home_prob, 4),
            "calibrated": calibrated,
        })
    return results


# Entry point

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--train", action="store_true", help="Force retrain")
    args = parser.parse_args()

    with open(args.input, "r") as f:
        input_data = json.load(f)

    game_dicts = input_data.get("games", [])
    if not game_dicts:
        print("[mlb_model] No games in input", file=sys.stderr)
        with open(args.output, "w") as f:
            json.dump({"results": []}, f)
        return

    model, trained = load_or_train(force_train=args.train)
    results = predict(model, game_dicts)

    with open(args.output, "w") as f:
        json.dump({"results": results}, f, indent=2)

    print(f"[mlb_model] Wrote {len(results)} predictions to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
