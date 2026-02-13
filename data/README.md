# Data folder structure

- `data/raw/` - untouched manual exports from free/public sources.
  - `data/raw/nba/` - NBA files (CSV or JSON)
  - `data/raw/nfl/` - NFL files (CSV or JSON)
- `data/processed/` - optional derived files generated from ingest/transform scripts.

## Workflow

1. Drop fresh free/public exports in `data/raw/nba` and `data/raw/nfl`.
2. Run `npm run ingest:free` to load into SQLite via Prisma.
3. (Optional) keep generated summaries in `data/processed`.
