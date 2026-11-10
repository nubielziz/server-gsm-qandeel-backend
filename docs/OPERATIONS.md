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
| `ADMIN_HOST` (`admin.example.com`) | the admin console (container `console`, nginx) | `/admin/*`, `/health`, `/reference*` |
| `API_HOST` (`api.example.com`) | machine clients only | `/api/index.php` (Dhru), `/v1/*` (REST v1), `/webhooks/*`, `/docs*`; everything else is 404 |

Why this shape: the sessions' cookies belong to one host, so the browser must reach the API on the page's own host. `/metrics` is routed
on no host.

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
   openssl rand -hex 32          # run once for each of CSRF_SECRET, TOKEN_PEPPER, METRICS_TOKEN
   echo "k1:$(openssl rand -base64 32)"   # the whole line is the value of ENCRYPTION_KEYS
   ```

   Fill `deploy/.env` (hosts, `ACME_EMAIL`, the Postgres and MinIO passwords: letters and digits only) and `.env.production` (every
   `CHANGE_ME`, every `example.com`). The same passwords appear in both files: `POSTGRES_PASSWORD` in `DATABASE_URL`, `MINIO_ROOT_USER`
   and `MINIO_ROOT_PASSWORD` in `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Write the metrics token for Prometheus with no newline,
   readable by it:

   ```bash
   printf '%s' "<the METRICS_TOKEN value>" > deploy/secrets/metrics_token && chmod 644 deploy/secrets/metrics_token
   ```

   The app refuses to start in production with a missing required value, a development secret or `COOKIE_SECURE=false`, and prints the full list.

2. **Build the images** (the console from the console repository, with the API on the same origin):

   ```bash
   sed -i "s/^GIT_SHA=.*/GIT_SHA=$(git rev-parse --short HEAD)/; s/^APP_VERSION=.*/APP_VERSION=$(date +%Y.%m.%d)/" deploy/.env
   gsmc build api                                  # builds BACKEND_IMAGE (api, worker and migrate use it)
   docker build -t gsm-console:local --build-arg VITE_API_BASE_URL="" ../frontend-admin   # CONSOLE_IMAGE
   ```

3. **Start the data services, then run the first-run command** (it applies the migrations, creates the base currency, the system ledger
   accounts and the Owner role, and asks for the first admin):

   ```bash
   gsmc up -d postgres redis-queue redis-cache minio minio-init
   gsmc run --rm api bun run setup
   ```

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
   - A mail is delivered to an outside address (section 7), then run a backup and a restore drill (section 4) before real money flows.

Never run the development seed (`bun run db:seed`, `db:reset`) against the production database: the seed refuses production, and the
data in it is fake.

## 3. Upgrades and rollback

Migrations are additive by rule (a new release's schema works with the previous release's code), so the order below is safe:

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

## 4. Backups and the restore drill

What is saved, every night: a full dump of the database (`pg_dump`, custom format), encrypted with `age` for the public key
`BACKUP_AGE_RECIPIENT`, uploaded to the bucket `BACKUP_S3_BUCKET` (use another provider or account than the server: a backup on the same disk
is not a backup). Thirty daily dumps are kept (`BACKUP_RETENTION_DAYS`), and the dump of the first day of each month is kept twelve
times (`BACKUP_MONTHLY_KEEP`). The files bucket is copied (never synced: a file deleted by mistake stays in the backup). **Not saved:**
the queue Redis (its jobs are re-created from `outbox_events`; its append-only file survives restarts), the cache Redis and the
Prometheus history.

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

| Secret | What breaks if it is lost or changed | Rule |
| --- | --- | --- |
| `ENCRYPTION_KEYS` | TOTP secrets and supplier and gateway credentials become unreadable (suppliers and gateways stop until their credentials are typed in again, staff must re-enrol 2FA) | two offline copies, held by two people, with the `age` private key of the backups. Never lose it, never change an existing key |
| `age` private key | no backup can be read | two offline copies, two people; never on the server except during a drill |
| `TOKEN_PEPPER` | changing it signs everybody out and voids every API key and open link | change only as a planned operation |
| `CSRF_SECRET` | changing it only voids forms that are open | can be changed at any time |
| `METRICS_TOKEN` | Prometheus cannot scrape until `deploy/secrets/metrics_token` has the same value | change both together |
| Postgres and MinIO passwords | the services lock out the app | change them in `deploy/.env` and `.env.production` together, then recreate the services |

**Adding an encryption key without losing the old one:** `ENCRYPTION_KEYS` is a list, `k1:<key>,k2:<key>`. Make the new key
(`openssl rand -base64 32`), append it with a new id, set `ENCRYPTION_ACTIVE_KID=k2`, keep `k1` in the list for as long as any stored value
still carries it (old values stay readable under their own id; new ones are written under `k2`; decision 019), then `gsmc up -d api worker`.
Keep a copy of the new list offline before you restart.

## 6. Logs, health, metrics and Sentry

- **Logs** are JSON lines on stdout (decision 012): `gsmc logs -f api worker caddy`. Every line of a request has its request id, which is
  also the `X-Request-Id` the client got; give it to whoever reads the log. Passwords, tokens, cookies and secrets are redacted; e-mail,
  phone and IMEI are masked. Docker keeps the logs on the host: set a log rotation in `/etc/docker/daemon.json`
  (`{"log-driver":"local","log-opts":{"max-size":"20m","max-file":"5"}}`) so the disk does not fill.
- **Health:** `GET /health` always answers 200 with `ok`, `degraded` or `down` and the checks; `GET /health?strict=1` answers 503 when
  Postgres is down (this is what the container healthcheck calls). The System health pages of the console show the same and more.
- **Metrics:** `/metrics` of the API and the worker (port 9464) need `Authorization: Bearer <METRICS_TOKEN>` and are reachable only inside
  the compose network. Prometheus scrapes both every 15 s; nothing is published. To look at one by hand:
  `gsmc exec api bun -e "console.log(await (await fetch('http://127.0.0.1:3000/metrics', {headers: {authorization: 'Bearer ' + process.env.METRICS_TOKEN}})).text())"`.
- **Sentry** is off until you set `SENTRY_DSN` in `.env.production` (a project of your own Sentry account) and run `gsmc up -d api worker`.
  It then receives only unexpected server errors (an unhandled 5xx of the API) and jobs that failed for good, with the stack, the route, the
  request id and the queue and job name. It does not receive request bodies, headers, cookies, users, breadcrumbs, the host name, or
  e-mail addresses and long digit runs inside messages. To turn it off, remove the line and restart: with no DSN the SDK is never started.

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
- [ ] Cloudflare Turnstile: a widget for `SHOP_HOST`; the secret in `TURNSTILE_SECRET_KEY`, the site key given to the storefront.
- [ ] Exchange rates: an API key in `FX_API_KEY` (`FX_PROVIDER=openexchangerates`), or the rates are kept by hand.
- [ ] Telegram bot (optional): token, username and webhook secret in `.env.production`.
- [ ] Object storage for backups on another provider, its keys in `deploy/.env`, and the two key holders named.
- [ ] A Sentry project (optional) and its DSN.
- [ ] The payment provider chosen by the owner (decision D-6) and its keys entered in the console, never in a file.

**Before go-live**
- [ ] Every check of section 2.5 passed, including the client-address check.
- [ ] A backup ran and a restore drill passed (section 4), and the first-day-of-month copy is understood.
- [ ] `ENCRYPTION_KEYS` and the backup private key exist offline in two places, with two people.
- [ ] `COOKIE_SECURE=true`, `REFERENCE_DOCS=staff`, the dev seed was never run on this database.
- [ ] A timer or cron entry runs the nightly backup and something tells you when it fails.
- [ ] Docker log rotation is set, and the host has disk space for the volumes (database, files, Prometheus).
