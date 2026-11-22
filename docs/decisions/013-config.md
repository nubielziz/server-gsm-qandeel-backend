# 013: Configuration

Status: accepted, 2026-10-31.

**Decision.** `src/config/env.ts` declares every environment variable in one zod schema (types, defaults for local
development, required in production). It is parsed once at boot; any problem stops the process with a readable list
(no partial start). The parsed, frozen `AppConfig` is a Nest provider (`APP_CONFIG`); code never reads
`process.env` directly (lint rule). No `@nestjs/config`. Bun loads `.env` files itself (`.env`, `.env.<NODE_ENV>`,
`.env.local`); tests use `NODE_ENV=test` and `.env.test`. Secrets (encryption keys, token pepper, gateway and supplier
credentials) come only from env or the secret store and are never logged; the boot log prints a redacted summary.

**Test instances.** Under `NODE_ENV=test` the database, both Redis roles and the bucket come only from the `*_TEST`
variables (defaults: `gsm_test`, Redis DB 1, `gsm-files-test`); the normal variables are ignored (decision 014).

**Consequences.** A missing or malformed setting fails at deploy time, not on the first request that needs it.

Amended by decision 055: the three database time limits `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_LOCK_TIMEOUT_MS` and
`DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` (defaults 15 s, 5 s and 60 s; 0 means none; none under `NODE_ENV=test`; a value from 1 to 999 ms
is refused) are settings of each process; the production compose file gives the worker its own.

**Amended by decision 055:** a process whose `NODE_ENV` is unset refuses to start unless every database host of `DATABASE_URL` is this machine or a socket; production refuses the templates' `CHANGE_ME` placeholders in any variable, secrets under their minimum length, short passwords of services on another machine, the development values of the database, Redis, S3 and mail settings, an unset `TRUST_PROXY` and argon2 below the OWASP minimum; production sends mail over TLS only. New settings: `DATABASE_OWNER_URL` (the owner role, for `db:migrate` and `setup`; ignored under test) and `S3_PUBLIC_ENDPOINT` (the address file links are signed for).
