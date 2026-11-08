# Money module (`money`)

Map domain E. The double-entry ledger and everything that moves money: wallets and statements, currencies, invoices, payment gateways and payments, withdrawals, refunds, disputes and tax rates. `postTransaction()` is the only ledger writer (decision 024).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 011 money, 024 ledger. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Stage 3 is built (feature 3): the ledger core, merchant wallets, the ledger screens, reconciliation and currencies (14
routes). Stage 8 billing is built (feature 8, below): gateways, invoices, top-up payments, the payment webhook and the
automatic credit. The exchange-rate refresh (`POST /admin/currencies/refresh-fx`) is built (feature 14b, below). Refunds and
disputes arrive with 16, the money reports with 11 and 16.

- **Ledger writer.** `postTransaction(tx, input, now)` (and the injectable `LedgerPoster.post(tx, input)`, which reads the
  Clock) is the only writer of `ledger_transactions`, `ledger_entries` and account balances (decision 024): at least two
  positive lines in one currency that balance (`LEDGER_UNBALANCED`), the header first so a repeated `idempotency_key` returns
  the first transaction and posts nothing, every account locked `FOR UPDATE` in id order (missing accounts are opened, then
  all are locked again in one statement), a `client_wallet` debit refused below `-overdraft_limit` (`INSUFFICIENT_FUNDS`;
  credits always pass, user rule 2), entries with `balance_after`, balances and versions updated. `ref_id 0` is only for
  `system` (`LedgerRefRequiredError`, a programming error).
- **Money events.** `domain/money-events.ts` has a pure builder for each of the 13 map money events (`deposit`, `topup`,
  `order`, `complete`, `reject`, `adjust`, `commission`, `payout`, `b2cPay`, `b2cDeliver`, `b2cFee`, `b2cRefund`,
  `b2cChargeback`); each returns the map's lines and is unit-tested with the map's numbers. Later features spread one into
  `LedgerPoster.post`. Beyond the 13 (decision 024, "rules beyond the 13 map events"; feature 5): `reopen` (B2B: revenue back to
  the merchant hold, kind `adjustment`), `reopenB2c` (revenue back to customer funds) and `refund` (B2B: revenue to the wallet, kind
  `refund`), all keeping the cost booked, with their own id type (`REVERSAL_EVENT_IDS`) so the map-parity test of the 13 stays
  exact; unit tests in `domain/order-reversals.spec.ts`. `OrderSettlements.liveOf(db, orderId)` finds the settlement of an order
  that no `reverse:<id>` transaction has reversed, so the orders module posts a reversal under that key.
- **Wallets.** `MerchantAccounts.open` opens `client_wallet` and `client_hold` with the merchant (resolution ip-1; user rule
  2 checked there and by the credit-limit route); `WalletService` serves the wallet view, the statement (JSON or CSV), manual
  adjustments (`adjust` event, ref type `client`, reason in the memo, `APPROVAL_REQUIRED` above the single-approver setting,
  `CREDIT_LIMIT_EXCEEDED`, `IDEMPOTENCY_KEY_REUSED`) and the credit limit.
- **Ledger screens.** `LedgerReadService` lists journals (wire `refType` through `toWireRefType`: stored `client` goes out as
  `system`, resolutions money-1/6; numeric and text `q`, money-15) and accounts with their owners' names.
- **Reconciliation.** `ReconcileService.run` compares every stored balance with the sum of its entries in one repeatable-read
  snapshot, records a `job_runs` row of job `ledger_reconcile` (`RECONCILE_RUNNING` while one runs) and audits the run. It is
  synchronous (ANSWERS finance Q4) and never corrects anything.
- **Currencies.** `CurrencyService`: CRUD with `decimals` 0 to 4 and `isStale` for a non-base rate older than 24 h
  (money-13).
- **Exchange-rate refresh** (feature 14b, decision 029, resolution money-9): `FxRefreshService` (`application/fx-refresh.service.ts`) asks the
  driver behind the token `FX_PROVIDER` for every active non-base currency, stores the rates it gets (`rate_updated_at` from the clock, so
  `isStale` is false), and answers `{ refreshed, failed, source }`. A currency the provider does not offer, or sends an unusable rate for, is in
  `failed[]` ("Not offered by the provider") and the route still answers `200`; `502 FX_PROVIDER_DOWN` when nothing could be fetched at all (the
  detail is the driver's: "No exchange-rate provider is configured." for `manual` or a missing key, "The exchange-rate provider did not answer in
  time.", "...refused the request (HTTP n).", "...answer could not be read.", or "...offered none of our currencies."): the old rates stay and no
  audit row is written. The provider is called before the transaction (no lock across the network); the rows are locked in code order. Audit:
  `refreshed exchange rate` on entity type `currency`, with the old and new rates. Drivers (`domain/fx-provider.ts`, `infra/`):
  `OpenExchangeRatesProvider` (`GET <base>/latest.json?symbols=...`, key in `Authorization: Token ...`, never in the URL or a log line, through
  `OutboundHttp` target `fx_provider`, timeout `FX_TIMEOUT_MS`, no retry) and `ManualFxProvider` (fetches nothing). The module provider picks the
  driver from `FX_PROVIDER`/`FX_API_KEY`. The hourly `fx_refresh` maintenance job of decision 029 (`jobs/fx-refresh.module.ts`, `FxRefreshJobModule` in the worker; scheduler `fx-refresh`, `0 * * * *`, queue `maintenance`) runs the same
  `FxRefreshService.refresh()` with no request behind it, so the audit actor is the system, and records a `job_runs` row (`processed` = rates refreshed). With the `manual` driver, or
  `openexchangerates` without a key, it asks nothing, changes nothing and is recorded as `succeeded` with the reason in `result` (no error, no retry; `skipped` would show a warning every hour); with a provider but no active non-base currency it ends without a call and without an audit row (`refresh({ auditEmpty: false })`; the admin route audits its empty refresh as before); a configured provider that cannot answer fails the run and the queue's retry policy applies.
- **Tax rates** (stage 14, built ahead of feature 14b by the lead): `TaxRateService` lists, reads, adds and changes the
  windows of `tax_rates` (`/admin/tax-rates`, permissions `tax:read|create|update`): country two capital letters, rate 0 to
  100 with four decimals, `taxType` vat | gst | sales_tax | none, `validTo` after `validFrom` (exclusive end), and one window
  at a time per country and region (422 on `validFrom`; changes of one pair serialised by an advisory lock). No delete
  (M163): a rate that stops applying gets an end. The seed loads the demo's 12 rates as the console's mock maps them.
- **Spend and credit reads for the groups (feature 4a).** `MerchantSpend.completedSpend(db, clientIds)` is the cumulative
  completed-order spend in USD (the `order_settle` debits on each merchant's `client_hold` minus the settlements that were
  reversed: a transaction with the idempotency key `reverse:<settlement id>` exists, decision 024); the nightly group promotion
  of identity reads it. `MerchantWallets.idsWithCreditLimit(db)` lists the merchants whose credit limit is above zero (the
  catalog's `overdraftAllowed: false` guard). `findMerchant` takes `FOR SHARE` on the merchant's group row, so a credit limit
  change and a change of the group's overdraft flag never interleave.
- **Merchant machine surfaces (feature 7a).** `MerchantApiAccount` (`application/merchant-api-account.ts`) serves `GET /v1/account`
  (`balance`, `reserved`, `creditLimit` and `available` from the same wallet view as the portal, the currency and the client group),
  `GET /v1/transactions` (the wallet's statement by cursor: `?limit=` 1 to 100, `?cursor=` the entry id of the last line sent; newest
  first, from the merchant side, so a deposit is positive and an order hold negative; the hold-only lines never appear) and binds Dhru's
  `accountinfo` to the `DhruGateway`: `{ message: 'Your Accout Info', AccoutInfo: { credit, mail, currency } }` where `credit` is the
  available balance (balance plus credit limit, what an order may spend now). Never cached (decision 022). Scope `account:read`.
- **Seed.** `scripts/seed/money.ts` opens the accounts of every demo merchant and posts the demo's ledger history through
  `postTransaction`, skipping merchants the identity seed has not created.

- **Billing (feature 8).** 18 routes (the 5 KYC routes are identity's). Contracts `contracts/{gateways,invoices,payments,billing-portal,payment-webhook}.contracts.ts`; use cases
  `application/`: `PaymentGatewayService` (CRUD, secrets encrypted by `GatewayCredentialsVault`, audit `added|changed|removed payment method`, and `turned on|turned off payment method` when a change only moves the switch, the demo's phrases), `InvoiceAdminService` (list, read, issue a manual invoice, audit `issued invoice for`),
  `PaymentReviewService` (list, read, approve, reject; audit `approved|rejected deposit of`) with `PaymentViews` (the wire around a page: merchant, group, wallet, gateway, reviewer, hints) and `PaymentCrediting` (the one place that credits a top-up),
  `MerchantBillingService` (the portal: payment methods, invoices, a new top-up invoice, the receipt), `PaymentWebhookService` and `PaymentWebhookVerifier` (the incoming confirmation), `InvoiceDocuments` (PDF) and `InvoiceOutbox` (`invoice.paid`).
  - **Money rules.** A deposit posts the map event `deposit` (Dr `bank` for a manual gateway or `gateway_clearing` for an automatic one, Cr `client_wallet` net, Cr `fee_income` fee) with ref `payment`, key `deposit:payment:<id>`, memo
    `Deposit PAY-<id> (<method>)`. Lock order everywhere: the payment row, then its invoice, then the ledger accounts. Approve and reject re-check under the lock: not pending → `409 PAYMENT_ALREADY_REVIEWED`; an automatic gateway
    whose payment was not sent to review → `409 PAYMENT_AUTO_CREDIT_PENDING` (user rule 6). Reject voids a top-up invoice and leaves a staff-issued manual invoice open.
  - **Invoices.** `INV-<year>-<id padded to 4>` (the id is reserved first, so a gateway checkout can carry the number; a failed checkout leaves a gap), due in 14 days (setting `billing.invoice_due_days`), tax at the B2B VAT rate
    (setting `billing.b2b_vat_rate_percent`, default 0, a bad value reads as 0), base currency, `kind` manual or topup. A top-up invoice: `fee = amount × percent + fixed`, `net = amount − fee`, `total = amount`; a manual one: no fee, `total = net + tax`.
    The PDF (decision 030, the platform's `PdfRenderer`) is rendered after the commit of an issue and again after the payment, stored through `StoredFiles` as the merchant's file, and a failure only logs (the money never waits for a document).
  - **Drivers** (`infra/gateway-drivers/`): `payment_gateways.driver` names the code behind a gateway: `card` / `stripe` (Stripe Checkout protocol: form-encoded calls with a bearer key, webhooks `t=<unix>,v1=<hmac>` in `stripe-signature`, signed with
    the webhook secret) and `crypto` / `usdt` (a JSON invoice API; header `x-gsm-signature`; confirmed only at the required confirmations); `bank` and `wise` are manual (staff review the receipt). A driver verifies, reads an event, opens a checkout and
    asks the gateway about a payment (`checkStatus`) for the job. API calls go through `OutboundHttp` (`target: gateway`, 10 s, SSRF guard); the gateway's API address is `config_enc.apiBase` (default of the card driver: `https://api.stripe.com`);
    tests provide `GATEWAY_HTTP_POLICY` to reach a local server.
  - **Webhook** `POST /webhooks/payments/:gateway`: the guard verifies the signature through the driver, the 5-minute window and the event-id replay filter; the handler records a confirmed payment of an open invoice of that gateway once (unique
    `(gateway_id, gateway_txn_id)`; two racing deliveries create one) as `pending`, `captured_at` = now, `auto_credit_at` = now + max(setting `payments.auto_credit_delay_minutes` (10), `hold_hours`); an amount or currency that differs from the invoice
    goes to review (`review_required`, the reason in `review_note`) and can never be credited: the row keeps the invoice's amount and fee, `PaymentCrediting` re-reads the stored gateway event (`raw`) with the driver and refuses
    a different amount or currency (and an event it can no longer read) with `409 CONFLICT`, for staff approval and for the job alike; staff reject it and adjust the wallet by hand. Everything else is acknowledged with `200`.
  - **Automatic credit job** `payment_auto_credit` (queue `maintenance`, every minute; `docs/queues.md`): asks the gateway again, then credits, sends to staff or asks again later. Risk (feature 18) sends a payment to review by setting `review_required`.
  - **Group cleanup.** `PaymentGateways.dropGroup(tx, groupId)` (exported, global) takes a deleted merchant group out of `payment_gateways.allowed_group_ids`; the catalog's group delete calls it in its own transaction (a leaf file, `application/payment-gateways.ts`, so that it loads before the catalog import cycle, decision 032).
  - **Seed.** `scripts/seed/billing.ts`: the demo's 4 gateways (ids 1-4, codes card, crypto, bank, wise), its 54 top-ups with an invoice each (`PAY-1000` is payment 1000, invoice 1), linked to the deposit journals the money seed replayed, 3 manual invoices
    and one verification request per merchant. No receipt files or PDFs (no objects to download).

Known deviation (tech debt, PROGRESS): `infra/foreign-directory.repository.ts` reads merchant (name, email, country, group), group, supplier, customer
and staff names, and the fx rate of a storefront payment's checkout (`orders`, `checkout_sessions`), with plain selects because those modules export no directory yet; replace its bodies with their public
services as they appear (identity, catalog 4a, suppliers 6, customers 14b). Nothing outside that file knows.

## Public API (`index.ts`)

`MoneyModule` (global: `MerchantAccounts`, `LedgerPoster`, `MerchantWallets`, `MerchantSpend`, `OrderSettlements`, `PaymentGateways`, `StorefrontMoney`), `MoneyOutboxModule`, `PaymentAutoCreditModule` (worker), `FxRefreshJobModule` (worker), `INVOICE_PAID_EVENT`, `GATEWAY_HTTP_POLICY`, `topupMethodOf`, `postTransaction`, the 13 money event builders and their ids, the reversal builders `reopen`, `reopenB2c` and `refund`,
the account helpers (`walletViewOf`, `balanceDelta`, `normalSideOf`, `toDebitPositive`, `BASE_CURRENCY`), the ledger line
helpers, the wire ref types (`toWireRefType`, `storedRefTypesOf`) and the stale-rate rule `isRateStale` (the System health dashboard's `fx_stale` item reads it, so it agrees with the currencies page). `StorefrontMoney` (feature 14a, read only, takes the caller's
database handle): `currencies` / `offered` / `defaultCurrency` / `byCode` (the currencies the shop offers, `is_storefront` and
`is_active`), `taxInForce(db, country, at, region?)` and `taxRatesInForce(db, at)` (the tax window whose `valid_from` is at most the
moment and whose `valid_to` is empty or after it; a regional window wins over the national one), `paymentMethods` (active gateways
for the B2C or both audiences: code, name, 3DS support). `WalletService` is exported by `MoneyAdminModule`
(the routes and the services that read the database; a database-less test app leaves it out). Other modules import only
`src/modules/money/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 11 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `currencies` | Currencies and exchange rates, with a markup and psychological (charm) rounding for the storefront display. |
| `ledger_accounts` | Accounts: wallet, hold, revenue, customer funds and tax payable. |
| `ledger_transactions` | The journal entry header, with an idempotency key. |
| `ledger_entries` | Journal entry lines; they always sum to zero. |
| `invoices` | Top-up invoices and statements, and B2C tax receipts with a PDF copy. |
| `payment_gateways` | Payment gateways with their fees and limits, split by audience (B2B or B2C). |
| `payments` | Payments and their confirmation: a wallet top-up or a B2C order payment. |
| `withdrawal_requests` | Withdrawal requests, for a later phase. |
| `refunds` | Refunds: full or partial, to the card, the wallet or store credit. |
| `disputes` | Chargeback disputes: the deadline, the evidence pack and the outcome. |
| `tax_rates` | Tax rates per country for digital services, including the OSS scheme. |

## Routes

57 endpoints (admin 43, client 7, v1 2, dhru 1, hooks 2, events 2). Source: `docs/slices/money.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (43)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/payment-gateways/:id` | staff-permission · `payments:gateways` | Payment gateways: fees, limits and merchant groups. | 8 |
| `GET /admin/clients/:id/statement` | staff-permission · `wallet:read` | Merchant account statement. | 3 |
| `GET /admin/clients/:id/wallet` | staff-permission · `wallet:read` | Merchant wallet: available balance, reserved balance and limit. | 3 |
| `GET /admin/currencies` | staff-permission · `settings:update` | Currencies and exchange rates. | 3 |
| `GET /admin/currencies/:id` | staff-permission · `settings:update` | Currencies and exchange rates. | 3 |
| `GET /admin/disputes` | staff-permission · `disputes:read` | Card disputes (chargebacks) and the evidence deadline. | 16 |
| `GET /admin/disputes/:id` | staff-permission · `disputes:read` | Card disputes (chargebacks) and the evidence deadline. | 16 |
| `GET /admin/invoices` | staff-permission · `invoices:*` | Invoices; creating one issues a manual invoice for a merchant. | 8 |
| `GET /admin/invoices/:id` | staff-permission · `invoices:*` | Invoices; creating one issues a manual invoice for a merchant. | 8 |
| `GET /admin/ledger/accounts` | staff-permission · `ledger:read` | Accounts and their balances. | 3 |
| `GET /admin/ledger/transactions` | staff-permission · `ledger:read` | Ledger entries with their lines. | 3 |
| `GET /admin/ledger/transactions/:id` | staff-permission · `ledger:read` | Ledger entries with their lines. | 3 |
| `GET /admin/payment-gateways` | staff-permission · `payments:gateways` | Payment gateways: fees, limits and merchant groups. | 8 |
| `GET /admin/payment-gateways/:id` | staff-permission · `payments:gateways` | Payment gateways: fees, limits and merchant groups. | 8 |
| `GET /admin/payments` | staff-permission · `payments:read` | Payments and the manual review queue. | 8 |
| `GET /admin/payments/:id` | staff-permission · `payments:read` | Payments and the manual review queue. | 8 |
| `GET /admin/refunds` | staff-permission · `refunds:read` | Refund requests and their status. | 16 |
| `GET /admin/refunds/:id` | staff-permission · `refunds:read` | Refund requests and their status. | 16 |
| `GET /admin/reports/client-statement/:clientId` | staff-permission · `reports:read` | Official account statement for a merchant. | 11 |
| `GET /admin/reports/payments` | staff-permission · `reports:finance` | Storefront payments by method: fees, net amount and settlements. | 16 |
| `GET /admin/reports/profit` | staff-permission · `reports:read` | Profit by day, service, supplier or merchant. | 11 |
| `GET /admin/reports/vat` | staff-permission · `reports:finance` | VAT due by country and period, computed from ledger entries rather than invoices. | 16 |
| `GET /admin/reports/wallet-exposure` | staff-permission · `reports:read` | Balances, overdraft and reserved amounts. | 11 |
| `GET /admin/tax-rates` | staff-permission · `tax:*` | Tax rates by country and their effective dates. | 14 |
| `GET /admin/tax-rates/:id` | staff-permission · `tax:*` | Tax rates by country and their effective dates. | 14 |
| `PATCH /admin/clients/:id/credit-limit` | staff-permission · `wallet:credit_limit` | Credit limit (overdraft). | 3 |
| `PATCH /admin/currencies/:id` | staff-permission · `settings:update` | Currencies and exchange rates. | 3 |
| `PATCH /admin/payment-gateways/:id` | staff-permission · `payments:gateways` | Payment gateways: fees, limits and merchant groups. | 8 |
| `PATCH /admin/tax-rates/:id` | staff-permission · `tax:*` | Tax rates by country and their effective dates. | 14 |
| `POST /admin/clients/:id/wallet/adjust` | staff-permission · `wallet:adjust` | Manually add to or deduct from the wallet, with a reason. | 3 |
| `POST /admin/currencies` | staff-permission · `settings:update` | Currencies and exchange rates. | 3 |
| `POST /admin/currencies/refresh-fx` | staff-permission · `currencies:update` | Refresh the exchange rates shown to customers. | 14 |
| `POST /admin/disputes/:id/accept` | staff-permission · `disputes:manage` | Accept the loss; the amount and the dispute fee are recorded in chargeback_loss. | 16 |
| `POST /admin/disputes/:id/evidence` | staff-permission · `disputes:manage` | Submit evidence before the deadline: payment, delivery, order result and customer consents. | 16 |
| `POST /admin/invoices` | staff-permission · `invoices:*` | Invoices; creating one issues a manual invoice for a merchant. | 8 |
| `POST /admin/ledger/reconcile` | staff-permission · `ledger:reconcile` | Run the reconciliation now. | 3 |
| `POST /admin/payment-gateways` | staff-permission · `payments:gateways` | Payment gateways: fees, limits and merchant groups. | 8 |
| `POST /admin/payments/:id/approve` | staff-permission · `payments:approve` | Approve a manual payment and top up the wallet. | 8 |
| `POST /admin/payments/:id/reject` | staff-permission · `payments:approve` | Reject a payment with a reason. | 8 |
| `POST /admin/refunds/:id/approve` | staff-permission · `refunds:approve` | Approve a full or partial refund; the ledger entry is reversed according to whether the order was delivered. | 16 |
| `POST /admin/refunds/:id/decline` | staff-permission · `refunds:approve` | Decline the refund with a reason that reaches the customer. | 16 |
| `POST /admin/refunds/:id/retry` | staff-permission · `refunds:approve` | Retry a refund that failed at the gateway. | 16 |
| `POST /admin/tax-rates` | staff-permission · `tax:*` | Tax rates by country and their effective dates. | 14 |

### Merchant portal (7)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /client/invoices` | merchant-session | My invoices. | 8 |
| `GET /client/invoices/:id` | merchant-session | An invoice and its payments. | 8 |
| `GET /client/payment-methods` | merchant-session | Payment gateways available to my client group, with fees and limits. | 8 |
| `GET /client/wallet` | merchant-session | Available and held balance and credit limit. | 3 |
| `GET /client/wallet/statement` | merchant-session | Account statement; ?format=csv exports it. | 3 |
| `POST /client/invoices` | merchant-session | Top-up invoice; returns a payment link or bank transfer instructions. | 8 |
| `POST /client/invoices/:id/receipt` | merchant-session | Upload a bank transfer receipt for review. | 8 |

### REST API v1 (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /v1/account` | api-key · `account:read` | Available and held balance, credit limit and client group. | 7 |
| `GET /v1/transactions` | api-key · `account:read` | Account statement: wallet ledger entries, cursor pagination. | 7 |

### Dhru Fusion API (1)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DHRU accountinfo` | dhru-credentials | Account info: available balance, email and currency. | 7 |

### Incoming webhooks (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `POST /webhooks/disputes/:gateway` | gateway-signature | New or resolved dispute from the gateway; records the dispute with its evidence deadline and posts the loss when the dispute is lost. | 16 |
| `POST /webhooks/payments/:gateway` | gateway-signature | Payment confirmation: check the signature and idempotency, then credit the merchant wallet or, for the storefront, create the order and dispatch it once confirmed. | 8 |

### Outgoing webhook events (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `EVENT invoice.paid` | outbound-hmac | The wallet was credited from an invoice. | 8 |
| `EVENT wallet.low_balance` | outbound-hmac | The available balance fell below the alert threshold. | 7 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/scenarios/`).

- `success`: Order completed by the supplier (tables: `ledger_entries`)
- `reject`: Supplier rejects the order (tables: `ledger_entries`)
- `manual`: Manual fulfilment by staff (tables: `ledger_entries`)
- `timeout`: Supplier timeout (the order needs attention) (tables: `ledger_entries`)
- `b2c-paid`: Paid storefront order (tables: `currencies`, `invoices`, `ledger_entries`, `payment_gateways`, `payments`, `tax_rates`)
- `b2c-refund`: Refund before delivery (tables: `ledger_entries`, `payments`, `refunds`)
- `b2c-chargeback`: Chargeback dispute that we lose (tables: `disputes`, `ledger_entries`, `ledger_transactions`, `payments`)
- `system-integrity`: Ledger mismatch and maintenance mode (tables: `ledger_accounts`, `ledger_entries`, `ledger_transactions`, `payments`)

## Permissions

Staff permissions the map requires on this module's admin routes: `currencies:update`, `disputes:manage`, `disputes:read`, `invoices:create`, `invoices:read`, `ledger:read`, `ledger:reconcile`, `payments:approve`, `payments:gateways`, `payments:read`, `refunds:approve`, `refunds:read`, `reports:finance`, `reports:read`, `settings:update`, `tax:*`, `wallet:adjust`, `wallet:credit_limit`, `wallet:read`.

API key scopes on its REST v1 routes: `account:read`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced: `wallet.low_balance` (queue `merchant-webhooks`, aggregate `ledger_accounts`, payload `{ clientId, currency, available, threshold }`), written by
`WalletLowBalanceWatch` inside `LedgerPoster.post` (feature 7b) in the posting's own transaction: for each `client_wallet` a debit took from an available balance (balance
plus credit limit) at or above the merchant's threshold to below it, once per crossing. The threshold is `clients.notification_prefs.lowBalanceThreshold`, a money string
(the map names no field; feature 12a's notification preferences are where a merchant sets it; no threshold, no alert). The route is registered by the platform module.
`postTransaction` itself writes no alert: only the injectable `LedgerPoster` does. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

`invoice.paid` (queue `merchant-webhooks`, aggregate `invoices`, payload `{ invoiceId, clientId }`), written by `InvoiceOutbox.paid` in the transaction that credits a top-up (a staff approval and the automatic credit
job); the type is registered by `InvoiceOutbox` (module `MoneyOutboxModule`, loaded by the API and the worker). The webhook fan-out (7b) re-reads the invoice.

Outgoing webhook events from the map (documented as OpenAPI `webhooks` once defined with `defineEvent`): `wallet.low_balance`, `invoice.paid`.

## Jobs and schedules

`payment_auto_credit` (queue `maintenance`, every minute; see `docs/queues.md`): credits the confirmed top-ups of automatic gateways after the delay. `POST /admin/ledger/reconcile` runs in the request and records a `job_runs` row of job `ledger_reconcile`
(trigger `manual`, overlap refused: `RECONCILE_RUNNING`); the nightly integrity job of feature 12b can reuse
`ReconcileService.compare`.

## Cache keys

None, on purpose: balances, statements and ledger lists are never cached (decision 022).

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-6` · GET /admin/risk/queue
- `identity-platform-1` · POST /admin/clients
- `identity-platform-3` · POST /admin/clients
- `money-1` · GET /admin/ledger/transactions, GET /admin/ledger/transactions/:id
- `money-2` · GET /admin/payments, GET /admin/payments/:id, POST /admin/payments/:id/approve|reject
- `money-3` · GET /admin/payments, POST /admin/payments/:id/approve
- `money-4` · GET /admin/reports/payments, GET /admin/refunds, GET /admin/refunds/:id
- `money-5` · GET /admin/reports/payments, GET /admin/payment-gateways
- `money-6` · GET /admin/ledger/transactions, GET /admin/ledger/transactions/:id
- `money-7` · GET /admin/invoices, GET /admin/invoices/:id, POST /admin/invoices
- `money-8` · GET /admin/payments, GET /admin/payments/:id
- `money-9` · POST /admin/currencies/refresh-fx
- `money-10` · GET /admin/reports/client-statement/:clientId
- `money-11` · GET /admin/refunds, POST /admin/refunds/:id/approve|retry
- `money-12` · GET /admin/refunds, GET /admin/refunds/:id
- `money-13` · GET /admin/currencies, POST /admin/currencies, PATCH /admin/currencies/:id
- `money-14` · POST /admin/payment-gateways, PATCH /admin/payment-gateways/:id
- `money-15` · GET /admin/ledger/transactions
