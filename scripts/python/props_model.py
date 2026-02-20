"""
NBA Player Props — Main Python Model Entry Point

Reads JSON from stdin, writes JSON to stdout.

stdin schema:
{
  "players": [
    {
      "player": str,
      "market": str,
      "consensusLine": float,
      "overPrices": list[float],   # American odds
      "underPrices": list[float],
      "isHome": bool | null,
      "opponent": str | null,
      "restDays": int | null,
      "heuristicProjection": float,   # fallback from TS heuristic
      "games": [
        {
          "date": str,
          "team": str,
          "opponent": str,
          "homeAway": "home" | "away" | "unknown",
          "minutes": float | null,
          "points": float | null,
          "rebounds": float | null,
          "assists": float | null,
          "threes": float | null,
          "blocks": float | null,
          "steals": float | null,
          "turnovers": float | null,
          "fga": float | null,
          "fta": float | null
        }
      ]
    }
  ]
}

stdout schema:
{
  "results": [
    {
      "player": str,
      "market": str,
      "modelMean": float,
      "modelStd": float,
      "modelPOver": float,
      "modelPUnder": float,
      "expectedValueOver": float,
      "expectedValueUnder": float,
      "distributionFamily": str,
      "minutesMean": float | null,
      "minutesStd": float | null,
      "minutesPDNP": float | null
    }
  ],
  "errors": [str]
}
"""

from __future__ import annotations
import sys
import json
import traceback
import statistics
from minutes_model import estimate_minutes
from stat_models import model_stat
from calibration import calibrate_prob, compute_ev


def _avg(lst: list[float]) -> float | None:
    if not lst:
        return None
    return statistics.mean(lst)


def process_player(item: dict) -> dict:
    player = item.get("player", "unknown")
    market = item.get("market", "unknown")
    line = float(item.get("consensusLine", 0.0))
    over_prices = [float(x) for x in item.get("overPrices", []) if x is not None]
    under_prices = [float(x) for x in item.get("underPrices", []) if x is not None]
    rest_days = item.get("restDays")
    if rest_days is not None:
        rest_days = int(rest_days)
    games = item.get("games", [])

    # Normalize: replace None with None (games from TS may have null values)
    for g in games:
        for k in ("minutes", "points", "rebounds", "assists", "threes", "blocks", "steals", "turnovers", "fga", "fta"):
            v = g.get(k)
            if v is not None:
                g[k] = float(v)

    # Stage 1: Minutes model
    minutes_dist = estimate_minutes(games, rest_days)

    # Stage 2: Stat model
    stat_result = model_stat(games, market, line, minutes_dist)

    raw_p_over = stat_result.get("modelPOver", 0.5)

    # Stage 3: Calibration (identity until backtesting fits params)
    model_p_over = calibrate_prob(raw_p_over)
    model_p_under = 1.0 - model_p_over

    # Stage 4: EV calculation
    avg_over_price = _avg(over_prices)
    avg_under_price = _avg(under_prices)
    ev_over, ev_under = compute_ev(model_p_over, avg_over_price, avg_under_price)

    return {
        "player": player,
        "market": market,
        "modelMean": stat_result.get("modelMean", 0.0),
        "modelStd": stat_result.get("modelStd", 0.0),
        "modelPOver": round(model_p_over, 4),
        "modelPUnder": round(model_p_under, 4),
        "expectedValueOver": ev_over,
        "expectedValueUnder": ev_under,
        "distributionFamily": stat_result.get("distributionFamily", "fallback"),
        "minutesMean": minutes_dist.get("minutesMean"),
        "minutesStd": minutes_dist.get("minutesStd"),
        "minutesPDNP": minutes_dist.get("minutesPDNP"),
    }


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=None, help="Path to input JSON file")
    parser.add_argument("--output", default=None, help="Path to output JSON file")
    args = parser.parse_args()

    if args.input:
        with open(args.input, "r", encoding="utf-8") as f:
            payload = json.load(f)
    else:
        payload = json.loads(sys.stdin.read())

    players = payload.get("players", [])

    results = []
    errors = []

    for item in players:
        try:
            result = process_player(item)
            results.append(result)
        except Exception:
            player = item.get("player", "?")
            market = item.get("market", "?")
            tb = traceback.format_exc()
            errors.append(f"{player}/{market}: {tb}")
            results.append({
                "player": player,
                "market": market,
                "modelMean": 0.0,
                "modelStd": 0.0,
                "modelPOver": 0.5,
                "modelPUnder": 0.5,
                "expectedValueOver": 0.0,
                "expectedValueUnder": 0.0,
                "distributionFamily": "fallback",
                "minutesMean": None,
                "minutesStd": None,
                "minutesPDNP": None,
            })

    out = json.dumps({"results": results, "errors": errors})
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(out)
    else:
        print(out)


if __name__ == "__main__":
    main()
