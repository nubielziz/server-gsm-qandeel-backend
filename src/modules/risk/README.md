# Risk & compliance module (`risk`)

Map domain K. Risk and compliance: risk assessments, the blocklist and data requests (export and anonymize).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: feature 18 (the review queue, the rules, the blocklist and the data requests, with the account privacy routes). Since decision 064 this module names the buyer by account: an assessment, a blocklist entry and a data request carry the account's number (`account_id`) whatever its rank, a guest checkout names its guest row, and the old `customer_id` columns are never written (`retiredCustomerId`).

### Risk screening (feature 18, `RiskScreening`)

`RiskScreening.assess(tx, input)` scores a captured storefront payment against the rules and writes one `risk_assessments` row
(`internal` provider, the score, the signals as plain sentences, the decision). The caller (the storefront payment) places the order
`held` when `hold` is true (decision 025: `placementDispatchState({ held })`), refuses and refunds when `block` is true, and links the
assessment with `linkOrder` when the order did not exist yet. The rules are read inside the caller's transaction, never from the
cache (a rule decides whether a customer's money is held).

**At the storefront capture** (`CheckoutCaptureService` of the customers module) every confirmed payment is assessed on the webhook's
transaction before `CustomerOrderPlacement.place`, with what the capture knows (the buyer account (`ScreeningInput.accountId`, null when no row is known; a guest checkout passes its guest row), email, checkout session, USD gross incl. VAT,
payment method, the session's IMEI, the card's fingerprint, country and funding from the card driver's charge details, the tax country, the
session's address and visitor country (`checkout_sessions.ip_country`), and whether the account itself opened the checkout: decision 050).
`allow` places the order as before. `review` places it `held` (no stock claimed, no `order.dispatch_requested`, a `review` timeline line with `holdReason`).
`block` places it `held` and `RiskDecisionsService.refundBlocked` rejects it at once as the system: a `processing` refund, the
`b2c_refund` journal and the `refund.process` event of feature 16, the first signal as the reason, no blocklist entry, no audit row,
and the assessment records outcome `refunded` with no reviewer. A risk refund is always paid out, even while `autoRefundFailed` is off,
except a payment the buyer disputed with the card network: it opens a refund request for staff (decision 048).

**Review reasons from the payment side** (decision 048): `ScreeningInput.reviewReasons` are facts the payment found that need staff
review whatever the score (a payment made after the checkout's price lock ended). `withReviewReasons` makes an `allow` a `review`, puts
the reasons first in the signals (a `block` keeps its hard signals first) and the first reason is the hold sentence.
`RiskDecisionsService.refundBlocked` takes an optional `reason` (else the sentence from the signals): the capture uses it to refund a
late payment at once when the gateway can refund.

- **Signals** (points, `domain/risk-scoring.ts`, the demo's table): disposable email 22, first order above the rule's USD 18,
  IP country differs from card country 25, prepaid card 12, a 4th order in an hour from one address or customer 20,
  more orders from one email in 24 hours than the rule allows 50. The score is the sum
  capped at 100.
- **Hard blocks** (score 100, decision `block`): a live blocklist entry matching the email, its domain, the IMEI, the card
  fingerprint or a country; a disposable email while `blockDisposableEmail` is on. A chargeback entry reads "Email on a previous chargeback".
- **Thresholds**: at or above `blockThreshold` (80) the decision is `block`, at or above `reviewThreshold` (50) it is `review`
  (held); a threshold whose switch is off does not apply.
- **Top-ups**: `RiskScreening.reviewTopUp(db, { email, cardFingerprint })` answers `{ flagged, reason }` from the blocklist, for the
  auto-credit job of billing to set `payments.review_required` (RESOLUTIONS money-3). `RiskServicesModule.onModuleInit` registers it with money's `TopUpScreeningHooks` (money cannot import risk: decision 032), the worker imports `RiskServicesModule`, and the job asks the hook under the payment's lock before it credits. A process without the risk module's hook sends every automatic top-up to staff review (decision 050).

**Inputs and where they come from** (decision 050). A rule or signal whose input this installation cannot supply never applies.

| Rule or signal | Needs | Source in this installation | Without it |
|---|---|---|---|
| Hold when the IP country differs from the card country (`reviewIpCountryMismatch`, +25, card payments) | the visitor's and the card's country | card: the card driver; visitor: `checkout_sessions.ip_country` from `GEOIP_COUNTRY_HEADER` | never applies; named at boot while on |
| Prepaid card BIN (+12) | the card's funding | the card driver | never applies (no card details) |
| Country blocklist | the declared tax country, the visitor's and the card's country | as above | matches the countries known |
| Tax country evidence (no switch) | the card's country, else the visitor's | as above | the declared country stands |

At boot the API logs `Risk rule without an input source: <rule>. <reason>` for each gap (`application/risk-input-check.ts`,
`domain/risk-inputs.ts`); the rules page itself does not say it yet.

- **Guest checkouts** (decision 050). A payment is *proven* when its checkout was opened by a signed-in account
  (`checkout_sessions.opened_signed_in`) and the account is known. A proven payment is judged on that account's own signed-in checkouts: its
  history (first order) and its daily and hourly counts. A guest payment is always a first order, is counted on its email and the guest
  row of that email, and adds nothing to the history of the account that owns the email. When the email has earlier orders the first-order
  signal reads `Guest checkout, treated as a first order above $<n>`, so the reviewer does not read the account's history as the buyer's.
  The blocklist's guest-checkout entries match a guest payment only.
- **Tax country evidence** (decision 050). The card's issuing country decides, and the visitor's country when the card does not say. When it
  differs from the declared tax country, the signal `Tax country <XX> differs from the card country <YY>` (or `... from the IP country <YY>`)
  is a review reason (`withReviewReasons`, after the payment side's own reasons, so it is the hold sentence only when there is none): the
  order is held whatever the score and the review switch, a block stays a block. It has no rule switch and applies only while the shop has a
  tax window in force. Staff approve (the declared country stands) or refund.
- **Velocity** (decision 050). The daily and burst counts also count the buyer's other checkouts whose order payment is `pending` (an open
  payment page, or a confirmation held for staff) and has no order yet, for 24 hours, so pages opened with a guest's email can send that
  guest's next payment to review (held, never refused; a signed-in account's counts do not include guest checkouts). Orders and in-flight
  checkouts are read in one SQL statement. `assess` first takes `pg_advisory_xact_lock(hashtextextended('risk-buyer:<email>', 0))`, so two
  payments of one email screened at the same moment run one after the other and the second sees the first one's order. Lock order: the payment
  and checkout-session rows the caller holds, then this lock, then the order, stock and ledger rows of the placement; no network call is made
  while it is held.

- **Shop orders only** (decision 064). The velocity rules (orders in 24 hours from one email, orders in one hour from one device, the first order) and the review queue count shop orders only (`prepaidOrderSql`, `source = 'store'`), so the orders a merchant account holds from its wallet never raise them and its portal history is not its shopping history. The assessments of a guest row move to the account that proves its mailbox in the link exchange (the participant `risk_assessments` of the guest claim, `application/guest-claim.participant.ts`, `RiskGuestClaimParticipant`, API process only: rows are taken `FOR UPDATE NOWAIT` so the claim never waits for a reviewer or a payment, and only the pointer moves).

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
gross the checkout locked (the figure the Refunds page shows). Refund on a guest order (decision 050): `blockEmail` adds the card that paid
the order, and blocks the checkout's email for guest checkouts only when that email belonged to an account before the order (a staff-made
account, or an email verified before the order); otherwise it blocks the email everywhere, as on a signed-in order, which adds no card. The
limited entry's reason ends with " (guest checkouts only)" and the audit row says `emailScope: 'guest checkouts'`.

The held order's `customer.email` is masked (`ja•••@example.com`) unless the caller holds `clients:read` (the `customer` key holds the buyer account: its id is the account id, any rank, the guest row for a guest checkout; its history counts the account's shop orders only) (decision 047; `RiskQueueService.get(contact)`).

### The rules (feature 18)

`GET`/`PUT /admin/risk/rules`: seven rules (`domain/risk-rules.ts`), stored in `settings`: six under the key `riskRules`, and
`require3ds` as the storefront policy of the same name (one stored value). `PUT` takes the whole set, validates it (unknown id,
whole number from 0, number on a plain switch, review threshold below block threshold even when the switches are off) and audits each
change with the demo's phrases.

### The blocklist (feature 18)

`Blocklist` (public) is the one writer and matcher of `blocklist_entries`. Values are stored only as keyed hashes plus a masked
display: an email as its normalised text (the recipe of feature 14b), an IMEI behind the prefix `imei:`, the other kinds behind a kind
prefix. An insert is `ON CONFLICT (kind, value_hash) DO NOTHING`; `match` ignores an entry past its `expires_at` (the clock's time is a
parameter). `POST /admin/blocklist` adds manual entries (`409 ALREADY_BLOCKED` for a duplicate), `DELETE` removes an entry of any source.
`removeAddedByBlockOf` deletes only the manual entries an account's block added (RESOLUTIONS b2c-5; `BlockRequest.accountId`, no `customerId` key at all). `isEmailBlocked` answers whether an
email or its domain is blocked: the customers module asks it for admin create and email change, store sign-in and sign-up, and the
checkout (`POST /store/v1/checkout-sessions` also asks for the IMEI) refuses a match with the `ACCOUNT_SUSPENDED` a blocked customer gets,
one message whichever entry matched.

An entry has one of two scopes (`guest_only`, decision 050). The default blocks everywhere. An entry limited to guest checkouts is matched
by a guest use only: a checkout opened without a signed-in session and the screening of its payment. Sign-in by link, a staff create, an
email change, a signed-in checkout, a signed-in payment and a top-up do not match it, and `isEmailBlocked` does not count it. Only the risk
refund of a guest order writes one. A block that staff add by hand over it (`POST /admin/blocklist`) widens the entry to a full one (the
route answers `201`, the audit row's `before` says `scope: 'guest checkouts'`); a full entry stays `409 ALREADY_BLOCKED`. The risk refund
of an order that is not a limited guest order widens it the same way when it blocks the email (the audit row's `blocked` lists the email and
`emailScopeBefore` says `guest checkouts`), so a full block is never refused because a narrower entry of that email exists. The account
block keeps `ON CONFLICT DO NOTHING`: it leaves a limited entry as it is, and the account's `blocked` status refuses the account anyway.

**The risk refund of a held guest order and the login account of its email** (`RiskDecisionsService`, `AccountDirectory.findLoginByEmail`). When staff refund a held guest order and block its email, the entry is limited to guest checkouts if a login account holds that email and existed before the order (made by staff, or its mailbox proven earlier: `accountBeforeOrder`), because the guest row is not that account; the account keeps signing in. Otherwise the block is a full one.

### Data requests (feature 18)

`POST /store/v1/me/data-export` and `/data-delete` record an `open` request due 30 days later (asking again while one is open returns it,
serialised by an advisory lock). `GET`/`PATCH /admin/data-requests` list and move them: open to in progress, completed or rejected; a
rejection needs a note (stored on the request and in the audit row); a closed request is `409 REQUEST_CLOSED`; an erasure request cannot
be completed by hand before the account is anonymized (`409 ERASURE_NOT_DONE`). `DataRequestService.completePending(tx, accountId, ...)` is what an
export download and an anonymization call to close the account's waiting request.

**Decision 064.** The routes are `rank: 'any'` (a copy of the data can be asked by an account of any rank) and the use case takes the account row lock first (`AccountDirectory.lockForUpdate`), so the rank it judges is the current one. **Erasure is for the retail rank only**: for a merchant rank `POST /store/v1/me/data-delete` answers `409 CONFLICT` with "This account has a merchant rank. Ask us to move it to the retail rank first; then you can ask for erasure." and stores nothing. The rows of `GET /admin/data-requests` and its two siblings carry `accountId` and `accountName` ("Deleted account" after anonymization) in place of `customerId` and `customerName`; the filter `accountId` replaces `customerId`, which is `422`; the audit entity is `account`. The lock order of a request: the account row, then the request rows (the advisory lock `data_request:<id>:<kind>` is gone).

## Public API (`index.ts`)

`countryFromHeader`, `maskedImei`, `erasedMainInput`, `RISK_RULE_IDS`, `holdReason`, `blockDisplay`, `blockHashInput`,
`normalizeBlockValue`, the services `RiskScreening`, `RiskDecisionsService`, `Blocklist`, `RiskRules`, `DataRequestService`, and the modules
`RiskServicesModule` (the services without controllers), `RiskAdminModule` (the routes), `RiskModule`. The services take `AccountDirectory` (identity): `DataRequestService(DbService, AuditService, AccountDirectory, CLOCK)` and `RiskDecisionsService(DbService, OrderTransitions, Blocklist, AuditService, AccountDirectory, CLOCK)`. Other modules import only `src/modules/risk/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 3 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts`. A fourth table, `imei_checks`, stays in the database and in the schema, unread and unwritten, until the contract release of the one account type drops it. The buyer column of the three tables is `account_id` (NOT NULL on `data_requests`, nullable on the other two; the retired `customer_id` columns are `retiredCustomerId`).

| Table | What it holds |
|---|---|
| `risk_assessments` | Risk assessment of a session or an order: a score, signals and a decision (allow, review or block); `account_id` names the buyer account (a guest row for a guest checkout). |
| `blocklist_entries` | The blocklist: email, domain, IMEI, card fingerprint, device and country. IP addresses live in ip_rules. |
| `data_requests` | Data-subject requests: export or deletion, with a legal deadline; `account_id` names the account. |

## Routes

14 endpoints (admin 12, store 2). Source: `docs/slices/risk.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (12)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/blocklist/:id` | staff-permission · `risk:*` | Blocklist: email, domain, IMEI or card. | 18 |
| `GET /admin/blocklist` | staff-permission · `risk:*` | Blocklist: email, domain, IMEI or card. | 18 |
| `GET /admin/blocklist/:id` | staff-permission · `risk:*` | Blocklist: email, domain, IMEI or card. | 18 |
| `GET /admin/data-requests` | staff-permission · `customers:privacy` | Data export and deletion requests and the deadline to fulfil them. | 18 |
| `GET /admin/data-requests/:id` | staff-permission · `customers:privacy` | Data export and deletion requests and the deadline to fulfil them. | 18 |
| `GET /admin/risk/queue` | staff-permission · `risk:read` | Paid orders held by the rules, waiting for a staff decision. | 18 |
| `GET /admin/risk/rules` | staff-permission · `risk:read` | Risk rules and their thresholds: when to hold for review and when to block. | 18 |
| `PATCH /admin/data-requests/:id` | staff-permission · `customers:privacy` | Data export and deletion requests and the deadline to fulfil them. | 18 |
| `POST /admin/blocklist` | staff-permission · `risk:*` | Blocklist: email, domain, IMEI or card. | 18 |
| `POST /admin/risk/orders/:id/approve` | staff-permission · `risk:decide` | Approve; the order is sent to the supplier afterwards. | 18 |
| `POST /admin/risk/orders/:id/refund` | staff-permission · `risk:decide` | Refund the held order, optionally adding the customer or device to the blocklist. | 18 |
| `PUT /admin/risk/rules` | staff-permission · `risk:*` | Update the rules; the review threshold must be lower than the block threshold. | 18 |

### Storefront (B2C) (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `POST /store/v1/me/data-delete` | customer-session | Request anonymization; payment records stay for accounting. | 18 |
| `POST /store/v1/me/data-export` | customer-session | Request an export of all my data. | 18 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/e2e/`).

- `b2c-paid`: Paid storefront order (tables: `risk_assessments`)
- `b2c-chargeback`: Chargeback dispute that we lose (tables: `blocklist_entries`, `risk_assessments`)
- `b2c-account`: Managing a storefront account (tables: `blocklist_entries`)
- `ip-rules`: IP block list and allowlist (tables: `risk_assessments`)
- `system-alert`: Alert and incident: a supplier slows down (tables: `risk_assessments`)

## Permissions

Staff permissions the map requires on this module's admin routes: `customers:privacy`, `risk:*`, `risk:decide`, `risk:read`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced: none of its own (a held order's approval writes the orders module's `order.dispatch_requested`, a refund its
`order.status_changed`, through `OrderTransitions`). Consumed: none.

## Jobs and schedules

None.

## Cache keys

None. The rules are read from the table inside the screening's transaction (a risk decision is never cached); the settings snapshot is
dropped after a rules save so `GET /admin/settings` shows the change.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-4` · POST /admin/customers/:id/anonymize
- `b2c-6` · GET /admin/risk/queue
- `b2c-11` · GET /admin/customers/:id, GET /admin/risk/queue
- `b2c-13` · PATCH /admin/data-requests/:id
- `b2c-17` · GET /admin/risk/queue
