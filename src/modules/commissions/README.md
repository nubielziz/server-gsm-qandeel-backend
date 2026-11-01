# Commissions & referrals module (`commissions`)

Map domain F. Referral and commission plans, their assignment to merchants and the accruals they produce.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 011 money, 024 ledger. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Not built yet: the module is an empty shell (`commissions.module.ts`, `index.ts`). Its feature adds controllers, services, repositories and the owned tables.

## Public API (`index.ts`)

Exports `CommissionsModule` only. Add the services other modules may call here, and nothing else: other modules import only `src/modules/commissions/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 3 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `commission_plans` | Referral and cashback plans. |
| `commission_assignments` | Links a plan to the merchant who benefits from it. |
| `commission_accruals` | Commissions owed and paid out. |

## Routes

15 endpoints (admin 13, client 2). Source: `docs/slices/commissions.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (13)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/commission-assignments/:id` | staff-permission · `commissions:*` | Assign plans to merchants. | 11 |
| `DELETE /admin/commission-plans/:id` | staff-permission · `commissions:*` | Referral and rebate plans. | 11 |
| `GET /admin/commission-accruals` | staff-permission · `commissions:read` | Accrued commissions and their status. | 11 |
| `GET /admin/commission-accruals/:id` | staff-permission · `commissions:read` | Accrued commissions and their status. | 11 |
| `GET /admin/commission-assignments` | staff-permission · `commissions:*` | Assign plans to merchants. | 11 |
| `GET /admin/commission-assignments/:id` | staff-permission · `commissions:*` | Assign plans to merchants. | 11 |
| `GET /admin/commission-plans` | staff-permission · `commissions:*` | Referral and rebate plans. | 11 |
| `GET /admin/commission-plans/:id` | staff-permission · `commissions:*` | Referral and rebate plans. | 11 |
| `PATCH /admin/commission-assignments/:id` | staff-permission · `commissions:*` | Assign plans to merchants. | 11 |
| `PATCH /admin/commission-plans/:id` | staff-permission · `commissions:*` | Referral and rebate plans. | 11 |
| `POST /admin/commission-accruals/approve` | staff-permission · `commissions:approve` | Approve and pay out in bulk, with a ledger entry on the wallet. | 11 |
| `POST /admin/commission-assignments` | staff-permission · `commissions:*` | Assign plans to merchants. | 11 |
| `POST /admin/commission-plans` | staff-permission · `commissions:*` | Referral and rebate plans. | 11 |

### Merchant portal (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /client/commissions` | merchant-session | My commissions and their status. | 11 |
| `GET /client/referrals` | merchant-session | Referral link and referred merchants. | 11 |

## Scenarios

None of the 13 map scenarios (`docs/slices/` → `scenarios`) touches this module's tables.

## Permissions

Staff permissions the map requires on this module's admin routes: `commissions:*`, `commissions:approve`, `commissions:read`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

None yet. List each queue, job, schedule, idempotency key and retry policy here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `health-commissions-1` · GET /admin/commission-plans
- `health-commissions-2` · POST /admin/commission-assignments
- `health-commissions-3` · GET /admin/commission-accruals
- `health-commissions-4` · POST /admin/commission-accruals/approve, GET /admin/commission-accruals
- `health-commissions-11` · GET /admin/commission-accruals
- `health-commissions-12` · DELETE /admin/commission-assignments/:id
