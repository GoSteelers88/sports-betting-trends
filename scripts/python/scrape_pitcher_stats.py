"""
scrape_pitcher_stats.py — Scrape 2026 MLB season pitching stats from baseball-reference.com

Target: https://www.baseball-reference.com/leagues/MLB/2026-standard-pitching.shtml
Uses static Fetcher (not StealthyFetcher) — baseball-reference serves static HTML.

Output: data/processed/pitcher-stats-season.json
  {
    "fetchedAt": "ISO",
    "pitchers": {
      "Jack Flaherty": { "era": 3.24, "whip": 1.12, "ip": 16.2, "gs": 3, "k9": 9.1, "bb9": 2.3 },
      ...
    }
  }

Run: python scripts/python/scrape_pitcher_stats.py [--dry-run]
"""

import json
import re
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path

from scrapling.fetchers import Fetcher as ScraplingFetcher

URL = "https://www.baseball-reference.com/leagues/MLB/2026-standard-pitching.shtml"

# baseball-reference column positions in the standard pitching table.
# Header: Rk, Name, Age, Tm, Lg, W, L, W-L%, ERA, G, GS, GF, CG, SHO, SV, IP, H, R, ER, HR, BB, IBB, SO, HBP, BK, WP, BF, ERA+, FIP, WHIP, H9, HR9, BB9, SO9, SO/W, Awards
# We parse by header text to be robust to column reordering.

REQUEST_TIMEOUT = 30  # seconds

def parse_ip(ip_str: str) -> float | None:
    """Convert IP string like '16.1' (16 full innings + 1 out) to decimal innings."""
    try:
        ip_str = ip_str.strip()
        if "." in ip_str:
            full, thirds = ip_str.split(".", 1)
            return float(full) + int(thirds) / 3.0
        return float(ip_str)
    except (ValueError, AttributeError):
        return None


def safe_float(val: str) -> float | None:
    """Parse a float string, returning None for empty/dash values."""
    try:
        v = val.strip()
        if v in ("", "-", "—", "null"):
            return None
        return float(v)
    except (ValueError, AttributeError):
        return None


def safe_int(val: str) -> int | None:
    """Parse an int string, returning None for empty/dash values."""
    try:
        v = val.strip()
        if v in ("", "-", "—", "null"):
            return None
        return int(v)
    except (ValueError, AttributeError):
        return None


def fetch_pitcher_stats(dry_run: bool = False) -> dict:
    """Fetch and parse standard pitching table. Returns {pitcher_name: stats_dict}."""
    if dry_run:
        print("[scrape_pitcher_stats] DRY RUN — returning empty dict", flush=True)
        return {}

    print(f"[scrape_pitcher_stats] Fetching: {URL}", flush=True)
    try:
        fetcher = ScraplingFetcher()
        page = fetcher.get(URL)
    except Exception as e:
        print(f"[scrape_pitcher_stats] ERROR fetching {URL}: {e}", file=sys.stderr)
        return {}

    if page.status != 200:
        print(f"[scrape_pitcher_stats] WARNING: HTTP {page.status}", file=sys.stderr)
        return {}

    # baseball-reference wraps the main stats table in a comment to avoid
    # AdBlock — we need to parse it from the raw HTML.
    html = page.html_content

    # Try direct CSS selector first (works if table is not commented)
    tables = page.css("table#players_standard_pitching")
    if not tables:
        tables = page.css("table.stats_table")

    if not tables:
        print("[scrape_pitcher_stats] WARNING: no pitching table found via CSS — trying raw HTML fallback", file=sys.stderr)
        # baseball-reference hides table inside HTML comment; parse via regex
        return _parse_from_raw_html(html)

    table = tables[0]
    pitchers: dict[str, dict] = {}

    # baseball-reference uses data-stat attributes on each td for reliable column access.
    # Confirmed column data-stat names: name_display, p_gs, p_g, p_earned_run_avg,
    # p_whip, p_ip, p_so, p_bb, p_so_per_nine, p_bb_per_nine

    for row in table.css("tbody tr"):
        # Skip header spacer rows
        cls = row.attrib.get("class", "")
        if "thead" in cls or "spacer" in cls:
            continue

        # Player name — either via link or direct text in name_display cell
        name_raw = row.css("td[data-stat='name_display'] a::text").get("").strip()
        if not name_raw:
            name_raw = row.css("td[data-stat='name_display']::text").get("").strip()
        if not name_raw or name_raw in ("Player", "Name", ""):
            continue

        # Remove trailing asterisk/hash (HOF markers, active-player indicators)
        name_clean = re.sub(r"[*#]+$", "", name_raw).strip()

        gs_raw  = row.css("td[data-stat='p_gs']::text").get("").strip()
        g_raw   = row.css("td[data-stat='p_g']::text").get("").strip()
        era_raw = row.css("td[data-stat='p_earned_run_avg']::text").get("").strip()
        whip_raw = row.css("td[data-stat='p_whip']::text").get("").strip()
        ip_raw  = row.css("td[data-stat='p_ip']::text").get("").strip()
        so_raw  = row.css("td[data-stat='p_so']::text").get("").strip()
        bb_raw  = row.css("td[data-stat='p_bb']::text").get("").strip()

        gs = safe_int(gs_raw) or 0
        g  = safe_int(g_raw)  or 1
        ip_decimal = parse_ip(ip_raw)

        # Only keep starting pitchers: GS >= 1 OR GS/G ratio > 0.5
        if gs == 0 and (g == 0 or gs / g <= 0.5):
            continue

        era  = safe_float(era_raw)
        whip = safe_float(whip_raw)

        # Compute K/9 and BB/9 from raw counts + IP (more precise than pre-computed p_so_per_nine)
        so  = safe_int(so_raw)
        bb  = safe_int(bb_raw)
        k9  = round(so * 9 / ip_decimal, 1) if (so is not None and ip_decimal and ip_decimal > 0) else None
        bb9 = round(bb * 9 / ip_decimal, 1) if (bb is not None and ip_decimal and ip_decimal > 0) else None

        # For duplicate pitchers (traded mid-season), keep the entry with most IP
        if name_clean in pitchers:
            existing_ip = pitchers[name_clean].get("ip") or 0
            if (ip_decimal or 0) <= existing_ip:
                continue

        pitchers[name_clean] = {
            "era":  era,
            "whip": whip,
            "ip":   round(ip_decimal, 2) if ip_decimal is not None else None,
            "gs":   gs,
            "k9":   k9,
            "bb9":  bb9,
        }

    print(f"[scrape_pitcher_stats] Parsed {len(pitchers)} starting pitchers", flush=True)
    return pitchers


def _parse_from_raw_html(html: str) -> dict:
    """
    Fallback: parse pitcher stats from raw HTML when the table is inside an HTML comment.
    baseball-reference wraps the main data table in <!-- --> to prevent easy scraping.
    We extract row data using regex.
    """
    print("[scrape_pitcher_stats] Attempting raw HTML fallback parser", flush=True)

    # Uncomment the hidden table section
    # The pitching stats table id is "players_standard_pitching"
    section_match = re.search(
        r"<!--(.*?id=['\"]players_standard_pitching['\"].*?)-->",
        html, re.DOTALL
    )
    if not section_match:
        print("[scrape_pitcher_stats] Raw HTML fallback: table not found in comments", file=sys.stderr)
        return {}

    table_text = section_match.group(1)

    # Extract rows: <tr ...><td ...>...</tr>
    row_pattern = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL)
    cell_pattern = re.compile(r'<t[dh][^>]*data-stat=["\']([^"\']+)["\'][^>]*>(.*?)</t[dh]>', re.DOTALL)
    tag_strip = re.compile(r"<[^>]+>")

    pitchers: dict[str, dict] = {}

    for row_m in row_pattern.finditer(table_text):
        row_html = row_m.group(1)
        cells: dict[str, str] = {}
        for cell_m in cell_pattern.finditer(row_html):
            stat_name = cell_m.group(1)
            raw_val = tag_strip.sub("", cell_m.group(2)).strip()
            cells[stat_name] = raw_val

        name_raw = cells.get("player", "").strip()
        if not name_raw or name_raw == "Name":
            continue

        name_clean = re.sub(r"[*#]+$", "", name_raw).strip()

        gs = safe_int(cells.get("GS", "")) or 0
        g  = safe_int(cells.get("G", "")) or 1

        if gs == 0 and (g == 0 or gs / g <= 0.5):
            continue

        ip_decimal = parse_ip(cells.get("IP", ""))
        era  = safe_float(cells.get("earned_run_avg", ""))
        whip = safe_float(cells.get("whip", ""))
        so   = safe_int(cells.get("SO", ""))
        bb   = safe_int(cells.get("BB", ""))

        k9  = round(so * 9 / ip_decimal, 1) if (so is not None and ip_decimal and ip_decimal > 0) else None
        bb9 = round(bb * 9 / ip_decimal, 1) if (bb is not None and ip_decimal and ip_decimal > 0) else None

        pitchers[name_clean] = {
            "era":  era,
            "whip": whip,
            "ip":   round(ip_decimal, 2) if ip_decimal is not None else None,
            "gs":   gs,
            "k9":   k9,
            "bb9":  bb9,
        }

    print(f"[scrape_pitcher_stats] Raw fallback parsed {len(pitchers)} starting pitchers", flush=True)
    return pitchers


def main():
    parser = argparse.ArgumentParser(description="Scrape 2026 MLB pitcher season stats from baseball-reference")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    out_dir = repo_root / "data" / "processed"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "pitcher-stats-season.json"

    pitchers = fetch_pitcher_stats(dry_run=args.dry_run)

    output = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "pitcherCount": len(pitchers),
        "source": "baseball-reference.com",
        "pitchers": pitchers,
    }

    out_path.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"Wrote {len(pitchers)} pitchers -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
