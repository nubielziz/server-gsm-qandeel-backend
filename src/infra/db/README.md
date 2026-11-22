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
| Dedicated `LISTEN` connection that reconnects by itself                 | `pg-listener.ts` (`PgListener`; the outbox relay's wake-up)                     |
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
| `bun run setup`                                          | the first run on a fresh server, production included: migrates, then USD, the 12 system ledger accounts, the Owner role, and the first admin (asked for in a terminal, or `--email` and `--name`; README "First run on a server") |
| `bun run db:reset`                                       | development only: drop and recreate the database, migrate, empty both Redis databases and the files bucket, then optionally `--seed` or `--setup` (which asks for the first admin; README "Start fresh in development") |

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
- **Time limits (decision 055).** Every connection of the process's pool carries `statement_timeout`, `lock_timeout` and
  `idle_in_transaction_session_timeout` from `DATABASE_STATEMENT_TIMEOUT_MS` (default 15 s), `DATABASE_LOCK_TIMEOUT_MS` (5 s) and
  `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` (60 s); 0 means none, and under `NODE_ENV=test` all three default to none (the limit tests set
  them). The production worker gets 300 s and 30 s from `deploy/compose.prod.yaml`. A transaction that reads much passes
  `statementTimeoutMs` (the reports use `REPORT_STATEMENT_TIMEOUT_MS`, 120 s): its first statement raises the limit for it alone, and never
  lowers a longer or absent one. Migrations and setup build pools without limits. A limit that strikes (SQLSTATE `57014`, `55P03`,
  `25P03`) or a session Postgres ended (`57P01`, `57P05`, or the client error of a statement sent on it) answers `503 UNAVAILABLE`.
  Every pool client has its own `error` listener, so a session that ends while a transaction holds it fails that transaction, never the
  process.
- Callbacks registered inside a nested transaction (savepoint) that rolls back still run after the outer commit. That is
  harmless for cache deletes and real-time doorbells (the uses today: the hub finds no row and sends nothing); track callbacks
  per savepoint before using them for jobs or emails.
- **`onCommit(callback)`** (`transaction.ts`, exported from `src/infra/db`; decision 037): registers work for after the commit of
  the transaction of the *current async context* (`runInTransaction` runs its function inside an `AsyncLocalStorage`), without
  needing the `afterCommit` parameter. Why: many callers hold only `tx` (`NotificationService.enqueue({ tx })` has 21 call
  sites), and the real-time doorbell must ring after the commit. It runs after the commit; **never** after a rollback; at once
  when no transaction is open; at once when called after the commit (a late promise). It is not awaited and a failure is only
  logged. A savepoint (`tx.transaction`) shares the list of its transaction, nested `runInTransaction` calls keep their own, and
  `afterCommit` uses the same list. Use it for a publish or a cache delete, never for a write that must be atomic with the change
  (use the outbox, decision 020).
- Repositories take `DbExecutor` (the database or a transaction) so one function serves both.
- The `postgres` health indicator (critical) is registered by `DbModule`; `GET /health` runs `select 1`.
- `PgListener` is for `LISTEN`/`NOTIFY`: one `pg.Client` of its own (never a pooled connection held for ever), named in
  `pg_stat_activity`, reconnecting with a growing, jittered wait, and calling `onConnected({ reconnect })` after every
  connect so the owner can catch up on what a lost `NOTIFY` would have said. It never throws into the process.

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

## A data migration that refuses: `0035` (English only, decision 039)

Release 30 is the one release that is not additive (`docs/OPERATIONS.md`, "Release 30"). `0035_english_only_data.sql` is a custom
migration that deletes the content in other languages (the schema migrations `0036`-`0039` then drop the language columns), and
it starts with a guard, one `DO` block:

- It refuses while a legal document type has a version in force in another language and none in English.
- It counts what the release deletes (eleven counts, one `jsonb_build_object`). When everything is zero it passes; otherwise it
  needs the marker of `scripts/english-only-export.ts`: the newest succeeded `job_runs` row with `job = 'english_only_export'`,
  whose `result.counts` must equal the live counts, and no counted row other than a person's saved language may have an
  `updated_at` after the marker's `started_at` (the export's snapshot time). The export script repeats the guard's expression word for word
  (`COUNTS_SQL`; a test compares the two texts).
- Template rows inserted by migrations `0023`, `0025` and `0027` earlier in the same run (a fresh database: all pending
  migrations run in one transaction and `now()` is its start) are not content and are not counted.
- A database whose name ends in `_test` skips the guard (the tests truncate every table) unless it is forced on with
  `ALTER DATABASE <name> SET gsm.english_only_guard = 'on'`, as `test/integration/platform/english-only-migration.test.ts` does on its
  scratch databases. Those tests fill a database at `0034` with raw SQL and migrate it to the newest file; after the migration
  they assert by id only, so they stay valid while `0036`-`0039` drop the columns.

`legacy_slugs` (storefront, `0034`) remembers the addresses in other languages that `0035` deletes; nothing writes it later
except the demo seed.

## Tests

`test/integration/db-*.test.ts` run against `gsm_test`, which the first database test of a run migrates
(`test/support/db.ts`; nothing runs from the global preload, so `bun test ./test/unit` works without Docker).
`test/tooling/schema-structure.test.ts` checks the schema without a database. See `test/README.md`.

## Vocabularies settled by the audit resolutions (migration `0003`)

`docs/contract/RESOLUTIONS.md` closed these vocabularies before Phase 3. Each is an exported `as const` array in the
owning module's `db/schema.ts` and a named `CHECK`; a new value needs a migration. Several rules pin a vocabulary per
`purpose` or per other column:

- identity: `auth_tokens.purpose` (`invite`, `reset`, `verify_email`, `magic_link`; staff use `STAFF_TOKEN_PURPOSES`, the
  subset `invite` and `reset`)
- platform: `notifications.recipient_type` (`staff`, `client`, `customer`; the template audience still says `merchant`),
  `audit_logs.actor_type` (`staff`, `client`, `customer`, `system`) with the new `audit_logs.actor_name` snapshot
- money: `payments.status` and `payments.method_type` per purpose (top-up: `pending`/`approved`/`rejected` and
  `bank`/`card`/`usdt`/`wise`; order: `pending`/`captured`/`failed`/`refunded`/`partial_refund`/`disputed`/`chargeback`
  and `card`/`wallet`/`crypto`), `refunds.method` (`original`, `manual`), `ledger_transactions.ref_type` (no
  `ledger_transaction`; `ref_id` is never null, `0` for `system`), `currencies.decimals` (0 to 4)
- catalog: `services.price_mode` (`fixed`) and `duplicate_rule` (`allow`, `block_open`)
- orders: `orders.verification_status` (`requested`, `accepted`, `refunded`; null when none) and `order_events.type`
  (21 types)
- suppliers: `suppliers.driver` (`dhru`, `rest`) and `param_format` (`dhru_xml`, `json`), `supplier_api_logs.outcome`
  (`ok`, `error`, `timeout`)
- health: `alert_events.subject_type` (default `system`) and `unit`, `service_checks` keys (`supplier:<id>`,
  `gateway:<id>`)
- commissions: `commission_accruals.status` (`accrued`, `approved`, `reversed`; `approved_at` is set exactly when
  approved)
- customers and storefront: `checkout_sessions.status` (`open`, `paid`, `expired`), `consent_records.purpose` and
  `subject_type`, `legal_documents.type` (`terms`, `privacy`, `refund`, `cookies`)
- support: `support_tickets.status` (no `closed`)

Other changes of `0003` worth knowing: `services.effective_cost` (the price floor), `services.archived_at` (archive
instead of delete; an archived service gives its code back), a composite foreign key keeping `services.type` equal to
its category's type, `inventory_codes.batch_ref` numbered from `inventory_batch_ref_seq`, `payments.review_required`,
`auto_credit_at`, `brand` and `card_fingerprint`, `alert_events` keeping a snapshot of its rule, `commission_plans.tiers`
as a jsonb object, one current commission assignment per merchant, one accrual per order and beneficiary, one incident
per alert, and `job_runs`, `supplier_api_logs`, `invoices` and `consent_records` columns that are never null.

Still plain `text` because no source fixes the values; each feature that owns one adds the CHECK with its migration
once the values are known:

- platform: `files.owner_type`, `outbox_events.type` and `aggregate_type`
- money: `ledger_transactions.kind` (the 13 money events plus reversal kinds), `withdrawal_requests.method` and `status`
  (later phase), `tax_rates.tax_type` and `applies_to`
- catalog: `client_groups.kind` (`b2c_retail` is known), `tac_catalog.source`
- suppliers: `supplier_services.type`
- health: `service_checks.component` (shaped by the two key checks above), `alert_rules.metric` (a registry in code),
  `job_runs.job`
- commissions: `commission_plans.basis` and `period`, `commission_assignments.scope`
- storefront: `help_articles.category`

Types and nullability that the map and decision 027 do not settle (guesses):

- `ip_rules.cidr` is Postgres `cidr` (decision 027 only types arrays); a single address reads back with `/32`.
- `payload`, `before`, `after`, `request`, `response` carry no `jsonb` mark in the map but are `jsonb`; `settings.value`
  is `jsonb` without a default (any JSON value).
- `alert_rules.threshold` and `alert_events.value` are `numeric(18,4)` (a measure in the metric's unit, not money);
  `files.size` is `bigint`; `suppliers.credit_rate` is `numeric(18,8)`.
- `supplier_services.custom_fields`, `risk_assessments.signals` and `incidents.timeline` are `jsonb` lists (default
  `[]`); every other `jsonb` defaults to `{}`, including `commission_plans.tiers` (an object, enforced by a CHECK).
- Credentials are nullable until set: `clients.password_hash`, `totp_secret_enc`, `payment_gateways.config_enc` and
  `webhook_secret_enc`, `suppliers.api_key_enc`. Optional links are nullable foreign keys (for example
  `payments.invoice_id`, `refunds.payment_id`, `orders.api_key_id`). `suppliers.api_key_hint` shows which key is set
  without decrypting it.
- Defaults: `currencies.decimals` 2, `client_groups.kind` `b2b`, `services.cost_currency` and `suppliers.currency` `USD`,
  free-text fields without a meaning `''`, initial states from the sources (`pending`, `new`, `firing`, ...).
- Extra constraints read from error codes and scenarios: one default and one retail merchant group, one legal document
  version in force per type (decision 039), one current commission assignment per merchant, one payment per gateway reference, unique
  `(client_id, idempotency_key)` on orders, unique non-void inventory `code_hash`, `(scope = 'global') = (target_id is null)`
  on pricing rules.

## Audit resolution notes (docs pass)

Details the documentation pass recorded next to the schema pass (both apply `docs/contract/RESOLUTIONS.md`):

- identity: none left (`auth_tokens.purpose` is closed: `invite`, `reset`, `verify_email`, `magic_link`, from the exported
  `AUTH_TOKEN_PURPOSES`)
- platform: `files.owner_type`, `outbox_events.type` and `aggregate_type` (`audit_logs.actor_type` is closed to
  `staff | client | customer | system` and `notifications.recipient_type` to `staff | client | customer`; the audit entity
  type is enforced in code from `AUDIT_ENTITY_TYPES`, with no CHECK)
- money: `ledger_transactions.kind` (the 13 money events plus reversal kinds), `withdrawal_requests.method` and `status`,
  `tax_rates.tax_type` and `applies_to` (`payments.status` and `method_type` are closed per purpose, `refunds.method` to
  `original | manual`)
- catalog: `client_groups.kind` (`b2c_retail` is known), `tac_catalog.source` (`services.price_mode` is closed to `fixed` and
  `duplicate_rule` to `allow | block_open`)
- orders: none left (`orders.verification_status` is `NULL | requested | accepted | refunded`; `order_events.type` is a
  closed list)
- suppliers: `supplier_services.type` (`suppliers.driver` is `dhru | rest` and `param_format` is derived from it)
- health: `service_checks.component`, `alert_rules.metric` (a registry in code), `job_runs.job` (`alert_events.subject_type`
  is closed)
- commissions: `commission_plans.basis` and `period`, `commission_assignments.scope`
- customers: none left (`checkout_sessions.status`, `consent_records.subject_type` and `purpose` are closed lists)
- storefront: `help_articles.category` (`legal_documents.type` is closed)

The resolutions of the pre-Phase-3 audit (`docs/contract/RESOLUTIONS.md`) closed the vocabularies struck from this list; the
lead's migration `0003` adds their CHECKs, and each feature that owns a column still open adds its CHECK with its own migration.
- `supplier_services.custom_fields`, `risk_assessments.signals` (an array of plain strings) and `incidents.timeline` are `jsonb`
  lists (default `[]`); every other `jsonb` defaults to `{}`, `commission_plans.tiers` included (a free JSON object of plan
  conditions, never a list).
- From migration `0003` (audit resolutions money-6, catalog-1): `ledger_transactions.ref_id` is `NOT NULL DEFAULT 0`, where `0`
  means no record (a system posting) and a CHECK allows it only for `ref_type = 'system'`.
- From migration `0003`: `services.effective_cost` is a derived column the catalog module maintains (`recomputeEffectiveCost`, B117): the greater of
  `services.cost` and the first active supplier link's `credit x credit_rate`; floors, `belowFloor` and the `cost` on the wire
  read it.
  Also: one legal document version in force per type, one current assignment per merchant (`commission_assignments` with `ends_at` null), one payment per gateway reference, unique
