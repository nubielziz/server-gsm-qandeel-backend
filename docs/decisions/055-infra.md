# 055: Infrastructure: trust inside the stack, least privilege and recovery

Status: accepted (feature 45a: inside the application; feature 45b: the production stack; both accepted 2026-11-22). Builds on decisions
006, 007, 013, 019, 020, 022, 027, 036, 044 and 054.

**Context.** Inside the application the cached sessions, API keys, roles, IP rules, settings and maintenance state were used as stored,
whatever wrote them into the cache Redis, and a stale entry could be served for as long as Redis kept its key. A failed cache delete after
a security change was only logged. Postgres had no time limits on statements, lock waits or idle transactions. Work whose queue job was
lost (storefront refunds, merchant webhook deliveries, bulk publish and Quick add runs) stayed waiting, handed-over outbox rows were kept
for ever, and failed jobs had no count limit in the queue Redis.

Before this decision every container of the production stack shared one network, both Redis instances accepted any client
on it, the API took the client address from any container of the subnet, the application connected to Postgres as the owner of every
table, the object store had one identity (its administrator) and its file links were signed for an address only the containers resolve,
and the offsite copy of the files was stored as it was. A process without `NODE_ENV` ran as development against whatever database its
settings named, and production accepted the template's placeholder values and short secrets.

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

## Part B: the production stack

**Decision: the production stack.**
- **Networks.** `edge` (Caddy, the API, the console, the site), `data` (internal: API, worker, migrate, backup, Postgres, both Redis,
  MinIO, Typesense), `files` (internal: Caddy and MinIO), `monitoring` (internal: Prometheus, API, worker) and `egress` (worker and
  backup, which call the internet). Every network has an explicit subnet that differs from the one the single network used, so the
  new networks can be created while the old one still exists on the host.
- **Client address.** Caddy (`172.30.1.2`) and the site (`172.30.1.3`) have fixed addresses on `edge`, and every other container gets
  an address from the upper half of the subnet. `TRUST_PROXY` names exactly those two addresses. Production requires the setting (an
  explicit `false` states a stack without a proxy) and warns at boot when it holds a range or a hop count.
- **Passwords.** Both Redis instances require one, in the URLs as well; their health checks accept an answer that asks for the
  password, which proves the server is up. The password is on the command line of the Redis process, which a user of the host can read,
  like the deploy files it comes from. Production refuses the templates' `CHANGE_ME` values in any variable, secrets shorter than their
  minimum, passwords under 16 characters for services on another machine, the development values of the database, both Redis URLs, the
  S3 key pair and the mail URL, and argon2 below the OWASP minimum (decision 007). The credentials in `MAIL_SMTP_URL` have no length rule
  (the provider issues them).
- **Containers.** No service gains privileges through a setuid program; logs and process counts are bounded; the images that run as an
  unprivileged user drop every Linux capability, Caddy keeps the one that binds ports 80 and 443, and the services that only answer on
  the internal networks (Postgres, both Redis, MinIO, the search engine and the console) drop raw sockets (`NET_RAW`) and keep their
  other defaults. The queue Redis has a memory bound
  and still evicts nothing: a full instance refuses new jobs and the outbox keeps the work in Postgres. The search engine's admin key
  comes from the container's environment, not its command line.
- **Database roles.** The API and the worker connect with the application's own role, which is neither a superuser, nor an owner of a
  table or of the database, nor a role that reads or writes files or runs programs on the database server (`pg_read_server_files`,
  `pg_write_server_files`, `pg_execute_server_program`), nor a member of any of these in any way: a membership that inherits nothing
  still lets the member switch to the role, so the check asks about membership, not only about inheritance. The process refuses to start
  in production otherwise, each refusal naming the setting (`DATABASE_URL`) and the rule it breaks, never a role name or a value; a
  start whose check cannot be made stops too, like the check of the lookup key (decision 054). Both root modules import the check, and a
  test fails when either loses it. A grants step that `db:migrate` and `setup` run after the migrations creates the role and gives it
  what the code needs: no `UPDATE` or `DELETE` on the ledger, the order events and the audit log, no `TRUNCATE`, no trigger changes, no
  new objects. The step sends the role's password as a SCRAM-SHA-256 verifier computed in the process (PBKDF2-HMAC-SHA-256, 4096 rounds,
  a random 16-byte salt), never the password itself, so a statement that fails cannot write the password into the server's log; the
  password is therefore printable ASCII, which is also what the driver signs in with. The whole step runs under one transaction-level
  advisory lock with its own key, so two runs at once wait for each other. Migrations, setup and the backups use the owner role, whose
  address only the migrate service and the backup service receive. The development and test databases keep one role (decision 014): the
  step sees one role and does nothing there.
- **Object storage.** The application has its own MinIO user limited to its bucket, and the backups have a read-only one; the
  administrator account stays with the MinIO containers and the one-off `minio-admin` tool. File links are signed for a public files
  address (`S3_PUBLIC_ENDPOINT`) that Caddy serves with reads of single objects only, each with a signature, as attachments that can run
  nothing on that host. The path is what a stored object's name can be, the storage layer's own rule for a key (every segment starts with
  a letter or a digit), so a path with a `.` or `..` segment is not passed on. The bucket itself, a listing and every other method or
  path are a 404.
- **Backups.** The files copy is encrypted like the database dumps, object by object, and a failed read leaves no partial copy. A dump is
  made into a file, checked, copied to an incoming folder, checked again, and only then copied to the daily folder, so the daily folder
  holds complete dumps only. A listing of the offsite copy that fails stops the files copy with a non-zero exit instead of being read as an
  empty copy (which would encrypt and copy every object again); only a missing `files-age/` folder on the first run counts as empty. The nightly key writes and never deletes; retention, versioning and the object lock are rules of the
  offsite bucket (docs/OPERATIONS.md section 4), and `BACKUP_PRUNE=1` keeps the old pruning for a provider without them. A purge
  procedure with a separate key, kept off the server, removes the copies of erased files. The backup container receives only its own
  variables. The monthly restore drill restores as a temporary role that is not a superuser, and the restore script refuses a
  superuser target unless it is asked for explicitly.
- **Configuration.** A process without `NODE_ENV` is development and refuses a database that is not on this machine (its host, and any
  `host` or `hostaddr` parameter of the URL, must be local or a socket); a URL that names no host is not local by itself, because the
  driver then connects to `PGHOST`, which is judged the same way (unset or empty means this machine); the development seed refuses a
  remote database too. Production sends mail over TLS only (`smtps://`, or `smtp://` with STARTTLS required), accepts a plain-http
  object store only inside the stack (a host name of one label, or a loopback address; a dotted name, any other address and any IPv6
  literal that is not loopback need TLS), and warns when links would be signed for an address no browser can open. The argon2 floor is
  exactly the published OWASP pairs: 46 MiB with 1 pass, 19 MiB with 2, 12 MiB with 3, 9 MiB with 4 and 7 MiB with 5; a setting passes
  when some pair has both its memory and its passes at or below the setting's (a product of memory and passes is not equivalent).
- **Edge timeouts.** Caddy cuts a client that is slow to send its headers or that stalls an upload. Caddy has no per-address connection
  limit; the API's per-address limits stay, and the runbook names an optional host firewall rule.

**Consequences.** A change of `TOKEN_PEPPER` also empties the cache (every entry becomes a miss), and the first start of this release reads
every entry of the previous one as unreadable once. A cache Redis that hangs adds up to about 6 s to the answer of a security write (the
invalidation is awaited after the commit: three tries of up to 2 s each). A report that needs more than two minutes per statement must
be split. Work lost with the queue Redis comes back within about 15 minutes, except mails whose own job had not run, merchant webhook events
whose fan-out job had not run (no delivery was created, so nothing re-arms it), event notifications whose planning job had not run (no
notification row exists), a waiting price change scan, the Quick add hand-over and the failed-job list. Cache uses that stay unsealed:
rate-limit counters, stampede locks, version counters, replay marks, the real-time doorbell and the health "last snapshot" copy.

A deploy adds two Redis passwords, an application database password, two MinIO users (created once per volume by the
operator), a files host name and its DNS record, and the compose file refuses to run without them; `setup` runs in the migrate service.
The release has one outage, from the stop of the API and the worker (the data services move onto the new networks and the old API cannot
reach them) until the new API is healthy; the one-off `migrate` and `minio-admin` commands run with `--no-deps` so that none of them moves a
service early, and the backup of the release is taken before `.env.production` changes (docs/OPERATIONS.md section 3). The old network is
removed by hand after the first `up`. A restore of a dump that needs a superuser fails in the drill, which then
names the object. Erased files leave the offsite copy when the purge runs and the bucket's lifecycle rule expires the old versions.
What stays as it was: MinIO runs as root (its volume is root-owned and its image has no shell), Postgres, both Redis, the search
engine and the console keep their default capabilities except raw sockets, no file system is read-only, and the application role can still update
balances and insert postings (it needs both; a database rule for balances is a separate design).

Not done here: a statement limit per route, a durable (outbox) invalidation, a cross-check of cached views against Postgres on every
request, signing the database dumps, per-address connection caps at the edge, objects without a database row, storage and disk alerts, and a
bucket quota.
