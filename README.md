# GSM backend

The supplier server behind the GSM admin console, the merchant portal, the storefront and the Dhru Fusion / REST v1
APIs: IMEI, Server, Remote and File services sold to B2B merchants (prepaid wallet) and B2C storefront customers
(pay first, then dispatch), on one order engine, one supplier layer and one double-entry ledger.

Stack: NestJS 12 on Fastify, run by Bun 1.4 · Drizzle ORM + PostgreSQL 18 · BullMQ on Redis 8 (a queue instance and
a cache instance) · S3-compatible storage (MinIO locally) · zod contracts → OpenAPI 3.1 → Scalar.

> Status: see `PROGRESS.md`. The Phase 0 Bun compatibility spike (decision 001) is retired: the integration tests under
> `test/integration/` (queues, worker process, outbox, Redis, storage, process) prove the same checks.

## Run locally

Requirements: Bun ≥ 1.4.4 (`npm i -g bun`), Docker with Compose, and the frontend repo next to this one
(`../frontend-admin`, read-only input; override with `FRONTEND_DIR`).

```bash
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d          # Postgres, queue Redis, cache Redis, MinIO (+ bucket init), Prometheus
bun run check                 # typecheck + lint + english-only guard + route manifest/slices + contract docs + OpenAPI documents + tests
bun run dev                   # API on :3000 (GET /health, GET /metrics, API docs at /docs and /reference)
bun run dev:worker            # worker process: queue workers, schedulers, outbox relay (its own /metrics on :9464)
```

Local services (host ports can be changed with `GSM_PG_PORT`, `GSM_REDIS_QUEUE_PORT`, `GSM_REDIS_CACHE_PORT`,
`GSM_S3_PORT`, `GSM_S3_CONSOLE_PORT`, `GSM_PROMETHEUS_PORT`):

| Service | Port | Notes |
|---|---|---|
| Postgres 18 | 5432 | user/password/db `gsm`; tests use `gsm_test` |
| Redis (queue) | 6379 | `noeviction`, AOF: BullMQ only; tests use database 1 |
| Redis (cache) | 6380 | `allkeys-lru`, no persistence: cache, rate limits, locks; tests use database 1 |
| MinIO | 9000 (console 9001) | `gsm-minio` / `gsm-minio-secret`; buckets `gsm-files`, `gsm-files-test` (tests) |
| Prometheus | 9090 | scrapes the API (`:3000`) and the worker (`:9464`) running on the host; `PROMETHEUS_URL=http://localhost:9090` |

Prometheus (decision 015) is configured in `docker/prometheus/prometheus.yml`. Locally the API answers `/metrics` to private
addresses without a token, so the container scrapes it as it is. In production `METRICS_TOKEN` is required, so Prometheus
must send `Authorization: Bearer <token>`: the comment at the top of that file shows the `credentials_file` setting.

## Local sign-in

`bun run db:migrate && bun run db:seed` (development only) loads the frontend's demo staff and gives them credentials, so the
console can sign in against the real API. The simplest way is the console's partial mock mode (frontend decision 018):
run `bun src/main.ts` (and `bun src/worker.ts` for the jobs), then in the frontend
`VITE_API_MOCKS=unbuilt VITE_DEV_PROXY_TARGET=http://localhost:3000 VITE_API_BASE_URL= npm run dev`: the routes this API has
built go to it through the Vite proxy (one origin, no CORS), the others stay mocked (`npm run mocks:live` there after this
repository gains routes). Calling the API cross-origin (`VITE_API_BASE_URL=http://localhost:3000`) also works: the development
default of `CONSOLE_ORIGINS` allows `http://localhost:5173` (decision 045). The seed also allows `127.0.0.1` and `::1` on the admin allowlist
(IP rules 8 and 9), so a console on the same machine is not locked out. Nothing here exists in production, and no code path
skips the TOTP step.

Password of every seeded member: `demo-password`. TOTP secrets (base32, 30 s, 6 digits; public on purpose, development
databases only):

| Member | Email | Role | State | TOTP secret |
|---|---|---|---|---|
| Rami K. | `rami@gsm-supply.example` | Owner | active, 2FA on | `4DP3DBKM62TVFPNM5QE6OO4P6STUYM3J` |
| Lina S. | `lina@gsm-supply.example` | Support | active, 2FA on | `KMG4IZYMUXD3VSCZ6VRP5TRPN3VCYBEW` |
| Omar T. | `omar@gsm-supply.example` | Finance | active, 2FA on | `ZYVGUXLFHQY5BDL562CL5QODEESABP4I` |
| Dana M. | `dana@gsm-supply.example` | Admin | active, 2FA on | `TRGSIXPEFSEMGX6X6SMFLZYYSD5JRBQR` |
| Nadia H. | `nadia@gsm-supply.example` | Risk reviewer | invited, no 2FA | none: the first sign-in answers `totp_setup` and shows her secret |
| Yusuf A. | `yusuf@gsm-supply.example` | Read only | suspended | `4KMDJNV4B3PLNO2OQETFBT3OBZ7LXEUR` (sign-in answers `403 ACCOUNT_SUSPENDED`) |

Add a secret to any authenticator app, or print the current code:

```bash
bun -e 'import { generate } from "otplib"; console.log(await generate({ secret: "4DP3DBKM62TVFPNM5QE6OO4P6STUYM3J" }))'
```

The flow with curl (`login` sets the pending session; `2fa` needs its `X-CSRF-Token`; a code can be used once, so wait for the
next 30-second step before signing in again with the same member):

```bash
B=http://localhost:3000 O='Origin: http://localhost:5173'
curl -s -c jar -H "$O" -H 'Content-Type: application/json' -d '{"email":"rami@gsm-supply.example","password":"demo-password"}' $B/admin/auth/login
CSRF=$(awk '$6=="csrf_token"{print $7}' jar)
curl -s -b jar -c jar -H "$O" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"code":"<6 digits>"}' $B/admin/auth/2fa
curl -s -b jar $B/admin/auth/me
```

## First run on a server

Deploying to a real server (images, Caddy and TLS, the production compose file, secrets, backups, upgrades, the owner's checklists) is in
[docs/OPERATIONS.md](docs/OPERATIONS.md); this section is only the `bun run setup` step of it.

A fresh database has no currency, no ledger accounts and nobody who can sign in. `bun run setup` is the one command that fixes that, in
production too (the demo seed refuses production). Once, on a new server, in a terminal:

```bash
# The empty database, Redis (queue and cache) and the files bucket exist, and the production environment is set (see .env.example).
bun run setup
```

```
✓ Migrations: up to date
✓ Base currency USD: created
✓ 12 system ledger accounts: created
✓ Owner role: created

No admin account yet. Create the first one now? [Y/n] y
  Email: you@example.com
  Full name: Your Full Name
  Password: ********
  Repeat password: ********
✓ First admin created: you@example.com
  Sign in at the console; you will set up 2FA (TOTP) first.
```

`setup` applies the pending migrations first (the same as `bun run db:migrate`; nothing happens when there are none), then creates what
is missing and says what already existed, one line per part:

- the base currency USD (rate 1, active) and the 12 system ledger accounts (decision 024: the same rows the development seed creates);
- the Owner role (permission `*`), unless a role that grants every permission exists already;
- the first admin, only when no staff member has a role that grants every permission (otherwise it asks nothing and says the account is
  already there; add more staff from the console, Admins & access).

**The questions.** In a terminal (standard input and output both) it asks for the first admin. Enter means yes at "Create the first one
now?"; `n` ends the run without an admin (run `bun run setup` again later). Each answer is checked as you type it, with the rules of
`POST /admin/staff`: a valid email that no other staff member uses, a name of 2 to 100 characters, and a password of at least 10
characters that is not trivially weak and does not contain your email or your name. A bad answer prints the rule and asks again, up to
3 times, then the run stops with exit code 1 and creates no admin account (the base data printed above it is already saved). The password is typed twice and never shown (one `*` per character;
backspace works). Ctrl+C at any question prints `Cancelled: no admin account was created.` and exits with code 130. Ctrl+D does the same at the
password questions, but at a plain question (the y/n, the email and the name) only on an empty line: on a line you have started to
type it deletes the character under the cursor, as in any shell. If someone else creates an owner while you are typing, `setup`
refuses at the end and creates no admin account.

The password is yours, so it is not temporary: it is stored only as an argon2id hash and the first sign-in is not forced to change it. It
goes straight to the authenticator (TOTP) setup (two factors are mandatory). It is never printed, logged or written to an audit row.

**For a deploy script (no terminal).** Without a terminal and without options `setup` asks nothing: it creates the base data and ends with
the line that says how to create the first admin. To create the admin without questions:

```bash
bun run setup --email you@example.com --name "Your Full Name"                  # a temporary password is printed once
printf '%s\n' "$ADMIN_PASSWORD" | bun run setup --email you@example.com --name "Your Full Name" --password-stdin
```

- With `--email` and `--name` the account is made the way the console makes a member with a temporary password: a strong generated
  password, stored only as a hash, a password change forced at the first sign-in. **The password is printed once on stdout and nowhere
  else**: copy it before you close the terminal.
- With `--password-stdin` as well, the password is read from standard input instead (one line; the trailing newline is removed), checked
  with the same rules, stored like a typed one (not temporary) and not printed. Standard input must be a pipe, not the keyboard.
- Everything is created in one transaction: if an owner already exists, `setup` refuses with exit code 1 and changes nothing.

Every created thing gets one audit row (actor: the system; the admin's row says `onboarding: chosen_password` or `temporary_password`,
never a password). Run it again whenever you like: a second run creates nothing.

Then, at the console:

1. Start the API (`bun run start`) and the worker (`bun run start:worker`), open the console and sign in with the email and your password
   (or the printed temporary one; the console then asks you to choose a new password and sign in again).
2. Two-factor sign-in is mandatory: the console shows the authenticator secret and QR code. Scan it with an authenticator app and
   type the 6-digit code. From now on every sign-in asks for a code.
3. Set the business up from the console: more currencies and their rates (USD is there), tax rates, payment gateways, suppliers,
   categories and services, and the other staff (Admins & access). The IP allow-list is optional and off until you add a rule.

If the first admin's password is lost before the first sign-in (a temporary one that was not copied), nobody can sign in and `setup`
refuses to make another admin (an owner exists). Remove that never-used account with SQL
(`delete from staff_users where email = 'you@example.com';`) and run `bun run setup` again.

## Start fresh in development

`bun run db:reset` throws the development data away and starts again, in one command. It drops and recreates the database of
`DATABASE_URL`, runs the migrations, empties the queue Redis and cache Redis databases of your configuration (no stale jobs that point
at old ids) and the files bucket, and prints what it removed. Then, by flag:

| Command | Result |
|---|---|
| `bun run db:reset` | a new, migrated, empty database (run `bun run setup` or `bun run db:seed` yourself) |
| `bun run db:reset --seed` | the demo data, as `bun run db:seed` loads it (sign-in: "Local sign-in" above) |
| `bun run db:reset --setup` | the first run in a terminal: the base data, then the same questions as `bun run setup` (email, full name, password twice) |
| `bun run db:reset --setup --email you@example.com --name "Your Name" [--password-stdin]` | the first run without questions: a temporary password printed once, or the password read from standard input |

`--setup` without `--email` and `--name` needs a terminal. Without one it is refused **before anything is dropped**
(`--setup needs a terminal to ask for the first admin, or pass --email and --name`). The questions come after the reset: Ctrl+C then
leaves the reset database without an admin (exit code 130); run `bun run setup` to create one.

Stop the API and the worker first and start them again afterwards (the reset ends their database connections and deletes their
queue data). It is for development only and refuses, before it changes anything: `NODE_ENV=production` or a production configuration,
`NODE_ENV=test` and any database called `*_test` (it never touches the test databases), and a database, Redis server or S3 endpoint that
is not on this machine. It also checks that Postgres, both Redis servers and the S3 endpoint answer before it drops anything.

## Scripts

| Script | What it does |
|---|---|
| `bun run dev` / `start` | API process (watch / plain) |
| `bun run dev:worker` / `start:worker` | Worker process (watch / plain) |
| `bun run typecheck` | `tsc --noEmit` (TypeScript 6, decision 003) |
| `bun run lint` / `lint:fix` | ESLint (type-aware typescript-eslint, TSDoc on exports, module boundaries, `process.env` only in `src/config`, no `console` in `src`); `lint:fix` applies the safe fixes |
| `bun run format` / `format:check` | Prettier over the code (Markdown, YAML and generated JSON are left alone) |
| `bun run english:check` | English only (decision 039): fail when Arabic script, the `ar` locale or right-to-left layout code is back in the code, outside the allowlist of `scripts/english-only.config.json` (Arabic text that people and suppliers type is data and stays: PDF shaping, CSV, plain-text mails) |
| `bun run docs:openapi` | Regenerate `docs/contract/openapi.json` (every route) and `openapi.public.json` (REST v1, Dhru reference, webhook events) from the route contracts, without any infrastructure |
| `bun run docs:openapi:check` | Fail when those two files differ from what the contracts generate (CI) |
| `bun run test` | Every test under `test/` with `bun test`, in batches: unit (`test/unit`, the same paths as `src/`), integration (`test/integration/<module>`), end to end (`test/e2e`), contract, Dhru and tooling (`test/tooling`); see `test/README.md` |
| `bun run test:unit` / `test:integration` | Only `test/unit` (no Docker) or only `test/integration` |
| `GSM_TEST_DOCKER=1 bun test test/integration/infra/queue-redis-restart.test.ts` | Restarts the queue Redis container (`docker restart`) while a worker runs; skipped unless `GSM_TEST_DOCKER=1` |
| `bun run routes:build` | Rebuild `docs/route-manifest.{json,md}` and `docs/slices/*.json` from the map |
| `bun run routes:check` | Fail when those files are stale (CI) |
| `bun run contract:extract` | Re-extract the frontend's endpoint types into `docs/contract/frontend-endpoints.json` |
| `bun run contract:docs` | Re-render the contract docs from the extraction and `docs/contract/lead-decisions.json` |
| `bun run contract:check` | Fail when the extract or the contract docs are stale (CI) |
| `bun run setup [--email <address> --name "<full name>" [--password-stdin]]` | The first run on a fresh server, production included: applies the migrations, creates the base currency, system ledger accounts and Owner role, and asks for the first admin in a terminal (or takes it from the options; see "First run on a server") |
| `bun run db:reset [--seed \| --setup [--email ... --name ... [--password-stdin]]]` | Development only: drop and recreate the database, migrate, empty Redis and the files bucket, then seed the demo or run the first run, which asks for the first admin in a terminal (see "Start fresh in development") |
| `bun run bench:argon2` | Print the time of one argon2id hash for candidate settings (aim for 50-150 ms on the production host) |
| `bun run check` | Everything CI runs: typecheck, lint, the English-only guard, route manifest, contract docs, OpenAPI documents, tests |
| `scripts/ci.sh` | The CI pipeline in one command: `bun install --frozen-lockfile`, start the Docker services, `bun run check`; exits non-zero on any failure |

## CI

There is no hosted CI file yet (the hosting is not decided); any CI system can run `scripts/ci.sh`. It needs Bun, Docker
(or `CI_SKIP_SERVICES=1` with the services provided elsewhere) and the frontend checkout next to this repo
(`FRONTEND_DIR`, default `../frontend-admin`: `contract:check` reads its TypeScript). It runs
`bun install --frozen-lockfile`, starts the Docker services that are not running yet (`docker compose up -d --wait`,
only for the missing ones: running services are left alone, because `docker compose up` from a second checkout such as a
git worktree would recreate them), waits until they are healthy, then runs `bun run check` and prints the step that
failed.

## API documentation

Generated from the route contracts (decisions 008, 009, 017) and committed under `docs/contract/`:

| URL | What |
|---|---|
| `GET /openapi.json`, `GET /docs` | Public: REST API v1, the Dhru Fusion reference and the webhook events we send (Scalar page) |
| `GET /reference/openapi.json`, `GET /reference` | Internal: every route. `REFERENCE_DOCS` = `open` (default outside production), `staff` (default in production; needs a staff session with `system:read`) or `off` (404) |

## Where things are

- `reference/` → symlink to `../frontend-admin/reference`: the API design map (`gsm-map/data/*.mjs`) and the static
  demo (`gsm-admin`). Never open `reference/**/dist/**`.
- `docs/route-manifest.json`: all 274 map rows expanded to 382 endpoints with access rules, owning module and, for
  admin routes, the frontend function that calls them (plus the rows of `scripts/map-additions`). `docs/slices/<module>.json`: the brief input per module.
- `scripts/module-map.mjs`: which module owns each table and each route.
- `docs/ARCHITECTURE.md`: the system on four pages. `docs/contract/ALIGNMENT.md`: the wire conventions every route
  follows; `docs/contract/endpoints/<module>.md`: per-endpoint contract; `error-codes.md`, `MISMATCHES.md`,
  `ANSWERS.md`, `RULES.md`, `OPEN-QUESTIONS.md`, `TESTS.md` next to it.
- `docs/decisions/`: decision records. `CLAUDE.md`: working rules for agents. `PROGRESS.md`: status.
  `CONTRIBUTING.md`: how to run everything, add an endpoint, a job, a cache key or a money event.
- `docs/OPERATIONS.md`: deploy, upgrade, back up and restore in production (`Dockerfile`, `deploy/`, `scripts/backup/`; decision 036).
- `src/modules/<id>/README.md`: per module its purpose, owned tables, routes, scenarios, permissions, events, jobs and
  cache keys. `docs/contract/openapi.json` and `openapi.public.json`: the generated API documents.
- `docs/queues.md`: every BullMQ queue with its jobs, payloads, idempotency keys, retry policy and schedules; `docs/cache-keys.md`:
  every cache key family. `src/infra/queues/README.md`: how to add a job.
