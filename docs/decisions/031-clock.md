# 031: The Clock (no code reads the wall clock directly)

Status: accepted, 2026-11-01 (user request before Phase 3, brief `docs/briefs/P2.8-clock.md`). Applies to every module and to
every later feature.

**Decision.**
- `src/common/clock.ts` holds the one `Clock` interface (`now(): Date`, `nowMs(): number`), the real `SystemClock` and the DI
  token `CLOCK`. `ClockModule` (global, imported by `AppModule` and `WorkerModule`) provides them. The same file holds the
  `Timers` interface (`setTimeout`, `clearTimeout`), the real `systemTimers` and the token `TIMERS`, for the waits that code
  schedules itself (a reconnect, a scheduler retry, a health deadline).
- **Every decision that depends on the time of day asks the injected `Clock`.** That is: session absolute and idle expiry and
  the last-seen throttle, pending sign-in lifetimes, token expiry (invite, reset, verify, link, capability, API key), TOTP
  checks (the epoch is passed in), IP rule expiry, maintenance retry hints, webhook timestamp windows, cache freshness
  (`freshUntil`), version counters, in-memory memo ages, "last used" and "last hit" times, job-run start, end and duration,
  outbox creation, lag and retry waits, the date a presigned link is signed with, and any holds, SLA ages, invoice due dates and
  accruals the Phase 3 features add.
- **SQL that decides takes the clock's time as a parameter** (`expires_at > $now`, `started_at < $now - $age`), never `now()`.
  Rows that carry a time a rule later reads (`job_runs.started_at`, `outbox_events.created_at` and `updated_at`) are written
  from the clock too, so both sides of every comparison are on one clock.
- **Allowed to stay on another clock:**
  - Column defaults (`created_at default now()`, `updated_at` refreshed by Drizzle's `$onUpdate`): bookkeeping that no rule
    reads. The single `new Date()` in `src/infra/db/columns.ts` carries an `eslint-disable` with this reason.
  - Elapsed-time measurements for metrics, logs and local deadlines (`performance.now()`): request and call durations, the
    log throttle, the cache lock wait, the short-memo default, the share window of the Redis memory gauges. They are monotonic
    on purpose (a stepped system clock cannot shorten or stretch them).
  - Timers (`setTimeout`, `node:timers/promises`) used for deadlines and retries: they wait in real time by nature. The ones
    whose wait a test would otherwise sit through go through `Timers` (PgListener and the outbox listener, the job scheduler
    retry, the health deadline); `withTimeout`, `sleep` and the cache lock poll stay real (their tests are about the timer).
  - Clocks owned by an external system: Redis TTLs, `rate-limiter-flexible` windows and the semaphore's `TIME`, BullMQ delays,
    backoff and cron `next`, MinIO's expiry check and `Last-Modified`, the AWS SDK's own request signing. The code sets the TTL,
    window, delay or option; tests assert what was set (PTTL, job options, `X-Amz-Expires`) and never wait for the system.
  - Scripts under `scripts/` (the demo seed takes a `now` option; the one-off tools are not part of the running service).
- **Lint rule `no-restricted-syntax`** (`scripts/eslint/structural-rules.mjs`, tested in `test/lint/lint-rules.test.mjs`):
  `Date.now()` (also as a reference) and `new Date()` without arguments are errors under `src/` except in
  `src/common/clock.ts`. `new Date(x)` (a conversion), `Date.parse` and `performance.now()` are not flagged. Unit specs under
  `src/` are covered too: they use `TestClock`.

**Tests.** `test/support/clock.ts` has `TestClock` (`set`, `advance`, `reset`; frozen until moved, starting at the real time of
its creation unless given a date) and `ManualTimers` (fake `setTimeout`/`clearTimeout`; `advance` fires what falls due and can
move a `TestClock` along). `createTestApp({ clock, timers })` and `createInfra({ clock, timers })` install them; the default is
the real clock and timers. A test that needs time to pass calls `clock.advance(...)`; it never sleeps, never writes a time into
a row to fake age (the row is created through the service and the clock moves), and never uses a margin that a loaded or
stepped machine can break. Call `clock.reset()` in `beforeEach` of a file that moves the clock far, because cache entries and
rows outlive it on the shared test instances. The one polling primitive is `eventually` (condition polling for work owned by
something outside the process; its deadline is monotonic). Child-process tests and the Docker restart test keep real time,
with a one-line reason at the wait.

**Consequences.** Two processes now compare times from their own clocks where one database clock used to be the judge (an outbox row written by the API and relayed by the worker; a job run started by the API and closed by the worker). With NTP the skew is milliseconds; lag and duration values are clamped at zero, and a wait such as the outbox retry is exact on one process. A host whose clock is far off is an operations problem (time sync), not something the code hides. A memo that keeps a value by the clock (`ShortMemo`) loads again when the clock was stepped back.

Time-dependent behaviour is covered at its exact edges (the last millisecond of a token's hour, the minute of
the touch throttle, the second of a retry wait) in milliseconds of test time. Production code gains one constructor parameter
per service that decides on time. New features inject `@Inject(CLOCK) private readonly clock: Clock`, pass `clock.now()` into
repositories, and never import `Date.now`. A feature that needs a new external-time assertion documents it in its README.

**Review notes (lead).** `IpRuleCache` and `MaintenanceService` give their short memo the Clock (wall time); the memo
reloads early when the clock steps back, so a step can only cause an extra reload. Presigned storage links pass the
Clock as `signingDate`, so the AWS SDK's own clock-skew correction does not apply (no effect with MinIO). Outbox lag is
the difference of two process clocks and can be negative in the row; the metric clamps it at 0.
