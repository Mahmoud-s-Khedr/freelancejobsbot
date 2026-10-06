# Production rollout — 2026-10-06

The real database is `/home/mk/Projects/CV_projects/freelancebot/dev.db`. Before migration, its 660 jobs and empty Telegram queue were backed up using SQLite's online backup API to:

`/home/mk/.local/state/freelancebot/backups/dev-2026-10-06T11-00-31.788Z.db`

The production migration was applied successfully. All original job fields were compared against the backup before marketplace refreshes began; all 660 were preserved and foreign-key validation passed.

Remotive and We Work Remotely completed their initial silent baselines. Full employer/feed collection then completed baselines for all 61 enabled ATS boards and Remote OK, bringing the initial complete source count to 64. Ureed subsequently completed its collection, bringing the count to 65.

Himalayas advertised approximately 118000 jobs, so its initial full cursor walk continues in the background. It persists 200-job batches with sightings under one leased run; memory usage stays bounded and an interrupted walk retains committed evidence. Its baseline remains unset until the final cursor is reached. No initial Himalayas alerts are sent. The initial collector was deliberately stopped to install streaming persistence; its interrupted runs were recorded and their leases reclaimed after confirming the process had stopped.

Mostaql encountered HTTP 500 responses, Khamsat a transport failure, and Nafezly HTTP 429. Observed jobs are retained, incomplete runs are reported, and persistent cooldowns remain effective. No access challenge is bypassed. These sources are retried by the normal scheduler when due and permitted.

Telegram bot validity and access to the configured chat were checked without printing credentials. Live marketplace job delivery has succeeded. Pending messages are delivered at the configured rate, with retry/failure and lease tracking. An in-flight message interrupted by a restart retains its queue lease until expiry; Telegram's documented crash-window duplicate risk still applies.

The enabled persistent user unit is:

`/home/mk/.config/systemd/user/freelancebot.service`

It starts `node --import tsx src/collection/cli.ts schedule --notify`, uses the absolute production database URL, reads the existing `.env` through dotenv, and restarts on process failure. User lingering was already enabled. No credential is embedded in the service unit. The transient `freelancebot-baseline-recovery.service` is doing the initial Himalayas walk; both processes share a SQLite-enforced limit of two active collection targets. If that walk fails or is interrupted, the scheduled collector retries it under the normal lease, interval, and cooldown rules.

Monitoring and controls:

```sh
systemctl --user status freelancebot.service
journalctl --user -u freelancebot.service -f
journalctl --user -u freelancebot-baseline-recovery.service -f
DATABASE_URL=file:/home/mk/Projects/CV_projects/freelancebot/dev.db pnpm --silent sources:status
```

`systemctl --user stop freelancebot.service` stops scheduled collection and delivery; it does not stop the initial Himalayas walk. To stop both, also stop `freelancebot-baseline-recovery.service`. Resume scheduled work with `systemctl --user start freelancebot.service`. Stop the collector before making later database changes; preserve backups rather than replacing a running database.

The rollout also corrected two inspected matching cases: an explicit South Africa country restriction excludes Egypt, and incidental software/tool mentions in nontechnical descriptions do not trigger new employer/feed tech alerts. Marketplace preferences remain unchanged.

Verification after the rollout changes: 42 tests passed, including bounded streaming and global source-lease concurrency, along with TypeScript checks. Himalayas full-baseline completion is ongoing, not claimed as verified here. This document records the initial rollout; source status and journals show the current live state.

Subsequent logging setup archived the journals and recorded that the first Himalayas walk ended incomplete after 8120 observations because of a SQLite operation timeout. Stored observations are retained; full-baseline completion remains unverified. See [persistent logs](LOGGING.md) for this evidence.
