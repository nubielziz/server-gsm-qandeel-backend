# Feature 24D: Production readiness (ROADMAP phase 5 ops; D6 §8, D-5, D-7, D-8)

Plan by Fable 5.2 (planner), 2026-11-10, against backend `main` @ `bd32229`. Implementer: one Sonnet 5.5, slices A to D.
Worktree `../backend-24d` on `feat/backend-24d`, test database `gsm_24d_test`, Redis DB 9 (LEAD-DECISIONS §1). No route, no
table, no console change, no W0 dependency: it may branch from `main` at once. Read first: `backend/CLAUDE.md`,
`docs/briefs/_common.md` (its frontend-cwd and Serena lines are stale), `CONTRIBUTING.md`, decisions 001, 012, 013, 015, 033,
`docs/briefs/P4b-first-run.md` (what `bun run setup` does). Paths are backend-relative.

**Hard limits for this feature.** No feature code. The implementer may run `docker build` (the two images below) and
`docker compose -f deploy/compose.prod.yaml config`; **never** `docker compose up|run|down`, never `docker run`, never anything
against the dev containers, :3000, :3100 or the `gsm` databases; no `db:migrate`, `db:seed`, `src/main.ts` in the worktree; no
git command that changes state; no agents. Every secret in a committed file is a placeholder. `bun run check` once at the end.

## 1. What exists and what is missing

| # | Requirement | Status | Evidence (verified in the code) |
|---|---|---|---|
| 1 | Backend image (api + worker) | missing | No `Dockerfile` or `.dockerignore` in `backend/`. Processes: `bun src/main.ts`, `bun src/worker.ts` (`package.json:14-16`). Runtime needs only `dependencies`: migrations use `drizzle-orm/node-postgres/migrator` (`src/infra/db/migrate.ts:4-5,9`, folder `drizzle/`), not drizzle-kit. `bunfig.toml` holds test settings only. Bun must start from the repo root (it reads `tsconfig.json` for the decorator flags, `PROGRESS.md:590`) |
| 2 | Graceful shutdown | exists in code | Both entry points call `enableShutdownHooks(['SIGTERM', 'SIGINT'])` (`src/main.ts`, `src/worker.ts`); the worker's drain grace is 25 s (`src/infra/queues/queue-workers.service.ts:39`), so a container needs `stop_grace_period: 30s` (`PROGRESS.md:564`) |
| 3 | Health | exists | `GET /health` always 200 with `status`; `GET /health?strict=1` is 503 when Postgres is down (decision 015). The worker serves `/metrics` on `WORKER_METRICS_PORT` (9464); production requires `METRICS_TOKEN` (`src/config/env.ts`: "is required in production") |
| 4 | Production compose and Caddy | missing | Only the dev `compose.yaml` (Postgres 18.6, queue Redis `--appendonly yes --appendfsync everysec --maxmemory-policy noeviction`, cache Redis `--save "" --appendonly no --maxmemory 256mb --maxmemory-policy allkeys-lru`, MinIO + bucket init, Prometheus, Mailpit; every port published, dev passwords). No Caddyfile. Prometheus scrapes `host.docker.internal` without a token (`docker/prometheus/prometheus.yml`) |
| 5 | Production env template | partial | `.env.example` marks 19 variables "REQUIRED in production"; `env.ts` refuses the dev secrets and `COOKIE_SECURE=false` there. No production template |
| 6 | First run and migrations | exists | `bun run setup` (migrates, creates what is missing, first admin from a prompt; allowed in production, idempotent), `bun run db:migrate` (`scripts/db-migrate.ts`). `scripts/setup.ts` imports only `src/**` and `scripts/lib/{first-run-flow,first-admin-prompt,stdin-password,terminal-prompter}.ts` |
| 7 | Backups and restore | missing | No dump, mirror or restore script or document anywhere |
| 8 | Operations document | missing | README has "First run on a server"; nothing on deploy, upgrades, backups, key custody |
| 9 | Sentry | inert | `SENTRY_DSN` is parsed into `config.observability.sentryDsn` (`env.ts`) and read by nothing; no Sentry package; decision 015 says "unexpected 5xx only". Unexpected errors are logged in one place (`src/common/errors/exception.filter.ts:105-110`, the `logAsError` branch); final job failures in one place (`queue-workers.service.ts:166-182`) |
| 10 | Proxy trust | exists (config) | `TRUST_PROXY` hop count or address list; a hop count is only safe when the port is reachable solely through the proxies (`PROGRESS.md:591-592`). `CORS_ORIGINS` must hold the browser origins even same-origin (the Origin check of public `/client` POSTs, handoff §8.3 trap 2) |

## 2. Design

### 2.1 Topology: A, one browser origin per audience with path routing (D6 D-5)

| Host | Serves | To the API (Caddy `reverse_proxy api:3000`) |
|---|---|---|
| `SHOP_HOST` (e.g. `shop.example.com`) | the storefront (Next server, container `site`) | `/client/*`, `/store/v1/*` |
| `ADMIN_HOST` (e.g. `admin.example.com`) | the console bundle (container `console`, nginx) | `/admin/*`, `/health`, `/reference*` |
| `API_HOST` (e.g. `api.example.com`) | nothing else (other paths answer 404) | `/api/index.php`, `/v1/*`, `/webhooks/*`, `/docs*` |

Why A: session cookies are host-only and `SameSite=Lax` and cannot be made `None` (`docs/contract/ALIGNMENT.md:100-101`); with
the API on the page's own origin there is no preflight, the `X-Turnstile-Token` header needs no CORS change, `CSRF_COOKIE_DOMAIN`
stays unset and no cookie crosses hosts. The machine surfaces (Dhru, REST v1, webhooks, public docs) use no cookies, so a
separate `API_HOST` costs nothing and keeps their paths from colliding with site pages. `/metrics` is never routed. Topology B
(an `api.` host for browsers) is **not built**: it would need `X-Turnstile-Token` in the CORS allow list and its test; recorded
in §8.

Client address: Caddy sets `X-Forwarded-For` itself (it drops a client-sent one unless told to trust it). The compose network
has a fixed subnet and the API trusts exactly it: `TRUST_PROXY=172.30.0.0/24`. Both paths then give the visitor's address:
browser → Caddy → API, and browser → Caddy → site (server render) → API with the forwarded header
(`storefront/lib/api/server.ts` forwards it). No container port except Caddy's 80/443 is published.

### 2.2 Files (all new unless marked)

| File | Content |
|---|---|
| `Dockerfile` | multi-stage, Bun pinned to the repo's version (`oven/bun:1.4.4-slim`; if that tag does not exist use the newest `1.4.x-slim` and say so). `deps`: `COPY package.json bun.lock` → `bun install --frozen-lockfile --production --ignore-scripts`. `verify` (thrown away): the runtime tree + `RUN bun -e "await import('./src/app.module.ts'); await import('./src/worker.module.ts')"` with `NODE_ENV=production` and dummy values only if an import reads the config; it proves no production code imports a dev dependency. `runtime`: `ENV NODE_ENV=production`, `WORKDIR /app`, copies `node_modules`, `package.json`, `tsconfig.json`, `src/`, `drizzle/`, `scripts/db-migrate.ts`, `scripts/setup.ts`, the four `scripts/lib` files of row 6, and a marker from `verify` (so BuildKit runs that stage); `ARG GIT_SHA`, `ARG APP_VERSION` → `ENV`; `USER bun`; `EXPOSE 3000 9464`; `HEALTHCHECK` = `bun -e` fetch of `http://127.0.0.1:${PORT:-3000}/health?strict=1` (exit 1 unless 2xx); `CMD ["bun", "src/main.ts"]` (exec form: Bun gets SIGTERM). No `.env*`, tests, docs, `reference/`, `.lead/`, dev dependencies or secrets in any layer |
| `.dockerignore` | `.git`, `node_modules`, `.env*`, `test/`, `docs/`, `reference`, `.lead/`, `.claude/`, `.serena/`, `docker/`, `deploy/`, `coverage`, `*.md`, `*.log`, `scripts/seed/`, everything else under `scripts/` not listed above |
| `deploy/compose.prod.yaml` | §2.3 |
| `deploy/Caddyfile` | §2.4 |
| `deploy/.env.example` | compose-level values only: `SHOP_HOST`, `ADMIN_HOST`, `API_HOST`, `ACME_EMAIL`, `BACKEND_IMAGE`, `CONSOLE_IMAGE`, `SITE_IMAGE`, `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, the backup target (`BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_AGE_RECIPIENT`, `BACKUP_RETENTION_DAYS=30`, `BACKUP_MONTHLY_KEEP=12`) |
| `.env.production.example` | the app's variables for the API **and** the worker (both get the same file): every "REQUIRED in production" variable of `.env.example` with a placeholder and a one-line "how to make it" (`openssl rand -base64 32` for `ENCRYPTION_KEYS`, `openssl rand -hex 32` for `CSRF_SECRET`, `TOKEN_PEPPER`, `METRICS_TOKEN`), with the compose host names: `DATABASE_URL=postgres://gsm:<POSTGRES_PASSWORD>@postgres:5432/gsm`, `REDIS_QUEUE_URL=redis://redis-queue:6379/0`, `REDIS_CACHE_URL=redis://redis-cache:6379/0`, `S3_ENDPOINT=http://minio:9000`, `S3_FORCE_PATH_STYLE=true`, `PROMETHEUS_URL=http://prometheus:9090`; `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=172.30.0.0/24`, `CORS_ORIGINS=https://<SHOP_HOST>,https://<ADMIN_HOST>`, `PORTAL_BASE_URL=https://<SHOP_HOST>/merchant`, `STORE_BASE_URL=https://<SHOP_HOST>`, `ERRORS_BASE_URL=https://<API_HOST>/errors`, `REFERENCE_DOCS=staff`, `TURNSTILE_HOSTNAMES=<SHOP_HOST>`; the optional ones commented (FX, Telegram, alerts, `GEOIP_COUNTRY_HEADER`, `SENTRY_DSN`); a commented `CONSOLE_BASE_URL=https://<ADMIN_HOST>` with the note "required in production once feature 20 is merged" |
| `deploy/prometheus/prometheus.yml` | jobs `gsm-api` (`api:3000`) and `gsm-worker` (`worker:9464`), `metrics_path: /metrics`, `authorization: { credentials_file: /run/secrets/metrics_token }` |
| `deploy/backup/Dockerfile` | `FROM postgres:18.6-trixie` (same major as the server, so `pg_dump`/`pg_restore` match) + `apt-get install --no-install-recommends rclone age ca-certificates`; copies `scripts/backup/*.sh`; non-root user; no entrypoint magic |
| `scripts/backup/lib.sh`, `pg-backup.sh`, `files-mirror.sh`, `pg-restore.sh`, `restore-drill.sh` | §2.5 |
| `docs/OPERATIONS.md` | §2.6 |
| `src/infra/observability/` (`error-reporter.ts`, `observability.module.ts`, `index.ts`, `scrub.ts`, specs) | §2.7 |
| edits | `src/common/errors/exception.filter.ts`, `src/infra/queues/queue-workers.service.ts` (one call each), the root infra wiring that makes the reporter injectable in both processes, `package.json`/`bun.lock` (`bun add @sentry/bun`), `.env.example` (the `SENTRY_DSN` line: what is sent), `README.md` (a pointer to OPERATIONS.md), `docs/decisions/015-observability.md` (one paragraph: how Sentry is wired), new `docs/decisions/036-production-deploy.md` (topology, images, backups; take the next free number) |

### 2.3 `deploy/compose.prod.yaml`

`name: gsm`; one network `gsm` with `ipam.config.subnet: 172.30.0.0/24`; `restart: unless-stopped` and `init: true` on every
long-running service; images pinned by tag (and by digest where the dev compose already pins one); **no `ports`** except Caddy.

| Service | Definition |
|---|---|
| `caddy` | `caddy:2-alpine` pinned to the current 2.x minor; ports `80:80`, `443:443`, `443:443/udp`; volumes `./Caddyfile:/etc/caddy/Caddyfile:ro`, `caddy-data:/data`, `caddy-config:/config`; env `SHOP_HOST`, `ADMIN_HOST`, `API_HOST`, `ACME_EMAIL`; depends on `api` healthy |
| `api` | `image: ${BACKEND_IMAGE}` (`build: { context: .., dockerfile: Dockerfile }`); `env_file: ../.env.production`; command default; the image's healthcheck; `depends_on` postgres, redis-queue, redis-cache `service_healthy`; `stop_grace_period: 15s` |
| `worker` | same image; `command: ["bun", "src/worker.ts"]`; `stop_grace_period: 30s` (25 s drain); healthcheck = `bun -e` fetch of `http://127.0.0.1:9464/metrics` with `Authorization: Bearer $METRICS_TOKEN` |
| `migrate` | same image; `profiles: ["tools"]`; `command: ["bun", "scripts/db-migrate.ts"]`; `restart: "no"` |
| `postgres` | `postgres:18.6-trixie`; `POSTGRES_USER: gsm`, `POSTGRES_DB: gsm`, `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}`; volume `pgdata:/var/lib/postgresql`; healthcheck `pg_isready -U gsm -d gsm`; `command: ["postgres", "-c", "max_connections=200"]` |
| `redis-queue` | `redis:8.10.3-alpine`; **queue role**: `redis-server --appendonly yes --appendfsync everysec --maxmemory-policy noeviction`; volume `redis-queue-data:/data`; healthcheck `redis-cli ping` |
| `redis-cache` | same image; **cache role**: `redis-server --save "" --appendonly no --maxmemory 256mb --maxmemory-policy allkeys-lru`; no volume |
| `minio` + `minio-init` | the dev images and digests; root user and password from `deploy/.env`; volume `minio-data:/data`; no console port; `minio-init` creates the private bucket `gsm-files` only. A comment says how to use an external S3 instead (drop both services, set `S3_*`) |
| `prometheus` | the dev image and digest; `./prometheus:/etc/prometheus:ro`, volume `prometheus-data`, retention 15 d; the token through a compose `secrets:` entry read from the file `./secrets/metrics_token` (git-ignored; OPERATIONS.md says to write the same value as `METRICS_TOKEN`) |
| `console` | `image: ${CONSOLE_IMAGE}` (built from `../frontend-admin/Dockerfile` with `VITE_API_BASE_URL=""`); nginx on 80 |
| `site` | `image: ${SITE_IMAGE}`; `profiles: ["site"]` until the storefront session ships its image (§9); listens on 3000; env `API_BASE_URL=http://api:3000` (the name the site reads is the storefront's to confirm) |
| `backup` | `build: ./backup`; `profiles: ["tools"]`; env from `deploy/.env` + `DATABASE_URL`; run by the host's timer (§2.5) |

Volumes: `pgdata`, `redis-queue-data`, `minio-data`, `prometheus-data`, `caddy-data`, `caddy-config`.
`docker compose -f deploy/compose.prod.yaml --env-file deploy/.env.example config` must succeed (acceptance).

### 2.4 `deploy/Caddyfile`

Global options: `email {$ACME_EMAIL}`. Three site blocks, each with `encode zstd gzip`, `header Strict-Transport-Security
"max-age=31536000"`, `request_body { max_size 27MB }` (the API's multipart ceiling is 25 MiB + fields) and a JSON access log
to stdout:
- `{$SHOP_HOST}`: `@api path /client/* /store/v1/*` → `reverse_proxy api:3000`; everything else → `reverse_proxy site:3000`.
- `{$ADMIN_HOST}`: `@api path /admin/* /health /reference /reference/*` → `api:3000`; everything else → `console:80`.
- `{$API_HOST}`: `@api path /api/index.php /v1/* /webhooks/* /docs /docs/*` → `api:3000`; `respond 404` otherwise.
Never add `trusted_proxies` unless a CDN is put in front (then list its ranges and say so in OPERATIONS.md). Caddy passes
`X-Forwarded-For`, `-Proto` and `-Host` by default. `/metrics` matches no block on any host.

### 2.5 Backups (bash, `set -euo pipefail`, every command through a `run` helper that prints instead of executing when `BACKUP_DRY_RUN=1`)

- `lib.sh`: checks required variables, builds the `rclone` remote from `BACKUP_S3_*` through `RCLONE_CONFIG_*` environment
  variables (no config file with secrets), timestamps in UTC, logs one JSON line per step.
- `pg-backup.sh`: `pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" | age -r "$BACKUP_AGE_RECIPIENT" |
  rclone rcat backup:$BUCKET/db/daily/gsm-<UTC stamp>.dump.age`; refuses to run without a recipient unless
  `BACKUP_ALLOW_PLAINTEXT=1`; on the first day of a month also copies the object to `db/monthly/`; then prunes
  `db/daily/` older than `BACKUP_RETENTION_DAYS` and keeps the newest `BACKUP_MONTHLY_KEEP` in `db/monthly/`; verifies the
  uploaded object exists with a size above zero; non-zero exit on any failure.
- `files-mirror.sh`: `rclone copy` (never `sync`: a deleted source object must not delete the copy) from the files bucket
  (`S3_*`) to `backup:$BUCKET/files/`; objects have unique keys and are never rewritten, so a copy is complete.
- `pg-restore.sh <object> <target DATABASE_URL> --identity <age key file>`: downloads, decrypts, `pg_restore --clean
  --if-exists --no-owner --exit-on-error`; refuses a target database that already has tables unless `--force`; never defaults
  the target to `DATABASE_URL`.
- `restore-drill.sh`: creates a scratch database `gsm_restore_drill_<stamp>` on the same server, restores the newest daily
  dump into it, checks `select coalesce(sum(amount), 0) = 0 from ledger_entries` (use the real amount column name of
  `src/modules/money/db/schema.ts`), the row count of the Drizzle migrations table against the files in `drizzle/`, and prints
  the counts of `orders`, `clients`, `ledger_transactions`; drops the scratch database; non-zero exit on any mismatch.
- Schedule: the host's cron or a systemd timer, documented with a ready sample:
  `15 1 * * * docker compose -f deploy/compose.prod.yaml run --rm backup pg-backup.sh && … files-mirror.sh`. Not backed up:
  the queue Redis (jobs are re-derived from `outbox_events`; AOF covers restarts), the cache Redis, Prometheus history.

### 2.6 `docs/OPERATIONS.md` (sections, each short and concrete)

1. Hosts, DNS records (three A/AAAA names), ports, what runs where (the table of §2.1, the services of §2.3).
2. First deploy: make the secrets, fill `deploy/.env` and `.env.production`, build images with `GIT_SHA`/`APP_VERSION`,
   `docker compose … up -d postgres redis-queue redis-cache minio minio-init`, then
   `docker compose … run --rm -it api bun run setup` (migrates and asks for the first admin), then `up -d`, then the checks:
   `https://<ADMIN_HOST>/health?strict=1`, sign in, System health page, a `TRUST_PROXY` check (the audit log or sessions list
   shows the visitor's real address, from a browser and after a server-rendered page).
3. Upgrades: backup → build → `run --rm migrate` → `up -d api worker` (the API never migrates on boot; migrations are
   additive by rule) → health; rollback = the previous image tag (never a down-migration).
4. Backups and the monthly restore drill (commands, what a pass looks like, where the last drill is recorded).
5. Key custody: `ENCRYPTION_KEYS` (losing it makes TOTP secrets and supplier/gateway credentials unreadable: keep two
   offline copies with the `age` private key of the backups, held by two people), `TOKEN_PEPPER` (rotating it signs everyone
   out and voids API keys and open links), `CSRF_SECRET` (rotating it only voids open forms), how to add a new encryption key
   id and switch `ENCRYPTION_ACTIVE_KID` without dropping the old id.
6. Logs (JSON on stdout: `docker compose logs`, request ids, what is redacted, decision 012), health and metrics
   (`/health`, `/metrics` with the token, Prometheus inside the network, the worker's port), Sentry (what is sent, how to turn
   it off).
7. Owner checklists: **mail domain** (verify the domain at the SMTP provider, SPF, DKIM, DMARC, `MAIL_FROM` on it, a test
   mail to an outside address); **DNS and TLS** (records, Caddy gets certificates itself, port 80 open); **provider
   accounts** (Cloudflare Turnstile site and secret keys with the host names, exchange-rate key, Telegram bot, object storage
   for backups, Sentry project, the payment provider of decision D-6); **before go-live** (every row of this document ticked,
   a restore drill passed, the dev seed never run in production).

### 2.7 Sentry: wire the official Bun SDK, errors only (decision D-7)

Decision: **wire it** with `@sentry/bun` (the official SDK for the Bun runtime; Sentry's own guide says errors and
manually captured exceptions work under Bun without their bundler plugin, which only adds tracing spans). `@sentry/nestjs`
is not used (it is built on Node preload hooks). Only manual capture, no tracing, no auto-instrumentation:

- `ErrorReporter` (injectable, global module in `src/infra/observability`): `capture(error, context: { process: 'api' |
  'worker'; requestId?; surface?; route?; method?; code?; queue?; job? })`. Without `SENTRY_DSN` it is a no-op and the SDK is
  **never initialised** (no network, no timers: tests, `docs:openapi` and development stay offline). With a DSN,
  `onModuleInit` calls `Sentry.init({ dsn, environment: config.env, release: <APP_VERSION + GIT_SHA>, defaultIntegrations:
  false, sendDefaultPii: false, tracesSampleRate: 0, beforeSend: scrubEvent })`; `onApplicationShutdown` awaits
  `Sentry.close(2000)`.
- `scrub.ts` (pure, spec): removes `request` (headers, cookies, body, query), `user`, breadcrumbs; masks e-mail addresses and
  digit runs of 12 to 19 (IMEI, card-like) in messages and exception values with the masks of `src/infra/logging/mask.ts`;
  keeps the tags above and the stack.
- Call sites (one line each): the `logAsError` branch of `exception.filter.ts` (unexpected 5xx only: decision 015), and the
  `final` branch of the worker's `failed` listener. Nothing else changes; a reporter failure is caught and logged at warn.
- System health's `sentryUrl` stays `null` (it would need the organisation and project of the owner's account; B168).
- **Go/no-go spike first** (in a spec, with the SDK's `transport` option replaced by an in-memory one): `init` +
  `captureException` + `close` deliver one scrubbed event under Bun 1.4.4, the import has no install script and opens no
  connection without a DSN. If any of these fails, do the fallback instead and say so in the report: remove `SENTRY_DSN`
  from `env.ts`, `.env.example`, `env.spec.ts` and decision 015, and add no package.

## 3. Database and API

None: no migration, no route, no contract, no error code, no permission. `GET /health` and `/metrics` are used as they are.

## 4. Admin console

None. Its image is built from `frontend-admin/Dockerfile` as it is (`VITE_API_BASE_URL=""`: same origin).

## 5. Risks and how the design closes them

| Area | Risk | Closure |
|---|---|---|
| Security | Secrets in an image or in git | `.dockerignore` excludes `.env*`; only `*.example` files are committed; `deploy/secrets/` and `deploy/.env` are git-ignored (add them to `.gitignore`); a test greps the examples for the dev secrets of `env.ts` |
| Security | A spoofed `X-Forwarded-For` defeats per-IP limits, IP rules and the admin allowlist | only Caddy is published; Caddy overwrites the header; the API trusts only the compose subnet; the first-deploy checklist verifies the address |
| Security | `/metrics`, Postgres, Redis or MinIO reachable from outside | no published ports; Caddy routes none of them; the metrics token is still required |
| Security | Container runs as root | `USER bun`; `init: true`; read-only mounts for configuration |
| Data loss | No backup, or a backup nobody can restore | nightly encrypted dump with retention, a file copy that never deletes, a scripted restore and a monthly drill that checks the ledger sums |
| Data loss | Backup readable by the storage provider | `age` encryption with a public key on the server; the private key is offline |
| Data loss | Queue Redis loses jobs or evicts keys | AOF `everysec` with a volume and `noeviction`, exactly as decision 006; the cache Redis is the only one with `allkeys-lru` |
| Integrity | A deploy kills running jobs | `stop_grace_period: 30s` > the 25 s drain; jobs are idempotent |
| Integrity | Schema newer or older than the code | migrations run as a one-off before the new containers start; OPERATIONS.md fixes the order |
| Privacy | Personal data sent to Sentry | no default integrations, no request data, `sendDefaultPii: false`, a scrubber with a spec; off without a DSN |
| Compatibility | The image misses a runtime file or imports a dev dependency | the `verify` stage imports both root modules during `docker build` |
| Compatibility | Feature 20 adds `CONSOLE_BASE_URL` (required in production) to `env.ts`; this feature edits `.env.example` nearby | the template carries the line commented; the lead resolves the two small conflicts (`.env.example`, `package.json`) |
| Performance | Memory on a small host | cache Redis capped at 256 MB; Postgres `max_connections` below the dev value; API pool `DATABASE_POOL_MAX` documented per process |

## 6. Slices

**A. Images (small).** `Dockerfile`, `.dockerignore`, `deploy/backup/Dockerfile`, `.gitignore` lines.
Acceptance: `docker build -t gsm-backend:24d .` and `docker build -t gsm-backup:24d -f deploy/backup/Dockerfile .` succeed;
`docker image inspect` shows user `bun`, no `.env`, the healthcheck; `docker history` shows no secret.

**B. Compose, Caddy, env templates, Prometheus (medium).** `deploy/compose.prod.yaml`, `deploy/Caddyfile`,
`deploy/.env.example`, `.env.production.example`, `deploy/prometheus/prometheus.yml`, the env-template test.
Acceptance: `docker compose -f deploy/compose.prod.yaml --env-file deploy/.env.example config` exits 0 and shows the two
Redis command lines exactly as §2.3, `stop_grace_period: 30s` on the worker and no published port but Caddy's.

**C. Backups and OPERATIONS.md (medium).** `scripts/backup/*.sh`, the script tests, `docs/OPERATIONS.md`, decision 036,
README pointer. Acceptance: every script passes `bash -n` and its dry-run test; the document has the seven sections.

**D. Sentry (small; spike first).** §2.7 and its tests; or the fallback.
Acceptance: with no DSN nothing is initialised; with a DSN an unexpected 500 and a final job failure each deliver one
scrubbed event to the in-memory transport; a `422` delivers none.

Finish: `bun run format`, `bun run check` (foreground). Report: files by folder, the Sentry outcome, the exact image tags
used, anything that could not be verified without starting containers (say so plainly: nothing here was run end to end).

## 7. Tests

| File | Covers |
|---|---|
| `test/unit/env-production-example.test.ts` | every variable `.env.example` marks "REQUIRED in production" is in `.env.production.example`; every key of the production template is a variable `env.ts` reads; no dev secret of `DEV_DEFAULTS` appears in either example; `TRUST_PROXY` of the template parses with `parseTrustProxy` and equals the compose subnet |
| `test/unit/deploy-files.test.ts` | parses `deploy/compose.prod.yaml` as YAML: only `caddy` has `ports`; the queue Redis command has `noeviction` and `--appendonly yes`, the cache one `allkeys-lru` and no persistence; `worker.stop_grace_period` is `30s`; api, worker and migrate share one image; the Caddyfile routes exactly the path lists of §2.4 and never `/metrics` (string checks) |
| `test/unit/backup-scripts.test.ts` | runs each script with `BACKUP_DRY_RUN=1` and stub `pg_dump`, `age`, `rclone`, `pg_restore`, `psql` on `PATH`: the printed pipeline, the refusal without a recipient, the monthly copy on day 1, the prune arguments from the retention variables, `copy` (not `sync`) for files, the restore refusal on a non-empty target and without an explicit target |
| `src/infra/observability/scrub.spec.ts`, `error-reporter.spec.ts` | scrubbing of request data, e-mails and digit runs; no-op without a DSN; one event per capture with the tags; `close` on shutdown; a transport error never throws |
| `src/common/errors/exception.filter.spec.ts` (extend), the queue workers spec (extend) | 5xx → one capture with route, surface and request id; 4xx → none; final failure → one capture, a retried attempt → none |

## 8. Decisions

Owner decisions taken with defaults (the owner may change them):
1. **Topology A** (D-5): the shop and the console each talk to the API on their own host; machine clients use `API_HOST`.
2. **Sentry is wired but off** until the owner sets `SENTRY_DSN` (D-7); errors only, scrubbed.
3. **Backups** (D-8): nightly, encrypted with `age`, to a separate S3-compatible bucket the owner provides; 30 daily and 12
   monthly dumps; a copy of the files bucket that never deletes; a monthly restore drill. The owner names the storage
   account and the two people who hold the offline keys.
4. **Object storage in production** is the bundled MinIO by default; an external S3 is a configuration change.
5. Backups are started by the host's timer, not by a container that sleeps.

Spec decisions for the lead: decision 036 (deploy topology, images, backups); decision 015 gains the Sentry wiring; no
B-entry is needed (no contract change). Out of scope, recorded: topology B and the `X-Turnstile-Token` CORS header; the
storefront's own image (§9); webhook-delivery hardening (re-queue of lost deliveries, auto-disable of failing endpoints);
gateway health checks (B168); CI/CD pipelines; a CDN; high availability (one host, one Postgres).

## 9. Storefront handoff

- The site needs a production image (no `Dockerfile` exists in `storefront/`): a Next server listening on 3000 as service
  `site` on the network `gsm`. Until it exists the `site` service stays behind the compose profile `site`.
- Under topology A the browser reaches the API on the site's own origin: Caddy sends `/client/*` and `/store/v1/*` (and the
  smart sign-in path of feature 24A, which is under `/client`) straight to the API, so in production these never pass
  through Next's rewrites. No CORS, one set of cookies, no Turnstile header problem.
- Server-side calls go to `http://api:3000` inside the network and must keep forwarding `Cookie`, `Origin` and the incoming
  `X-Forwarded-For` unchanged (as `lib/api/server.ts` does); the API trusts the compose subnet.
- Site build variables to provide to the lead: the public site origin, the Turnstile site key, the internal API base URL.
- Mail links use `STORE_BASE_URL=https://<SHOP_HOST>` and `PORTAL_BASE_URL=https://<SHOP_HOST>/merchant`.

## 10. Review against the code, and approval

Checked in the code: both entry points and their shutdown hooks, the worker's 25 s grace, `scripts/db-migrate.ts`,
`src/infra/db/migrate.ts` (runtime migrator, folder path relative to `src/infra/db`), the imports of `scripts/setup.ts`,
`package.json` scripts and the split of runtime and dev dependencies, `bunfig.toml`, the dev `compose.yaml` and
`docker/prometheus/prometheus.yml`, the production rules of `resolveConfig` (`withDefault`, `noDevValue`, `COOKIE_SECURE`,
`METRICS_TOKEN`, `TURNSTILE_SECRET_KEY`, mail), `.env.example`, the single places that log unexpected errors and final job
failures, the console's `Dockerfile`, the absence of one in the storefront, and the `PROGRESS.md` notes on the grace period
and on `TRUST_PROXY`. Sentry's Bun guide was read through Context7 (`/getsentry/sentry-docs`).

Limits of this plan, stated plainly: nothing can be started under the rules above, so the compose file, the Caddyfile and the
backup scripts are verified by `config`, parsing and dry runs only. The first real deploy is the owner's, following
OPERATIONS.md, and is the true test; the document says so at its top. The exact Bun and Caddy image tags must be confirmed
against the registry when the images are built.

**Approved by Fable 5.2**
