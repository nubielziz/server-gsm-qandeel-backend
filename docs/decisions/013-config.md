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
