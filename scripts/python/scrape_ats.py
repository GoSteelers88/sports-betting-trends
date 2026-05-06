"""
scrape_ats.py — Scrape full-season ATS records from actionnetwork.com

Replaces teamrankings.com (blocked headless browser) with Action Network
which renders data server-side — plain requests + BeautifulSoup, no browser needed.

Column layout on Action Network ATS standings pages:
  [0] Team  [1] Overall  [2] Home  [3] Away
  [4] ATS   [5] ATS HOME [6] ATS AWAY
  [7] Ov/Un [8] Ov/Un Home [9] Ov/Un Away

Outputs:
  data/processed/scraped-ats-nba.json
  data/processed/scraped-ats-ncaab.json
  data/processed/scraped-ats-nhl.json
  data/processed/scraped-ats-mlb.json

Run: python scripts/python/scrape_ats.py [--league nba|ncaab|nhl|mlb|all] [--dry-run]
"""

import json
import re
import sys
import time
import argparse
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

# ── Config ─────────────────────────────────────────────────────────────────────

LEAGUES = {
    "nba": {
        "label": "NBA",
        "url": "https://www.actionnetwork.com/nba/against-the-spread-standings",
        "out_file": "scraped-ats-nba.json",
    },
    # NCAAB: season runs Nov–Apr. Re-enable when season starts.
    # "ncaab": {
    #     "label": "NCAAB",
    #     "url": "https://www.actionnetwork.com/ncaab/against-the-spread-standings",
    #     "out_file": "scraped-ats-ncaab.json",
    # },
    "nhl": {
        "label": "NHL",
        "url": "https://www.actionnetwork.com/nhl/against-the-spread-standings",
        "out_file": "scraped-ats-nhl.json",
    },
    "mlb": {
        "label": "MLB",
        "url": "https://www.actionnetwork.com/mlb/against-the-spread-standings",
        "out_file": "scraped-ats-mlb.json",
    },
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.google.com/",
}

REQUEST_DELAY = 2.0

# ── Helpers ────────────────────────────────────────────────────────────────────

def parse_record(s: str) -> dict | None:
    """Parse '19-8' or '19-8-1' into {wins, losses, pushes, games, coverPct}."""
    s = s.strip()
    m = re.match(r"^(\d+)-(\d+)(?:-(\d+))?$", s)
    if not m:
        return None
    wins = int(m.group(1))
    losses = int(m.group(2))
    pushes = int(m.group(3)) if m.group(3) else 0
    total = wins + losses
    cover_pct = round(wins / total * 100, 1) if total > 0 else None
    return {
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "games": wins + losses + pushes,
        "coverPct": cover_pct,
        "mov": None,
        "atsDiff": None,
    }


def scrape_league(league_key: str, dry_run: bool = False) -> dict:
    cfg = LEAGUES[league_key]
    label = cfg["label"]
    url = cfg["url"]

    print(f"\n=== {label} ===", flush=True)
    print(f"  Fetching: {url}", flush=True)

    empty = {
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
        "league": label,
        "source": "actionnetwork.com",
        "teamCount": 0,
        "teams": [],
    }

    if dry_run:
        print("  [DRY RUN] skipping fetch")
        return empty

    try:
        resp = requests.get(url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        return empty

    soup = BeautifulSoup(resp.text, "html.parser")
    table = soup.find("table")

    if not table:
        print(f"  WARNING: no table found", file=sys.stderr)
        return empty

    # Action Network uses 2 thead rows: row[0] = league title span, row[1] = real headers
    thead = table.find("thead")
    header_rows = thead.find_all("tr") if thead else []
    col_headers = []
    if len(header_rows) >= 2:
        col_headers = [th.get_text(strip=True).upper() for th in header_rows[1].find_all(["th", "td"])]
    elif len(header_rows) == 1:
        col_headers = [th.get_text(strip=True).upper() for th in header_rows[0].find_all(["th", "td"])]

    print(f"  Columns: {col_headers}", flush=True)

    # Find column indices
    ats_overall_idx = None
    ats_home_idx    = None
    ats_away_idx    = None

    for i, h in enumerate(col_headers):
        if h == "ATS":
            ats_overall_idx = i
        elif h == "ATS HOME":
            ats_home_idx = i
        elif h == "ATS AWAY":
            ats_away_idx = i

    # Fallback to positional if headers not matched
    if ats_overall_idx is None and len(col_headers) >= 7:
        ats_overall_idx = 4
        ats_home_idx    = 5
        ats_away_idx    = 6

    if ats_overall_idx is None:
        print(f"  WARNING: could not find ATS columns", file=sys.stderr)
        return empty

    # Parse body rows
    tbody = table.find("tbody")
    rows = tbody.find_all("tr") if tbody else table.find_all("tr")[len(header_rows):]

    teams = []
    for row in rows:
        cells = row.find_all(["td", "th"])
        if len(cells) < ats_overall_idx + 1:
            continue

        # Team name from first cell — prefer link text
        link = cells[0].find("a")
        team_name = link.get_text(strip=True) if link else cells[0].get_text(strip=True)
        if not team_name:
            continue

        def get_record(idx):
            if idx is None or idx >= len(cells):
                return None
            return parse_record(cells[idx].get_text(strip=True))

        overall = get_record(ats_overall_idx)
        if overall is None:
            continue

        teams.append({
            "team":       team_name,
            "overall":    overall,
            "home":       get_record(ats_home_idx),
            "away":       get_record(ats_away_idx),
            "asFavorite": None,  # not available from Action Network
        })

    print(f"  -> {len(teams)} teams parsed", flush=True)
    return {
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
        "league": label,
        "source": "actionnetwork.com",
        "teamCount": len(teams),
        "teams": teams,
    }


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Scrape ATS records from actionnetwork.com")
    parser.add_argument("--league", choices=["nba", "nhl", "mlb", "all"], default="all")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    out_dir = repo_root / "data" / "processed"
    out_dir.mkdir(parents=True, exist_ok=True)

    target_leagues = list(LEAGUES.keys()) if args.league == "all" else [args.league]

    for league_key in target_leagues:
        data = scrape_league(league_key, dry_run=args.dry_run)
        out_path = out_dir / LEAGUES[league_key]["out_file"]
        out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(f"\nWrote {data['teamCount']} teams -> {out_path}", flush=True)
        if not args.dry_run and len(target_leagues) > 1:
            time.sleep(REQUEST_DELAY)


if __name__ == "__main__":
    main()
