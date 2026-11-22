# Operations: deploying and running GSM in production

For the person who runs the server. Decision 036 explains why it is built this way. **Read this first:** the compose file, the Caddyfile
and the backup scripts were checked by `docker compose config`, by parsing and by dry runs, and were never started end to end. Your
first deploy is the real test: follow section 2 in order and tick every check.

Every command below runs from the repository root, with these two shortcuts:

```bash
alias gsmc='docker compose -f deploy/compose.prod.yaml --env-file deploy/.env'
```

## 1. Hosts, DNS and what runs where

Four DNS names (A, and AAAA if you have IPv6) point at the server. Ports 80 and 443 (TCP and UDP) must be open: Caddy gets and renews the
certificates itself, and needs port 80 for that. Nothing else is published.

| Host (`deploy/.env`) | Serves | Sent to the API |
| --- | --- | --- |
| `SHOP_HOST` (`shop.example.com`) | the storefront and the merchant portal (container `site`) | `/client/*`, `/store/v1/*` |
| `ADMIN_HOST` (`admin.example.com`) | the admin console (container `console`, nginx) | `/admin/*`, `/health`, `/reference*`, `/store/v1/media/*` (the pictures the console shows) |
| `API_HOST` (`api.example.com`) | machine clients only | `/api/index.php` (Dhru), `/v1/*` (REST v1), `/webhooks/*`, `/docs*`; everything else is 404 |
| `FILES_HOST` (`files.example.com`) | signed file downloads only (decision 055) | nothing: reads of one object of the files bucket that carry a signature go to MinIO; the bucket itself, a listing and every other path or method are 404 |

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
| `migrate` | one-off: applies the pending migrations and sets the application role's privileges; `setup` runs here too (profile `tools`); the only service that holds the owner role of the database |
| `postgres` | the database (volume `pgdata`) |
| `redis-queue` | BullMQ only: append-only file, nothing evicted, 512 MB by default (`REDIS_QUEUE_MAXMEMORY`: beyond it new jobs are refused and the outbox keeps the work), password (volume `redis-queue-data`) |
| `redis-cache` | cache, rate limits and locks: 256 MB, least recently used evicted, nothing saved, password |
| `minio`, `minio-init` | the files bucket `gsm-files` (volume `minio-data`); to use an external S3 delete both (and `minio-admin`) and change the `S3_*` lines of `.env.production` |
| `minio-admin` | one-off MinIO administration (profile `tools`): creates the application's and the backups' users once per MinIO volume (section 2, step 3) |
| `prometheus` | metrics history for the System health pages (15 days) |
| `console` | the admin console bundle |
| `site` | the storefront (profile `site`: it is left out until the storefront ships its image; start with `gsmc --profile site up -d site`) |
| `backup` | backup tools, started by the host's timer (profile `tools`); it receives its own variables only, never `.env.production` |

**Networks and addresses** (decision 055). `edge` holds Caddy, the API, the console and the site: the services that serve browsers or are reached
by Caddy. `data` is internal (no way out, no way in): the API, the worker, `migrate`, `backup`, Postgres, both Redis, MinIO and Typesense.
`files` is internal and joins Caddy to MinIO for the signed file links. `monitoring` is internal and joins Prometheus to the API and the worker.
`egress` carries the worker and the backups to the internet (suppliers, payment gateways, the mail provider, the exchange-rate provider, the
offsite bucket). Caddy is `172.30.1.2` and the site `172.30.1.3`: the only addresses `TRUST_PROXY` names, so no other container can choose the
client address the API sees. Never add a service to `edge` that does not serve browsers, and keep `TRUST_PROXY` to those two addresses: it warns at every boot when it holds a range or a hop count (with a CDN in front of Caddy, whose published ranges are added to it, that warning is expected). Caddy has no
per-address connection cap; a host firewall can add one on ports 80 and 443 (a limit on the number of connections per source address, for
example with nftables), tested from a second address before it is relied on. The API's own per-address limits stay in force either way, and
Caddy cuts a client that is slow to send its headers (10 s) or that stalls an upload (30 s).

### Visitor country (`GEOIP_COUNTRY_HEADER`)

The visitor's country is read when a checkout is opened and kept on it (`checkout_sessions.ip_country`). The risk rules (the IP country
against the card country), the check of the declared tax country, the country blocklist and `imei_checks.country` use it (decision 050).
A visitor can send any header, so only a CDN in front of Caddy that writes this header on every request may supply it. **The bundled
stack has none: leave the setting unset.** The API's boot log then names the IP-country rule as a rule without an input source, and the
rule never applies. The setting lives in `deploy/.env`: compose passes it to the API (a value in `.env.production` is not used) and to
Caddy, which removes that header from every request on all three hosts (the line `request_header -{$GEOIP_COUNTRY_HEADER:X-Visitor-Country}`
at the top of each host block), so no value a visitor sends ever reaches the API. With the setting on but the Caddyfile left as it is,
`ip_country` stays empty and the boot log names no gap: the query of step 5 is the check.

With a CDN in front:
1. Set `GEOIP_COUNTRY_HEADER` in `deploy/.env` to the header the CDN writes (Cloudflare: `CF-IPCountry`).
2. Let only the CDN reach ports 80 and 443 (the firewall of the host).
3. In `deploy/Caddyfile` add the CDN's address ranges as `trusted_proxies static <ranges>` in the global options, and in the shop host's
   block replace the `request_header` line by a matcher `@not_cdn not remote_ip <ranges>` and the line
   `request_header @not_cdn -{$GEOIP_COUNTRY_HEADER}` (the CDN form replaces the plain removal on that host; the other two hosts keep it).
4. Add the same ranges to `TRUST_PROXY`, so the API sees the visitor's address and not the CDN's.
5. `gsmc up -d caddy api`, open a checkout from the shop, then:
   `gsmc exec postgres psql -U gsm -d gsm -c "select id, ip_country, created_at from checkout_sessions order by id desc limit 3;"`
   shows your country.

## 2. First deploy

1. **Make the secrets** (keep them out of git and out of chat; two offline copies, section 5):

   ```bash
   cp deploy/.env.example deploy/.env
   cp .env.production.example .env.production
   mkdir -p deploy/secrets
   openssl rand -hex 32          # run once for each of CSRF_SECRET, TOKEN_PEPPER, LOOKUP_HASH_KEY, METRICS_TOKEN and, in deploy/.env, TYPESENSE_BOOTSTRAP_KEY, TYPESENSE_INDEXER_KEY, TYPESENSE_SEARCH_KEY
   openssl rand -hex 24          # run once for each password of deploy/.env (POSTGRES_PASSWORD, REDIS_QUEUE_PASSWORD, REDIS_CACHE_PASSWORD, MINIO_ROOT_PASSWORD, MINIO_APP_PASSWORD, MINIO_BACKUP_PASSWORD) and for the password in DATABASE_URL of .env.production (the application's role)
   echo "k1:$(openssl rand -base64 32)"   # the whole line is the value of ENCRYPTION_KEYS
   ```

   Fill `deploy/.env` (the four hosts, `ACME_EMAIL`, the passwords: letters and digits only, and the MinIO user names) and `.env.production`
   (every `CHANGE_ME`, every `example.com`). Some values appear in both files: the Redis passwords in `REDIS_QUEUE_URL` and `REDIS_CACHE_URL`
   (`redis://:<password>@redis-queue:6379/0`), `MINIO_APP_USER` and `MINIO_APP_PASSWORD` in `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, and
   `S3_PUBLIC_ENDPOINT=https://<FILES_HOST>`. `POSTGRES_PASSWORD` is the owner role's password: it stays in `deploy/.env` (the `migrate` and
   `backup` services build the owner's address from it), and `DATABASE_URL` names the application's own role `gsm_app` with a password of its
   own (`db:migrate` creates the role with it). The root account of MinIO (`MINIO_ROOT_*`) never goes into `.env.production`. Write the metrics
   token for Prometheus with no newline, readable by the Prometheus user only:

   ```bash
   printf '%s' "<the METRICS_TOKEN value>" > deploy/secrets/metrics_token && sudo chown 65534:65534 deploy/secrets/metrics_token && sudo chmod 0400 deploy/secrets/metrics_token
   ```

   The app refuses to start in production with a missing required value, a development secret, `COOKIE_SECURE=false`, an `http:` base URL or
   origin, a `CORS_ORIGINS` line, a `CHANGE_ME` placeholder in any variable, a short secret (`METRICS_TOKEN` and the two search keys under 32
   characters, the S3 secret under 16), a database or Redis password under 16 characters for a service on another machine, no `TRUST_PROXY`,
   argon2 below the OWASP minimum (the setting must reach one of the published pairs of memory and passes: 46 MiB with 1 pass, 19 MiB with 2, 12 MiB with 3, 9 MiB with 4, 7 MiB with 5) or a database
   role that is a superuser, an owner of the tables or of the database, a role that reads or writes files or runs programs on the database server
   (`pg_read_server_files`, `pg_write_server_files`, `pg_execute_server_program`), or a member of any of these (a member that inherits nothing
   counts), and prints the full list. Three secrets never
   reach those checks, because only compose reads them: `MINIO_ROOT_PASSWORD`, `MINIO_BACKUP_PASSWORD` and `TYPESENSE_BOOTSTRAP_KEY`. Make them
   with the commands above, and check that no placeholder is left in either file: `grep -n CHANGE_ME deploy/.env .env.production` must print nothing.

2. **Build the images** (the console from the console repository, with the API on the same origin):

   ```bash
   sed -i "s/^GIT_SHA=.*/GIT_SHA=$(git rev-parse --short HEAD)/; s/^APP_VERSION=.*/APP_VERSION=$(date +%Y.%m.%d)/" deploy/.env
   gsmc build api                                  # builds BACKEND_IMAGE (api, worker and migrate use it)
   docker build -t gsm-console:local --build-arg VITE_API_BASE_URL="" ../frontend-admin   # CONSOLE_IMAGE
   ```

3. **Start the data services, create the MinIO users, then run the first-run command** (it applies the migrations, creates the
   application's database role, the base currency, the system ledger accounts and the Owner role, and asks for the first admin):

   ```bash
   gsmc up -d postgres redis-queue redis-cache minio minio-init typesense
   # once per MinIO volume (decision 055): the application's user (its bucket only) and the backups' user (read only); --no-deps because
   # the data services are already up and these one-off commands must not touch them
   set -a; . deploy/.env; set +a
   gsmc run --rm --no-deps minio-admin admin policy create local gsm-app /etc/gsm/minio/gsm-app-policy.json
   gsmc run --rm --no-deps minio-admin admin policy create local gsm-backup-read /etc/gsm/minio/gsm-backup-read-policy.json
   gsmc run --rm --no-deps minio-admin admin user add local "$MINIO_APP_USER" "$MINIO_APP_PASSWORD"
   gsmc run --rm --no-deps minio-admin admin user add local "$MINIO_BACKUP_USER" "$MINIO_BACKUP_PASSWORD"
   gsmc run --rm --no-deps minio-admin admin policy attach local gsm-app --user "$MINIO_APP_USER"
   gsmc run --rm --no-deps minio-admin admin policy attach local gsm-backup-read --user "$MINIO_BACKUP_USER"
   gsmc run --rm --no-deps minio-admin admin user info local "$MINIO_APP_USER"     # shows PolicyName: gsm-app
   gsmc run --rm --no-deps migrate bun run setup
   # the search engine's two keys (section 6, "Search engine"): the engine knows only its bootstrap key until this ran
   gsmc run --rm -e TYPESENSE_BOOTSTRAP_KEY -e TYPESENSE_INDEXER_KEY -e TYPESENSE_SEARCH_KEY -e TYPESENSE_PREFIX=gsm_production_ api bun scripts/search-keys.ts
   ```

   A second `attach` answers that the policy is already attached: that is fine, as is a second `policy create` or `user add`. A user that was not
   created shows later as "storage unavailable" in System health, not as a refusal at boot. `setup` needs the owner role, which only the
   `migrate` service holds; it prints `✓ Application role gsm_app: created` the first time.

   A temporary password printed by `setup` works for 72 hours (decision 052). If it ran out before the first sign-in, remove the
   never-used first owner and run `setup` again (root `README.md`, "First run on a server").

4. **Start everything**: `gsmc up -d` (add `--profile site` once the storefront image exists).

5. **Checks, all of them:**
   - `curl -s https://<ADMIN_HOST>/health?strict=1` answers 200 with `"status":"ok"` (`degraded` names the part that is down).
   - Sign in at `https://<ADMIN_HOST>`, set up 2FA, open System health: the API and the worker are up and the queues move.
   - **Client address:** sign in once from your own network and open the sessions list or the audit log: the address shown is yours,
     not `172.30.1.x`. Repeat after loading a storefront page that is rendered on the server. If you see `172.30.1.x`, `TRUST_PROXY`
     is wrong and every per-IP limit and IP rule is working on the proxy's address. `gsmc logs api | grep -i 'Configuration warning'` shows
     no `TRUST_PROXY` line.
   - **The application's database role:** `gsmc exec postgres psql -U gsm -d gsm -c '\du gsm_app'` shows the role without `Superuser`.
   - **Files:** open a KYC document or an invoice PDF from the console: the browser goes to `https://<FILES_HOST>/gsm-files/…` and downloads
     it. `curl -s -o /dev/null -w '%{http_code}' https://<FILES_HOST>/gsm-files/x` answers 404 (no signature).
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
# 3. apply the new migrations with the new image and set the application role's privileges for the new tables (one-off; the API never
#    migrates on boot; run it after every release, before step 4)
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

### Release with decision 048 (payments integrity)

The migration of this release (`payments_integrity`) first checks that no two orders share a checkout session; when some do, it stops,
changes nothing and names them (see "One order per checkout session" in section 6). Before step 3, and once more after step 4:

- The card API key can read PaymentIntents and Checkout Sessions: a storefront order is created only after the webhook has read the
  payment's record. The gateway account's API version must support `expand[]=latest_charge` (the driver sends no version header).
- `gateway_card_details_unavailable_total` is 0 on the metrics page before the release: from now on a record that cannot be read answers
  502 (the gateway delivers the event again) and, after 24 hours, holds the payment for staff.
- `STORE_BASE_URL` and `PORTAL_BASE_URL` are the real addresses of the shop and the portal: `/pay` refuses a return address on any other
  origin.
- Storefront payments that were already held for staff before this release appear as findings of the money integrity check on its first run.
- `supportsRefunds` is off by default for a payment method: until it is switched on, money of a held or late payment is paid back by hand.

### Release with decision 050 (risk inputs)

Additive (two nullable or defaulted columns); the usual order applies. What to do around it:
- **Tax windows.** Before the first tax window is created, create one for every country the shop sells to (0 % with the type "no tax"
  where no tax is due, in Settings → Tax): from then on a checkout for a country without a window in force is refused (`422` on
  `country`), and a payment whose card or visitor country differs from the declared one is held for review (this hold has no rule
  switch: it applies as long as a tax window is in force). While no window is in force
  the shop sells everywhere without tax and neither rule applies. To see the windows in force:
  `gsmc exec postgres psql -U gsm -d gsm -c "select country, region, rate_percent, tax_type from tax_rates where valid_from <= now() and (valid_to is null or valid_to > now()) order by country, region;"`
- If `.env.production` sets `GEOIP_COUNTRY_HEADER`, delete it there and follow "Visitor country" (section 1): the compose file passes it from `deploy/.env`.
- After step 4: `gsmc up -d caddy` (its environment changed), then read the API's boot log for `Risk rule without an input source` lines: they
  name the rules that have no input here (the VPN or proxy signal and the blacklisted-IMEI rule always; the IP-country rule until a CDN
  supplies the header).
- A guest checkout is judged as a first order; an email blocked from a guest order may be limited to guest checkouts (the blocklist page
  shows the scope in the reason of the entry).

### Release with decision 055 (the production stack)

The one release that changes the stack itself: new networks, passwords, users and a fourth host. Do it in one sitting, in this order (the
DNS record of `FILES_HOST` can be made the day before).

**The outage of this release begins at step 6 and ends at step 9.** Step 6 stops the API and the worker and moves Postgres, both Redis,
MinIO and the search engine onto the new networks; the old API and worker run on the old network and could not reach them any more. The
shop and the console answer with errors from step 6 until `api` is healthy again at step 9. Nothing before step 6 touches a running
service.

Two rules keep the order safe on a live host:

- The compose file refuses to run a command (the nightly backup included) while a variable it needs is missing, so `deploy/.env` changes
  before the new compose file reaches the host (step 2 before step 4). The old stack's backup service reads `DATABASE_URL` and the `S3_*`
  keys from `.env.production`, and neither the role `gsm_app` nor the MinIO users exist before steps 7 and 8, so those three lines keep
  their old values until step 8.
- `gsmc run --rm migrate ...` and `gsmc run --rm minio-admin ...` are written with `--no-deps`. Without it compose also starts the services
  they depend on and recreates the ones whose definition changed, which would move Postgres and MinIO onto the new networks while the old API
  and worker still run on the old one: the outage would begin inside a "check" or a "create a user". With it these commands touch nothing but
  their own container, so the data services must already be up: step 6 does that, on purpose. For the same reason the nightly backup must not
  fire between step 4 and step 9 (it depends on Postgres and would recreate it): comment its cron line out for the sitting, and put it back
  after step 10.

1. **Back up with the old stack, before any file changes** (section 4): `gsmc run --rm -T backup pg-backup.sh`, then wait for it to finish.
   Take it while `.env.production` still has its old values: the old backup service connects with the `DATABASE_URL` in that file.
2. **Add to `deploy/.env`:** `FILES_HOST`, `REDIS_QUEUE_PASSWORD`, `REDIS_CACHE_PASSWORD`, `MINIO_APP_USER`, `MINIO_APP_PASSWORD`,
   `MINIO_BACKUP_USER`, `MINIO_BACKUP_PASSWORD` (section 2, step 1; the old compose file ignores them), and create the DNS record of
   `FILES_HOST` if it does not exist (Caddy asks for its certificate at step 9). Make `MINIO_ROOT_PASSWORD`, `MINIO_BACKUP_PASSWORD` and `TYPESENSE_BOOTSTRAP_KEY` with `openssl rand -hex 24` (or `-hex 32`):
   only compose reads them, so the application's checks never see them.
3. **Prepare `.env.production` except three lines:** both Redis URLs with their passwords, `S3_PUBLIC_ENDPOINT=https://<FILES_HOST>` and
   `TRUST_PROXY=172.30.1.2,172.30.1.3`, and every other value the new rules ask for. **Leave `DATABASE_URL`, `S3_ACCESS_KEY_ID` and
   `S3_SECRET_ACCESS_KEY` as they are** until step 8 (the reason is above); write the new ones (`DATABASE_URL` as the user `gsm_app` with a new
   password, the `MINIO_APP_*` values) in a note for step 8. `grep -n CHANGE_ME deploy/.env .env.production` must print nothing.
4. **`git pull`** (from here every `gsmc` command uses the new compose file), set `BACKEND_IMAGE` to a new tag in `deploy/.env` and build
   (`gsmc build api`; section 2, step 2).
5. **Check the existing values against the new rules in the new image before anything is replaced.** The check reads no database, so it runs
   with `--no-deps`:
   `gsmc run --rm --no-deps migrate bun -e "const { loadConfigOrExit } = await import('./src/config/index.ts'); loadConfigOrExit(); console.log('configuration ok')"`.
   It prints every refusal at once (a `METRICS_TOKEN` or search key under 32 characters, an S3 secret under 16, a `TRUST_PROXY` that is missing
   or wrong, the argon2 floor, an `http:` object store that is not inside the stack). Fix them and run it again. A `DATABASE_OWNER_URL` refusal
   means `POSTGRES_PASSWORD` is under 16 characters: set a longer one inside Postgres first (section 5). A `TRUST_PROXY` that holds a CDN's ranges
   is accepted, with a warning at every boot.
6. **The outage begins.** Stop the API and the worker (the worker drains its running jobs for up to 25 s), then start the data services,
   which recreates them on the new networks:
   `gsmc stop api worker`, then `gsmc up -d postgres redis-queue redis-cache minio minio-init typesense`. Wait until `gsmc ps` shows `postgres`
   and both Redis healthy.
7. **Create the MinIO users** (section 2, step 3: the `minio-admin` block, once, with `--no-deps`).
8. **Switch the three lines** of `.env.production` to their new values, run the check of step 5 again, then
   `gsmc run --rm --no-deps migrate`: it applies the migrations and creates the role `gsm_app` with the password of `DATABASE_URL`
   (`Application role gsm_app: created`).
9. **`gsmc up -d`** creates the API, the worker, the console and Caddy on the new networks (Caddy gets its new Caddyfile and a certificate for
   `FILES_HOST` on its own; add `--profile site` if the storefront runs). **The outage ends** when `gsmc ps` shows `api` healthy and
   `curl -s https://<ADMIN_HOST>/health?strict=1` answers `ok`.
10. Remove the old network once nothing uses it: `docker network rm gsm_gsm`. Put the cron line of the nightly backup back.
11. Check: section 2.5 (the client address, the role, the files host), and that the worker still reaches the outside from its new networks:
    `gsmc exec worker bun -e "console.log((await fetch('https://example.com')).status)"` prints 200.
12. Set the rules of the offsite bucket and give the nightly key write-only rights (section 4); if the old plaintext `files/` prefix exists
    offsite, delete it with the purge key (`rclone purge`, section 4) once the encrypted copy under `files-age/` is complete.

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

### Release with decision 049 (manual money and exchange rates)

Every command of the image refuses to start in production when `FX_PROVIDER` is `openexchangerates` (its default) and `FX_API_KEY` is not
set. Before step 3, put the provider key in `.env.production`, or set `FX_PROVIDER=manual` to keep the rates by hand. The migration stops
when a receipt file backs more than one pending or approved payment (see "One receipt, one payment" in section 6). Before migrating a
database that holds real receipts, run this statement read-only (`gsmc exec postgres psql -U gsm -d gsm`, then paste it) and resolve
what it lists; no rows means the migration does not stop on this rule:

```sql
SELECT receipt_file_id FROM payments
WHERE receipt_file_id IS NOT NULL AND status IN ('pending', 'approved')
GROUP BY receipt_file_id HAVING count(*) > 1
ORDER BY receipt_file_id LIMIT 20;
```

After step 4, open the Currencies page: a rate older than 48 hours is not offered in the shop until you confirm it (enter
the rate; the same number restarts its age), or set `fx.max_rate_age_hours` (`PATCH /admin/settings`, 1 to 720 hours; only an Owner changes it).

## 4. Backups and the restore drill

What is saved, every night: a full dump of the database (`pg_dump`, custom format, as the owner role), encrypted with `age` for the public key
`BACKUP_AGE_RECIPIENT`, uploaded to the bucket `BACKUP_S3_BUCKET` (use another provider or account than the server: a backup on the same disk
is not a backup). The dump is made into a file in the backup container first (it needs free disk space of about its own size), copied to
`db/incoming/`, checked there, and only then copied to `db/daily/` (and, on the first day of each month, to `db/monthly/`), so the daily folder holds
complete dumps only. The files bucket is copied encrypted with the same key, object by object, to `files-age/` (never synced: a file deleted by
mistake stays in the backup until the purge below). **How long copies are kept is a rule of the bucket, not of the script** (below). **Not
saved:** the queue Redis (its append-only file survives restarts; a job lost with its data is not re-created from `outbox_events`: see "If the
queue Redis loses its data" in section 6), the cache Redis and the Prometheus history.

**Make the age key pair once, on your own computer, not on the server:**

```bash
age-keygen -o gsm-backup.agekey      # prints the public key "age1..."; put it in BACKUP_AGE_RECIPIENT of deploy/.env
```

The private key (`gsm-backup.agekey`) is kept offline by two people (section 5). Without it a backup cannot be read.

**The offsite bucket's rules** (set them at the provider; the nightly key cannot change them): versioning on; an object lock with a default
retention of 30 days where the provider offers it; lifecycle rules: `db/incoming/` expires after 2 days, `db/daily/` after
`BACKUP_RETENTION_DAYS` (30), `db/monthly/` after 400 days, noncurrent versions after 30 days, and incomplete multipart uploads are aborted after
2 days. **The nightly key** (`BACKUP_S3_ACCESS_KEY_ID`) may list, read and write objects, nothing else: no delete, no version delete, no lock or
lifecycle change, so a stolen server cannot destroy the past copies. **The purge key** may also delete; it never stays on the server. A provider
without lifecycle rules: set `BACKUP_PRUNE=1` (the script then deletes the daily dumps older than `BACKUP_RETENTION_DAYS` and the monthly copies
beyond `BACKUP_MONTHLY_KEEP`) and give the nightly key delete rights; that is weaker, because the key can then delete the backups.

The backup service reads the files bucket with the read-only user `MINIO_BACKUP_USER`. With an external S3 for the files (the `S3_*` lines of
`.env.production`), change the `S3_*` lines of the `backup` service in `deploy/compose.prod.yaml` to that store and a read-only key.

**Schedule** (the host's cron; `-T` is needed because cron has no terminal):

```cron
15 1 * * * cd /opt/gsm && docker compose -f deploy/compose.prod.yaml --env-file deploy/.env run --rm -T backup pg-backup.sh >> /var/log/gsm-backup.log 2>&1 && docker compose -f deploy/compose.prod.yaml --env-file deploy/.env run --rm -T backup files-mirror.sh >> /var/log/gsm-backup.log 2>&1
```

Each script prints one JSON line per step and exits non-zero on any failure (an empty or missing upload fails the run, and so does a listing of the offsite copy that fails: the files mirror never takes an unreadable target for an empty one and copies everything again; only a missing `files-age/` folder on the very first run counts as empty). Make the host
tell you when the exit code is not zero (cron mails, or a monitor that reads the log). Try a script without doing anything:
`gsmc run --rm -e BACKUP_DRY_RUN=1 backup pg-backup.sh` prints the commands.

**Purge after an erasure or a retention run** (monthly, and within the deadline of an erasure request). The nightly copy never deletes, so the
encrypted copy of a file that no longer exists at the source stays until this runs. Run it by hand with the purge key, which never stays on the
server, exported from a prompt, dry run first:

```bash
read -rs BACKUP_PURGE_S3_SECRET_ACCESS_KEY; export BACKUP_PURGE_S3_SECRET_ACCESS_KEY
export BACKUP_PURGE_S3_ACCESS_KEY_ID=<the purge key id>
gsmc run --rm -e BACKUP_DRY_RUN=1 -e BACKUP_PURGE_S3_ACCESS_KEY_ID -e BACKUP_PURGE_S3_SECRET_ACCESS_KEY backup files-purge.sh   # lists what it would delete
gsmc run --rm -e BACKUP_PURGE_S3_ACCESS_KEY_ID -e BACKUP_PURGE_S3_SECRET_ACCESS_KEY backup files-purge.sh
```

It deletes only the copies whose object is gone from the application's bucket, and refuses to run when the listing of that bucket is empty. With
versioning on, the old versions of a deleted copy disappear when the noncurrent-version rule expires them (30 days): say this limit in the
privacy notice. If an older release left a plaintext `files/` prefix offsite, remove it once with the purge key (`rclone purge`).

**Restore a file** from the encrypted copy (the age key as in the restore below; the application's own MinIO user writes it back):

```bash
set -a; . deploy/.env; set +a
gsmc run --rm -e S3_ACCESS_KEY_ID="$MINIO_APP_USER" -e S3_SECRET_ACCESS_KEY="$MINIO_APP_PASSWORD" -v "$PWD/age.key.restore:/age.key:ro" backup bash -c \
  '. /opt/backup/lib.sh; setup_backup_remote; setup_files_remote; rclone cat "backup:$BACKUP_BUCKET/files-age/<key>.age" | age --decrypt -i /age.key | rclone rcat "files:$S3_BUCKET/<key>"'
```

**Restore into a new, empty database** (never over the live one; the script refuses a database that already has tables unless you
pass `--force`, it has no default target, and it refuses a target that connects as a superuser unless you pass `--as-superuser`). Restore as
the owner of a database made for the purpose: a dump's statements run with the rights of the restoring role, so a dump that was tampered
with can do no more than that role can. Use `--as-superuser` only for a dump you made yourself and checked by name and size against
`/var/log/gsm-backup.log`.

The backup image runs as uid 10001, and `age-keygen` writes the key file readable by its owner only (mode 0600), so the container
cannot read your copy. Give it its own copy for the restore and remove it afterwards:

```bash
sudo install -m 0400 -o 10001 -g 10001 gsm-backup.agekey ./age.key.restore
gsmc exec postgres psql -U gsm -d gsm -c "create role gsm_restored login password '<a new password>' nosuperuser nocreatedb nocreaterole" -c 'create database gsm_restored owner gsm_restored'
gsmc run --rm -v "$PWD/age.key.restore:/age.key:ro" backup pg-restore.sh \
  db/daily/gsm-<UTC stamp>.dump.age "postgres://gsm_restored:<that password>@postgres:5432/gsm_restored" --identity /age.key
sudo shred -u ./age.key.restore
```

To go live on the restored copy: stop `api` and `worker`, rename the databases (`gsmc exec postgres psql -U gsm -d postgres -c 'alter database gsm
rename to gsm_old' -c 'alter database gsm_restored rename to gsm'`), hand the restored objects to the owner role (`gsmc exec postgres psql -U gsm -d gsm
-c 'reassign owned by gsm_restored to gsm'`, then drop the role), run `gsmc run --rm migrate` (it sets the application role's privileges on the
restored tables), start `api` and `worker`, and check. No file of configuration changes.

**Monthly restore drill** (do it on the first working day of the month, and once before go-live): it restores the newest daily dump, as a
temporary role that is not a superuser, into a scratch database that role owns next to the live one, checks that the ledger lines sum to
zero and that the migrations match the code, prints the row counts and drops the scratch database and the role. It needs the owner role (it
creates the role). The role's password is made for the run and never printed. A dump object that needs a superuser fails the drill with its name
(`pg_restore --exit-on-error`): the first real drill shows whether the dump has any.

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
| `TOKEN_PEPPER` | everybody is signed out; every API key and every open sign-in, reset, invitation and Telegram link stops working; the cache is emptied too (every entry becomes a miss, decision 055) | change only as a planned operation; every API and worker process must have the same value |
| `LOOKUP_HASH_KEY` | every stored lookup stops matching: blocked e-mails, cards and IMEIs pass the blocklist again, the IMEI history and the duplicate checks of inventory codes and open orders forget what they knew, unsubscribe links in sent mails stop working, Idempotency-Key replays of the last 7 days and the event ids of pending merchant webhook deliveries change, and every checkout, tracking and ticket link stops working | never change it (production refuses to start with a different key); on an installation that has data it equals the `TOKEN_PEPPER` the data was made with (section 3) |
| `CSRF_SECRET` | forms that are open fail once and are sent again | any time |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram's calls are refused until the webhook is registered again | change it, restart api, run `scripts/telegram-webhook.ts` (section 6); the release of decision 054 gives it a new value (section 3) |
| `TELEGRAM_BOT_TOKEN` | Telegram messages fail until the new token is set; the webhook must be registered again | change it at BotFather and in `.env.production` together, then run the script |
| `TURNSTILE_SECRET_KEY` | the shop's protected forms refuse visitors until the site key and the secret belong to one widget | change both together |
| `MAIL_SMTP_URL` credentials | mails fail and are retried until the right ones are set | change at the provider and in `.env.production` together |
| `FX_API_KEY` | the hourly rate refresh fails; stored rates stay | any time |
| `SENTRY_DSN` | errors go to the new project (or nowhere) | any time |
| `METRICS_TOKEN` | Prometheus cannot scrape until `deploy/secrets/metrics_token` has the same value | change both together |
| `POSTGRES_PASSWORD` (the owner role `gsm`) | `migrate`, `setup` and the backups are locked out | change it inside Postgres first (`gsmc exec postgres psql -U gsm -d gsm`, then `\password gsm`), then in `deploy/.env`; the stored password of an existing database does not follow the variable |
| the application role's password (`DATABASE_URL` of `.env.production`) | the API and the worker cannot connect | change it in `DATABASE_URL`, run `gsmc run --rm migrate` (it sets the new password on the role), then restart `api` and `worker` |
| `REDIS_QUEUE_PASSWORD`, `REDIS_CACHE_PASSWORD` (`deploy/.env`) | the API and the worker cannot reach Redis until both files agree | change it in `deploy/.env` and in the matching URL of `.env.production` together, then recreate the Redis service, `api` and `worker` |
| `MINIO_ROOT_*` (`deploy/.env`) | the MinIO containers and `minio-admin` | change it in `deploy/.env`, recreate `minio`; the application's and the backups' users are separate and unaffected |
| `MINIO_APP_*`, `MINIO_BACKUP_*` | file uploads and downloads fail (the API shows storage down), or the file copy of the backups fails | change them with `minio-admin admin user add` (section 2, step 3) and in the files that hold them (`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` of `.env.production`; `deploy/.env`), then recreate `api` and `worker` |
| the backup purge key (offsite bucket) | the purge cannot delete | held offline by two people; it never stays on the server (section 4) |
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
  Referer, and leaves out credential headers. Docker keeps at most 5 × 20 MB of logs per container (the compose file sets the `local` log
  driver for every service, decision 055); a rotation in `/etc/docker/daemon.json` (`{"log-driver":"local","log-opts":{"max-size":"20m","max-file":"5"}}`)
  is still useful for any other container on the host.
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
reconcile, within 15 minutes); storefront receipts (made at their first download); every scheduled job; and (decision 055) within about 15
minutes, through `lost_work_reconcile`: storefront refunds waiting for their gateway call, merchant webhook deliveries that were already
created, bulk publish runs (preparation, apply, switch) and Quick add runs. These do not come back by themselves: mails sent by a job of
their own that had not run yet (sign-in and password links, invitations, ticket mails, abandoned-checkout reminders: the person asks
again), merchant webhook events whose fan-out job had not run yet (no delivery was created, so nothing re-arms it: order status, invoice
paid, low balance and price change webhooks), event notifications whose planning job had not run yet (no notification row exists), a
waiting price change scan (the next price change asks for one), the one-time category name clean-up of migration 0046, the Quick add
hand-over to the bulk publish (the Quick add progress offers to prepare the preview by hand), and the failed jobs kept for staff (the
failed list is empty afterwards).
A refund asked for three times without an answer, or whose send started more than 20 hours ago, is failed with the note "...check the
payment at the gateway before you send it again": check the payment at the gateway before you press retry (the retry sends under the same
gateway key, so the gateway does not refund twice for one key). A publish or Quick add run asked for three times stays stalled: start it
again from the console. Note the affected orders, refunds and runs before you change anything.

**Database time limits** (decision 055). Every connection of the API and the worker carries three limits: a statement runs at most
`DATABASE_STATEMENT_TIMEOUT_MS` (default 15 s), waits for a lock at most `DATABASE_LOCK_TIMEOUT_MS` (5 s), and a transaction left idle is
ended after `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` (60 s); `0` means no limit. `deploy/compose.prod.yaml` gives the worker 300 s and 30 s
(its jobs read more per statement) and keeps its 60 s idle limit. The money reports, the client statement and the ledger reconcile raise
their own statement limit to 2 minutes (never lower). A request that hits a limit answers `503` with "The database took too long to answer.
Try again in a moment." and a warning line that names the SQLSTATE (`57014` statement, `55P03` lock, `25P03` idle transaction; `57P01` a
session ended by an administrator or a restart). When a report or a job keeps hitting a limit, raise the setting for that container (the
`environment` of the worker in the compose file, or `.env.production` for the API), not for every process, and say which query it was.

**Cache errors that mean something** (decision 055). `cache_errors_total{operation="mac"}` (an error line "Cache mac failed ... integrity
check") means an entry in the cache Redis was not written by this application with this `TOKEN_PEPPER`: tampering, or two processes with
different peppers. Check who can reach the cache Redis and that every API and worker has the same value. `operation="invalidate"` (an error
line "Cache invalidation failed for <family> after 3 attempts") means a delete that follows a security change (a revoke, a role change, a
suspension) did not reach Redis; the old entry lives until its TTL (60 s for sessions and keys, 300 s for roles) unless Redis comes back.
A short burst of `operation="decode"` right after this release is expected: entries of the previous release are read once as unreadable
and replaced.

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

**Exchange rates** (decision 049). The worker refreshes them every hour. A provider rate that moved more than
`fx.max_refresh_move_percent` (default 20) from the stored one is not used: the old rate stays, the currency shows as stale on the Currencies
page and in the dashboard, the shop stops offering it (buyers see USD), and the refresh logs an error (and reports it to Sentry when it is on),
once per hold. Check the rate; if the move is real, enter the new rate on the Currencies page: the currency is offered again at once. A rate
older than `fx.max_rate_age_hours` (default 48) is not offered either; a shop that keeps rates by hand (`FX_PROVIDER=manual`) confirms them
at least that often or raises the setting (`PATCH /admin/settings`, 1 to 720 hours). A checkout keeps the rate it locked. The held rate's
line in the refresh answer (`failed`) names the provider's rate, the stored rate, the move judged and the bound. `fx.max_refresh_move_percent`,
`fx.max_rate_age_hours` and `wallet.customer.adjust_approval_limit` are changed by an Owner only; another staff member with `settings:update`
gets 403.

**Manual money limits** (decision 049). A staff member's credits within 24 hours, per kind of wallet, and any single debit, are capped by
the approval limit (`wallet.adjust_approval_limit` for merchants, `wallet.customer.adjust_approval_limit` for customers); above it only an
Owner adjusts. A credit limit above the merchant limit, and approving the payment of an invoice one issued oneself, also need an Owner.
A merchant holds at most five unpaid top-up invoices younger than 24 hours or with a receipt in review, and five receipts in review.
Commissions never pay more than an order's margin.

**One receipt, one payment** (decision 049). A receipt file, or a copy with the same content, backs one pending or approved top-up. If the
migration of decision 049 stops on this rule it names the files (the statement of the release note lists the same ones before you migrate):
for each, look at the payments in the console (Finance, Payments) and decide which of them the transfer backs.

- A pending payment that the transfer does not back is rejected in the console, with a reason. A rejected payment releases its receipt.
- If the transfer backs the pending payment and not an approved one, take back the approved credit with a debit adjustment, clear the
  approved payment's link as shown below, then approve the pending payment.
- If two payments are approved, check the bank statement and take back what was credited twice with a debit adjustment. Then, for the
  payment that loses the link, first write the file id into its review note, and only then clear its `receipt_file_id`:

  ```bash
  gsmc exec postgres psql -U gsm -d gsm -c "update payments set review_note = concat_ws(' ', nullif(review_note, ''), 'Receipt file <file id> was also attached to payment <other payment id>; the link was removed at the release of decision 049.') where id = <payment id>;"
  gsmc exec postgres psql -U gsm -d gsm -c "update payments set receipt_file_id = null where id = <payment id> and receipt_file_id = <file id> and review_note like '%Receipt file <file id> was%';"
  ```

  Each command must answer `UPDATE 1`. If the second answers `UPDATE 0`, the note is missing: do not clear the link. A proof is never
  removed from an approved payment without that note, because the note is what keeps the trail of what backed the credit.

Then migrate again.

**Storefront payments held for staff** (decision 048). A storefront confirmation that cannot pay its checkout is held: the gateway's record
does not say paid, says another amount, currency or checkout, the event does not state its amount or currency, the checkout cannot be found,
the gateway reference belongs to another payment, or the record could not be read for 24 hours. Nothing is booked for it. When money arrived
and the gateway can refund (a card method with refunds switched on), the whole amount is sent back at once by the refund job; that return is a
refund without an order, so the Refunds page does not list it and a failed one cannot be retried from the console. Every held payment whose
money is not back is listed under System health, Integrity, "Every confirmed payment has an entry" (with its gateway reference), and raises the
`ledger.mismatch_count` alert when such a rule exists: nightly at 02:30 UTC, or at once with "Run now". What to do: find the reference in the
gateway's dashboard and pay the money back there (or confirm that none arrived), then close the payment with
`POST /admin/held-payments/:id/close`, outcome `returned` or `not_received` and a note (the console gets a screen later). A payment whose
gateway record showed its money received (another amount or currency, no checkout, money refunded or disputed since) can only be closed
`returned`: `not_received` answers `409` ("The gateway's record shows this payment was received: send it back, then close it as
returned."). A payment held with "The gateway's record shows this payment was refunded in full after it was made." or "The gateway's record
shows this payment is disputed." had its money go back or contested at the gateway, and nothing is sent back from here: check the gateway's
dashboard, then close it `returned` with a note of what the gateway did (for a dispute, once it is decided). A payment held with "The
gateway's record shows part of this payment was refunded after it was made." still has the rest of its money at the gateway, and nothing is
sent back from here either: pay back what is left at the gateway's dashboard first, and only then close it `returned`, with a note of what
was paid back. A payment held before this rule accepts both outcomes. A payment held
with "The gateway's record of this payment belongs to another checkout." received nothing of its own: the money is that other checkout's,
which captures it with its own confirmation, so close it `not_received` and pay nothing back. An automatic return the gateway fails after it
had completed is failed again, and its payment is listed again: pay it back at the gateway's dashboard, then close it `returned`. The gateway's fee
of a returned payment is not booked. A gateway that cannot be reached makes storefront confirmations wait: its delivery log shows 502 answers,
and they are captured when the gateway delivers again; a confirmation that still cannot be checked after 24 hours is held. A payment made more
than 30 minutes after its checkout's price lock ended is refunded at once, or waits in the risk queue when its method cannot refund.

**Card top-ups checked against the gateway's record** (decision 048). Before a card top-up credits itself, the job reads the gateway's
record of the payment: it must say paid, show the invoice's amount and currency as received, show nothing refunded or disputed since and,
when it states the reference of its checkout, name this invoice. Otherwise the top-up waits on the Payments page for review with a note
that starts "The gateway's record ...": look the payment up in the gateway's dashboard, approve it only when the gateway holds the
invoice's amount for this invoice, else reject it and settle what really arrived by hand. A gateway that cannot be reached still only delays
the credit.

**Refunds of a charged-back payment** (decision 048). When a dispute is lost (the gateway's event, or staff accepting the loss), the
refunds of the payment that the gateway has not paid (a request, a refund waiting to be sent, one that failed) are closed (`rejected`,
"Not sent: the payment was charged back.") and their journals are reversed: the card network already gave the money back. A refund whose
last send got no answer (a timeout or an error at the gateway: it shows `failed`, and the gateway may still have made it) is closed and
reversed with the others. So when a chargeback is booked, check the gateway's dashboard for each such refund of the payment (the order's
timeline shows its failed send): if the gateway made it, the buyer got the money back twice while the books show it leaving once. A refund
the gateway completed before stays, and the books then show both, as the gateway paid both. A refund the gateway had taken and not answered
yet stays `processing` until it answers; if it then completes, look the payment up in the gateway's dashboard.

**A confirmation for a closed top-up invoice** (decision 048). A top-up confirmation for an invoice that is already paid or void is recorded on
the Payments page for review and is never credited: refund it at the gateway or adjust the wallet by hand, then reject it. The reason typed when
rejecting is mailed to the customer, and a void top-up then shows as rejected.

**One order per checkout session** (decision 048). The migration of feature 38 stops when two orders share a checkout session and names the
sessions. For each one: keep the order that `checkout_sessions.order_id` names, refund or reject the other order from the console, take a
backup, set that order's `checkout_session_id` to `NULL` (one `UPDATE orders set checkout_session_id = null where id = <id>` per order),
then run the migration again.

**Search engine** (feature 29, decision 038). The English search of the shop header and the results page runs on one Typesense node
(`typesense` in `deploy/compose.prod.yaml`, pinned by digest, on the internal `data` network only: no published port, no Caddy route, never
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
- [ ] `MAIL_SMTP_URL` and `MAIL_FROM` are set in `.env.production`. In production mail goes over TLS only: `smtps://`, or `smtp://` on a port that offers STARTTLS (a server that
      offers none cannot be used: every send fails and is retried).
- [ ] A test mail reaches an address at another provider (use a password reset of a test account) and does not land in spam.

**DNS and TLS**
- [ ] The four names (`SHOP_HOST`, `ADMIN_HOST`, `API_HOST`, `FILES_HOST`) resolve to the server, and ports 80 and 443 are open.
- [ ] `https://<SHOP_HOST>`, `https://<ADMIN_HOST>` and `https://<API_HOST>` open with a valid certificate (Caddy needs a minute after the first start; `gsmc logs caddy` shows why when not), and `https://<FILES_HOST>/gsm-files/x` answers 404.

**Provider accounts**
- [ ] Cloudflare Turnstile: a widget for `SHOP_HOST`; the secret in `TURNSTILE_SECRET_KEY`, the site key given to the storefront, which
      shows it on the shop forms and on the merchant sign-in and forgot-password forms (`TURNSTILE_MERCHANT_AUTH` is on by default in
      production, decision 052; `false` switches the merchant forms' check off).
- [ ] Exchange rates: an API key in `FX_API_KEY` (`FX_PROVIDER=openexchangerates`, required in production), or `FX_PROVIDER=manual` and the
  rates entered by hand at least every 48 hours (decision 049).
- [ ] Telegram bot (optional): token, username and webhook secret in `.env.production`, then run `scripts/telegram-webhook.ts` (section 6).
- [ ] Object storage for backups on another provider, with versioning, an object lock and the lifecycle rules of section 4; two keys: the nightly one (list, read and
      write, never delete; in `deploy/.env`) and a purge key (may delete; kept offline); and the two key holders named.
- [ ] A Sentry project (optional) and its DSN.
- [ ] The payment provider chosen by the owner (decision D-6) and its keys entered in the console, never in a file.
- [ ] The provider sends every checkout, refund and dispute event to `/webhooks/payments/<code>`, and refunds are switched on for the method
      (`supportsRefunds`) so a payment that cannot be used goes back by itself.
- [ ] The card API key can read PaymentIntents and Checkout Sessions, and the account's API version supports `expand[]=latest_charge`.
- [ ] An alert rule on `ledger.mismatch_count` above 0 exists (it also reports storefront payments held for staff; only the demo seed
      creates one).

**Before go-live**
- [ ] Every check of section 2.5 passed, including the client-address check.
- [ ] A backup ran and a restore drill passed (section 4), and the first-day-of-month copy is understood.
- [ ] The offsite bucket's rules are set and the nightly key cannot delete (try `rclone deletefile` with it: it must be refused).
- [ ] The application connects as `gsm_app` (not a superuser, not an owner: section 2.5), and `TRUST_PROXY` is the two fixed addresses.
- [ ] The files host answers a download from the console, and `grep -n CHANGE_ME deploy/.env .env.production` prints nothing.
- [ ] `ENCRYPTION_KEYS` and the backup private key exist offline in two places, with two people.
- [ ] `LOOKUP_HASH_KEY` is set (on an installation with data: the value of its `TOKEN_PEPPER`).
- [ ] `COOKIE_SECURE=true`, `REFERENCE_DOCS=staff`, the dev seed was never run on this database.
- [ ] `.env.production` has no `CORS_ORIGINS`, and the four base URLs are https (decision 045).
- [ ] Every country the shop sells to has a tax window in force (0 % "no tax" included): once any window exists, any other country is
      refused at checkout (decision 050).
- [ ] Every supplier address starts with https://, and suppliers.allowPlainHttp is not true (only an Owner can change it).
- [ ] A timer or cron entry runs the nightly backup and something tells you when it fails.
- [ ] The host has disk space for the volumes (database, files, Prometheus) and for one dump at a time in the backup container (the compose file already limits the logs to 5 × 20 MB per container).

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
   `set -a; . deploy/.env; set +a; gsmc exec -e REDISCLI_AUTH="$REDIS_CACHE_PASSWORD" redis-cache redis-cli DEL gsm:production:identity:ip-rules:active gsm:production:platform:settings:all`
4. Sign in, check the access settings, and note what you changed: these steps write no audit row.
