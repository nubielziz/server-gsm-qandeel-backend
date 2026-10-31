# Database infrastructure (`src/infra/db`)

Postgres 18 through `pg` and Drizzle (decisions 005 and 027). This folder is the runtime; the tables live with their
modules.

| What                                                                    | Where                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Tables (66 + the schema additions of MISMATCHES B116)                   | `src/modules/<id>/db/schema.ts`, one file per module, only that module's tables |
| Barrel for drizzle-kit and the typed client                             | `src/infra/db/schema.ts` (re-exports the 12 module files)                       |
| Column helpers (`pk`, `fk`, `money`, `timestampTz`, `inList`, ...)      | `columns.ts` (module schemas import this file, never the `index.ts` barrel)     |
| Pool, Drizzle instance, `Database` / `Transaction` / `DbExecutor` types | `database.ts`                                                                   |
| Nest provider, lifecycle, health check                                  | `db.service.ts`, `db.module.ts`, `postgres.health.ts`                           |
| Transaction helper with `afterCommit`                                   | `transaction.ts`                                                                |
| Migrator (advisory lock)                                                | `migrate.ts`                                                                    |
| Migrations                                                              | `drizzle/` at the repository root (SQL + snapshots, committed)                  |

## Commands

| Command                                                  | What it does                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `bun run db:generate`                                    | `drizzle-kit generate`: diff the schema against the last snapshot and write a new SQL migration                                   |
| `bunx --bun drizzle-kit generate --custom --name <what>` | an empty migration for SQL Drizzle cannot express (triggers, functions)                                                           |
| `bun run db:migrate`                                     | apply pending migrations to `DATABASE_URL` (`NODE_ENV=test` selects `DATABASE_URL_TEST`); never runs on app boot                  |
| `bun run db:check`                                       | fail when the schema has a change no migration contains; needs no database, part of `bun run check`                               |
| `bun run db:seed`                                        | load the frontend demo state (roles, staff, IP rules, settings, currencies, system ledger accounts); development only, idempotent |

Never edit an applied migration: a fix is a new one. After changing a schema file run `bun run db:generate`, read the
SQL, and commit it with the schema.

## Using the client

```ts
constructor(private readonly db: DbService) {}

await this.db.runInTransaction(async ({ tx, afterCommit }) => {
  const order = await this.orders.place(tx, input); // pass tx to every repository and public service
  afterCommit(() => this.cache.delete(`gsm:${env}:orders:order:${order.id}`)); // only after a successful commit
  return order;
});
```

- `DbService` owns one `pg` pool per process (`DATABASE_POOL_MAX`). Nothing connects until the first query, so building
  the Nest app offline (OpenAPI generation) works without Postgres. Under `NODE_ENV=test` it uses `DATABASE_URL_TEST`.
- Throwing inside `runInTransaction` rolls back and skips the `afterCommit` callbacks. A callback that throws is logged
  and does not stop the others (the data is already committed). A failing `COMMIT` (a deferred constraint such as the
  ledger zero-sum rule) also skips them.
- `isolation: 'repeatable read' | 'serializable'` is optional; there is no automatic retry on a serialization failure.
- Callbacks registered inside a nested transaction (savepoint) that rolls back still run after the outer commit. That is
  harmless for cache deletes (the only use today); track callbacks per savepoint before using them for jobs or emails.
- Repositories take `DbExecutor` (the database or a transaction) so one function serves both.
- The `postgres` health indicator (critical) is registered by `DbModule`; `GET /health` runs `select 1`.

## Conventions beyond decision 027

- Ids are `bigint generated always as identity`, read as JS numbers. The seed inserts explicit ids with
  `overridingSystemValue()` and then moves the sequence (`syncIdentity`).
- Timestamps are `timestamptz(3)`: millisecond precision, so a value read back equals the stored one.
- A `currency` column is `text` referencing `currencies.code`, not an id (the wire sends the code, B40).
- Enumerations are `text` + `CHECK`. The CHECK list and the TypeScript type come from one exported `as const` array, and
  a structure test fails if an exported array is not used in a CHECK. A column whose values no source fixes stays plain
  `text` (its TSDoc says so).
- A CHECK passes when its expression is `NULL`: write multi-branch checks with `is not distinct from` or `is null`
  (see `ledger_accounts_kind_owner_check`).
- Foreign keys are `ON DELETE RESTRICT`, except configuration that dies with its parent (service fields, options and
  prices, supplier services, webhook deliveries, ticket messages, customer credentials, check history).
- Every foreign key has a full (non-partial) index starting with its column; a test checks the schema and the database.
- Partial indexes serve hot states: open orders, unprocessed outbox rows, live sessions, pending webhook retries.
- Deviation from decision 027 ("booleans default false"): `is_active` / `is_available` default to `true`, because a
  newly created rule, link or service is meant to be live unless the admin switches it off (the frontend forms send
  the flag explicitly anyway).
- Production should run the API with a role that does not own the tables (so it cannot `TRUNCATE` or disable the
  ledger triggers); migrations run with the owner role. Tests use the owner role on purpose.

## Integrity enforced by the database (custom migration `0001`)

- `ledger_entries`, `ledger_transactions`, `order_events` and `audit_logs` refuse `UPDATE` and `DELETE`
  (trigger `<table>_append_only`, SQLSTATE `23514`, constraint `<table>_append_only`). `TRUNCATE` is not blocked.
- `ledger_entries_zero_sum`: a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on insert, update and delete checks at
  commit that the entries of a transaction sum to zero and that their accounts share one currency (decision 024;
  `postTransaction` validates both first). SQLSTATE `23514`, constraint `ledger_entries_zero_sum` or
  `ledger_entries_single_currency`.
- Not enforced by the database: appending a balanced pair of lines to an older ledger transaction. `postTransaction`
  always creates a new header with its lines, and it is the only writer of ledger rows.

## Tests

`test/integration/db-*.test.ts` run against `gsm_test`, which the first database test of a run migrates
(`test/support/db.ts`; nothing runs from the global preload, so `bun test ./src` works without Docker).
`test/schema/structure.test.ts` checks the schema without a database. See `test/README.md`.

## Open vocabularies and type guesses (for the Phase 3 features to settle)

Columns left as plain `text` because no source (frontend wire enum, decisions 018/024/025, scenarios, endpoint docs)
fixes their values; each feature that owns one adds the CHECK with its migration once the values are known:

- identity: `auth_tokens.purpose`
- platform: `notifications.recipient_type`, `audit_logs.actor_type`, `files.owner_type`, `outbox_events.type` and
  `aggregate_type`
- money: `ledger_transactions.kind` (the 13 money events plus reversal kinds), `payments.status`,
  `payments.method_type`, `refunds.method`, `withdrawal_requests.method` and `status`, `tax_rates.tax_type` and
  `applies_to`
- catalog: `client_groups.kind` (`b2c_retail` is known), `services.price_mode` and `duplicate_rule`, `tac_catalog.source`
- orders: `orders.verification_status` (`requested` is known), `order_events.type`
- suppliers: `suppliers.driver` and `param_format`, `supplier_services.type`
- health: `service_checks.component`, `alert_rules.metric` (a registry in code), `alert_events.subject_type`,
  `job_runs.job`
- commissions: `commission_plans.basis` and `period`, `commission_assignments.scope`, `commission_accruals.status`
- customers: `checkout_sessions.status`, `consent_records.subject_type` and `purpose`
- storefront: `help_articles.category`, `legal_documents.type`

Types and nullability that the map and decision 027 do not settle (guesses):

- `ip_rules.cidr` is Postgres `cidr` (decision 027 only types arrays); a single address reads back with `/32`.
- `payload`, `before`, `after`, `request`, `response` carry no `jsonb` mark in the map but are `jsonb`; `settings.value`
  is `jsonb` without a default (any JSON value).
- `alert_rules.threshold` and `alert_events.value` are `numeric(18,4)` (a measure in the metric's unit, not money);
  `files.size` is `bigint`; `suppliers.credit_rate` is `numeric(18,8)`.
- `supplier_services.custom_fields`, `risk_assessments.signals`, `incidents.timeline` and `commission_plans.tiers`
  are `jsonb` lists (default `[]`); every other `jsonb` defaults to `{}`.
- Credentials are nullable until set: `clients.password_hash`, `totp_secret_enc`, `payment_gateways.config_enc` and
  `webhook_secret_enc`, `suppliers.api_key_enc`. Optional links are nullable foreign keys (for example
  `payments.invoice_id`, `refunds.payment_id`, `orders.api_key_id`).
- Defaults: `currencies.decimals` 2, `client_groups.kind` `b2b`, `services.cost_currency` and `suppliers.currency` `USD`,
  free-text fields without a meaning `''`, initial states from the sources (`pending`, `new`, `firing`, ...).
- Extra constraints read from error codes and scenarios: one default and one retail merchant group, one current legal
  document per type and locale, one active assignment per plan and merchant, one payment per gateway reference, unique
  `(client_id, idempotency_key)` on orders, unique non-void inventory `code_hash`, `(scope = 'global') = (target_id is null)`
  on pricing rules.
