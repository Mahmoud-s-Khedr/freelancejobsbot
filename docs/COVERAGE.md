# Collection coverage — 2026-10-06

All 575 report entities have a tracked disposition, as do all 72 platform assessment rows (47 catalogue entries, two historical extras, 23 reference ATS routes). Registry validation checks unique target IDs, entity relationships, pending reasons, and evidence on enabled ATS targets.

61 employer targets are enabled after public employer HTML confirmed a tenant-qualified ATS link and the API returned validated job records. 514 report entities remain pending for association, payload, unsupported-provider, or discovery work. 14 additional ATS candidate targets remain pending; a marketing HTTP 200, inferred token, or unvalidated vacancy is insufficient activation evidence. Shared-board relationships and distinct entity identities are retained.

| Enabled provider | Targets |
| --- | ---: |
| ashby | 31 |
| greenhouse | 21 |
| lever | 9 |
| himalayas | 1 |
| remotive | 1 |
| remoteok | 1 |
| wwr | 1 |
| mostaql | 1 |
| khamsat | 1 |
| ureed | 1 |
| nafezly | 1 |

69 targets are enabled in total: 61 employer boards, four public feeds, and four existing marketplaces. These are integration coverage counts, not a promise that every polling run succeeds. Empty or blocked public checks do not establish closure. Klaviyo remains pending because the checked board returned no job sample for field validation.

Verification passed: 45 tests, TypeScript checks, Prisma schema validation, registry checks, and migration status on an isolated database. Applying the migration to an isolated backup of the existing database preserved all 660 jobs' original fields exactly; queue relationships and foreign keys were preserved. Production database was not migrated.

Bounded public smoke checks validated Greenhouse (12 records), Ashby (67), Lever (79), Remotive (17), Remote OK (99), and WWR (89). Notification delivery was disabled, and initial baselines queued zero alerts. Himalayas validated two cursor pages of 20 jobs each; this was a bounded pagination check, not a complete historical/full-board inventory. Collection-only current JSONL and history CSV exports and source-status inspection were exercised on an isolated database without Telegram credentials. Concurrent queue delivery, retry exhaustion, interrupted lease/batch recovery, edits/reposts, partial runs, and geographic exclusions were verified offline with mocked delivery.

Pending ATS targets and reasons:

| Target | Reason |
| --- | --- |
| lever:api.lever.co:whereby | Error: Employer association not confirmed by public HTML |
| greenhouse:boards-api.greenhouse.io:wizeline | TypeError: fetch failed |
| greenhouse:boards-api.greenhouse.io:circleci | Error: Employer association not confirmed by public HTML |
| greenhouse:superhuman.com:grammarly | Error: Employer association not confirmed by public HTML |
| greenhouse:boards-api.greenhouse.io:klaviyojobs | Error: Payload not verified:  / 0 jobs |
| lever:api.lever.co:livechatinc | Error: Employer association not confirmed by public HTML |
| greenhouse:boards-api.greenhouse.io:pinterest | Error: Employer association not confirmed by public HTML |
| ashby:api.ashbyhq.com:plaid | Error: Employer association not confirmed by public HTML |
| ashby:api.ashbyhq.com:98cd1a00-2706-4aa8-ab72-38a7b8c9c20c | Error: Employer association not confirmed by public HTML |
| lever:api.lever.co:spotify | Error: Employer association not confirmed by public HTML |
| ashby:api.ashbyhq.com:temporal | Error: Employer association not confirmed by public HTML |
| ashby:api.ashbyhq.com:triggerdev | Error: Employer association not confirmed by public HTML |
| lever:api.lever.co:toptal | Error: Employer association not confirmed by public HTML |
| ashby:api.ashbyhq.com:workos | Error: Employer association not confirmed by public HTML |

Production rollout was started on 2026-10-06 after backing up and migrating the real database. See [the rollout record](ROLLOUT.md) for the operational status; the smoke counts above describe the earlier isolated verification.


## Website expansion — 2026-10-07

Six additional opt-in targets are implemented, bringing the tracked target count to 89; the original 69 enabled targets are unchanged. Indeed and WUZZUF reuse RTJobs extraction approaches; LinkedIn supports public guest cards and authenticated detail panels. Forasna, Bayt, and Wellfound follow actual job links and structured job data.

Bounded checks with isolated databases and no notification delivery validated Indeed (15 listings, 10 full details), WUZZUF (15 rich records, with an intentional one-page cap reported incomplete), and Forasna (20 discoveries, one full detail under an intentional detail cap). Public LinkedIn HTML yielded 60 guest cards, but Chromium collection returned HTTP 999; authenticated collection needs session setup and remains unverified. Bayt and Wellfound search pages returned HTTP 200 while the sampled detail requests returned 403; these collectors remain provisional.

These checks do not establish exhaustive pagination, stable access, or historical completeness. New sources remain opt-in. See WEBSITES.md for commands and scope semantics.
