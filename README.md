# freelancebot

Collects employer and job-board listings plus freelance marketplace projects into SQLite/Prisma, retains changes for local market analysis, and sends personal Telegram alerts. All occupations are stored; preferences filter only alerts.

See [collection setup, commands, configuration and behavior](docs/COLLECTION.md), [verified coverage](docs/COVERAGE.md), and [third-party notices](docs/THIRD_PARTY_NOTICES.md).

```sh
pnpm install
pnpm db:generate
DATABASE_URL=file:/absolute/path/jobs.db pnpm exec prisma migrate deploy
DATABASE_URL=file:/absolute/path/jobs.db pnpm collect
```

Collection works without Telegram credentials. Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, then use `pnpm dev` for scheduled collection and delivery. Back up an existing database before deploying migrations.

Marketplace alert preferences remain available:

- `ENABLE_TECH_FILTER=false` disables the existing keyword filter.
- `ADDITIONAL_TECH_KEYWORDS_EN` and `ADDITIONAL_TECH_KEYWORDS_AR` extend it with comma-separated terms.
- `MOSTAQL_SCRAPE_URL` and the other marketplace URL overrides restrict discovery explicitly. Mostaql defaults to all categories.
- A legacy minute-step `CRON_EXPR` such as `*/3 * * * *` sets marketplace polling cadence. Employer and feed intervals remain independent.

```sh
pnpm test
pnpm run typecheck
pnpm exec prisma validate
```
