# 027: Database conventions (Drizzle + Postgres 18)

Status: accepted, 2026-10-31.

**Context.** The map lists 66 tables with snake_case column names and few type hints (`nullable`, `unique`, `jsonb`,
`text[]`, `bigint[]`, `int[]`, `cidr[]`). The frontend derived its wire types from the same names
(`scripts/gen-entity-types.mjs` there); the database must agree with them.

**Decision.**
- Drizzle with `casing: 'snake_case'`: TypeScript keys are camelCase, columns snake_case. Each module owns
  `src/modules/<id>/db/schema.ts`; `src/infra/db/schema.ts` re-exports all for drizzle-kit and relations.
- Every table: `id bigint generated always as identity primary key`, `created_at timestamptz not null default now()`,
  and `updated_at timestamptz not null default now()` on mutable tables (append-only tables have none).
- Columns are `NOT NULL` unless the map says `nullable` or the column is a lifecycle timestamp/actor
  (`*_at`, `*_by`) or an optional link. Type by name, same rules as the frontend generator: `*_id` / `*_by` →
  `bigint` FK (`ON DELETE RESTRICT` unless the map implies cascade); `*_ids`/`bigint[]` → `bigint[]`; `*_at` and
  date names → `timestamptz`; booleans (`is_|has_|allow_|supports_|must_|requires_` prefixes, `_enabled`, explicit
  list) → `boolean not null default false`; counters (`_count|_ms|_qty|_per_min|_hours`) → `integer`; rates and
  percents → `numeric(9,4)`, FX rates `numeric(18,8)`; money names (`amount|price|cost|balance|credit|fee*|total*|
  *_limit|…`) → `numeric(18,4)`; `jsonb` → `jsonb not null default '{}'`; `cidr[]` → `cidr[]`; external ids
  (`gateway_txn_id`, `telegram_chat_id`, …) → `text`; everything else `text`.
- Enumerations (status, kind, type, purpose, channel…) are `text` with a `CHECK (col IN (…))` constraint whose values
  come from the contract enums (frontend types and map); not Postgres enums (cheaper migrations). The TS enum and
  the CHECK list are generated from one `as const` array.
- Constraints the map implies are in the schema: unique keys (emails, usernames, `token_hash`, `key_hash`,
  `idempotency_key`, `public_token`, ledger account identity), one-of checks (`orders`: exactly one of `client_id`,
  `customer_id`), positive amounts, the ledger triggers (decision 024). Every FK and every list filter/sort column
  gets an index; partial indexes for hot states (open orders, pending outbox rows).
- Migrations: `drizzle-kit generate` SQL, committed and reviewed; triggers and other SQL Drizzle cannot express go
  into custom migrations (`drizzle-kit generate --custom`). Never edit an applied migration; a fix is a new one.
  `bun run db:migrate` applies them (the API and worker never migrate on boot).
- Repositories use the query builder with bound parameters only; raw `sql` fragments use the `sql` tag (bound).

**Consequences.** DB types, wire types and frontend types follow one naming rule set; a column the rules get wrong
gets an explicit override next to its definition.
