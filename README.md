# freelancebot

Scrapes jobs from Mostaql and Khamsat, stores them in SQLite via Prisma, and sends new jobs to Telegram.

## Runtime configuration

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
