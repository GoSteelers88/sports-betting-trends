"""
scrape_ats.py — Scrape full-season ATS records from teamrankings.com

Outputs:
  data/processed/scraped-ats-nba.json
  data/processed/scraped-ats-ncaab.json
  data/processed/scraped-ats-nhl.json

Run: python scripts/python/scrape_ats.py [--league nba|ncaab|nhl|all] [--dry-run]
"""

import json
import os
import re
import sys
import time
import argparse
from datetime import datetime, timezone
from pathlib import Path

from scrapling.fetchers import StealthyFetcher

# ── Config ────────────────────────────────────────────────────────────────────

LEAGUES = {
    "nba": {
        "slug": "nba",
        "label": "NBA",
        "out_file": "scraped-ats-nba.json",
    },
    "ncaab": {
        "slug": "ncaa-basketball",
        "label": "NCAAB",
        "out_file": "scraped-ats-ncaab.json",
    },
    "nhl": {
        "slug": "nhl",
        "label": "NHL",
        "out_file": "scraped-ats-nhl.json",
    },
}

SPLITS = {
    "overall":    "",
    "home":       "?sc=is_home",
    "away":       "?sc=is_away",
    "asFavorite": "?sc=is_fav",
    # asUnderdog excluded: ?sc=is_underdog redirects to win_trends on this page
}

BASE_URL = "https://www.teamrankings.com/{slug}/trends/ats_trends/{qs}"

# Polite delay between requests (seconds)
REQUEST_DELAY = 3.0

# ── Helpers ───────────────────────────────────────────────────────────────────

def parse_record(record_str: str) -> dict | None:
    """Parse '36-23-0' into {wins, losses, pushes}."""
    m = re.match(r"^(\d+)-(\d+)-(\d+)$", record_str.strip())
    if not m:
        return None
    wins, losses, pushes = int(m.group(1)), int(m.group(2)), int(m.group(3))
    total = wins + losses  # pushes excluded from cover %
    cover_pct = round(wins / total * 100, 1) if total > 0 else None
    return {
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "games": wins + losses + pushes,
        "coverPct": cover_pct,
    }


def parse_float(value: str) -> float | None:
    """Parse '+5.4' or '-3.1' or '17.5' into a float."""
    try:
        return float(value.strip().replace("+", ""))
    except (ValueError, AttributeError):
        return None


def scrape_split(slug: str, split_label: str, qs: str, dry_run: bool = False) -> dict[str, dict]:
    """
    Fetch one ATS split page and return a dict of {team_name: split_data}.
    """
    url = BASE_URL.format(slug=slug, qs=qs)
    print(f"  Fetching [{split_label}]: {url}", flush=True)

    if dry_run:
        print("  [DRY RUN] skipping fetch")
        return {}

    try:
        page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
    except Exception as e:
        print(f"  ERROR fetching {url}: {e}", file=sys.stderr)
        return {}

    if page.status != 200:
        print(f"  WARNING: HTTP {page.status} for {url}", file=sys.stderr)
        return {}

    tables = page.css("table")
    if not tables:
        print(f"  WARNING: no table found on {url}", file=sys.stderr)
        return {}

    results: dict[str, dict] = {}
    rows = tables[0].css("tr")

    for row in rows[1:]:  # skip header
        # Team name is in an <a> tag inside the first <td>
        team_name = row.css("td a::text").get("").strip()
        if not team_name:
            # betiq-style: first td::text is the team name
            tds = row.css("td::text").getall()
            if tds:
                team_name = tds[0].strip()
                tds = tds[1:]
            else:
                continue
        else:
            tds = row.css("td::text").getall()

        if not team_name or len(tds) < 4:
            continue

        record_data = parse_record(tds[0])
        if not record_data:
            continue

        record_data["coverPctRaw"] = parse_float(tds[1]) if len(tds) > 1 else None
        record_data["mov"]         = parse_float(tds[2]) if len(tds) > 2 else None
        record_data["atsDiff"]     = parse_float(tds[3]) if len(tds) > 3 else None

        # Use raw coverPct from page if available (more precise)
        if record_data["coverPctRaw"] is not None:
            record_data["coverPct"] = record_data["coverPctRaw"]
        del record_data["coverPctRaw"]

        results[team_name] = record_data

    print(f"  -> {len(results)} teams parsed", flush=True)
    return results


def scrape_league(league_key: str, dry_run: bool = False) -> dict:
    """Scrape all splits for one league and merge into a team list."""
    cfg = LEAGUES[league_key]
    slug = cfg["slug"]
    label = cfg["label"]

    print(f"\n=== {label} ===", flush=True)

    # Collect all splits
    split_data: dict[str, dict[str, dict]] = {}
    for split_label, qs in SPLITS.items():
        split_data[split_label] = scrape_split(slug, split_label, qs, dry_run)
        if not dry_run:
            time.sleep(REQUEST_DELAY)

    # Merge: union of all team names seen
    all_teams = set()
    for sd in split_data.values():
        all_teams.update(sd.keys())

    teams = []
    for team in sorted(all_teams):
        entry: dict = {"team": team}
        for split_label in SPLITS:
            entry[split_label] = split_data[split_label].get(team)
        teams.append(entry)

    return {
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
        "league": label,
        "source": "teamrankings.com",
        "teamCount": len(teams),
        "teams": teams,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Scrape ATS records from teamrankings.com")
    parser.add_argument("--league", choices=["nba", "ncaab", "nhl", "all"], default="all")
    parser.add_argument("--dry-run", action="store_true", help="Skip fetches, write empty output")
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


if __name__ == "__main__":
    main()
