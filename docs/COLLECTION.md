Collection stores all occupations. Personal alert matching is applied after persistence: existing marketplace tech preferences remain configurable in the existing filter (disabling that filter applies only to marketplaces), and employer/feed alerts additionally require Egypt-local or potentially Egypt-eligible remote work. Uncertain remote matches say “Egypt eligibility unverified”; explicit geographic exclusions suppress alerts. This is a heuristic, not proof of work authorization. Review the linked listing.

Setup and execution:

```sh
pnpm install
pnpm db:generate
DATABASE_URL=file:/absolute/path/jobs.db pnpm db:deploy
DATABASE_URL=file:/absolute/path/jobs.db pnpm collect
DATABASE_URL=file:/absolute/path/jobs.db pnpm collect --source remotive
DATABASE_URL=file:/absolute/path/jobs.db pnpm collect --source greenhouse:boards-api.greenhouse.io:brave
DATABASE_URL=file:/absolute/path/jobs.db pnpm --silent sources:status
DATABASE_URL=file:/absolute/path/jobs.db pnpm --silent export --view current > current.jsonl
DATABASE_URL=file:/absolute/path/jobs.db pnpm --silent export --view history --format csv > history.csv
```

`pnpm collect` is one shot and never delivers Telegram messages. It can create queue entries for eligible discoveries after baselining. Collection and exports require no Telegram credentials. `--source` accepts comma-separated collection IDs or providers. `--force` bypasses the polling interval, but never active leases or cooldowns; reserve it for diagnostics. Avoid forcing feed requests beyond documented limits.

`pnpm dev` schedules due sources every minute and drains the Telegram queue. Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` first. For a collection-only scheduler use `pnpm exec tsx src/collection/cli.ts schedule`. For one-shot delivery add `--notify` to `pnpm collect`. Existing Telegram retry/delay options remain supported. Collection HTTP requests use a 15-second timeout and persistent cooldowns. Marketplace URL overrides (`MOSTAQL_SCRAPE_URL`, etc.) remain effective; Ureed requires a GraphQL endpoint. Mostaql now defaults to all categories. `MOSTAQL_MAX_PAGES`, `KHAMSAT_MAX_PAGES`, and `NAFEZLY_MAX_PAGES` default to 5. A cap is an incomplete run. `HIMALAYAS_MAX_PAGES` defaults to 10000 (200000 rows); traversal uses opaque cursors, persists batches of 200 jobs as they arrive, and reports a cap/interruption as incomplete. The baseline is committed only when traversal reaches its end. No historical availability before discovery is promised.

ATS and rolling feeds poll every six hours; Himalayas polls daily. Existing marketplaces retain five-minute defaults; a legacy minute-step `CRON_EXPR` such as `*/3 * * * *` overrides that cadence. There are at most two leased collection targets across cooperating processes, bounded HTTP requests, one-second per-host pacing reserved in SQLite, and persistent host/source cooldowns respecting Retry-After. Run leases are renewed on requests and expire after 30 minutes. A crashed run remains inspectable and is marked interrupted when its source lease is reclaimed. Partial inventories retain their observed jobs; they cannot establish a baseline or mark jobs missing.

New employer/feed sources baseline silently until a complete enumeration succeeds. Subsequent new source-qualified IDs can queue alerts; edits never resend. Failed detail fetches preserve rich fields. Full-board omission records `missingFromSourceAt`, never closure. Rolling-feed omissions do not mean disappearance or closure. Publication, update, discovery, and sighting timestamps are separate. Greenhouse `updated_at` is update-only; Ashby publication can represent republication. Source raw fields are retained as quality evidence; normalized missing values stay unknown. Legacy records have an immutable imported snapshot; Nafezly's historical discovery/publication ambiguity is flagged without changing imported values.

Jobs are keyed by collection ID plus external ID, allowing distinct tenants to reuse IDs. Registry targets deduplicate provider/host/tenant and retain entity relationships. Exact shared application URLs (falling back to listing URLs) suppress duplicate alerts while retaining separate corpus records. Reposted jobs with a new ID retain a new record; a previously alerted identical application URL suppresses its alert. URL variants are not guessed equivalent.

Each bounded batch commits job writes, versions, sightings and queue entries in one transaction. A final transaction records run completeness, missing sightings and the baseline; a crash during persistence leaves the run incomplete and retains already committed evidence. Content changes create immutable versions, including a return to earlier content. Queue leases reserve deliveries, retain attempts and terminal failures, and reclaim expired reservations. Telegram can accept a message just before the process crashes; retrying that queue entry can duplicate delivery. No exactly-once delivery guarantee is possible with Telegram's send API.

The tracked `data/source-registry.json` is the runtime registry. Production never reads `reports/` or `tmp/`. Every report entity and platform assessment has a disposition; evidence and unresolved reasons remain attached. Run `pnpm exec tsx scripts/verify-registry.ts --pending` to attempt bounded public verification of pending ATS candidates. This updates only the tracked registry; no Telegram or browser session is involved. Check resulting evidence before committing. Research originals remain unchanged. Browser-dependent sites now have opt-in collectors; see WEBSITES.md for implementation and live-verification status.

Feed restrictions and source attribution:

- [Himalayas documentation](https://himalayas.app/docs/remote-jobs-api): daily refresh, cursor pagination, retain Himalayas attribution and listing links.
- [Remotive terms](https://github.com/remotive-com/remote-jobs-api): at most four requests daily; retain Remotive attribution and links; no third-party job-site submission or signup/email gate. The public feed is delayed by 24 hours.
- [Remote OK API notice](https://remoteok.com/api): retain Remote OK attribution and original links. Its metadata notice is not a job.
- [WWR RSS documentation](https://weworkremotely.com/remote-job-rss-feed): use the all-jobs RSS feed and retain source links.

Exports support private local analysis. No public redistribution or commercial resale feature is provided. ATS code licensing and RTJobs owner permission do not establish employer/website-content rights. See THIRD_PARTY_NOTICES.md for provenance and OpenIntern's Apache-2.0 license.

Verification: `pnpm test`, `pnpm run typecheck`, `pnpm exec prisma validate`. New integration tests create an isolated SQLite database and mock delivery; they never send Telegram messages. Public smoke checks must use an isolated database and omit `--notify`. `scripts/smoke-himalayas.ts` checks two pages only, not a full inventory.

This machine now runs the enabled user service `freelancebot.service`. See [rollout details and monitoring commands](ROLLOUT.md). A reusable unit template is in `deploy/freelancebot.service.example`; fill in absolute paths before installing it on another machine.

Persistent rotated diagnostic logs are enabled; see [log locations, retention, and search commands](LOGGING.md).


Website collectors for Indeed, LinkedIn, WUZZUF, Forasna, Bayt, and Wellfound are implemented as opt-in sources. See [WEBSITES.md](WEBSITES.md) for browser installation, session setup, live-verification status, and search coverage limits. Website inventories are rolling search scopes; omissions never mark jobs missing.

Fallback detail status is persisted. New fallback jobs discovered after an employer/feed baseline (or in a marketplace) can be reevaluated once when their details recover. Initial baseline jobs and ordinary edits stay silent. Existing records are not bulk-enrolled for retroactive alerts. To explicitly reevaluate a particular unsent, unqueued record on its next successful detail collection: `pnpm alerts:recover --id JOB_POST_ID`. Source baseline and duplicate-URL checks still apply.

Expired exhausted queue claims are marked failed during delivery and status inspection. Failed queue IDs appear in `sources:status`; retry one deliberately with `pnpm queue:retry --id QUEUE_ID`. This resets attempts without sending immediately. Delivery leases renew during long Telegram Retry-After waits. Retrying an uncertain delivery can duplicate a message already accepted by Telegram before a crash.
