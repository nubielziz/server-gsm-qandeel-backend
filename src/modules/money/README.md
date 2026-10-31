# Money module (`money`)

Map domain E. The double-entry ledger and everything that moves money: wallets and statements, currencies, invoices, payment gateways and payments, withdrawals, refunds, disputes and tax rates. `postTransaction()` is the only ledger writer (decision 024).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 011 money, 024 ledger. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Not built yet: the module is an empty shell (`money.module.ts`, `index.ts`). Its feature adds controllers, services, repositories and the owned tables.

## Public API (`index.ts`)

Exports `MoneyModule` only. Add the services other modules may call here, and nothing else: other modules import only `src/modules/money/index.ts` (lint rule `gsm/module-boundaries`).

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

Staff permissions the map requires on this module's admin routes: `currencies:update`, `disputes:manage`, `disputes:read`, `invoices:*`, `ledger:read`, `ledger:reconcile`, `payments:approve`, `payments:gateways`, `payments:read`, `refunds:approve`, `refunds:read`, `reports:finance`, `reports:read`, `settings:update`, `tax:*`, `wallet:adjust`, `wallet:credit_limit`, `wallet:read`.

API key scopes on its REST v1 routes: `account:read`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

Outgoing webhook events from the map (documented as OpenAPI `webhooks` once defined with `defineEvent`): `wallet.low_balance`, `invoice.paid`.

## Jobs and schedules

None yet. List each queue, job, schedule, idempotency key and retry policy here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").
