# Persistent debug logs

The enabled `freelancebot-logs.service` saves the scheduler and both initial-baseline units' journal output to:

`/home/mk/.local/state/freelancebot/logs/`

Records are JSONL and include UTC timestamps, systemd unit, process ID, and the original event/message. New collector events include collection run IDs, source IDs, completeness, counts, and elapsed time. HTTP events include request IDs, URL, method, response status, Retry-After, duration, and failure stacks with underlying connection causes. Telegram events include queue/job IDs, attempt number, success, and whether a failure is terminal. Message bodies and request bodies are not added to debug events.

Existing journal output from today was backfilled, including the uninterrupted logging of the earlier Himalayas collector. Its crawl was not restarted for logging. The journal cursor is saved after each appended record, so restarting the log collector resumes from its last archived position. A crash between append and cursor save can repeat the last record; it does not intentionally skip records. Capture errors remain visible in its own systemd journal and trigger service restart.

Files are named `freelancebot-YYYY-MM-DD-NNNNNN.jsonl`. They rotate at midnight UTC or before a new record would exceed 10 MiB; an individual oversized record is retained. The latest 30 files are kept (about 300 MiB maximum for ordinary records), not an unlimited history. The directory is created with user-only access and new files with mode 0600. Configured tokens/secrets/passwords and Telegram chat ID, Telegram bot URLs, and bearer tokens are redacted. Logs contain job URLs and diagnostic metadata, so keep them private when sharing a debug excerpt.

```sh
ls -lh ~/.local/state/freelancebot/logs/
tail -f ~/.local/state/freelancebot/logs/$(ls ~/.local/state/freelancebot/logs/ | sort | grep '\.jsonl$' | tail -1)
systemctl --user status freelancebot-logs.service
journalctl --user -u freelancebot-logs.service -n 30
```

To search all retained files:

```sh
rg 'http_request_failed|telegram_delivery_failed|fatal_error' ~/.local/state/freelancebot/logs/*.jsonl
rg 'himalayas|Operation has timed out' ~/.local/state/freelancebot/logs/*.jsonl
```

Rotation settings are `LOG_DIR`, `LOG_MAX_BYTES` (default 10485760), and `LOG_MAX_FILES` (default 30) in the logger's user unit. Change the unit, run `systemctl --user daemon-reload`, and restart only `freelancebot-logs.service`. This does not interrupt collection or Telegram delivery. The collector unit wants the logger unit, and both are enabled for login/boot with the existing user lingering configuration. Templates are in `deploy/`.

Saved logs already exposed a local SQLite operation timeout that ended the first Himalayas walk after 8120 observations. Its committed jobs remain stored, its run is incomplete, and no baseline was established. This is available for debugging in the archived log; the scheduled collector follows its normal polling interval and cooldown before retrying. Collection run records in SQLite remain an additional diagnostic source.

Verification covers rotation/retention, restarting an existing file series, cursor persistence, user-only file permissions, credential redaction, and retaining nested error causes. Captured production records were parsed as JSON and checked for the configured bot token without exposing it.
