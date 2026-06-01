"""
ingest_statcast_pitching.py — Pull forward-looking pitching metrics from Baseball
Savant (Statcast) via pybaseball (free). Replaces lagging season ERA/WHIP as the
primary starting-pitcher signal.

Why: season ERA is the noisiest, most backward-looking pitcher stat. The betting
market prices starters off contact-quality / expected metrics, so feeding the model
raw ERA means it reads a staler version of reality than the line does — that
generates phantom edges and the negative CLV we measured on MLB picks.

Why Savant and not FanGraphs (SIERA/xFIP): FanGraphs now hard-blocks scrapers (403
on both the legacy leaderboard and the JSON API), and pybaseball's FanGraphs module
is effectively dead. Baseball Savant (baseballsavant.mlb.com — MLB's own site) is
reliable and free, and its expected stats are arguably better for prediction:
  - xERA      : Statcast's ERA estimator from quality of contact + K/BB. Forward-
                looking; the direct, superior replacement for raw ERA.
  - xwOBA-against (est_woba): expected wOBA allowed — contact quality the pitcher
                gives up, stripped of defense/luck.

Data source: pybaseball.statcast_pitcher_expected_stats() — no API key, no paid tier.

Output: data/processed/statcast-pitching.json
  {
    "fetchedAt": "ISO",
    "season": 2026,
    "pitcherCount": 654,
    "pitchers": {
      "Sandy Alcantara": { "xera": 3.79, "xwobaAgainst": 0.309,
                           "wobaAgainst": 0.331, "estSlgAgainst": 0.401,
                           "pa": 210, "playerId": 645261 },
      ...
    }
  }

Keyed by "First Last" pitcher name to mirror pitcher-stats-season.json so
mlb-model.ts can reuse its existing name lookup (exact → normalized → last-name).

Run: python scripts/python/ingest_statcast_pitching.py [--season 2026] [--dry-run]
"""

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

OUT_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "statcast-pitching.json"

# Savant column -> our output key. Parsed by label (robust to column reordering).
COLUMN_MAP = {
    "xera": "xera",
    "est_woba": "xwobaAgainst",
    "woba": "wobaAgainst",
    "est_slg": "estSlgAgainst",
    "est_ba": "estBaAgainst",
    "pa": "pa",
    "player_id": "playerId",
}


def clean(val):
    """Convert pandas/NaN/inf to JSON-safe values (None for missing)."""
    if val is None:
        return None
    if isinstance(val, str):
        v = val.strip()
        return v if v else None
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def reformat_name(savant_name) -> str | None:
    """Savant gives 'Last, First' (sometimes with accents). Return 'First Last'."""
    if not isinstance(savant_name, str):
        return None
    s = savant_name.strip()
    if not s:
        return None
    if "," in s:
        last, first = (p.strip() for p in s.split(",", 1))
        return f"{first} {last}".strip()
    return s


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, default=datetime.now(timezone.utc).year,
                        help="MLB season year (default: current year)")
    parser.add_argument("--min-pa", type=int, default=10,
                        help="Minimum batters faced to include a pitcher (default: 10)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch and print summary without writing the file")
    args = parser.parse_args()

    try:
        from pybaseball import statcast_pitcher_expected_stats
        from pybaseball import cache
        cache.enable()  # disk-cache Savant pulls (cheap repeat runs in CI)
    except ImportError:
        print("[statcast] pybaseball not installed — run: pip install -r scripts/python/requirements.txt",
              file=sys.stderr)
        return 1

    try:
        df = statcast_pitcher_expected_stats(args.season, minPA=args.min_pa)
    except Exception as e:  # noqa: BLE001 — network/parse failures shouldn't crash the pipeline
        print(f"[statcast] statcast_pitcher_expected_stats({args.season}) failed: {e}", file=sys.stderr)
        return 1

    if df is None or len(df) == 0:
        print(f"[statcast] No rows returned for season {args.season}", file=sys.stderr)
        return 1

    name_col = "last_name, first_name"
    if name_col not in df.columns:
        print(f"[statcast] FATAL: expected name column '{name_col}' not in {list(df.columns)}", file=sys.stderr)
        return 1

    have = [c for c in COLUMN_MAP if c in df.columns]
    missing = [c for c in COLUMN_MAP if c not in df.columns]
    if missing:
        print(f"[statcast] WARNING: columns absent from Savant response: {missing}", file=sys.stderr)

    pitchers: dict[str, dict] = {}
    for _, r in df.iterrows():
        name = reformat_name(r.get(name_col))
        if not name:
            continue
        entry = {}
        for col in have:
            entry[COLUMN_MAP[col]] = clean(r.get(col))
        if entry.get("playerId") is not None:
            entry["playerId"] = int(entry["playerId"])
        if entry.get("pa") is not None:
            entry["pa"] = int(entry["pa"])
        pitchers[name] = entry

    payload = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "season": args.season,
        "pitcherCount": len(pitchers),
        "pitchers": pitchers,
    }

    # Sanity: best xERA arms (lowest = best), so a human can eyeball the pull.
    ranked = sorted(
        ((n, p) for n, p in pitchers.items() if p.get("xera") is not None),
        key=lambda kv: kv[1]["xera"],
    )[:10]
    print(f"[statcast] season {args.season}: {len(pitchers)} pitchers parsed "
          f"(fields: {[COLUMN_MAP[c] for c in have]})")
    print("[statcast] best xERA (lower = better):")
    for n, p in ranked:
        print(f"  {n:<26} xERA {p['xera']:.2f}  xwOBA-against {p.get('xwobaAgainst')}  PA {p.get('pa')}")

    if args.dry_run:
        print("[statcast] --dry-run: not writing file")
        return 0

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[statcast] wrote {OUT_PATH.relative_to(Path(__file__).resolve().parents[2])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
