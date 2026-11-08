# Risk & compliance module (`risk`)

Map domain K. Risk and compliance: IMEI checks, risk assessments, the blocklist and data requests (export and anonymize).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: feature 14a (`POST /store/v1/imei/check`) and feature 18 (the other 19 routes of the module and the customer privacy routes).

### The IMEI check (feature 14a)

- **The check** (`application/imei-check.service.ts`, `domain/imei-check.ts`): the typed IMEI loses spaces and dashes
  (`normalizeImei` of the orders module) and must be 15 digits with a valid Luhn digit (`isValidImei`), else `422 INVALID_IMEI`
  with `errors[{field: 'imei'}]` and nothing is stored. The first 8 digits are looked up in `tac_catalog` through the catalog's
  `TacDirectory`; an unknown TAC is a valid check with `device: null`. The status is `unknown`, the type `basic` and `result`
  `{ stage: 'basic', checksum: 'valid', tac: 'known' | 'unknown' }`. No supplier blacklist or lock lookup exists (the manifest has no
  supplier call for it), so `cached_until` stays null; a stored check that says `blacklisted` (the seed has some) still counts.
- **Privacy** (decision 019): the IMEI is stored only as `imei_enc` (AES-GCM, context `imei_checks.imei_enc`) with `imei_hash` =
  `TokenService.hash('imei:' + imei)` for the lookup; it is never in a log line, an error or a metric (a test checks the log).
- **No reuse**: every check writes its own row (`cached_until` null, `cached: false`).
- **Source**: with `serviceId` the check is `pre_order` for that service; without it, `storefront_free`. `ip` is the trusted-proxy
  address; `country` is the country header of a trusted proxy when `GEOIP_COUNTRY_HEADER` is configured, else null.
- **Anti-bot**: the route is `turnstile: true` (decision 034).

### Risk screening (feature 18, `RiskScreening`)

`RiskScreening.assess(tx, input)` scores a captured storefront payment against the rules and writes one `risk_assessments` row
(`internal` provider, the score, the signals as plain sentences, the decision). The caller (the storefront payment) places the order
`held` when `hold` is true (decision 025: `placementDispatchState({ held })`), refuses and refunds when `block` is true, and links the
assessment with `linkOrder` when the order did not exist yet. The rules are read inside the caller's transaction, never from the
cache (a rule decides whether a customer's money is held).

**At the storefront capture** (`CheckoutCaptureService` of the customers module) every confirmed payment is assessed on the webhook's
transaction before `CustomerOrderPlacement.place`, with what the capture knows (customer, email, checkout session, USD gross incl. VAT,
payment method, the session's IMEI, the event's card fingerprint, the tax country, the session's address). `allow` places the order as
before. `review` places it `held` (no stock claimed, no `order.dispatch_requested`, a `review` timeline line with `holdReason`).
`block` places it `held` and `RiskDecisionsService.refundBlocked` rejects it at once as the system: a `processing` refund, the
`b2c_refund` journal and the `refund.process` event of feature 16, the first signal as the reason, no blocklist entry, no audit row,
and the assessment records outcome `refunded` with no reviewer. A risk refund is always paid out, even while `autoRefundFailed` is off.

- **Signals** (points, `domain/risk-scoring.ts`, the demo's table): disposable email 22, first order above the rule's USD 18, VPN or
  proxy 15, IP country differs from card country 25, prepaid card 12, a 4th order in an hour from one address or customer 20,
  an IMEI an earlier check found blacklisted 30, more orders from one email in 24 hours than the rule allows 50. The score is the sum
  capped at 100.
- **Hard blocks** (score 100, decision `block`): a live blocklist entry matching the email, its domain, the IMEI, the card
  fingerprint or a country; a blacklisted IMEI while `blockBlacklistedImei` is on; a disposable email while `blockDisposableEmail` is
  on. A chargeback entry reads "Email on a previous chargeback".
- **Thresholds**: at or above `blockThreshold` (80) the decision is `block`, at or above `reviewThreshold` (50) it is `review`
  (held); a threshold whose switch is off does not apply.
- **Top-ups**: `RiskScreening.reviewTopUp(db, { email, cardFingerprint })` answers `{ flagged, reason }` from the blocklist, for the
  auto-credit job of billing to set `payments.review_required` (RESOLUTIONS money-3). `RiskServicesModule.onModuleInit` registers it with money's `TopUpScreeningHooks` (money cannot import risk: decision 032), the worker imports `RiskServicesModule`, and the job asks the hook under the payment's lock before it credits.

### The review queue (feature 18)

`GET /admin/risk/queue` lists the storefront orders whose newest assessment is `review`, undecided, and whose dispatch state is `held`,
oldest payment first, with the 30-day figures and the six latest decisions. `POST /admin/risk/orders/:id/approve` and `/refund` move
the order through the orders module's machine (`riskApprove`, `riskRefund`, decision 025) in one transaction with the assessment
outcome, the timeline lines, the blocklist entries of a refund and the audit row. The assessment row is locked first, so two reviewers
at once give one `204` and one `409 NOT_HELD`. The refunds row and the gateway refund of a storefront payment are feature 16's, hooked
into the machine's `b2c_refund` move like a staff rejection: one `refunds` row of the whole amount requested by the staff member, one
`b2c_refund` journal and one `refund.process` event, never a second. The audit row names the blocklist entries it added by kind and
mask (an IMEI as its TAC and bullets), never a readable IMEI. `RiskDecisionsService` lives in `RiskServicesModule` so the capture can
call it. A customer's history on a card counts the orders the customer created before the held one; the captured amount is the USD
gross the checkout locked (the figure the Refunds page shows).

### The rules (feature 18)

`GET`/`PUT /admin/risk/rules`: eight rules (`domain/risk-rules.ts`), stored in `settings`: seven under the key `riskRules`, and
`require3ds` as the storefront policy of the same name (one stored value). `PUT` takes the whole set, validates it (unknown id,
whole number from 0, number on a plain switch, review threshold below block threshold even when the switches are off) and audits each
change with the demo's phrases.

### The blocklist (feature 18)

`Blocklist` (public) is the one writer and matcher of `blocklist_entries`. Values are stored only as keyed hashes plus a masked
display: an email as its normalised text (the recipe of feature 14b), an IMEI as the IMEI-check hash, the other kinds behind a kind
prefix. An insert is `ON CONFLICT (kind, value_hash) DO NOTHING`; `match` ignores an entry past its `expires_at` (the clock's time is a
parameter). `POST /admin/blocklist` adds manual entries (`409 ALREADY_BLOCKED` for a duplicate), `DELETE` removes an entry of any source.
`removeAddedByBlockOf` deletes only the manual entries a customer's block added (RESOLUTIONS b2c-5). `isEmailBlocked` answers whether an
email or its domain is blocked: the customers module asks it for admin create and email change, store sign-in and sign-up, and the
checkout (`POST /store/v1/checkout-sessions` also asks for the IMEI) refuses a match with the `ACCOUNT_SUSPENDED` a blocked customer gets,
one message whichever entry matched.

### The IMEI log and its erasure (feature 18)

`GET /admin/imei-checks` decrypts `imei_enc` for the answer, and shows `tac` plus bullets once it was erased (15 bullets when the TAC is
unknown). `q` is a 15-digit IMEI (matched through the hash), a TAC (8 to 14 digits) or a prefix of it, or text for the brand and model.
Erasure sets `imei_enc`, `imei_hash` and `cached_until` to NULL together (the table's check keeps the first two together): the nightly
`data_retention` job does it by age (`imeiRetentionDays`, default 180, `0` means do not keep), and `ImeiErasure.forCustomer` does it for a
customer being anonymized (it also clears the stored address).

### Data requests (feature 18)

`POST /store/v1/me/data-export` and `/data-delete` record an `open` request due 30 days later (asking again while one is open returns it,
serialised by an advisory lock). `GET`/`PATCH /admin/data-requests` list and move them: open to in progress, completed or rejected; a
rejection needs a note (stored on the request and in the audit row); a closed request is `409 REQUEST_CLOSED`; an erasure request cannot
be completed by hand before the customer is anonymized (`409 ERASURE_NOT_DONE`). `DataRequestService.completePending` is what an
export download and an anonymization call to close the customer's waiting request.

## Public API (`index.ts`)

`IMEI_CHECK_AAD`, `imeiHashInput`, `maskedImei`, `erasedMainInput`, `RISK_RULE_IDS`, `holdReason`, `blockDisplay`, `blockHashInput`,
`normalizeBlockValue`, the services `RiskScreening`, `RiskDecisionsService`, `Blocklist`, `RiskRules`, `ImeiErasure`, `DataRequestService`, and the modules
`ImeiCheckModule`, `RiskServicesModule` (the services without controllers), `RiskAdminModule` (the routes), `DataRetentionModule` (the
worker's nightly job), `RiskModule`. Other modules import only `src/modules/risk/index.ts` (lint rule `gsm/module-boundaries`).

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

Outbox events produced: none of its own (a held order's approval writes the orders module's `order.dispatch_requested`, a refund its
`order.status_changed`, through `OrderTransitions`). Consumed: none.

## Jobs and schedules

- `data_retention` (queue `maintenance`, scheduler `data-retention`, daily 03:00 UTC, `src/modules/risk/jobs/`): erases the IMEI of
  `imei_checks` older than `imeiRetentionDays` in batches of 1000 (at most 50 batches a run). Idempotent (a row that is erased cannot be
  erased again), recorded in `job_runs`; retry policy of the `maintenance` queue. Listed in `docs/queues.md`.

## Cache keys

None. The rules are read from the table inside the screening's transaction (a risk decision is never cached); the settings snapshot is
dropped after a rules save so `GET /admin/settings` shows the change.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-3` · GET /admin/imei-checks, GET /admin/imei-checks/:id
- `b2c-4` · GET /admin/imei-checks, POST /admin/customers/:id/anonymize
- `b2c-6` · GET /admin/risk/queue
- `b2c-11` · GET /admin/customers/:id, GET /admin/risk/queue
- `b2c-13` · PATCH /admin/data-requests/:id
- `b2c-17` · GET /admin/risk/queue
