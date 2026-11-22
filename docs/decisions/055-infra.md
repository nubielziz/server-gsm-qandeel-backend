# 055: Infrastructure: trust inside the stack, least privilege and recovery

Status: accepted, 2026-11-22 (feature 45a: inside the application). The production stack part follows with feature 45b. Builds on decisions
006, 007, 013, 019, 020, 022, 027, 036 and 044.

**Context.** Inside the application the cached sessions, API keys, roles, IP rules, settings and maintenance state were used as stored,
whatever wrote them into the cache Redis, and a stale entry could be served for as long as Redis kept its key. A failed cache delete after
a security change was only logged. Postgres had no time limits on statements, lock waits or idle transactions. Work whose queue job was
lost (storefront refunds, merchant webhook deliveries, bulk publish and Quick add runs) stayed waiting, handed-over outbox rows were kept
for ever, and failed jobs had no count limit in the queue Redis.

**Decision: inside the application.**
- **Sealed cache entries.** Every entry the cache service writes is `c1:<kind>:<freshUntil>:<seal>:<JSON>`: an HMAC-SHA256 over its
  format version, its key, its kind, its freshness time and its value, made with a key derived from `TOKEN_PEPPER` with HKDF-SHA256
  (salt `gsm-cache-entry-mac`, info `cache entry seal v1`), so the seal key never equals a value the application writes into a key
  name. The seal is checked before the value is parsed; an entry without a valid seal is a miss and is replaced
  (`cache_errors_total{operation="mac"}`, logged at error level: it means tampering or a `TOKEN_PEPPER` that differs between processes).
  A stale entry is served only inside the stale window of the reader, counted from the entry's freshness time.
- **Credential binding.** The session and API key lookups also check, in constant time, that the cached view belongs to the credential
  presented; one that does not is refused (401), deleted, and logged as a warning.
- **Invalidations that follow a security change** (sessions, API keys, role permissions, IP rules, settings, maintenance state) go through
  `CacheService.invalidate`: three tries (waits of 50 ms and 250 ms); when every try fails they are counted
  (`operation="invalidate"`) and logged as an error without the keys. They never fail the change that was committed; the entries' short
  lifetimes bound what remains. The "touch" deletes that refresh a last-seen time keep `del`.
- **Database time limits per process**, sent as session settings of the pool: statement 15 s, lock 5 s and idle in transaction 60 s by
  default (`DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_LOCK_TIMEOUT_MS`, `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`; 0 means none; none
  under `NODE_ENV=test`, where the limit tests set their own). The production worker has 300 s and 30 s for statements and locks and keeps
  the 60 s idle-in-transaction limit: a job that holds a transaction open while it waits for something else (a receipt stores its file
  while the invoice row is locked) has its transaction ended after 60 s and is retried by its queue. A report that reads a whole period in
  one snapshot raises its own statement limit to 120 s in its transaction; the raise never lowers a longer or absent limit. Migrations
  and the first-run setup use pools without limits. A time limit, or a session Postgres ended, answers `503 UNAVAILABLE` at warn level;
  every pool client has an error listener, so a session that ends while a transaction holds it fails that transaction and never the
  process.
- **Lost work is asked for again.** A job every 5 minutes (`lost_work_reconcile`, queue `maintenance`) runs passes the owning modules
  register: storefront refunds waiting for their gateway call, merchant webhook deliveries, bulk publish runs (preparation, apply, switch)
  and Quick add runs. A row that waits, whose newest request is older than 10 minutes and has no live job (not handed over yet, or a job
  that waits, runs or is delayed), gets a new outbox request marked `reconcile: true`, written under the row's lock after the same check
  is made again; a request type no route names in the process, or a queue Redis that does not answer, decides nothing. At most three times;
  then refunds are failed with a note (as a failure whose outcome is unknown, so the gateway key is kept and the console's retry applies),
  also once the current send started more than 20 hours ago, and runs are left to their stalled state, which staff resume. Webhook
  deliveries get their own job id again. The Quick add hand-over to the bulk publish keeps its manual way.
- **Retention.** Handed-over outbox rows are deleted after 45 days (`outbox_purge`, daily at 04:50 UTC, 5 000 rows per statement, at most
  20 statements a run, never a pending row): longer than every reader of handed-over rows looks back (the price change scan 30 days, the
  notification reconcile 48 hours). Failed jobs are kept 14 days and at most 10 000 per queue.

**Decision: the production stack.** Follows with feature 45b (networks, Redis passwords, fixed proxy addresses, container hardening, the
application's own database role, object storage users and the files host, backups, configuration guards, edge timeouts).

**Consequences.** A change of `TOKEN_PEPPER` also empties the cache (every entry becomes a miss), and the first start of this release reads
every entry of the previous one as unreadable once. A cache Redis that hangs adds up to about 6 s to the answer of a security write (the
invalidation is awaited after the commit: three tries of up to 2 s each). A report that needs more than two minutes per statement must
be split. Work lost with the queue Redis comes back within about 15 minutes, except mails whose own job had not run, merchant webhook events
whose fan-out job had not run (no delivery was created, so nothing re-arms it), event notifications whose planning job had not run (no
notification row exists), a waiting price change scan, the Quick add hand-over and the failed-job list. Cache uses that stay unsealed:
rate-limit counters, stampede locks, version counters, replay marks, the real-time doorbell and the health "last snapshot" copy. Not done
here: a statement limit per route, a durable (outbox) invalidation, a cross-check of cached views against Postgres on every request.
