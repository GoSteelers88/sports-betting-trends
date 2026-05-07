"""
scrape_nba_props.py — Scrape NBA player props from RotoWire.

Source: https://www.rotowire.com/betting/nba/player-props.php

The page renders prop tables via JavaScript — one table per stat category
(Points, Rebounds, Assists, Threes, Blocks, Steals, Pts+Reb+Ast, Pts+Reb,
Pts+Ast). Each row has a player, line, sportsbook over/under odds, and
RotoWire's own projection.

We compute confidence as scaled |projection - line| / line, and pickSide as
whichever side the projection lands on.

Output: data/processed/latest-player-props.json (same shape as the existing
file produced by ingest-props.ts, so the homepage `PlayerProps` component
just works.)

Run: python scripts/python/scrape_nba_props.py [--dry-run]
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from scrapling.fetchers import StealthyFetcher

URL = "https://www.rotowire.com/betting/nba/player-props.php"

# Map RotoWire heading text → our market key, label, category
MARKETS = {
    "points":           ("player_points",                 "Points",        "core"),
    "rebounds":         ("player_rebounds",               "Rebounds",      "core"),
    "assists":          ("player_assists",                "Assists",       "core"),
    "threes":           ("player_threes",                 "Threes",        "core"),
    "three pointers":   ("player_threes",                 "Threes",        "core"),
    "blocks":           ("player_blocks",                 "Blocks",        "defense"),
    "steals":           ("player_steals",                 "Steals",        "defense"),
    "turnovers":        ("player_turnovers",              "Turnovers",     "defense"),
    "pts+reb+ast":      ("player_points_rebounds_assists","Pts+Reb+Ast",   "combo"),
    "points + rebounds + assists": ("player_points_rebounds_assists","Pts+Reb+Ast","combo"),
    "pts+reb":          ("player_points_rebounds",        "Pts+Reb",       "combo"),
    "points + rebounds":("player_points_rebounds",        "Pts+Reb",       "combo"),
    "pts+ast":          ("player_points_assists",         "Pts+Ast",       "combo"),
    "points + assists": ("player_points_assists",         "Pts+Ast",       "combo"),
    "reb+ast":          ("player_rebounds_assists",       "Reb+Ast",       "combo"),
    "rebounds + assists":("player_rebounds_assists",      "Reb+Ast",       "combo"),
}


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def parse_american(s: str) -> int | None:
    s = clean(s).replace("−", "-")  # unicode minus
    m = re.match(r"^[+-]?\d+$", s)
    if not m:
        return None
    return int(s)


def parse_float(s: str) -> float | None:
    s = clean(s).replace("−", "-")
    try:
        return float(s)
    except ValueError:
        return None


def detect_market_key(heading: str) -> tuple[str, str, str] | None:
    h = heading.lower()
    for key, val in MARKETS.items():
        if key in h:
            return val
    return None


def confidence_from_edge(projection: float | None, line: float | None) -> int:
    if projection is None or line is None or line <= 0:
        return 50
    edge = abs(projection - line) / max(line, 1.0)  # fractional edge
    # Map 0-25% edge to 50-95 confidence
    score = 50 + min(45, edge * 180)
    return int(round(score))


def pick_side(projection: float | None, line: float | None) -> str:
    if projection is None or line is None:
        return "over"
    return "over" if projection > line else "under"


def scrape() -> dict:
    print(f"Fetching {URL} ...", flush=True)
    page = StealthyFetcher.fetch(URL, headless=True, network_idle=True)
    if page.status != 200:
        print(f"  ERROR: HTTP {page.status}", file=sys.stderr)
        return {"available": False, "topProps": [], "props": []}

    props: list[dict] = []

    # RotoWire wraps each market in a <section> or <div> with a heading.
    # We look for any block that contains a player-row table.
    sections = page.css("[class*='prop'], [data-section], section, div.market-block")
    seen_section_keys = set()

    # Scan all tables — for each, find the nearest preceding heading text
    # to determine the market.
    tables = page.css("table")
    for tbl in tables:
        # Find the closest heading text before this table
        heading_text = ""
        prev = tbl.find_previous("h1, h2, h3, h4, h5, .section-title, .heading, [class*='title']")
        if prev:
            heading_text = clean(prev.text)
        else:
            # Fall back: search up the DOM for a heading-y class
            ancestor = tbl.parent
            for _ in range(5):
                if ancestor is None:
                    break
                title = ancestor.css_first("h1, h2, h3, h4, h5, .heading")
                if title:
                    heading_text = clean(title.text)
                    break
                ancestor = ancestor.parent

        market_meta = detect_market_key(heading_text)
        if not market_meta:
            continue
        market, label, category = market_meta

        if market in seen_section_keys:
            continue
        seen_section_keys.add(market)

        # Extract rows
        rows = tbl.css("tr")
        for row in rows[1:]:  # skip header
            cells = row.css("td")
            if len(cells) < 4:
                continue

            # Layout (RotoWire common pattern):
            #  [0] Player (with team/opponent in subtitle)
            #  [1] Projection
            #  [2] Line / Over odds
            #  [3] Under odds
            # Real layout varies — be flexible.
            cell_texts = [clean(c.text) for c in cells]

            # Player name + team + opponent — try first cell
            player_text = cell_texts[0] if cell_texts else ""
            player = player_text.split("(")[0].split("\n")[0].strip()
            team_match = re.search(r"\(([^)]+)\)", player_text)
            team = team_match.group(1) if team_match else None

            # Opponent often in another column or as "vs/at OPP" suffix
            opponent = None
            opp_match = re.search(r"(?:vs|@)\s*([A-Z]{2,3})", player_text, re.I)
            if opp_match:
                opponent = opp_match.group(1).upper()

            # Find projection and line — they're floats in the row
            floats = [parse_float(t) for t in cell_texts]
            floats = [f for f in floats if f is not None]
            projection = None
            line = None
            if len(floats) >= 1:
                # First numeric is usually projection or line
                # Prefer the value that looks line-like (often labeled line)
                line = floats[0] if len(floats) == 1 else floats[1]
                projection = floats[0] if len(floats) >= 2 else None

            # American odds — pick out integers with sign
            ints = [parse_american(t) for t in cell_texts]
            ints = [i for i in ints if i is not None and -1000 < i < 1000]
            over_price = ints[0] if len(ints) >= 1 else None
            under_price = ints[1] if len(ints) >= 2 else None

            if not player or line is None:
                continue

            confidence = confidence_from_edge(projection, line)
            side = pick_side(projection, line)
            signals: list[str] = []
            if projection is not None:
                signals.append(f"RotoWire projection {projection:.1f} vs line {line:.1f}")

            props.append({
                "player": player,
                "team": team,
                "opponent": opponent,
                "market": market,
                "marketLabel": label,
                "category": category,
                "line": line,
                "overPrice": over_price,
                "underPrice": under_price,
                "pickSide": side,
                "confidence": confidence,
                "rationaleSignals": signals,
            })

    # Sort by confidence desc; top 25 broad list, top 5 in topProps
    props.sort(key=lambda p: p["confidence"], reverse=True)
    top_props = props[:5]

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sport": "NBA",
        "source": "rotowire",
        "available": len(props) > 0,
        "topProps": top_props,
        "props": props[:100],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default="data/processed/latest-player-props.json")
    args = ap.parse_args()

    if args.dry_run:
        print("dry run — would scrape", URL)
        return 0

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        data = scrape()
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        return 1

    out.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Wrote {len(data.get('props', []))} props ({len(data.get('topProps', []))} top) → {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
