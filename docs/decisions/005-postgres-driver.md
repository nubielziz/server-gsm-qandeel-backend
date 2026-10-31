# 005: Postgres driver: node-postgres (pg) under Drizzle

Status: accepted, 2026-10-31.

**Context.** Drizzle supports pg, postgres.js and `bun:sql`; all three passed the spike, all return `numeric` as a
string.

**Options.** pg 8.23 (mature, widest Drizzle and tooling use); postgres.js 4.0 (fast, but the major release is two
days old); `bun:sql` (fastest, Bun-only, youngest feature set).

**Decision.** pg with one `Pool` per process through `drizzle-orm/node-postgres`, pool size from env. Postgres 18.

**Consequences.** Money and other `numeric` values arrive as strings and stay decimal (never floats); `bigint`
columns also arrive as strings and are mapped explicitly. Transactions use `db.transaction()`; row locks use
`.for('update')`. The postgres.js dependency was dropped with the spike (P2.4b).
