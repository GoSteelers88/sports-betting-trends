# Sports Betting Trends (MVP)

Next.js + TypeScript + Tailwind + SQLite (Prisma) app for tracking betting performance and trends.

## Included MVP Features

- **Dashboard** with key metrics (units, ROI, win rate, bankroll)
- **Filters** (league, market, period, min edge)
- **Trends chart** (cumulative units history)
- **Props explorer** (mock projection/edge API)
- **Bankroll tracker** (deposits, withdrawals, current bankroll, units/ROI/win rate)
- **Strategy notes** panel
- **Responsive dark UI**
- **Mock API routes** for dashboard/props/bankroll/notes
- **SQLite + Prisma** models, migration, and seed script

## Tech Stack

- Next.js (App Router)
- TypeScript
- Tailwind CSS v4
- Prisma + SQLite
- Recharts

## Project Setup

1. Install dependencies:

```bash
npm install
```

2. Generate Prisma client:

```bash
npm run prisma:generate
```

3. Run migration + seed:

```bash
npm run prisma:migrate
```

4. Start dev server:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Exact Commands to Run (fresh clone)

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run ingest:free
npm run dev
```

## API Routes

- `GET /api/dashboard?league=ALL&market=ALL&period=30d`
- `GET /api/props?league=ALL&minEdge=4`
- `GET /api/bankroll`
- `GET /api/strategy-notes`
- `GET /api/free-stats/summary?league=ALL&conference=ALL` (NBA/NFL/NCAAB/MLB ingested free-data summary + trend scoring + best bets + Top 5 NBA player props)

## Database Schema

Prisma models:

- `Bet`
- `BankrollEntry`
- `StrategyNote`
- `FreeStat` (NBA/NFL free ingestion table)

SQLite file: `prisma/dev.db`

## Scripts

- `npm run dev`
- `npm run build`
- `npm run lint`
- `npm run prisma:generate`
- `npm run prisma:migrate`
- `npm run db:seed`
- `npm run ingest:free`
- `npm run ingest:props` (NBA player props ingest + ranking output to `data/processed/latest-player-props.json`)

## Free stats ingestion starter (NBA + NFL + NCAAB + MLB)

This starter uses only free/publicly available data workflows (no paid API keys, no bypassing auth/paywalls):

- **NBA sample source pattern:** manual CSV exports from public game box scores (e.g., Basketball-Reference)
- **NFL sample source pattern:** manual JSON exports from public game summaries/game finder pages (e.g., Pro-Football-Reference)
- **NCAAB live source:** ESPN public scoreboard + game summary endpoints (repeatable scripted ingest with manual CSV fallback)
- **MLB live source:** ESPN public scoreboard endpoint (repeatable scripted ingest with manual CSV fallback)

Sample files included:

- `data/raw/nba/sample_team_stats.csv`
- `data/raw/nfl/sample_team_stats.json`
- `data/raw/ncaab/sample_team_stats.csv`
- `data/raw/mlb/sample_team_stats.csv`

Documented data layout:

- `data/raw/` for untouched source files
- `data/processed/` for derived outputs (e.g., generated summaries)
- See `data/README.md` for details

### Refresh steps

1. (Optional) Replace sample files in `data/raw/nba` and/or `data/raw/nfl` with your latest manual exports.
2. Run:
   ```bash
   npm run ingest:free
   ```
   - NCAAB auto-fetches from ESPN public endpoints.
   - MLB auto-fetches from ESPN public endpoints.
   - Configure depth with `NCAAB_DAYS_BACK` and `MLB_DAYS_BACK` (default `7`).
3. Ingest NBA player props (The Odds API; gracefully handles unavailable markets/plans):
   ```bash
   npm run ingest:props
   ```
4. Verify API response:
   ```bash
   curl http://localhost:3000/api/free-stats/summary
   ```
5. Check homepage readability/quality view at `http://localhost:3000` (cards show ingest readiness, trend score, confidence, and Top 5 NBA player props).

### Trend scoring notes (free-data mode)

`/api/free-stats/summary` now returns per-league fields:

- `trendScore` (1-99)
- `trendSignal` (`up`, `flat`, `down`)
- `confidence` (0.35-1.0 based on sample count)
- `recentAvgPoints` and `recentAvgYards`
- `ncaab.last10Momentum`, `ncaab.atsForm`, `ncaab.upsetAlertScore`
- `ncaab.bubbleWatchTeams`, `ncaab.autoBidWatchTeams`
- `bestBets` (combined ranking output, including NCAAB + MLB teams)
- `conferences` + `league/conference` filter support (`conference` includes MLB divisions)

Scoring remains bounded heuristics for directional support only, not betting advice.
