# Risk & compliance module (`risk`)

Map domain K. Risk and compliance: IMEI checks, risk assessments, the blocklist and data requests (export and anonymize).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (feature 14a, storefront-checkout): `POST /store/v1/imei/check` (stage 14: checksum and TAC). The risk rules, the review
queue, the blocklist, the data requests and the IMEI log are stage 18.

- **The check** (`application/imei-check.service.ts`, `domain/imei-check.ts`): the typed IMEI loses spaces and dashes
  (`normalizeImei` of the orders module) and must be 15 digits with a valid Luhn digit (`isValidImei`), else `422 INVALID_IMEI`
  with `errors[{field: 'imei'}]` and nothing is stored. The first 8 digits are looked up in `tac_catalog` through the catalog's
  `TacDirectory`; an unknown TAC is a valid check with `device: null`. Blacklist and lock status come with stage 18, so the status
  is `unknown`, the type `basic` and `result` `{ stage: 'basic', checksum: 'valid', tac: 'known' | 'unknown' }`.
- **Privacy** (decision 019): the IMEI is stored only as `imei_enc` (AES-GCM, context `imei_checks.imei_enc`) with `imei_hash` =
  `TokenService.hash('imei:' + imei)` for the lookup; it is never in a log line, an error or a metric (a test checks the log).
- **No reuse**: every check writes its own row (`cached_until` null, `cached: false`). Answering from another visitor's stored
  result would tell a stranger that, and when, someone checked the same IMEI, and the basic check costs nothing to repeat.
  `cached_until` is for the paid supplier check of stage 18.
- **Source**: with `serviceId` (a service the shop sells: sellable for the retail group and listed, else `422` on `serviceId`) the check is `pre_order` for that service;
  without it, `storefront_free`. `ip` is the trusted-proxy address; `country` is the country header of a trusted proxy when
  `GEOIP_COUNTRY_HEADER` is configured (two letters, `XX` and `T1` ignored), else null (RESOLUTIONS b2c-3: a free check has no
  checkout and no signed-in customer; once a check is linked to a checkout session the session's tax country is the first source).
- **Anti-bot**: the route is `turnstile: true` (decision 034), so it needs `X-Turnstile-Token`; the per-IP limit of decision 021
  applies to the whole store surface.

## Public API (`index.ts`)

`imeiHashInput`, `IMEI_CHECK_AAD` (the retention job and the account erasure of stage 18 hash and
decrypt the same way), `ImeiCheckModule`, `RiskModule`. Other modules import only `src/modules/risk/index.ts` (lint rule
`gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 4 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `imei_checks` | IMEI checks: blacklist, lock and iCloud, free or before an order, with a cache. |
| `risk_assessments` | Risk assessment of a session or an order: a score, signals and a decision (allow, review or block). |
| `blocklist_entries` | The blocklist: email, domain, IMEI, card fingerprint, device and country. IP addresses live in ip_rules. |
| `data_requests` | Data-subject requests: export or deletion, with a legal deadline. |

## Routes

17 endpoints (admin 14, store 3). Source: `docs/slices/risk.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (14)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/blocklist/:id` | staff-permission · `risk:*` | Blocklist: email, domain, IMEI or card. | 18 |
| `GET /admin/blocklist` | staff-permission · `risk:*` | Blocklist: email, domain, IMEI or card. | 18 |
| `GET /admin/blocklist/:id` | staff-permission · `risk:*` | Blocklist: email, domain, IMEI or card. | 18 |
| `GET /admin/data-requests` | staff-permission · `customers:privacy` | Data export and deletion requests and the deadline to fulfil them. | 18 |
| `GET /admin/data-requests/:id` | staff-permission · `customers:privacy` | Data export and deletion requests and the deadline to fulfil them. | 18 |
| `GET /admin/imei-checks` | staff-permission · `risk:read` | Log of IMEI checks and their results (erased or hashed after the retention period). | 18 |
| `GET /admin/imei-checks/:id` | staff-permission · `risk:read` | Log of IMEI checks and their results (erased or hashed after the retention period). | 18 |
| `GET /admin/risk/queue` | staff-permission · `risk:read` | Paid orders held by the rules, waiting for a staff decision. | 18 |
| `GET /admin/risk/rules` | staff-permission · `risk:read` | Risk rules and their thresholds: when to hold for review and when to block. | 18 |
| `PATCH /admin/data-requests/:id` | staff-permission · `customers:privacy` | Data export and deletion requests and the deadline to fulfil them. | 18 |
| `POST /admin/blocklist` | staff-permission · `risk:*` | Blocklist: email, domain, IMEI or card. | 18 |
| `POST /admin/risk/orders/:id/approve` | staff-permission · `risk:decide` | Approve; the order is sent to the supplier afterwards. | 18 |
| `POST /admin/risk/orders/:id/refund` | staff-permission · `risk:decide` | Refund the held order, optionally adding the customer or device to the blocklist. | 18 |
| `PUT /admin/risk/rules` | staff-permission · `risk:*` | Update the rules; the review threshold must be lower than the block threshold. | 18 |

### Storefront (B2C) (3)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `POST /store/v1/imei/check` | public | IMEI check before payment: checksum and TAC (stage 14), then blacklist and lock status through the supplier (stage 18). | 14 |
| `POST /store/v1/me/data-delete` | customer-session | Request anonymization; payment records stay for accounting. | 18 |
| `POST /store/v1/me/data-export` | customer-session | Request an export of all my data. | 18 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/scenarios/`).

- `b2c-paid`: Paid storefront order (tables: `imei_checks`, `risk_assessments`)
- `b2c-chargeback`: Chargeback dispute that we lose (tables: `blocklist_entries`, `imei_checks`, `risk_assessments`)
- `b2c-account`: Managing a storefront customer account (tables: `blocklist_entries`)
- `ip-rules`: IP block list and allowlist (tables: `risk_assessments`)
- `system-alert`: Alert and incident: a supplier slows down (tables: `risk_assessments`)

## Permissions

Staff permissions the map requires on this module's admin routes: `customers:privacy`, `risk:*`, `risk:decide`, `risk:read`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

None yet. List each queue, job, schedule, idempotency key and retry policy here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-3` · GET /admin/imei-checks, GET /admin/imei-checks/:id
- `b2c-4` · GET /admin/imei-checks, POST /admin/customers/:id/anonymize
- `b2c-6` · GET /admin/risk/queue
- `b2c-11` · GET /admin/customers/:id, GET /admin/risk/queue
- `b2c-13` · PATCH /admin/data-requests/:id
- `b2c-17` · GET /admin/risk/queue
