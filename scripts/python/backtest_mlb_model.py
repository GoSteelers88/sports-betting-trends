"""
backtest_mlb_model.py — Leak-free CLV/ROI backtest for the structured MLB model.

v2 inputs (all computed as-of-date from a single Statcast pitch pull, no leakage):
  - Starter run-prevention: as-of xwOBA-against.
  - Bullpen run-prevention: as-of xwOBA-against of each team's NON-starter pitchers.
  - Offense: as-of team batting xwOBA, SPLIT by opposing starter handedness (vs LHP/RHP).
  - Honest close line: per game, the latest odds snapshot strictly BEFORE first pitch
    (commence_time), so CLV isn't contaminated by in-progress/post-game prices.

Run via uv (no system python locally):
  uv run --python 3.11 --with pybaseball scripts/python/backtest_mlb_model.py \
      --start 2026-04-01 --end 2026-05-22
"""

import argparse
import glob
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

ABBR_TO_FULL = {
    "AZ": "Arizona Diamondbacks", "ARI": "Arizona Diamondbacks",
    "ATL": "Atlanta Braves", "BAL": "Baltimore Orioles", "BOS": "Boston Red Sox",
    "CHC": "Chicago Cubs", "CWS": "Chicago White Sox", "CHW": "Chicago White Sox",
    "CIN": "Cincinnati Reds", "CLE": "Cleveland Guardians", "COL": "Colorado Rockies",
    "DET": "Detroit Tigers", "HOU": "Houston Astros", "KC": "Kansas City Royals",
    "LAA": "Los Angeles Angels", "LAD": "Los Angeles Dodgers", "MIA": "Miami Marlins",
    "MIL": "Milwaukee Brewers", "MIN": "Minnesota Twins", "NYM": "New York Mets",
    "NYY": "New York Yankees", "ATH": "Athletics", "OAK": "Athletics",
    "PHI": "Philadelphia Phillies", "PIT": "Pittsburgh Pirates", "SD": "San Diego Padres",
    "SF": "San Francisco Giants", "SEA": "Seattle Mariners", "STL": "St. Louis Cardinals",
    "TB": "Tampa Bay Rays", "TEX": "Texas Rangers", "TOR": "Toronto Blue Jays",
    "WSH": "Washington Nationals", "WAS": "Washington Nationals",
}

PARK_FACTORS = {
    "Colorado Rockies": 1.15, "Boston Red Sox": 1.06, "Cincinnati Reds": 1.05,
    "Texas Rangers": 1.04, "Philadelphia Phillies": 1.03, "New York Yankees": 1.02,
    "Toronto Blue Jays": 1.01, "Chicago Cubs": 1.01, "Houston Astros": 1.00,
    "Detroit Tigers": 1.00, "Cleveland Guardians": 1.00, "Chicago White Sox": 0.99,
    "Minnesota Twins": 0.99, "Los Angeles Dodgers": 0.98, "New York Mets": 0.98,
    "Miami Marlins": 0.98, "Kansas City Royals": 0.97, "Baltimore Orioles": 0.97,
    "Pittsburgh Pirates": 0.97, "Atlanta Braves": 0.97, "Milwaukee Brewers": 0.97,
    "Washington Nationals": 0.96, "St. Louis Cardinals": 0.96, "Arizona Diamondbacks": 0.96,
    "Los Angeles Angels": 0.96, "Seattle Mariners": 0.95, "Tampa Bay Rays": 0.95,
    "San Francisco Giants": 0.94, "Athletics": 0.94, "San Diego Padres": 0.92,
}

LEAGUE_RPG = 4.5
LEAGUE_XWOBA = 0.320     # league avg xwOBA (offense-for and defense-against share this mean)
PYTHAG_EXP = 1.83
HOME_FIELD = 0.025
SP_SHARE = 0.6           # starter share of a 9-inning game
MIN_PA = 40              # as-of PA before trusting a pitcher's xwOBA-against
MIN_OFF_PA = 40          # as-of PA before trusting a team's handed offense split
EDGE_THR = 0.06


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def american_to_raw(ml):
    return 100.0 / (ml + 100.0) if ml >= 0 else abs(ml) / (abs(ml) + 100.0)


def novig_home(home_ml, away_ml):
    h, a = american_to_raw(home_ml), american_to_raw(away_ml)
    s = h + a
    return h / s if s > 0 else 0.5


def profit(ml):
    return ml / 100.0 if ml >= 0 else 100.0 / abs(ml)


def norm(s):
    return "".join(c for c in s.lower() if c.isalnum() or c == " ").strip()


def nickname(full):
    return norm(full).split()[-1] if full else ""


def cumulate(series, date):
    """series: sorted [(date, sum, count)]; return (mean, count) using rows before `date`."""
    s = c = 0.0
    for d, sm, cn in series:
        if d < date:
            s += sm; c += cn
        else:
            break
    return (s / c, int(c)) if c > 0 else (None, 0)


# --- odds snapshots --------------------------------------------------------
def load_odds(odds_dir):
    """{date: {pairkey: [(snap_dt_utc, novig_home, home_ml, away_ml, commence_dt)]}} sorted by snap time."""
    by_date = defaultdict(lambda: defaultdict(list))
    mlb_nicks = {nickname(v) for v in ABBR_TO_FULL.values()}
    for path in glob.glob(os.path.join(odds_dir, "*.json")):
        base = os.path.basename(path)[:-5]            # 2026-05-15_2345
        date, hhmm = base.split("_")
        snap_dt = datetime(int(date[:4]), int(date[5:7]), int(date[8:10]),
                           int(hhmm[:2]), int(hhmm[2:]), tzinfo=timezone.utc)
        try:
            data = json.load(open(path, encoding="utf-8"))
        except Exception:
            continue
        for ev in data.get("events", data if isinstance(data, list) else []):
            home, away = ev.get("home_team"), ev.get("away_team")
            if not home or not away:
                continue
            if nickname(home) not in mlb_nicks or nickname(away) not in mlb_nicks:
                continue
            commence = None
            ct = ev.get("commence_time")
            if ct:
                try:
                    commence = datetime.fromisoformat(ct.replace("Z", "+00:00"))
                except ValueError:
                    commence = None
            book = next((b for b in ev.get("bookmakers", [])
                         if any(m.get("key") == "h2h" for m in b.get("markets", []))), None)
            if not book:
                continue
            h2h = next(m for m in book["markets"] if m["key"] == "h2h")
            hp = next((o["price"] for o in h2h["outcomes"] if nickname(o["name"]) == nickname(home)), None)
            ap = next((o["price"] for o in h2h["outcomes"] if nickname(o["name"]) == nickname(away)), None)
            if hp is None or ap is None:
                continue
            key = f"{nickname(home)}|{nickname(away)}"
            by_date[date][key].append((snap_dt, novig_home(hp, ap), hp, ap, commence))
    for date in by_date:
        for key in by_date[date]:
            by_date[date][key].sort(key=lambda t: t[0])
    return by_date


def pick_bet_and_close(entries):
    """bet = earliest snapshot; close = latest snapshot strictly before first pitch."""
    if not entries:
        return None, None
    bet = entries[0]
    commence = bet[4]
    close = None
    if commence:
        pre = [e for e in entries if e[0] < commence]
        close = pre[-1] if pre else None
    return bet, close


# --- statcast --------------------------------------------------------------
def build_statcast(start, end):
    from pybaseball import statcast, cache
    cache.enable()
    print(f"[backtest] pulling statcast {start}..{end} ...", file=sys.stderr)
    df = statcast(start_dt=start, end_dt=end)
    if "game_type" in df.columns:
        df = df[df["game_type"] == "R"]
    df = df.sort_values(["game_pk", "at_bat_number", "pitch_number"])

    games = {}
    for gpk, g in df.groupby("game_pk"):
        last = g.iloc[-1]
        date = str(last["game_date"])[:10]
        home, away = ABBR_TO_FULL.get(last["home_team"]), ABBR_TO_FULL.get(last["away_team"])
        hs = last.get("post_home_score", last.get("home_score"))
        as_ = last.get("post_away_score", last.get("away_score"))
        if home is None or away is None or hs is None or as_ is None:
            continue
        ft = g[(g["inning"] == 1) & (g["inning_topbot"] == "Top")]
        fb = g[(g["inning"] == 1) & (g["inning_topbot"] == "Bot")]
        games[gpk] = {
            "date": date, "home": home, "away": away,
            "home_win": float(hs) > float(as_),
            "home_sp": ft.iloc[0]["pitcher"] if len(ft) else None,
            "away_sp": fb.iloc[0]["pitcher"] if len(fb) else None,
        }

    # PA-ending rows with xwOBA value + context.
    pa = df[df["woba_denom"] == 1].copy()
    est = pa["estimated_woba_using_speedangle"]
    pa["xnum"] = est.where(est.notna(), pa["woba_value"])
    pa["date"] = pa["game_date"].astype(str).str[:10]
    # Pitcher's fielding team + batting team from half-inning.
    pa["fld_team"] = pa.apply(lambda r: ABBR_TO_FULL.get(r["home_team"]) if r["inning_topbot"] == "Top"
                              else ABBR_TO_FULL.get(r["away_team"]), axis=1)
    pa["bat_team"] = pa.apply(lambda r: ABBR_TO_FULL.get(r["away_team"]) if r["inning_topbot"] == "Top"
                              else ABBR_TO_FULL.get(r["home_team"]), axis=1)
    # Is this PA against the game's starter? (for bullpen split)
    sp_of = {gpk: (g["home_sp"], g["away_sp"]) for gpk, g in games.items()}
    def is_starter(r):
        hs, as_ = sp_of.get(r["game_pk"], (None, None))
        return (r["inning_topbot"] == "Top" and r["pitcher"] == hs) or \
               (r["inning_topbot"] == "Bot" and r["pitcher"] == as_)
    pa["is_sp"] = pa.apply(is_starter, axis=1)

    def series_by(group_cols, mask=None):
        d = pa[mask] if mask is not None else pa
        agg = d.groupby(group_cols + ["date"])["xnum"].agg(["sum", "count"]).reset_index()
        out = defaultdict(list)
        for _, r in agg.iterrows():
            keyparts = tuple(r[c] for c in group_cols)
            key = keyparts[0] if len(group_cols) == 1 else keyparts
            out[key].append((r["date"], r["sum"], r["count"]))
        for k in out:
            out[k].sort()
        return out

    pitcher_s = series_by(["pitcher"])                       # starter xwOBA-against
    bullpen_s = series_by(["fld_team"], mask=~pa["is_sp"])    # team bullpen xwOBA-against
    off_hand_s = series_by(["bat_team", "p_throws"])         # team offense by opp hand

    def xwoba_pitcher(p, date):
        m, c = cumulate(pitcher_s.get(p, []), date)
        return m if c >= MIN_PA else None

    def xwoba_bullpen(team, date):
        m, c = cumulate(bullpen_s.get(team, []), date)
        return m if c >= MIN_PA else None

    def xwoba_off(team, hand, date):
        m, c = cumulate(off_hand_s.get((team, hand), []), date)
        if c >= MIN_OFF_PA:
            return m
        # fallback: team offense vs both hands combined
        comb = []
        for h in ("L", "R"):
            comb += off_hand_s.get((team, h), [])
        comb.sort()
        m2, c2 = cumulate(comb, date)
        return m2 if c2 >= MIN_OFF_PA else None

    def starter_hand(p, date):
        # crude: most recent known throwing hand from any PA row for this pitcher
        rows = pa[pa["pitcher"] == p]
        return rows.iloc[0]["p_throws"] if len(rows) else "R"

    return games, xwoba_pitcher, xwoba_bullpen, xwoba_off, starter_hand


# --- model -----------------------------------------------------------------
def model_home_prob(g, xwoba_pitcher, xwoba_bullpen, xwoba_off, starter_hand):
    date = g["date"]
    home_sp, away_sp = g["home_sp"], g["away_sp"]
    home_hand = starter_hand(home_sp, date) if home_sp else "R"
    away_hand = starter_hand(away_sp, date) if away_sp else "R"

    # Offense factor (xwOBA-for vs the OPPOSING starter's hand) / league avg.
    home_off = (xwoba_off(g["home"], away_hand, date) or LEAGUE_XWOBA) / LEAGUE_XWOBA
    away_off = (xwoba_off(g["away"], home_hand, date) or LEAGUE_XWOBA) / LEAGUE_XWOBA

    def prevention(sp, team):
        sp_x = xwoba_pitcher(sp, date) if sp else None
        bp_x = xwoba_bullpen(team, date)
        sp_f = (sp_x / LEAGUE_XWOBA) if sp_x else 1.0
        bp_f = (bp_x / LEAGUE_XWOBA) if bp_x else 1.0
        return SP_SHARE * sp_f + (1 - SP_SHARE) * bp_f

    home_prev = prevention(home_sp, g["home"])
    away_prev = prevention(away_sp, g["away"])
    env = PARK_FACTORS.get(g["home"], 1.0)

    home_runs = clamp(LEAGUE_RPG * home_off * away_prev * env, 1.5, 9)
    away_runs = clamp(LEAGUE_RPG * away_off * home_prev * env, 1.5, 9)
    hp, ap = home_runs ** PYTHAG_EXP, away_runs ** PYTHAG_EXP
    return clamp(hp / (hp + ap) + HOME_FIELD, 0.02, 0.98)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-04-01")
    ap.add_argument("--end", default="2026-05-22")
    ap.add_argument("--odds-dir", default=os.path.join(os.path.dirname(__file__), "../../data/backtest/odds"))
    args = ap.parse_args()

    odds = load_odds(args.odds_dir)
    print(f"[backtest] odds days: {len(odds)}")
    games, xwoba_pitcher, xwoba_bullpen, xwoba_off, starter_hand = build_statcast(args.start, args.end)
    print(f"[backtest] games parsed: {len(games)}")

    print(f"\n{'w':>4} {'picks':>6} {'W-L':>9} {'ROI':>8} {'CLVbeat':>8} {'avgCLV(pp)':>12}")
    print("-" * 54)
    for w in [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]:
        n = wins = losses = 0
        pnl = 0.0
        clv = []
        for g in games.values():
            day = odds.get(g["date"])
            if not day:
                continue
            key = f"{nickname(g['home'])}|{nickname(g['away'])}"
            bet, close = pick_bet_and_close(day.get(key, []))
            if not bet:
                continue
            market_home = bet[1]
            raw = model_home_prob(g, xwoba_pitcher, xwoba_bullpen, xwoba_off, starter_hand)
            final_home = clamp(w * raw + (1 - w) * market_home, 0.01, 0.99)
            edge = final_home - market_home
            if abs(edge) < EDGE_THR:
                continue
            bet_home = edge > 0
            n += 1
            won = (g["home_win"] == bet_home)
            if won:
                wins += 1
                pnl += profit(bet[2] if bet_home else bet[3])
            else:
                losses += 1
                pnl -= 1.0
            if close:
                bp = market_home if bet_home else (1 - market_home)
                cp = close[1] if bet_home else (1 - close[1])
                clv.append(cp - bp)
        roi = (pnl / n * 100) if n else 0.0
        beat = (sum(1 for c in clv if c > 0) / len(clv) * 100) if clv else 0.0
        avg = (sum(clv) / len(clv) * 100) if clv else 0.0
        print(f"{w:>4.1f} {n:>6} {f'{wins}-{losses}':>9} {roi:>7.1f}% {beat:>7.0f}% {avg:>9.2f}  (n={len(clv)})")

    print("\n[backtest] close = last snapshot strictly before first pitch (honest CLV).")


if __name__ == "__main__":
    main()
