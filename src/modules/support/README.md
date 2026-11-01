# Support module (`support`)

Map domain J. Support for storefront customers: tickets, their messages and reply templates.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Not built yet: the module is an empty shell (`support.module.ts`, `index.ts`). Its feature adds controllers, services, repositories and the owned tables.

## Public API (`index.ts`)

Exports `SupportModule` only. Add the services other modules may call here, and nothing else: other modules import only `src/modules/support/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 3 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `support_tickets` | Support tickets from storefront customers and merchants, linked to an order, with an SLA deadline. |
| `ticket_messages` | Ticket messages from the customer, a staff member or the system, plus internal notes. |
| `reply_templates` | Ready-made reply templates for staff, by category and language. |

## Routes

14 endpoints (admin 10, store 4). Source: `docs/slices/support.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (10)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/reply-templates/:id` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `GET /admin/reply-templates` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `GET /admin/reply-templates/:id` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `GET /admin/support-tickets` | staff-permission · `support:*` | Support inbox: priority, assignment, status and SLA timers. | 17 |
| `GET /admin/support-tickets/:id` | staff-permission · `support:*` | Support inbox: priority, assignment, status and SLA timers. | 17 |
| `PATCH /admin/reply-templates/:id` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `PATCH /admin/support-tickets/:id` | staff-permission · `support:*` | Support inbox: priority, assignment, status and SLA timers. | 17 |
| `POST /admin/reply-templates` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `POST /admin/support-tickets/:id/note` | staff-permission · `support:reply` | Internal note that the customer does not see. | 17 |
| `POST /admin/support-tickets/:id/reply` | staff-permission · `support:reply` | Reply to the customer by email or Telegram. | 17 |

### Storefront (B2C) (4)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /store/v1/tickets/:token` | ticket-token | Ticket conversation (without internal notes). | 17 |
| `POST /store/v1/tickets` | public | Open a ticket from the order page or the contact page; it is linked to the order. | 17 |
| `POST /store/v1/tickets/:token/csat` | ticket-token | Satisfaction rating after the ticket is closed. | 17 |
| `POST /store/v1/tickets/:token/messages` | ticket-token | The customer's reply on the ticket. | 17 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/scenarios/`).

- `b2c-refund`: Refund before delivery (tables: `reply_templates`, `support_tickets`, `ticket_messages`)
- `b2c-ticket`: Support ticket about a delay (tables: `reply_templates`, `support_tickets`, `ticket_messages`)

## Permissions

Staff permissions the map requires on this module's admin routes: `support:*`, `support:reply`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

None yet. List each queue, job, schedule, idempotency key and retry policy here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-2` · POST /admin/support-tickets/:id/reply, GET /admin/support-tickets
- `b2c-9` · GET/POST/PATCH /admin/reply-templates
