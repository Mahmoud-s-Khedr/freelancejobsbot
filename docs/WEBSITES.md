# Website collectors

Indeed, LinkedIn, and WUZZUF use extraction approaches adapted from [RTJobs](https://github.com/Mahmoud-s-Khedr/RTJobs/tree/b2c3da9ea7bb763472f66f273b264d4222ec0208). Forasna, Bayt, and Wellfound use observed job links and Schema.org `JobPosting` data. These sources are opt-in; implementation and successful live collection are separate statuses in the registry.

## Setup

Use Node 22 or newer and the pinned pnpm version in package.json:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
DATABASE_URL=file:/absolute/path/jobs.db pnpm db:deploy
pnpm exec playwright install chromium
```

On a Linux machine missing browser libraries, install them with `pnpm exec playwright install-deps chromium`. An existing Chrome executable can be selected with `BROWSER_EXECUTABLE_PATH`. Browser traffic uses inherited HTTPS_PROXY/HTTP_PROXY settings when present; TLS verification remains enabled.

Copy `.env.example` to `.env`, set the database path, configure the desired search URL, and enable that source. Then collect without delivery:

```sh
INDEED_ENABLED=true pnpm collect --source indeed
LINKEDIN_ENABLED=true pnpm collect --source linkedin
WUZZUF_ENABLED=true pnpm collect --source wuzzuf
FORASNA_ENABLED=true pnpm collect --source forasna
BAYT_ENABLED=true pnpm collect --source bayt
WELLFOUND_ENABLED=true pnpm collect --source wellfound
```

Public pages are used when available. LinkedIn additionally supports authenticated detail panels. If a page requires login or a challenge, establish a session on a machine with a desktop or DISPLAY:

```sh
pnpm browser:session --source linkedin
# Also available for indeed, wuzzuf, forasna, bayt, wellfound.
```

Complete login/checkpoints manually in the visible browser. Session setup verifies a provider-specific ready page and exits, or times out after ten minutes. The collector does not require or store your password in configuration. Reuse the same profile directory for session setup and collection. Profiles default to `.local/browser-profiles/SOURCE`; override with `SOURCE_PROFILE_DIR`. A profile lock prevents concurrent use, including interactive session setup. Do not share a profile across machines.

`pnpm dev` schedules enabled sources and Telegram delivery. Set Telegram credentials before using it. New employment sources baseline silently. Subsequent eligible discoveries can queue alerts; collection without `--notify` does not deliver them.

## Coverage

| Source | Extraction | Scope and limitations |
| --- | --- | --- |
| Indeed | Embedded card JSON; embedded detail JSON; JobPosting fallback | First configured search page only. Defaults to ten detail fetches per run. Incomplete/new details are prioritized before refreshes on subsequent runs. |
| LinkedIn guest | Public cards and canonical detail pages | First public search page only. Stable job IDs; tracking parameters discarded. Day-level dates remain labelled as source publication dates. |
| LinkedIn authenticated | Cards and matching hydrated detail panels | At most four pages by default, offsets of 25. A mismatched/unhydrated detail becomes fallback. Relative publication dates are labelled estimates. Requires a persistent authenticated session. |
| WUZZUF | Embedded job state and card metadata | Page-index pagination; default cap of twenty pages. Description and requirements retained. Offset-free source-local timestamps are retained as evidence, not guessed as UTC. |
| Forasna | JobPosting metadata, description and labelled requirements | Actual `/job/p/` links; structured requirements fill missing descriptions. Follows observed next links. |
| Bayt | JobPosting on linked job details | Actual numeric-ID job URLs; follows observed next links. Access can be blocked. |
| Wellfound | JobPosting on linked job details | Actual `/jobs/ID-slug` links; follows observed next links. Access can be blocked. |

All scopes are rolling searches, not exhaustive employer boards. Indeed and LinkedIn guest `complete` means the declared first-page inventory was parsed; detail errors remain recorded separately in the run's errors. It does not mean all descriptions were retrieved or all jobs on the website were covered. Authenticated LinkedIn, WUZZUF, and other multi-page traversal caps are incomplete. No search omission marks a job closed or missing.

A redesigned page, missing inventory, login, challenge, repeated page, or HTTP error is recorded as a collection error. Successful pages remain persisted when later pages fail. Failed details preserve previously stored rich content. Website records use the existing transactional history and alert pipeline; known IDs are refreshed, rather than permanently skipped.

Controls: `SOURCE_SEARCH_URL`, `SOURCE_MAX_PAGES`, `SOURCE_MAX_DETAILS`, `BROWSER_TIMEOUT_MS` (default 30000), `BROWSER_HEADLESS` (default true). Page caps range from 1–100, detail caps from 1–1000. Indeed supports exactly one search page. Runtime selectors are in `data/selectors/`. Browser requests share SQLite host pacing/cooldowns and source leases with HTTP collection; active browser leases renew every minute.

Private diagnostic snapshots retain twenty files per source under `.local/browser-snapshots`. Forms, scripts, attributes, and configured secrets are removed. Remaining page text can still contain personal information; keep the directory private. Browser profiles and snapshots are gitignored.

## Verification

Tests use reduced RTJobs captures for Indeed and WUZZUF, public LinkedIn guest cards, and synthetic fixtures for structured routes and authenticated LinkedIn panels. Fixtures exclude authentication/tracking fields. No test sends Telegram messages.

```sh
pnpm test
pnpm run typecheck
pnpm exec prisma validate
pnpm exec tsx scripts/validate-registry.ts
```

Live checks on 2026-10-07 used an isolated database and disabled notifications. See the current verification entries in `data/source-registry.json`; a successful public search fetch does not establish authenticated access, full pagination, or complete historical coverage. Bayt and Wellfound remain provisional until real detail extraction is verified. Their blocked detail checks do not establish closure.
