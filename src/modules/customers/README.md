# Storefront customers & checkout module (`customers`)

Map domain I. Storefront customers and checkout (B2C): customer accounts and credentials, checkout sessions and consent records.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 010 ids and tokens, 018 authentication, sessions and CSRF, 019 encryption, 034 Turnstile. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (feature 14a, storefront-checkout): the checkout, 3 of the 13 storefront routes (`POST /store/v1/checkout-sessions`,
`GET /store/v1/checkout-sessions/:token`, `POST /store/v1/checkout-sessions/:token/consents`). Store sign-in, accounts and the admin
customer routes are feature 14b; paying a session (`.../pay`) and creating the order are feature 16. Checkout files:
`checkout.module.ts` (routes), `application/checkout-session.service.ts`, `application/consent.service.ts`,
`application/checkout-token.resolver.ts`, `infra/checkout.repository.ts`, `infra/consent.repository.ts`, `domain/checkout.ts`.

- **Open** (scenario b2c-paid steps 2 and 3): body `{ serviceId, email, country, region?, currency?, quantity?, imei?, inputs?,
  utm? }`. In one transaction: the policy `guestCheckout` (off answers `401 UNAUTHORIZED` "Sign in to check out.": a signed-in
  customer is not read on this public route yet, the lead links it when 14b merges); the service must be one the shop sells, lists
  (a switched-on `service_listings` row) and has priced (`StorefrontQuotes`, else `422` on `serviceId`; a `file` service cannot be ordered online yet); the quantity and the
  order fields are checked with the orders module's placement rules (`quantityProblem`, `inputProblems`); an IMEI service needs a
  valid IMEI (`INVALID_IMEI`, stored as `imei_enc`, context `checkout_sessions.imei_enc`, never returned: the answer shows the last
  four digits). The email (trimmed, lower case) finds the customer or inserts a guest (`has_account` false; `ON CONFLICT DO NOTHING`
  on the unique `lower(email)` index, so two checkouts racing on a new email make one customer); a `suspended` or `blocked`
  customer is refused with `403 ACCOUNT_SUSPENDED` and one neutral detail (scenario b2c-account step 8). A failed open rolls
  everything back (no customer is left behind). The session stores USD `net_amount`, `tax_rate`, `tax_amount`, `gross_amount`
  (RULES customers 6), the `currency` and the locked `fx_rate` (8 decimals, the markup included), `tax_country`, the encrypted
  IMEI, `inputs`, `utm`, `ip` (the trusted-proxy address) and the user agent; the token is 128 random bits (base64url, 22
  characters), `expires_at` is 30 minutes after the clock's time (`CHECKOUT_SESSION_TTL_MINUTES`). Maintenance with scope
  `checkout` or `store` already answers `503 MAINTENANCE` before this runs (the pipeline hook).
- **Status** (RESOLUTIONS b2c-14): `open | paid | expired`; an `open` session past `expires_at` reads `expired` for every reader at
  once without a job (`effectiveStatus`); `paid` is feature 16's.
- **Read** (`GET`): the capability guard of the identity module resolves the token (`CheckoutTokenResolver`, registered in
  `onModuleInit`): the row is found by the unique index and the stored token is compared with the presented one in constant time
  (decision 010 stores the checkout token as is so the link can be re-sent, so this is not a hash lookup like a session). One
  answer (`404 NOT_FOUND`, "This link is not valid.") for an unknown, malformed or nearly-right token; lookups are limited to 30 a
  minute per address by the pipeline. The view: status, expiry, the service, quantity, masked IMEI and email, the country, currency,
  rate and tax rate, the amounts in USD and in the buyer's currency (`gross` is what is charged), the consent state and the active
  B2C payment methods. The locked numbers never change after the session opens, whatever staff do to prices, tax or rates.
- **Consents** (RESOLUTIONS b2c-12, b2c-14): body `{ consents: [{ purpose, granted }], locale? }`; purposes `terms`, `privacy`,
  `refund_policy`, `withdrawal_waiver`, `marketing`. Each record stores the subject (the session's customer), the current legal
  document of the purpose's type and language (`terms`, `privacy`, `refund_policy` -> `terms`, `privacy`, `refund`; the waiver and
  marketing have no document; an English fallback), the session, the buyer's IP and user agent and the clock's time. Records are
  append only: a withdrawal is a new row with `granted = false`, the latest row of a purpose decides, and repeating the same
  answer for the same text is a retry that writes nothing. Required before payment: `terms`, `privacy` and, while the policy
  `withdrawalWaiver` is on, `withdrawal_waiver` (`consent.complete`). `422` for a purpose listed twice or without a published
  text; `409 INVALID_TRANSITION` on a paid or expired session. The route needs no anti-bot token: the capability token in the path
  is the credential.
- **Anti-bot**: opening a session is `turnstile: true` (decision 034).

## Public API (`index.ts`)

Exports `CHECKOUT_SESSION_TTL_MINUTES`, `CHECKOUT_IMEI_AAD`, `LEGAL_TYPE_OF_PURPOSE`, `effectiveStatus`, `requiredConsents`,
`CheckoutModule`, `CustomersModule` and `storefrontFunnel(db, now, days)` (`storefront-funnel.ts`, resolution b2c-10): a read-only
function that counts the storefront funnel (IMEI checks, checkouts started, paid, delivered) over the last `days` days. The
dashboard's storefront block (feature 9, 30 days) and the funnel report (feature 19) share it. Feature 16 reads a session through
its own use case in this module. Add the services other modules may call here, and nothing else: other modules import only
`src/modules/customers/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 4 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `customers` | Storefront customers: a guest with an email, or an account with a password or a sign-in link. Status is active, suspended (a reversible pause), blocked (fraud) or anonymized. |
| `customer_credentials` | Account sign-in data, kept apart from the profile: hash only. A temporary password set by a staff member forces a change at first sign-in, and nobody can read the current password. |
| `checkout_sessions` | The payment session before any order exists: the price, tax and exchange rate are locked in, and the order is created after payment. |
| `consent_records` | Proof of consent: terms, privacy, marketing and the withdrawal-right waiver, with the IP address and the time. |

## Routes

28 endpoints (admin 15, store 13). Source: `docs/slices/customers.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (15)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /admin/checkouts/abandoned` | staff-permission · `growth:read` | Abandoned carts, including who has marketing consent. | 19 |
| `GET /admin/customers` | staff-permission · `customers:*` | Storefront customers: search and view orders and payments; create a customer with an account (invitation link or temporary password); edit name, email, country, phone and notes; changing the email cancels the verification. | 14 |
| `GET /admin/customers/:id` | staff-permission · `customers:*` | Storefront customers: search and view orders and payments; create a customer with an account (invitation link or temporary password); edit name, email, country, phone and notes; changing the email cancels the verification. | 14 |
| `GET /admin/customers/:id/export` | staff-permission · `customers:privacy` | Export the customer data for a data-protection request. | 18 |
| `GET /admin/reports/funnel` | staff-permission · `reports:growth` | Sales funnel: check, then payment started, then paid, then delivered. | 19 |
| `PATCH /admin/customers/:id` | staff-permission · `customers:*` | Storefront customers: search and view orders and payments; create a customer with an account (invitation link or temporary password); edit name, email, country, phone and notes; changing the email cancels the verification. | 14 |
| `POST /admin/checkouts/recover` | staff-permission · `growth:send` | Send a recovery email once, only to customers with marketing consent. | 19 |
| `POST /admin/customers` | staff-permission · `customers:*` | Storefront customers: search and view orders and payments; create a customer with an account (invitation link or temporary password); edit name, email, country, phone and notes; changing the email cancels the verification. | 14 |
| `POST /admin/customers/:id/account` | staff-permission · `customers:update` | Create an account for a customer who bought as a guest: earlier orders are linked to the account and the customer receives a link to choose a password. | 14 |
| `POST /admin/customers/:id/anonymize` | staff-permission · `customers:privacy` | Anonymize the name, email and IMEI while keeping payment records for accounting. | 18 |
| `POST /admin/customers/:id/block` | staff-permission · `customers:block` | Block a customer for fraud, or lift the block, with a reason; blocking adds the customer fingerprint to the blocklist (use suspend for a temporary stop). | 18 |
| `POST /admin/customers/:id/password` | staff-permission · `customers:password` | Send a password-setting link, or set a temporary password that must be changed at first sign-in; the current password is never shown and never enters the audit log, and the sessions can optionally be ended. | 14 |
| `POST /admin/customers/:id/reactivate` | staff-permission · `customers:suspend` | Reactivate a suspended account; the customer signs in again. | 14 |
| `POST /admin/customers/:id/sessions/revoke` | staff-permission · `customers:password` | Sign the customer out of all devices: sets revoked_at on every active session. | 14 |
| `POST /admin/customers/:id/suspend` | staff-permission · `customers:suspend` | Suspend the account with a reason: no sign-in and no new orders, orders in progress still complete, and sessions are ended; a temporary suspension adds nothing to the blocklist. | 14 |

### Storefront (B2C) (13)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /store/v1/checkout-sessions/:token` | checkout-token | Session status, the locked price and the available payment methods. | 14 |
| `GET /store/v1/me` | customer-session | My account: details, currency, language and marketing consent. | 14 |
| `PATCH /store/v1/me` | customer-session | Change language, currency and marketing consent. | 14 |
| `POST /store/v1/auth/login` | public | Sign in with email and password; refuses a suspended account and locks temporarily after repeated failures. | 14 |
| `POST /store/v1/auth/logout` | customer-session | End the session. | 14 |
| `POST /store/v1/auth/magic-link` | public | Email a sign-in link instead of a password (second sign-in option). | 14 |
| `POST /store/v1/auth/password/forgot` | public | Request a password reset link; the answer is always the same, so no registered email is revealed. | 14 |
| `POST /store/v1/auth/password/set` | link-token | Set the password with an invitation or reset token (valid one hour, single use); ends older sessions. | 14 |
| `POST /store/v1/auth/verify` | link-token | Exchange a sign-in link token for a session; verifies the email on first use. | 14 |
| `POST /store/v1/checkout-sessions` | public | Open a checkout as a guest or from the account (service, IMEI, email, country); locks the price, tax rate and exchange rate, and refuses a suspended or blocked account. | 14 |
| `POST /store/v1/checkout-sessions/:token/consents` | checkout-token | Record consent to the terms, the privacy policy and the waiver of the withdrawal right, with the text version, time and IP. | 14 |
| `POST /store/v1/checkout-sessions/:token/pay` | checkout-token | Start payment (3DS card, wallet or crypto); the order is not created before the webhook confirms the payment. | 16 |
| `POST /store/v1/me/password` | customer-session | Change the password from the account by entering the current one; signs out the other devices. Used after a temporary password. | 14 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/scenarios/`).

- `b2c-paid`: Paid storefront order (tables: `checkout_sessions`, `consent_records`, `customers`)
- `b2c-chargeback`: Chargeback dispute that we lose (tables: `consent_records`, `customers`)
- `b2c-account`: Managing a storefront customer account (tables: `checkout_sessions`, `customer_credentials`, `customers`)
- `ip-rules`: IP block list and allowlist (tables: `checkout_sessions`)
- `system-integrity`: Ledger mismatch and maintenance mode (tables: `checkout_sessions`)

## Permissions

Staff permissions the map requires on this module's admin routes: `customers:*`, `customers:block`, `customers:password`, `customers:privacy`, `customers:suspend`, `customers:update`, `growth:read`, `growth:send`, `reports:growth`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none yet (the checkout routes write none). Consumed: none yet.

## Jobs and schedules

None yet. List each queue, job, schedule, idempotency key and retry policy here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

None: a session, its consents and the guest customer are decision-making state and are read from Postgres every time.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-1` · GET /admin/customers, GET /admin/customers/:id, POST /admin/customers, PATCH /admin/customers/:id
- `b2c-4` · GET /admin/imei-checks, POST /admin/customers/:id/anonymize
- `b2c-5` · POST /admin/customers/:id/block
- `b2c-8` · GET /admin/customers/:id/export
- `b2c-10` · GET /admin/reports/funnel
- `b2c-11` · GET /admin/customers/:id, GET /admin/risk/queue
- `b2c-12` · GET /admin/customers/:id
- `b2c-14` · GET /admin/checkouts/abandoned, GET /admin/customers/:id, GET /admin/legal-documents
- `b2c-16` · POST /admin/customers, PATCH /admin/customers/:id
