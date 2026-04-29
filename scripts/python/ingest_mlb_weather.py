"""
ingest_mlb_weather.py — Fetch weather for today's MLB games via Open-Meteo (free, no API key).

Uses mlb-pitchers-today.json for team list and latest-odds-api-baseball_mlb.json for game times.
Stadium lat/lon + outfield orientation from a static dict of all 30 MLB stadiums.

Output: data/processed/mlb-weather.json
  {
    "fetchedAt": "ISO",
    "games": {
      "Detroit Tigers": {
        "tempF": 52, "windMph": 12, "windDir": "out to CF",
        "precipPct": 10, "stadium": "Comerica Park",
        "windFactor": 1.0
      },
      ...
    }
  }

Run: python scripts/python/ingest_mlb_weather.py [--dry-run]
"""

import json
import math
import sys
import time
import argparse
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ── Stadium data ──────────────────────────────────────────────────────────────
# lat, lon, cf_bearing: compass bearing (degrees) from home plate toward center field.
# 0 = North, 90 = East, 180 = South, 270 = West.
# Wind blowing FROM a direction means it is traveling IN THE OPPOSITE direction.
# "Blowing out to CF" = wind direction vector aligns with home→CF bearing.

STADIUMS: dict[str, dict] = {
    # Team name (full) → stadium info
    "Arizona Diamondbacks":  {"name": "Chase Field",            "lat": 33.4455, "lon": -112.0667, "cf_bearing": 0},
    "Atlanta Braves":        {"name": "Truist Park",            "lat": 33.8908, "lon": -84.4678,  "cf_bearing": 5},
    "Baltimore Orioles":     {"name": "Oriole Park at Camden Yards", "lat": 39.2839, "lon": -76.6216, "cf_bearing": 60},
    "Boston Red Sox":        {"name": "Fenway Park",            "lat": 42.3467, "lon": -71.0972,  "cf_bearing": 95},
    "Chicago Cubs":          {"name": "Wrigley Field",          "lat": 41.9484, "lon": -87.6553,  "cf_bearing": 180},
    "Chicago White Sox":     {"name": "Guaranteed Rate Field",  "lat": 41.8300, "lon": -87.6338,  "cf_bearing": 2},
    "Cincinnati Reds":       {"name": "Great American Ball Park","lat": 39.0979, "lon": -84.5082, "cf_bearing": 355},
    "Cleveland Guardians":   {"name": "Progressive Field",      "lat": 41.4955, "lon": -81.6853,  "cf_bearing": 5},
    "Colorado Rockies":      {"name": "Coors Field",            "lat": 39.7559, "lon": -104.9942, "cf_bearing": 5},
    "Detroit Tigers":        {"name": "Comerica Park",          "lat": 42.3390, "lon": -83.0485,  "cf_bearing": 0},
    "Houston Astros":        {"name": "Minute Maid Park",       "lat": 29.7572, "lon": -95.3555,  "cf_bearing": 350},
    "Kansas City Royals":    {"name": "Kauffman Stadium",       "lat": 39.0517, "lon": -94.4803,  "cf_bearing": 5},
    "Los Angeles Angels":    {"name": "Angel Stadium",          "lat": 33.8003, "lon": -117.8827, "cf_bearing": 5},
    "Los Angeles Dodgers":   {"name": "Dodger Stadium",         "lat": 34.0739, "lon": -118.2400, "cf_bearing": 340},
    "Miami Marlins":         {"name": "loanDepot park",         "lat": 25.7781, "lon": -80.2197,  "cf_bearing": 345},
    "Milwaukee Brewers":     {"name": "American Family Field",  "lat": 43.0280, "lon": -87.9712,  "cf_bearing": 5},
    "Minnesota Twins":       {"name": "Target Field",           "lat": 44.9817, "lon": -93.2781,  "cf_bearing": 5},
    "New York Mets":         {"name": "Citi Field",             "lat": 40.7571, "lon": -73.8458,  "cf_bearing": 5},
    "New York Yankees":      {"name": "Yankee Stadium",         "lat": 40.8296, "lon": -73.9262,  "cf_bearing": 355},
    "Athletics":             {"name": "Sutter Health Park",     "lat": 38.5802, "lon": -121.5001, "cf_bearing": 10},
    "Oakland Athletics":     {"name": "Sutter Health Park",     "lat": 38.5802, "lon": -121.5001, "cf_bearing": 10},
    "Philadelphia Phillies": {"name": "Citizens Bank Park",     "lat": 39.9061, "lon": -75.1665,  "cf_bearing": 5},
    "Pittsburgh Pirates":    {"name": "PNC Park",               "lat": 40.4469, "lon": -80.0058,  "cf_bearing": 325},
    "San Diego Padres":      {"name": "Petco Park",             "lat": 32.7073, "lon": -117.1566, "cf_bearing": 315},
    "San Francisco Giants":  {"name": "Oracle Park",            "lat": 37.7786, "lon": -122.3893, "cf_bearing": 60},
    "Seattle Mariners":      {"name": "T-Mobile Park",          "lat": 47.5914, "lon": -122.3325, "cf_bearing": 5},
    "St. Louis Cardinals":   {"name": "Busch Stadium",          "lat": 38.6226, "lon": -90.1928,  "cf_bearing": 10},
    "Tampa Bay Rays":        {"name": "Tropicana Field",        "lat": 27.7682, "lon": -82.6534,  "cf_bearing": 0},
    "Texas Rangers":         {"name": "Globe Life Field",       "lat": 32.7513, "lon": -97.0820,  "cf_bearing": 5},
    "Toronto Blue Jays":     {"name": "Rogers Centre",          "lat": 43.6414, "lon": -79.3894,  "cf_bearing": 15},
    "Washington Nationals":  {"name": "Nationals Park",         "lat": 38.8730, "lon": -77.0074,  "cf_bearing": 355},
}

# Open-Meteo: WMO wind direction → cardinal + relative to CF
# Wind direction from Open-Meteo is "where the wind is coming FROM" (meteorological convention).
# To get where the wind is blowing TO, add 180 degrees.

WIND_SPEED_THRESHOLD = 15  # mph threshold for wind factor to kick in

# ── Helpers ───────────────────────────────────────────────────────────────────

def ms_to_mph(ms: float) -> float:
    """Convert m/s to mph."""
    return round(ms * 2.23694, 1)


def bearing_diff(a: float, b: float) -> float:
    """Smallest signed angular difference between two bearings (degrees), range [-180, 180]."""
    diff = (a - b + 360) % 360
    if diff > 180:
        diff -= 360
    return diff


def wind_direction_label(wind_from_deg: float, cf_bearing: float) -> str:
    """
    Given meteorological wind direction (from) and CF bearing from home plate,
    return a human-readable label: 'out to CF', 'in from CF', 'left to right', etc.
    """
    # Wind is blowing TO: wind_from_deg + 180
    wind_to = (wind_from_deg + 180) % 360

    # Angle between wind vector and home→CF vector
    diff = bearing_diff(wind_to, cf_bearing)

    if abs(diff) <= 45:
        return "out to CF"
    elif abs(diff) >= 135:
        return "in from CF"
    elif 45 < diff < 135:
        # Wind blowing from RF toward LF (left to right facing CF)
        return "left to right"
    else:
        return "right to left"


def wind_factor(wind_mph: float, wind_dir_label: str) -> float:
    """
    Compute a run-scoring multiplier based on wind speed and direction.
    Blowing out > 15mph → 1.08 (more HRs/runs)
    Blowing in > 15mph  → 0.92 (fewer HRs/runs)
    Otherwise → 1.0
    """
    if wind_mph > WIND_SPEED_THRESHOLD:
        if wind_dir_label == "out to CF":
            return 1.08
        elif wind_dir_label == "in from CF":
            return 0.92
    return 1.0


def celsius_to_fahrenheit(c: float) -> float:
    return round(c * 9 / 5 + 32, 1)


def fetch_weather(lat: float, lon: float, target_hour: int) -> dict | None:
    """
    Fetch hourly weather from Open-Meteo for a given lat/lon.
    Returns dict with tempF, windMph, windFromDeg, precipPct for the target hour.
    target_hour: UTC hour (0-23)
    """
    params = urllib.parse.urlencode({
        "latitude": lat,
        "longitude": lon,
        "hourly": "temperature_2m,windspeed_10m,winddirection_10m,precipitation_probability",
        "temperature_unit": "celsius",
        "windspeed_unit": "ms",  # m/s — we convert to mph
        "forecast_days": 1,
        "timezone": "UTC",
    })
    url = f"https://api.open-meteo.com/v1/forecast?{params}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "mlb-weather-ingest/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"  ERROR fetching weather for lat={lat} lon={lon}: {e}", file=sys.stderr)
        return None

    hourly = data.get("hourly", {})
    times  = hourly.get("time", [])
    temps  = hourly.get("temperature_2m", [])
    winds  = hourly.get("windspeed_10m", [])
    wdirs  = hourly.get("winddirection_10m", [])
    precip = hourly.get("precipitation_probability", [])

    # Find index for target_hour (UTC)
    idx = None
    for i, t in enumerate(times):
        # t is like "2026-04-04T17:00"
        try:
            hour = int(t.split("T")[1].split(":")[0])
            if hour == target_hour:
                idx = i
                break
        except (IndexError, ValueError):
            continue

    if idx is None or idx >= len(temps):
        # Fall back to nearest available hour
        idx = min(target_hour, len(temps) - 1) if temps else 0

    try:
        return {
            "tempC":      temps[idx] if idx < len(temps) else None,
            "windMs":     winds[idx] if idx < len(winds) else None,
            "windFromDeg": wdirs[idx] if idx < len(wdirs) else None,
            "precipPct":  precip[idx] if idx < len(precip) else None,
        }
    except (IndexError, TypeError):
        return None


def normalize_team(name: str) -> str:
    """Normalize a team name for matching."""
    return name.lower().strip()


def match_stadium(team_name: str) -> tuple[str, dict] | None:
    """Match a team name to a stadium entry. Returns (canonical_name, stadium_dict) or None."""
    # Exact match
    if team_name in STADIUMS:
        return team_name, STADIUMS[team_name]

    norm = normalize_team(team_name)
    for key, val in STADIUMS.items():
        if normalize_team(key) == norm:
            return key, val

    # Last-word (nickname) match
    last = norm.split()[-1] if norm.split() else ""
    for key, val in STADIUMS.items():
        if normalize_team(key).split()[-1] == last:
            return key, val

    return None


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Fetch weather for today's MLB games via Open-Meteo")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    processed_dir = repo_root / "data" / "processed"
    processed_dir.mkdir(parents=True, exist_ok=True)

    pitchers_path = processed_dir / "mlb-pitchers-today.json"
    odds_path     = processed_dir / "latest-odds-api-baseball_mlb.json"
    out_path      = processed_dir / "mlb-weather.json"

    # Load pitchers file for home team list
    if not pitchers_path.exists():
        print(f"[ingest_mlb_weather] ERROR: {pitchers_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(pitchers_path, encoding="utf-8") as f:
        pitcher_data = json.load(f)

    home_teams = [g["homeTeam"] for g in pitcher_data.get("games", [])]

    # Load odds file for game times
    game_times: dict[str, int] = {}  # home_team → UTC hour of game start
    if odds_path.exists():
        with open(odds_path, encoding="utf-8") as f:
            odds_data = json.load(f)
        for ev in (odds_data.get("events") or []):
            ht = ev.get("home_team", "")
            ct = ev.get("commence_time", "")
            if ht and ct:
                try:
                    dt = datetime.fromisoformat(ct.replace("Z", "+00:00"))
                    game_times[ht] = dt.hour
                except Exception:
                    pass

    if args.dry_run:
        print("[ingest_mlb_weather] DRY RUN — skipping API calls")
        result: dict[str, dict] = {}
        for team in home_teams:
            match = match_stadium(team)
            if match:
                canon, std = match
                result[team] = {
                    "tempF": None, "windMph": None, "windDir": None,
                    "precipPct": None, "stadium": std["name"], "windFactor": 1.0
                }
        output = {
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
            "games": result,
        }
        out_path.write_text(json.dumps(output, indent=2), encoding="utf-8")
        print(f"Wrote {len(result)} games (dry run) -> {out_path}")
        return

    result = {}

    for team in home_teams:
        match = match_stadium(team)
        if not match:
            print(f"  WARNING: no stadium found for '{team}'", file=sys.stderr)
            continue

        canon, std = match
        stadium_name = std["name"]
        lat = std["lat"]
        lon = std["lon"]
        cf_bearing = std["cf_bearing"]

        # Determine UTC game hour (default 19 = 7pm local; approx 23:00 UTC for EDT)
        utc_hour = game_times.get(team) or game_times.get(canon) or 23

        print(f"  Fetching weather for {team} ({stadium_name}) @ UTC hour {utc_hour}", flush=True)
        wx = fetch_weather(lat, lon, utc_hour)

        if wx is None:
            print(f"  WARNING: weather fetch failed for {team}", file=sys.stderr)
            result[team] = {
                "tempF": None, "windMph": None, "windDir": None,
                "precipPct": None, "stadium": stadium_name, "windFactor": 1.0
            }
            continue

        temp_f = celsius_to_fahrenheit(wx["tempC"]) if wx["tempC"] is not None else None
        wind_mph = ms_to_mph(wx["windMs"]) if wx["windMs"] is not None else None
        wind_from = wx["windFromDeg"]
        precip = wx["precipPct"]

        if wind_mph is not None and wind_from is not None:
            wdir_label = wind_direction_label(wind_from, cf_bearing)
            wfactor = wind_factor(wind_mph, wdir_label)
        else:
            wdir_label = None
            wfactor = 1.0

        result[team] = {
            "tempF":      temp_f,
            "windMph":    wind_mph,
            "windDir":    wdir_label,
            "precipPct":  precip,
            "stadium":    stadium_name,
            "windFactor": wfactor,
        }

        # Polite delay between API calls
        time.sleep(0.5)

    output = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "games": result,
    }
    out_path.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"\nWrote weather for {len(result)} games -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
