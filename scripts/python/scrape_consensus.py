"""
scrape_consensus.py — Scrape public betting consensus from covers.com

Sources:
  Spread: https://contests.covers.com/consensus/topconsensus/{league}/overall
  Total:  https://contests.covers.com/consensus/topoverunderconsensus/{league}

Outputs:
  data/processed/scraped-consensus.json

Run: python scripts/python/scrape_consensus.py [--league nba|ncaab|nhl|epl|mlb|all] [--dry-run]
"""

import json
import re
import sys
import time
import argparse
from datetime import datetime, timezone
from pathlib import Path

from scrapling.fetchers import StealthyFetcher

# ── Config ────────────────────────────────────────────────────────────────────

LEAGUES = {
    "nba":   {"label": "NBA",   "slug": "nba"},
    "ncaab": {"label": "NCAAB", "slug": "ncaab"},
    "nhl":   {"label": "NHL",   "slug": "nhl"},
    "epl":   {"label": "EPL",   "slug": "soccer", "optional": True},
    "mlb":   {"label": "MLB",   "slug": "mlb", "optional": True},
}

SPREAD_URL = "https://contests.covers.com/consensus/topconsensus/{slug}/overall"
TOTAL_URL  = "https://contests.covers.com/consensus/topoverunderconsensus/{slug}"

REQUEST_DELAY = 4.0

# When >= this % of public is on one side, we flag it as a potential
# sharp money opportunity (public betting one way, line may move other way)
SHARP_THRESHOLD = 65

# ── Helpers ───────────────────────────────────────────────────────────────────

def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def parse_picks(raw: list[str]) -> tuple[int, int]:
    """
    Extract two pick counts from a list of text nodes.
    Returns (count_a, count_b) or (0, 0) on failure.
    """
    nums = [int(x) for x in raw if re.fullmatch(r"\d+", x.strip())]
    if len(nums) >= 2:
        return nums[-2], nums[-1]
    return 0, 0


def pct(a: int, b: int) -> float | None:
    total = a + b
    if total == 0:
        return None
    return round(a / total * 100, 1)


def sharp_side(away_pct: float | None, home_pct: float | None) -> str | None:
    """
    Public heavily on one side => sharps likely on the other.
    Returns 'away', 'home', or None.
    """
    if away_pct is None or home_pct is None:
        return None
    if away_pct >= SHARP_THRESHOLD:
        return "home"
    if home_pct >= SHARP_THRESHOLD:
        return "away"
    return None


def parse_spread_value(td_texts: list[str]) -> tuple[str | None, str | None]:
    """Extract away_spread, home_spread from td text list."""
    spreads = [t.strip() for t in td_texts if re.match(r"^[+-]?\d+(\.\d+)?$", t.strip())]
    if len(spreads) >= 2:
        return spreads[0], spreads[1]
    return None, None


def parse_total_value(td_texts: list[str]) -> str | None:
    """Extract total line from td text list."""
    for t in td_texts:
        if re.match(r"^\d{3}(\.\d+)?$", t.strip()):
            return t.strip()
    return None


def fetch_page(url: str) -> object | None:
    try:
        page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
    except Exception as e:
        print(f"  ERROR fetching {url}: {e}", file=sys.stderr)
        return None
    if page.status != 200:
        print(f"  WARNING: HTTP {page.status} for {url}", file=sys.stderr)
        return None
    return page


def scrape_spreads(slug: str, dry_run: bool = False) -> dict[str, dict]:
    """
    Returns a dict keyed by 'AwayAbbr vs HomeAbbr' with spread consensus data.
    """
    url = SPREAD_URL.format(slug=slug)
    print(f"  Fetching spreads: {url}", flush=True)
    if dry_run:
        return {}

    page = fetch_page(url)
    if not page:
        return {}

    results: dict[str, dict] = {}
    tables = page.css("table")
    if not tables:
        return {}

    for row in tables[0].css("tr")[1:]:
        links = [clean(a) for a in row.css("td a::text").getall()]
        td_texts = [clean(t) for t in row.css("td::text").getall() if clean(t)]

        # links = [league, away_abbr, home_abbr, "Details"]
        if len(links) < 3:
            continue
        away_abbr = links[1]
        home_abbr = links[2]

        # Extract pick counts (last two integers in td text)
        away_picks, home_picks = parse_picks(td_texts)

        # Extract spread values
        away_spread, home_spread = parse_spread_value(td_texts)

        away_p = pct(away_picks, home_picks)
        home_p = pct(home_picks, away_picks)

        key = f"{away_abbr} vs {home_abbr}"
        results[key] = {
            "awayAbbr":   away_abbr,
            "homeAbbr":   home_abbr,
            "awaySpread": away_spread,
            "homeSpread": home_spread,
            "awayPicks":  away_picks,
            "homePicks":  home_picks,
            "awayPct":    away_p,
            "homePct":    home_p,
            "sharpSide":  sharp_side(away_p, home_p),
        }

    print(f"  -> {len(results)} spread games parsed", flush=True)
    return results


def scrape_totals(slug: str, dry_run: bool = False) -> dict[str, dict]:
    """
    Returns a dict keyed by 'AwayAbbr vs HomeAbbr' with total consensus data.
    """
    url = TOTAL_URL.format(slug=slug)
    print(f"  Fetching totals:  {url}", flush=True)
    if dry_run:
        return {}

    page = fetch_page(url)
    if not page:
        return {}

    results: dict[str, dict] = {}
    tables = page.css("table")
    if not tables:
        return {}

    for row in tables[0].css("tr")[1:]:
        links = [clean(a) for a in row.css("td a::text").getall()]
        td_texts = [clean(t) for t in row.css("td::text").getall() if clean(t)]

        if len(links) < 3:
            continue
        away_abbr = links[1]
        home_abbr = links[2]

        over_picks, under_picks = parse_picks(td_texts)
        total_line = parse_total_value(td_texts)

        over_p  = pct(over_picks, under_picks)
        under_p = pct(under_picks, over_picks)

        key = f"{away_abbr} vs {home_abbr}"
        results[key] = {
            "totalLine":   total_line,
            "overPicks":   over_picks,
            "underPicks":  under_picks,
            "overPct":     over_p,
            "underPct":    under_p,
        }

    print(f"  -> {len(results)} total games parsed", flush=True)
    return results


# ── Main ──────────────────────────────────────────────────────────────────────

def scrape_league(slug: str, label: str, dry_run: bool = False, optional: bool = False) -> list[dict]:
    print(f"\n=== {label} ===", flush=True)

    try:
        spread_data = scrape_spreads(slug, dry_run)
    except Exception as e:
        if optional:
            print(f"  WARNING: spread scrape failed for {label} (optional — skipping): {e}", file=sys.stderr)
            spread_data = {}
        else:
            raise
    if not dry_run:
        time.sleep(REQUEST_DELAY)
    try:
        total_data = scrape_totals(slug, dry_run)
    except Exception as e:
        if optional:
            print(f"  WARNING: totals scrape failed for {label} (optional — skipping): {e}", file=sys.stderr)
            total_data = {}
        else:
            raise

    all_keys = set(spread_data) | set(total_data)
    games = []
    for key in sorted(all_keys):
        sp = spread_data.get(key, {})
        tot = total_data.get(key, {})
        away = sp.get("awayAbbr") or tot.get("awayAbbr") or key.split(" vs ")[0]
        home = sp.get("homeAbbr") or tot.get("homeAbbr") or key.split(" vs ")[-1]
        games.append({
            "matchup":   f"{away} at {home}",
            "league":    label,
            "awayAbbr":  away,
            "homeAbbr":  home,
            "spread": {
                "awaySpread": sp.get("awaySpread"),
                "homeSpread": sp.get("homeSpread"),
                "awayPct":    sp.get("awayPct"),
                "homePct":    sp.get("homePct"),
                "awayPicks":  sp.get("awayPicks"),
                "homePicks":  sp.get("homePicks"),
                "sharpSide":  sp.get("sharpSide"),
            },
            "total": {
                "line":       tot.get("totalLine"),
                "overPct":    tot.get("overPct"),
                "underPct":   tot.get("underPct"),
                "overPicks":  tot.get("overPicks"),
                "underPicks": tot.get("underPicks"),
            },
        })

    return games


def main():
    parser = argparse.ArgumentParser(description="Scrape public betting consensus from covers.com")
    parser.add_argument("--league", choices=["nba", "ncaab", "nhl", "epl", "mlb", "all"], default="all")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    out_dir = repo_root / "data" / "processed"
    out_dir.mkdir(parents=True, exist_ok=True)

    target_leagues = list(LEAGUES.keys()) if args.league == "all" else [args.league]

    all_games: list[dict] = []
    for i, lk in enumerate(target_leagues):
        cfg = LEAGUES[lk]
        games = scrape_league(cfg["slug"], cfg["label"], dry_run=args.dry_run, optional=cfg.get("optional", False))
        all_games.extend(games)
        if not args.dry_run and i < len(target_leagues) - 1:
            time.sleep(REQUEST_DELAY)

    by_league = {}
    for g in all_games:
        by_league.setdefault(g["league"], []).append(g)

    output = {
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
        "source":    "covers.com",
        "gameCount": len(all_games),
        "byLeague":  {lg: len(gs) for lg, gs in by_league.items()},
        "games":     all_games,
    }

    out_path = out_dir / "scraped-consensus.json"
    out_path.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"\nWrote {len(all_games)} games -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
