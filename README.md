# freelancebot

Scrapes jobs from Mostaql and Khamsat, stores them in SQLite via Prisma, and sends new jobs to Telegram.

## Runtime configuration

### Telegram

curl "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"

### Scheduling

- `CRON_EXPR` (default: `*/3 * * * *`)

### HTTP resilience

- `HTTP_RETRY_MAX_ATTEMPTS` (default: `3`)
- `HTTP_RETRY_BASE_DELAY_MS` (default: `500`)
- `HTTP_RETRY_MAX_DELAY_MS` (default: `8000`)
- `HTTP_REQUEST_TIMEOUT_MS` (default: `10000`)

### Source pacing (recommended)

- `MOSTAQL_REQUEST_DELAY_MS` (recommended: `500` to `1200`)
- `MOSTAQL_DETAIL_CONCURRENCY` (recommended: `1` to `2`)
- `KHAMSAT_REQUEST_DELAY_MS` (recommended: `500` to `1200`)
- `KHAMSAT_DETAIL_CONCURRENCY` (recommended: `1` to `2`)

## Tech Job Focus & Filtering

The bot is optimized to target **Software, Development, and Technology** jobs. This operates in two ways:

1. **Source-level Filtering:** By default, Mostaql scrapes the `development` and `ai-machine-learning` categories instead of the general projects page, saving bandwidth and requests.
2. **Content-level Filtering:** Job posts are matched against a curated list of English and Arabic programming, technology, database, and devops keywords. Non-tech posts are stored in SQLite (to prevent scraping them again) but are filtered out from Telegram notifications.

### Configuration Env Vars

- `ENABLE_TECH_FILTER`: Set to `false` to disable keyword filtering and receive all scraped jobs (default: `true`).
- `MOSTAQL_SCRAPE_URL`: Override the URL scraped for Mostaql (e.g. to scrape all categories, set to `https://mostaql.com/projects`).
- `KHAMSAT_SCRAPE_URL`: Override the URL scraped for Khamsat.
- `ADDITIONAL_TECH_KEYWORDS_EN`: Comma-separated additional English keywords to filter on (e.g., `rust,golang,solidity`).
- `ADDITIONAL_TECH_KEYWORDS_AR`: Comma-separated additional Arabic keywords to filter on.



------

# 1. Install all dependencies
pnpm install

# 2. Generate the Prisma database client
pnpm run db:generate

# 3. Apply database schema migrations to create/sync your SQLite dev.db
pnpm run db:migrate
