# Data folder structure

- `data/raw/` - untouched manual exports from free/public sources.
  - `data/raw/nba/` - NBA files (CSV or JSON)
  - `data/raw/nfl/` - NFL files (CSV or JSON)
  - `data/raw/ncaab/` - NCAAB files (CSV preferred for conference + ATS tags)
- `data/processed/` - derived files generated from ingest/transform scripts.

## Workflow

1. Drop fresh free/public exports in `data/raw/nba`, `data/raw/nfl`, and `data/raw/ncaab`.
2. Run `npm run ingest:free` to load into SQLite via Prisma.
3. Use `/api/free-stats/summary?league=ALL&conference=ALL` for filtered summaries.
4. Generated snapshot is written to `data/processed/latest-summary.json`.

## NCAAB sample schema

`data/raw/ncaab/sample_team_stats.csv` columns:

- `date`, `conference`, `team`, `opponent`
- `points`, `opponent_points`, `rebounds`, `assists`
- `spread`, `ats_result` (`W|L|P`)
- `team_rank`, `opponent_rank`
- `bubble_status` (`LOCK|WORK|BUBBLE`)
- `auto_bid_status` (`AUTO_BID|AT_LARGE_TRACK`)
- `source`
