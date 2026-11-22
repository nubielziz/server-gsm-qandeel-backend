# Operations: deploying and running GSM in production

For the person who runs the server. Decision 036 explains why it is built this way. **Read this first:** the compose file, the Caddyfile
and the backup scripts were checked by `docker compose config`, by parsing and by dry runs, and were never started end to end. Your
first deploy is the real test: follow section 2 in order and tick every check.

Every command below runs from the repository root, with these two shortcuts:

```bash
alias gsmc='docker compose -f deploy/compose.prod.yaml --env-file deploy/.env'
```

## 1. Hosts, DNS and what runs where

Three DNS names (A, and AAAA if you have IPv6) point at the server. Ports 80 and 443 (TCP and UDP) must be open: Caddy gets and renews the
certificates itself, and needs port 80 for that. Nothing else is published.

| Host (`deploy/.env`) | Serves | Sent to the API |
| --- | --- | --- |
| `SHOP_HOST` (`shop.example.com`) | the storefront and the merchant portal (container `site`) | `/client/*`, `/store/v1/*` |
| `ADMIN_HOST` (`admin.example.com`) | the admin console (container `console`, nginx) | `/admin/*`, `/health`, `/reference*`, `/store/v1/media/*` (the pictures the console shows) |
| `API_HOST` (`api.example.com`) | machine clients only | `/api/index.php` (Dhru), `/v1/*` (REST v1), `/webhooks/*`, `/docs*`; everything else is 404 |

Why this shape: the sessions' cookies belong to one host, so the browser must reach the API on the page's own host. `/metrics` is routed
on no host.

**Which pages the API trusts** (decision 045). Pages of `ADMIN_HOST` may call `/admin/*` and `/reference*`, pages of `SHOP_HOST` may call
`/client/*` and `/store/v1/*`, and no browser page may read the machine routes (`/v1/*`, `/api/index.php`, `/webhooks/*`, `/docs*`) or
`/health`. The two lists of origins come from `CONSOLE_BASE_URL` and from `STORE_BASE_URL` and `PORTAL_BASE_URL`. A list given in
`.env.production` is used as it is: it replaces the derived one, it does not add to it. So `CONSOLE_ORIGINS` must include the origin of
`CONSOLE_BASE_URL`, and `SHOP_ORIGINS` the origins of `STORE_BASE_URL` and `PORTAL_BASE_URL`; leave both unset unless another https
origin must be trusted. At boot the API and the worker log a configuration warning when a given list leaves out the origin of its own
page (sign-in from that page is refused) and when the two lists share an origin (a page of that origin is trusted on both the staff and
the shop surfaces; keep one origin per audience). Neither warning stops the start. `CORS_ORIGINS` is refused in production. The
session cookies are `SameSite=Lax`, which separates registrable domains, not hosts: a console host on another registrable domain than
the shop's is the strongest separation, and the configuration supports it. **Page headers:** Caddy adds to the console's and the shop's
pages (not to the API's answers, which carry their own) `Content-Security-Policy` with `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff` and a `Referrer-Policy`; HSTS is on every host. The script policies belong to the console and the
storefront.

| Service | What it is |
| --- | --- |
| `caddy` | the only published service: TLS, routing, the real client address in `X-Forwarded-For` |
| `api`, `worker` | the same image; the API serves HTTP, the worker runs the queues and the schedules |
| `migrate` | one-off: applies the pending migrations (profile `tools`) |
| `postgres` | the database (volume `pgdata`) |
| `redis-queue` | BullMQ only: append-only file, nothing evicted (volume `redis-queue-data`) |
| `redis-cache` | cache, rate limits and locks: 256 MB, least recently used evicted, nothing saved |
| `minio`, `minio-init` | the files bucket `gsm-files` (volume `minio-data`); to use an external S3 delete both and change the `S3_*` lines of `.env.production` |
| `prometheus` | metrics history for the System health pages (15 days) |
| `console` | the admin console bundle |
| `site` | the storefront (profile `site`: it is left out until the storefront ships its image; start with `gsmc --profile site up -d site`) |
| `backup` | backup tools, started by the host's timer (profile `tools`) |

## 2. First deploy

1. **Make the secrets** (keep them out of git and out of chat; two offline copies, section 5):

   ```bash
   cp deploy/.env.example deploy/.env
   cp .env.production.example .env.production
   mkdir -p deploy/secrets
   openssl rand -hex 32          # run once for each of CSRF_SECRET, TOKEN_PEPPER, LOOKUP_HASH_KEY, METRICS_TOKEN and, in deploy/.env, TYPESENSE_BOOTSTRAP_KEY, TYPESENSE_INDEXER_KEY, TYPESENSE_SEARCH_KEY
   echo "k1:$(openssl rand -base64 32)"   # the whole line is the value of ENCRYPTION_KEYS
   ```

   Fill `deploy/.env` (hosts, `ACME_EMAIL`, the Postgres and MinIO passwords: letters and digits only) and `.env.production` (every
   `CHANGE_ME`, every `example.com`). The same passwords appear in both files: `POSTGRES_PASSWORD` in `DATABASE_URL`, `MINIO_ROOT_USER`
   and `MINIO_ROOT_PASSWORD` in `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Write the metrics token for Prometheus with no newline,
   readable by it:

   ```bash
   printf '%s' "<the METRICS_TOKEN value>" > deploy/secrets/metrics_token && chmod 644 deploy/secrets/metrics_token
   ```

   The app refuses to start in production with a missing required value, a development secret, `COOKIE_SECURE=false`, an `http:` base URL or
   origin, or a `CORS_ORIGINS` line, and prints the full list.

2. **Build the images** (the console from the console repository, with the API on the same origin):

   ```bash
   sed -i "s/^GIT_SHA=.*/GIT_SHA=$(git rev-parse --short HEAD)/; s/^APP_VERSION=.*/APP_VERSION=$(date +%Y.%m.%d)/" deploy/.env
   gsmc build api                                  # builds BACKEND_IMAGE (api, worker and migrate use it)
   docker build -t gsm-console:local --build-arg VITE_API_BASE_URL="" ../frontend-admin   # CONSOLE_IMAGE
   ```

3. **Start the data services, then run the first-run command** (it applies the migrations, creates the base currency, the system ledger
   accounts and the Owner role, and asks for the first admin):

   ```bash
   gsmc up -d postgres redis-queue redis-cache minio minio-init typesense
   gsmc run --rm api bun run setup
   # the search engine's two keys (section 6, "Search engine"): the engine knows only its bootstrap key until this ran
   set -a; . deploy/.env; set +a
   gsmc run --rm -e TYPESENSE_BOOTSTRAP_KEY -e TYPESENSE_INDEXER_KEY -e TYPESENSE_SEARCH_KEY -e TYPESENSE_PREFIX=gsm_production_ api bun scripts/search-keys.ts
   ```

   A temporary password printed by `setup` works for 72 hours (decision 052). If it ran out before the first sign-in, remove the
   never-used first owner and run `setup` again (root `README.md`, "First run on a server").

4. **Start everything**: `gsmc up -d` (add `--profile site` once the storefront image exists).

5. **Checks, all of them:**
   - `curl -s https://<ADMIN_HOST>/health?strict=1` answers 200 with `"status":"ok"` (`degraded` names the part that is down).
   - Sign in at `https://<ADMIN_HOST>`, set up 2FA, open System health: the API and the worker are up and the queues move.
   - **Client address:** sign in once from your own network and open the sessions list or the audit log: the address shown is yours,
     not `172.30.0.x`. Repeat after loading a storefront page that is rendered on the server. If you see `172.30.0.x`, `TRUST_PROXY`
     is wrong and every per-IP limit and IP rule is working on the proxy's address.
   - `https://<API_HOST>/metrics` and `https://<SHOP_HOST>/metrics` are not served by the API (404 or the site's own 404).
   - `gsmc ps` shows `api`, `worker`, `postgres`, both Redis roles and `prometheus` healthy; `gsmc logs worker` shows the queue workers.
   - Prometheus has both targets up: `gsmc exec prometheus wget -qO- 'http://localhost:9090/api/v1/targets'` lists `gsm-api` and
     `gsm-worker` as `up`.
   - **Origins per surface:** `curl -s -o /dev/null -D - -H 'Origin: https://<SHOP_HOST>' https://<ADMIN_HOST>/admin/auth/me | grep -i '^access-control-allow'`
     prints nothing; with `-H 'Origin: https://<ADMIN_HOST>'` it prints `access-control-allow-origin: https://<ADMIN_HOST>` and
     `access-control-allow-credentials: true`.
   - **Page headers:** `curl -sI https://<ADMIN_HOST>/ | grep -i -e content-security-policy -e x-frame-options -e referrer-policy` shows
     `frame-ancestors 'none'`, `DENY` and `same-origin`; `https://<SHOP_HOST>/` shows `frame-ancestors 'none'` and `DENY`.
   - A mail is delivered to an outside address (section 7), then run a backup and a restore drill (section 4) before real money flows.

Never run the development seed (`bun run db:seed`, `db:reset`) against the production database: the seed refuses production, and the
data in it is fake.

## 3. Upgrades and rollback

Migrations are additive by rule (a new release's schema works with the previous release's code), so the order below is safe.
**One release is not: release 30 (English only, decision 039)** drops columns the previous code reads and deletes content in
other languages after an export. It has its own order (below, "Release 30"); never run the old API on its migrated database.

```bash
git pull
# 1. backup first (section 4), then wait for it to finish
gsmc run --rm -T backup pg-backup.sh
# 2. build the new image under a new tag: edit BACKEND_IMAGE in deploy/.env, e.g. gsm-backend:2026.11.20
gsmc build api
# 3. apply the new migrations with the new image (one-off; the API never migrates on boot)
gsmc run --rm migrate
# 4. replace the API and the worker (the worker drains running jobs for up to 25 s; its container may take 30 s to stop)
gsmc up -d api worker
# 5. check /health?strict=1 and System health
```

**Rollback** is the previous image tag: set `BACKEND_IMAGE` back and `gsmc up -d api worker`. There is no down-migration. If a migration
itself went wrong, restore the backup taken in step 1 (section 4) into a new database and ask for help before switching to it.

Other images (`console`, `site`) change the same way: build, set the tag, `gsmc up -d console`.

### Release 30: English only (not additive)

Release 30 removes Arabic as a language of the system (decision 039). Its migrations `0035`-`0039` delete the stored content in
other languages (templates, service listings, pages, help articles, reply templates, legal versions nobody accepted), retire the
legal versions people accepted, rewrite the campaigns that targeted other languages, and drop the language columns. **The old
API fails on the new schema** (Drizzle names every column it reads), so the API and the worker stop for the migration, and the
backend, console and site images change together. The database must be at the previous release (migration `0033`) before it
starts: the export refuses an older one.

The deleted content is kept in one file per database, written by `scripts/english-only-export.ts` (in the image). Migration
`0035` refuses to delete anything without a fresh export of that database: it compares the counts the export wrote into
`job_runs` (job `english_only_export`) with the live data, and refuses when such a row was added or removed, or content was
edited, since the export ("out of date", "content changed after the export": run the export again). It also refuses while a legal document type has a version in
force in another language and none in English ("publish an English version of these documents first").

1. Backup: `gsmc run --rm -T backup pg-backup.sh`, and wait for it to finish (section 4).
2. Build the three new images (backend, `console`, `site`). **While everything still runs**, prove that the export can run where
   the migration runs. Make a host folder the image's user can write (the image runs as `bun`, uid 1000 in `oven/bun`;
   `gsmc run --rm migrate id -u` says so):
   ```bash
   install -d -m 700 -o 1000 -g 1000 <host folder>
   gsmc run --rm -v <host folder>:/out migrate bun scripts/english-only-export.ts --check --out /out
   ```
   Read the report: services switched on only in another language, or with no English listing (a listed one loses its page; a
   checkout session already open for one can still be paid), templates, pages and help articles with no English twin, legal types with no English version in force,
   the campaigns by fate (the finished ones too), search settings in Arabic script (left as they are). `--check` writes nothing.
   It fails here, with the shop up, when the script is not in the image, the folder cannot be written or the database is at
   the wrong level (exit 3).
3. `gsmc stop api worker` (no campaign is then mid-send, nothing is written).
4. Export: `gsmc run --rm -v <host folder>:/out migrate bun scripts/english-only-export.ts --out /out`. It writes
   `english-only-<database>-<UTC time>.json` (mode 0600; content and ids, no secret), reads it back, and only then writes its
   marker. Copy the file to the backup storage: it is the only copy of the deleted content besides the dumps.
5. `gsmc run --rm migrate` (it refuses without step 4).
6. `gsmc up -d api worker console site`.
7. Check `/health?strict=1`, open one `/ar/…` address (it answers 308 to the same path under `/en`), and reload open console
   and site tabs.

**If step 4 or 5 fails,** the database is unchanged (all pending migrations run in one transaction): set the previous image tags,
`gsmc up -d api worker`, and find the cause with the shop up. **Rollback after step 5:** restore the dump of step 1 into a new
database (section 4) and start the previous images; there is no down-migration. The export file tells how a deleted row is put
back (`howToRestore`). Exit codes of the export: 0 written and verified, or nothing to export (no file, no marker needed); 3 the
database is not at `0033` or `0034`, or already migrated; 1 any other error (a missing or unwritable `--out` folder, no
`DATABASE_URL`; nothing half-written is left).

### Release with decision 045 (origins per surface)

Every command of the image (the API, the worker, `migrate`, `setup`) refuses `CORS_ORIGINS` in production from this release on. Before
step 3: delete the `CORS_ORIGINS` line from `.env.production` (the origins now come from the base URLs) and check that `CONSOLE_BASE_URL`,
`STORE_BASE_URL`, `PORTAL_BASE_URL` and `ERRORS_BASE_URL` start with `https://`. After step 4, load the new page headers with `gsmc
exec caddy caddy reload --config /etc/caddy/Caddyfile`, then run the two checks of section 2.5 named above.

### Release 41: supplier connections and field patterns (decision 051)

Additive; the usual order applies. What staff and the owner notice:
- The hint of a supplier's API key shows `••••` after the migration; saving the key again shows its last 2 characters (for a key of 16
  or more characters).
- Moving a supplier to another address (scheme, host or port), account (username) or API type needs its API key in the same save.
- After the migration the worker reviews the stored field patterns once. A pattern outside the supported form is cleared and recorded in
  the audit log ("cleared an unsupported field pattern of <service>", with the old pattern); enter a simpler pattern where it still matters.
- Only an Owner can change `suppliers.allowPlainHttp`.

### Release with decision 054 (logs and secrets)

1. Before `gsmc run --rm migrate`: add `LOOKUP_HASH_KEY` to `.env.production`. On an installation that has data, give it **exactly the value
   of the current `TOKEN_PEPPER`** (the blocklist, IMEI history, duplicate checks, unsubscribe links and pending webhook ids were made
   with it). A new installation uses `openssl rand -hex 32`. Without it, production refuses to start (`migrate` too). The first start of
   the API or the worker stores a marker of the key; from then on a start with another key is refused (this key is never changed). A
   start that cannot read the marker because Postgres does not answer stops too; compose starts it again once Postgres is healthy.
2. Upgrade as usual (backup, build, migrate, `gsmc up -d api worker`). The worker then converts the stored link tokens once.
3. Reload Caddy for the new access log: `gsmc exec caddy caddy reload --config /etc/caddy/Caddyfile`.
4. If the Telegram bot is used: before the `gsmc up -d api worker` of step 2, set a new `TELEGRAM_WEBHOOK_SECRET` in `.env.production`
   (`openssl rand -hex 32`): until this release the secret was part of the webhook address, so the access logs written before it hold the
   old value. After step 2, register the webhook: `gsmc run --rm api bun scripts/telegram-webhook.ts --url https://<API_HOST>` (section 6).
   Until then Telegram's calls are refused and chats cannot be linked or unlinked; messages to linked chats keep working.
5. Check: `gsmc exec postgres psql -U gsm -d gsm -c "select job, status, processed from job_runs where job like '%_tokens_seal'"` shows
   three succeeded runs, and `select count(*) from checkout_sessions where token is not null` (likewise `orders.public_token`,
   `support_tickets.token`) answers 0.

## 4. Backups and the restore drill

What is saved, every night: a full dump of the database (`pg_dump`, custom format), encrypted with `age` for the public key
`BACKUP_AGE_RECIPIENT`, uploaded to the bucket `BACKUP_S3_BUCKET` (use another provider or account than the server: a backup on the same disk
is not a backup). Thirty daily dumps are kept (`BACKUP_RETENTION_DAYS`), and the dump of the first day of each month is kept twelve
times (`BACKUP_MONTHLY_KEEP`). The files bucket is copied (never synced: a file deleted by mistake stays in the backup). **Not saved:**
the queue Redis (its append-only file survives restarts; a job lost with its data is not re-created from `outbox_events`: see "If the
queue Redis loses its data" in section 6), the cache Redis and the Prometheus history.

**Make the age key pair once, on your own computer, not on the server:**

```bash
age-keygen -o gsm-backup.agekey      # prints the public key "age1..."; put it in BACKUP_AGE_RECIPIENT of deploy/.env
```

The private key (`gsm-backup.agekey`) is kept offline by two people (section 5). Without it a backup cannot be read.

**Schedule** (the host's cron; `-T` is needed because cron has no terminal):

```cron
15 1 * * * cd /opt/gsm && docker compose -f deploy/compose.prod.yaml --env-file deploy/.env run --rm -T backup pg-backup.sh >> /var/log/gsm-backup.log 2>&1 && docker compose -f deploy/compose.prod.yaml --env-file deploy/.env run --rm -T backup files-mirror.sh >> /var/log/gsm-backup.log 2>&1
```

Each script prints one JSON line per step and exits non-zero on any failure (an empty or missing upload fails the run). Make the host
tell you when the exit code is not zero (cron mails, or a monitor that reads the log). Try a script without doing anything:
`gsmc run --rm -e BACKUP_DRY_RUN=1 backup pg-backup.sh` prints the commands.

**Restore into a new, empty database** (never over the live one; the script refuses a database that already has tables unless you
pass `--force`, and it has no default target):

The backup image runs as uid 10001, and `age-keygen` writes the key file readable by its owner only (mode 0600), so the container
cannot read your copy. Give it its own copy for the restore and remove it afterwards:

```bash
sudo install -m 0400 -o 10001 -g 10001 gsm-backup.agekey ./age.key.restore
gsmc exec postgres psql -U gsm -d gsm -c 'create database gsm_restored'
gsmc run --rm -v "$PWD/age.key.restore:/age.key:ro" backup pg-restore.sh \
  db/daily/gsm-<UTC stamp>.dump.age "postgres://gsm:<POSTGRES_PASSWORD>@postgres:5432/gsm_restored" --identity /age.key
sudo shred -u ./age.key.restore
```

To go live on the restored copy, stop `api` and `worker`, change the database name in `DATABASE_URL`, start them, and check.

**Monthly restore drill** (do it on the first working day of the month, and once before go-live): it restores the newest daily dump into
a scratch database next to the live one, checks that the ledger lines sum to zero and that the migrations match the code, prints the
row counts and drops the scratch database.

```bash
sudo install -m 0400 -o 10001 -g 10001 gsm-backup.agekey ./age.key.restore
gsmc run --rm -v "$PWD/age.key.restore:/age.key:ro" backup restore-drill.sh --identity /age.key
sudo shred -u ./age.key.restore
```

A pass ends with `restore drill passed with gsm-<stamp>.dump.age` and exit code 0, after `ledger_entries sum to zero`, `migrations match`
(or a warning that a migration was applied after the dump: fine) and the counts of `orders`, `clients` and `ledger_transactions`.
Anything else is a failed drill: find out why before the next night. Write the date, the dump name and the counts in your own log.
The private key only has to be on the machine for the minute the drill runs.

## 5. Key custody

| Secret | What a change or a loss breaks | Rule |
| --- | --- | --- |
| `ENCRYPTION_KEYS` | values sealed by a key that is gone cannot be read: TOTP secrets (staff and merchants enrol 2FA again), supplier and gateway credentials and webhook secrets (they stop until typed in again), stored IMEIs and inventory codes, and the copies of the shop's links (mails and account pages can no longer show those links; the links themselves keep working) | two offline copies, two people, with the backup key; never lose it, never change an existing key; add keys as below |
| `age` private key | no backup can be read | two offline copies, two people; never on the server except during a drill |
| `TOKEN_PEPPER` | everybody is signed out; every API key and every open sign-in, reset, invitation and Telegram link stops working | change only as a planned operation |
| `LOOKUP_HASH_KEY` | every stored lookup stops matching: blocked e-mails, cards and IMEIs pass the blocklist again, the IMEI history and the duplicate checks of inventory codes and open orders forget what they knew, unsubscribe links in sent mails stop working, Idempotency-Key replays of the last 7 days and the event ids of pending merchant webhook deliveries change, and every checkout, tracking and ticket link stops working | never change it (production refuses to start with a different key); on an installation that has data it equals the `TOKEN_PEPPER` the data was made with (section 3) |
| `CSRF_SECRET` | forms that are open fail once and are sent again | any time |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram's calls are refused until the webhook is registered again | change it, restart api, run `scripts/telegram-webhook.ts` (section 6); the release of decision 054 gives it a new value (section 3) |
| `TELEGRAM_BOT_TOKEN` | Telegram messages fail until the new token is set; the webhook must be registered again | change it at BotFather and in `.env.production` together, then run the script |
| `TURNSTILE_SECRET_KEY` | the shop's protected forms refuse visitors until the site key and the secret belong to one widget | change both together |
| `MAIL_SMTP_URL` credentials | mails fail and are retried until the right ones are set | change at the provider and in `.env.production` together |
| `FX_API_KEY` | the hourly rate refresh fails; stored rates stay | any time |
| `SENTRY_DSN` | errors go to the new project (or nowhere) | any time |
| `METRICS_TOKEN` | Prometheus cannot scrape until `deploy/secrets/metrics_token` has the same value | change both together |
| Postgres and MinIO passwords | the services lock out the app | change them in `deploy/.env` and `.env.production` together, then recreate the services |
| `TYPESENSE_BOOTSTRAP_KEY`, `TYPESENSE_INDEXER_KEY`, `TYPESENSE_SEARCH_KEY` (`deploy/.env`) | the shop search falls back to the database search (nothing is lost: the index is derived data) | the bootstrap key stays with the `typesense` container and with you; the worker holds only the indexer key and the API only the search key. After a change or a lost volume run `scripts/search-keys.ts` again (section 6) |

**Adding an encryption key without losing the old one:** `ENCRYPTION_KEYS` is a list, `k1:<key>,k2:<key>`. Make the new key
(`openssl rand -base64 32`), append it with a new id, set `ENCRYPTION_ACTIVE_KID=k2`, then `gsmc up -d api worker`: new values are written under
`k2`, old ones stay readable under their own id (decision 019). No job re-encrypts stored values (decision 054): keep `k1` in the list for as
long as values sealed by it exist. After a suspected leak, change the secrets themselves (supplier and gateway keys, webhook secrets, 2FA
enrolment): entering them again seals them with the active key. The twelve encrypted columns are listed by `rg "_AAD = '" src` and
`CAPABILITY_TOKEN_COLUMNS` (`src/infra/crypto/capability-token-vault.ts`). Keep a copy of the new list offline before you restart.

## 6. Logs, health, metrics and Sentry

- **Logs** are JSON lines on stdout (decision 012): `gsmc logs -f api worker caddy`. Every line of a request has its request id, which is
  also the `X-Request-Id` the client got; give it to whoever reads the log. Secrets are redacted and e-mail, phone and IMEI masked at any
  depth of a log line; a database failure is logged as its SQLSTATE, table, constraint and a fixed sentence, never the statement or its
  values (decision 054). Caddy's access log replaces link tokens, the Telegram webhook path, searches and IMEIs in the address and the
  Referer, and leaves out credential headers. Docker keeps the logs on the host: set a log rotation in `/etc/docker/daemon.json`
  (`{"log-driver":"local","log-opts":{"max-size":"20m","max-file":"5"}}`) so the disk does not fill.
- **Health:** `GET /health` always answers 200 with `ok`, `degraded` or `down` and the checks; `GET /health?strict=1` answers 503 when
  Postgres is down (this is what the container healthcheck calls). The System health pages of the console show the same and more.
- **Metrics:** `/metrics` of the API and the worker (port 9464) need `Authorization: Bearer <METRICS_TOKEN>` and are reachable only inside
  the compose network. Prometheus scrapes both every 15 s; nothing is published. To look at one by hand:
  `gsmc exec api bun -e "console.log(await (await fetch('http://127.0.0.1:3000/metrics', {headers: {authorization: 'Bearer ' + process.env.METRICS_TOKEN}})).text())"`.
- **Sentry** is off until you set `SENTRY_DSN` in `.env.production` (a project of your own Sentry account) and run `gsmc up -d api worker`.
  It then receives only unexpected server errors (an unhandled 5xx of the API) and jobs that failed for good, with the stack, the route, the
  request id and the queue and job name. It does not receive request bodies, headers, cookies, users, breadcrumbs, the host name, or
  e-mail addresses and long digit runs inside messages; database failures arrive as their SQLSTATE and table, never the statement. To turn
  it off, remove the line and restart: with no DSN the SDK is never started.
- **Telegram bot:** set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and `TELEGRAM_WEBHOOK_SECRET` in `.env.production` and restart api, then
  register the webhook: `gsmc run --rm api bun scripts/telegram-webhook.ts --url https://<API_HOST>`. It sends Telegram the address and the
  header value derived from the secret, never prints them, and ends with `Telegram webhook registered…`. Run it again after changing the
  secret, the bot token or `API_HOST`. `--dry-run` shows what it would do. An installation that used the bot before the release of
  decision 054 sets a new secret first (section 3, that release's step 4).

**If the queue Redis loses its data** (a lost volume, a `FLUSHALL`, a crash that loses the last second of the append-only file; decision 044):
restart the worker (`gsmc restart worker`): it writes its schedules only when it starts. Then these come back by themselves: outbox events
not yet handed over (still in Postgres); supplier sends (the dispatch sweep asks again, within about 6 minutes, for orders whose request was
lost, and moves orders whose send was in flight to Needs attention after the supplier's timeout plus 2 minutes; nothing is sent twice; an
order that waited more than 24 hours, or was asked for 3 times, goes to Needs attention); status polls of sent orders (the poll tick); queued
notifications (`notification_reconcile` adds their send again once they waited 30 minutes); scheduled campaigns; the search index (its
reconcile, within 15 minutes); storefront receipts (made at their first download); every scheduled job. These do not come back yet:
storefront refunds approved and waiting for their gateway (they stay `processing`; the console's retry is for failed refunds only), merchant
webhook deliveries (they stay `pending`), Quick add and bulk publish runs waiting for their job, mails sent by a job of their own that had
not run yet (sign-in and password links, invitations, ticket mails, abandoned-checkout reminders: the person asks again), a waiting price
change scan (the next price change asks for one), the one-time category name clean-up of migration 0046, and the failed jobs kept for staff
(the failed list is empty afterwards). Note the affected orders, refunds and runs before you change anything.

**An order stays "being sent"** (decision 044). While the supplier is called, an order reads Pending in the console and staff actions on it
(reply, reject, send again, change supplier, refund approval) answer 409 with "This order is being sent to its supplier right now: wait for the
supplier's answer"; that is normal for as long as the supplier's timeout, plus about 2 minutes, and a merchant cannot cancel it. If it lasts
longer than that, the maintenance queue is not running the `dispatch_sweep` job (a worker that is down, or one that lost its schedules): look at
System health and at the worker's logs, then start or restart the worker (`gsmc restart worker`; it writes its schedules when it starts).
Within a minute the sweep moves the order to Needs attention with "A send was started but its answer was not recorded"; nothing is sent again by itself. Open the order,
check it with the supplier, then fetch its result or send it again (when the supplier accepted it under a reference, the order timeline has
a line that names it). A merchant cannot cancel an order that was sent once, even when it reads Pending again; staff cancel it by rejecting it.

**Retail prices that follow a rule** (feature 31, decision 040). The worker moves them when the cost, the floor or a rule changes, at most once a
minute and at least once an hour, and lists every move and every proposal under Storefront, Retail pricing. Once an hour at most it sends the counts to
the ops recipients: `ALERTS_EMAIL_TO` for the email and `ALERTS_TELEGRAM_CHAT_ID` for Telegram. Without them the message is recorded as failed in the
notification log with the reason, and the list in the console is the only notice.

**Search engine** (feature 29, decision 038). The English search of the shop header and the results page runs on one Typesense node
(`typesense` in `deploy/compose.prod.yaml`, pinned by digest, on the network `gsm` only: no published port, no Caddy route, never
reachable from a browser). Postgres is the truth; the index holds only public, English, price-free documents and can be rebuilt at any
moment. A prices or stock change shows at once because the API reads them from Postgres on every request; an edit of a service,
listing, category or stock reaches the index within about 5 seconds (outbox, queue `search-index`), and anything missed within 15
minutes (the reconcile). When the engine is off, down or has no index yet, the shop answers from the database search, says so, and
nothing fails.

- **Secrets** (`deploy/.env`): `TYPESENSE_BOOTSTRAP_KEY` (the node's own key), `TYPESENSE_INDEXER_KEY` (worker only) and
  `TYPESENSE_SEARCH_KEY` (API only: `documents:search`, `aliases:get`, `collections:get`). Both app keys are limited to the names of
  this environment (`TYPESENSE_PREFIX`, `gsm_production_`). Typesense scopes **collections** by key but not the global synonym and
  curation sets: the indexer key could write any set on the node. Accepted: production runs one node per environment, only our code holds
  the keys, and sets are named by prefix.
- **After a volume wipe, an image upgrade or a changed key**, before `api` and `worker` start (or restart them afterwards): run
  `set -a; . deploy/.env; set +a; gsmc run --rm -e TYPESENSE_BOOTSTRAP_KEY -e TYPESENSE_INDEXER_KEY -e TYPESENSE_SEARCH_KEY -e TYPESENSE_PREFIX=gsm_production_ api bun scripts/search-keys.ts`.
  It is idempotent (lists the keys, keeps those that work, recreates those that differ or answer 401) and never prints a key. The worker's
  boot reconcile then finds no alias and rebuilds the index (a few minutes for 100 000 services); the shop uses the database search
  meanwhile. The data volume is not backed up: it is derived data.
- **Console:** Storefront, **Search**: synonyms, pinned results, the report (what visitors searched for and what found nothing), a
  preview of a query with the rules applied, and the index status with **Rebuild index** (`storefront:publish`; a rebuild runs the
  nightly job now). Staff never edit Typesense by hand: the worker pushes the whole synonym and curation sets after every change.
- **Kill switch:** `SEARCH_ENABLED=false` in `.env.production` and `gsmc up -d api worker`: every search is the database search and the
  sync jobs complete without calls. No deploy of code is needed to go back to today's behaviour. Removing Typesense is stopping the
  container and deleting `typesense-data`.
- **Memory and disk:** the container is limited by `mem_limit` (`TYPESENSE_MEM_LIMIT`, default 1.5 GB, about 100 000 services; a rebuild
  needs about twice the services part while two collections live). Writes stop when the disk Postgres shares reaches 85 %
  (`--disk-used-max-percentage 85`): `GET /health` of the engine then reports `OUT_OF_DISK` and System health shows `Search engine`
  degraded; searches still answer. `typesense_memory_allocated_bytes` (the worker's `/metrics`, read from the engine at every reconcile;
  the engine has no Prometheus endpoint) is the memory figure: the container's own system figures report the host, not the container.
- **Alerts to set** (rules for the Prometheus of your choice; the repository ships none): `typesense_memory_allocated_bytes` above 80 % of
  `TYPESENSE_MEM_LIMIT`; host disk use above 80 %; `rate(search_fallback_total[5m]) > 0` for 10 minutes (the shop is on the database
  search); `increase(search_auth_failures_total[15m]) > 0` (the keys are missing: run `scripts/search-keys.ts`);
  `search_stale_hits_total` growing fast (the index is behind: check the `search-index` queue); `search_sync_lag_seconds` p95 above 30 s.
- **Metrics:** API: `search_requests_total{route,engine}`, `search_engine_seconds{route}`, `search_fallback_total{reason}` (`timeout`,
  `error`, `not_ready`, `circuit_open`, `disabled`), `search_stale_hits_total`, `search_zero_results_total{route}`,
  `search_suggest_limited_total`, `search_terms_dropped_total`. Worker: `search_sync_documents_total{op}`, `search_sync_failures_total`,
  `search_sync_rejected_total`, `search_auth_failures_total`, `search_sync_lag_seconds`, `search_index_documents`,
  `search_index_last_rebuild_timestamp_seconds`, `search_index_last_reconcile_timestamp_seconds`.
- **Logs and privacy:** Caddy replaces the `q` parameter of the URI and the Referer with `q=[redacted]` in its access log (a typed
  query can be an IMEI, a phone number or an email address); the API logs the route template only; the search engine keeps no request log (its slow-request and slow-search logs are off
  because they record the typed query; engine latency is `search_engine_seconds`). The statistics keep per day and term
  the count of searches, of searches without results and an estimate of distinct visitors (a HyperLogLog over a hash that changes
  every day, never the address); a text with an `@`, a link, a `+` start or five digits in a row is never counted; rows older than 180
  days are deleted.
- **Rate limits:** the suggest route has its own budget (`search-suggest`, 1200 a minute per client address: a typing visitor sends a
  request every 150 ms); the results page and `GET /store/v1/services` keep `ip` (300). The shop's server must forward the visitor's
  address (`X-Forwarded-For`) on search reads, or every visitor shares the server's budget.

**Live connections** (decision 037). The signed-in storefront account, merchant portal and admin console each keep one server-sent
event stream open (`GET /store/v1/me/stream`, `/client/stream`, `/admin/stream`), so a notification appears at once instead of at
the next poll. The browser's tabs share one stream; the server allows 3 per session, 30 per client address and 5000 per API process,
refuses the newest one over a limit (`429`, or `503 UNAVAILABLE` for the process limit), re-checks every stream at least every
15 minutes and closes it when its session ends. A stream is one open descriptor in the API and two in Caddy, so `deploy/compose.prod.yaml`
raises `nofile` to 65536 for `caddy` and `api`; the Caddyfile leaves the stream paths out of compression and sets no
`flush_interval`. All keys are optional, in `.env.production`:

| Key | Default | What it does |
| --- | --- | --- |
| `REALTIME_ENABLED` | `true` | the kill switch (below) |
| `REALTIME_MAX_CONNECTIONS` | `5000` | open streams per API process (1 to 100000); the next one is `503 UNAVAILABLE` |
| `REALTIME_MAX_PER_SESSION` | `3` | open streams per session (1 to 50) |
| `REALTIME_MAX_PER_IP` | `30` | open streams per client address (1 to 100000); raise it for an office behind one address |
| `REALTIME_HEARTBEAT_SECONDS` | `15` | the `hb` event interval (5 to 25); keep it under 30, which is where a Next rewrite cuts a silent stream |
| `REALTIME_MAX_AGE_SECONDS` | `900` | a stream ends after this long plus 0 to 120 s, and its browser reconnects through the guard (60 to 3600) |

- **Kill switch:** set `REALTIME_ENABLED=false` in `.env.production` and run `gsmc up -d api`. Open streams end, every stream route
  answers `503 UNAVAILABLE` with `Retry-After: 30`, and the pages fall back to their 60-second poll. Nothing else changes (the
  polling routes never went away). Turn it back on the same way.
- **API restart or deploy:** every stream ends and every browser reconnects on its own after 2 to 5 seconds (its own back-off while
  Caddy answers 502), sends its last event id and gets what it missed (at most 50 items, otherwise it refetches its list).
  Nothing to do.
- **Metrics** (the API's `/metrics`; the worker only publishes): `realtime_connections{surface}` (open streams),
  `realtime_subscriber_up` (1 while this API process hears the doorbell channel; 0 means items reach open pages only at their
  next reconnect or 5-minute poll, and the hub sends a refetch to every stream when the subscriber returns),
  `realtime_connections_refused_total{surface,reason}` (`disabled`, `capacity`, `rate`, `session_cap`, `ip_cap`),
  `realtime_drops_total{reason}` (should stay at 0: `slow_consumer` and `write_error` are dropped streams), `realtime_delivery_seconds`
  (doorbell to write, under 1 s at p95) and, in both processes, `realtime_publish_failures_total{topic}` (the cache Redis refused a
  doorbell: nothing is lost, the pages catch up on their poll). Logs: one `stream closed` line per stream (viewer kind and id, session id,
  duration, number of frames, reason); the access log and the request histogram skip streams.
- **Check after a deploy:** open `/account` on the shop signed in, then
  `gsmc exec api bun -e "const t = await (await fetch('http://127.0.0.1:3000/metrics', {headers: {authorization: 'Bearer ' + process.env.METRICS_TOKEN}})).text(); console.log(t.split('\n').filter((l) => l.startsWith('realtime_connections') || l.startsWith('realtime_subscriber_up')).join('\n'))"`
  shows `realtime_connections{surface="store"} 1` and `realtime_subscriber_up 1`.
- **Load test:** `bash scripts/with-slot.sh bun run test:load:realtime` in a development checkout opens 2000 streams against a
  test app and prints the table that `src/infra/realtime/README.md` keeps. Never point it at the production stack.

### Sign-in protections (decision 052)

- **A locked email.** Ten failed passwords for one email (from any networks; a success in between does not cancel them) lock it for
  15 minutes on its side (the console, or the shop for merchants and customers): the sign-in answers `429` "Too many failed attempts.
  Try again later." with `Retry-After`. A network the account signed in from before (the same IPv4 /24 or IPv6 /64 as one of its stored
  sessions) can still sign in, with five attempts per 15 minutes shared by every address of that network while the lock runs (the
  sixth gets the same `429`). Otherwise the person waits for the lock to end, or gets a new password, which lifts the lock at once:
  customers can use the emailed sign-in link or a reset link; merchants a reset link (changing the password while signed in does not lift
  the shop lock: a merchant registration proves no mailbox); staff ask an Owner (or a member allowed to act on them) for a password link
  or a temporary password. The API log has one `Sign-in refused (staff|shop): the email is locked` line per refusal, with the address and without the email.
- **Temporary passwords expire after 72 hours** (staff, merchants and customers): after that the sign-in refuses them like a wrong
  password; set a new one from the console.
- **The cache Redis holds the counters.** While it is down, the authenticator code step (staff and merchants with 2FA) is refused
  (`429`, retry after 60 s), so nobody with 2FA can finish signing in until it is back; the other sign-in limits and the lock count in
  memory per API process, so do not run more than one API process without the cache Redis.
- **Mails a visitor asks for** (sign-in link, forgot password) are capped at five an hour per account and kind; a request beyond the cap
  answers as usual and sends nothing. Mails staff send have their own budget.
- **Two-step sign-in of a merchant needs a confirmed email address.** Starting the setup or confirming it answers `409` ("Confirm your
  email address first; two-step sign-in can be switched on after that.") while the merchant's email is not confirmed: send the
  verification link first. Switching it off and signing in with a code are not affected.

## 7. Owner checklists

**Mail domain** (without it customers and merchants never receive links)
- [ ] The domain of `MAIL_FROM` is verified at your SMTP provider.
- [ ] SPF, DKIM and DMARC records are published for it (the provider shows the exact records).
- [ ] `MAIL_SMTP_URL` and `MAIL_FROM` are set in `.env.production`.
- [ ] A test mail reaches an address at another provider (use a password reset of a test account) and does not land in spam.

**DNS and TLS**
- [ ] The three names resolve to the server, and ports 80 and 443 are open.
- [ ] `https://<SHOP_HOST>`, `https://<ADMIN_HOST>` and `https://<API_HOST>` open with a valid certificate (Caddy needs a minute after the first start; `gsmc logs caddy` shows why when not).

**Provider accounts**
- [ ] Cloudflare Turnstile: a widget for `SHOP_HOST`; the secret in `TURNSTILE_SECRET_KEY`, the site key given to the storefront, which
      shows it on the shop forms and on the merchant sign-in and forgot-password forms (`TURNSTILE_MERCHANT_AUTH` is on by default in
      production, decision 052; `false` switches the merchant forms' check off).
- [ ] Exchange rates: an API key in `FX_API_KEY` (`FX_PROVIDER=openexchangerates`), or the rates are kept by hand.
- [ ] Telegram bot (optional): token, username and webhook secret in `.env.production`, then run `scripts/telegram-webhook.ts` (section 6).
- [ ] Object storage for backups on another provider, its keys in `deploy/.env`, and the two key holders named.
- [ ] A Sentry project (optional) and its DSN.
- [ ] The payment provider chosen by the owner (decision D-6) and its keys entered in the console, never in a file.

**Before go-live**
- [ ] Every check of section 2.5 passed, including the client-address check.
- [ ] A backup ran and a restore drill passed (section 4), and the first-day-of-month copy is understood.
- [ ] `ENCRYPTION_KEYS` and the backup private key exist offline in two places, with two people.
- [ ] `LOOKUP_HASH_KEY` is set (on an installation with data: the value of its `TOKEN_PEPPER`).
- [ ] `COOKIE_SECURE=true`, `REFERENCE_DOCS=staff`, the dev seed was never run on this database.
- [ ] `.env.production` has no `CORS_ORIGINS`, and the four base URLs are https (decision 045).
- [ ] Every supplier address starts with https://, and suppliers.allowPlainHttp is not true (only an Owner can change it).
- [ ] A timer or cron entry runs the nightly backup and something tells you when it fails.
- [ ] Docker log rotation is set, and the host has disk space for the volumes (database, files, Prometheus).

**Staff roles** (decision 046)
- [ ] Only people trusted like an Owner hold `*`; other admins hold what they need (they can give, and act on, only what they hold).
- [ ] The permissions in `src/modules/identity/README.md` ("Permissions that reach owner-level power") are given on purpose; an area
      wildcard such as `wallet:*` includes them.
- [ ] A second active Owner account on another role exists: it is what lets the last-Owner rule allow a change to the Owner role or to
      the other Owner's account, and it is the way back when one Owner is lost.
- [ ] The "owners keep access" rule looks at the addresses of an Owner's live sessions and last sign-in. Each Owner keeps a lasting allow
      rule (no expiry) for the address they sign in from, so a change by another admin that would refuse that address is turned away.

**Locked out of the console by an IP rule** (needs access to the server)
1. Turn the allow-list restriction off:
   `gsmc exec postgres psql -U gsm -d gsm -c "update settings set value = 'false'::jsonb where key = 'adminAllowlistOnly';"`
2. If a block covers your address, find it and remove it:
   `gsmc exec postgres psql -U gsm -d gsm -c "select id, cidr, scope, reason from ip_rules where kind = 'block' and scope in ('admin', 'all');"`
   then `gsmc exec postgres psql -U gsm -d gsm -c "delete from ip_rules where id = <id>;"`
3. Make it apply at once (otherwise within a few minutes):
   `gsmc exec redis-cache redis-cli DEL gsm:production:identity:ip-rules:active gsm:production:platform:settings:all`
4. Sign in, check the access settings, and note what you changed: these steps write no audit row.
