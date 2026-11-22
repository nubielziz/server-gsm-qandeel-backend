# 036: Production deploy: topology, images, backups

Status: accepted, 2026-11-10 (feature 24D, planned by Fable 5.2, approved by the lead). Builds on decisions 001 (runtime and
shutdown), 006 (two Redis roles), 012 (logging), 013 (configuration), 015 (observability) and 027 (migrations never run on boot).
The plan names number 036 (035 is left free for another feature of the same job; the lead renumbers at merge if needed).

**Context.** The backend ran only from a developer checkout. Production needs images, a way in with TLS, a place for secrets,
backups somebody can restore, and an operations document. Nothing here changes a route, a table or a contract.

**Decision.**
- **Topology A, one browser origin per audience.** `SHOP_HOST` serves the storefront, and Caddy sends `/client/*` and
  `/store/v1/*` straight to the API; `ADMIN_HOST` serves the console bundle, with `/admin/*`, `/health` and `/reference*` to the
  API; `API_HOST` serves only the machine surfaces (`/api/index.php`, `/v1/*`, `/webhooks/*`, `/docs*`) and answers 404 elsewhere.
  Why: session cookies are host-only and `SameSite=Lax` (`docs/contract/ALIGNMENT.md`, sessions and CSRF), so the API must share the page's origin; there is then no
  preflight, the `X-Turnstile-Token` header needs no CORS change, `CSRF_COOKIE_DOMAIN` stays unset and no cookie crosses hosts.
  `/metrics` is routed on no host. A separate API host for browsers (topology B) is not built. (Decision 045: `SameSite=Lax` separates
  registrable domains, not hosts, so the API also trusts browser origins per surface; production derives them from the base URLs.)
- **Client address.** Only Caddy publishes ports (80, 443). Caddy sets `X-Forwarded-For` itself; the compose network has the fixed
  subnet `172.30.0.0/24` and `TRUST_PROXY=172.30.0.0/24`, so the API trusts exactly Caddy (and, for the storefront's server-side
  calls, the forwarded header the site passes on). No `trusted_proxies` unless a CDN is put in front.
- **One backend image, three commands.** `Dockerfile` (multi-stage, `oven/bun:1.4.4-slim`, production dependencies installed without
  lifecycle scripts, a `verify` stage that imports both root modules so a dev-only import fails the build, user `bun`, healthcheck on
  `GET /health?strict=1`). The API is the default command, the worker is `bun src/worker.ts`, migrations are the one-off
  `bun scripts/db-migrate.ts` and the first run is `bun run setup`. The API never migrates on boot (decision 027): a deploy is
  backup, build, `run --rm migrate`, `up -d api worker`. Rollback is the previous image tag, never a down-migration.
- **Stack.** `deploy/compose.prod.yaml`: caddy, api, worker, migrate (profile `tools`), postgres 18.6, the two Redis roles exactly as
  decision 006 (queue: AOF `everysec`, `noeviction`; cache: `allkeys-lru`, 256 MB, no persistence), MinIO with a private bucket,
  Prometheus scraping with the `METRICS_TOKEN` (a compose secret), the console, the site (profile `site` until the storefront ships
  an image) and the backup tools (profile `tools`). `stop_grace_period: 30s` on the worker (its drain is 25 s). Secrets live in two
  git-ignored files (`deploy/.env`, `.env.production`) made from committed templates; `.dockerignore` keeps `.env*` out of every
  layer.
- **Backups.** Nightly `pg_dump` (custom format) encrypted with `age` (public key on the server, private key offline) and uploaded to
  a separate S3-compatible bucket: 30 daily and 12 monthly dumps; a copy of the files bucket that never deletes (`rclone copy`, never
  `sync`); a scripted restore into an explicit target and a monthly restore drill that checks the ledger sums to zero and the
  migrations match. Started by the host's cron or systemd timer, not by a container that sleeps. Not backed up: the queue Redis
  (AOF covers restarts; after a loss of its data only some work comes back by itself: decision 044 and docs/OPERATIONS.md section 6), the cache Redis, Prometheus history.
- **Sentry** is wired but off until `SENTRY_DSN` is set: see decision 015.

**Consequences.** One host, one Postgres, no high availability (a restore from backup is the recovery). The compose file, the
Caddyfile and the backup scripts are verified by `docker compose config`, parsing and dry runs; the first real deploy by the owner,
following `docs/OPERATIONS.md`, is the end-to-end test. Out of scope: CI/CD pipelines, a CDN, webhook-delivery hardening, gateway
health checks (B168), the storefront's own image.
