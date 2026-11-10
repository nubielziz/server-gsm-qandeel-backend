# 21 Customer wallet: technical plan

Planner: Fable 5.2, 2026-11-10, on `main` @ `bd32229`. Status: **approved** (section 14). Nobody writes code for feature 21
before reading this file. It is self-contained: the implementer needs `CLAUDE.md`, `docs/briefs/_common.md`,
`docs/briefs/_feature.md`, `CONTRIBUTING.md` and this file. Paths are relative to `backend/` unless they start with `FA/`
(`/home/saifi/gsm-project/frontend-admin`). `file:line` pointers were read on `bd32229`.

Sources: the owner's request of 2026-11-10 (below), ROADMAP phase 2W (`docs/ROADMAP.md:57-76`), the lead's binding decisions
(`.lead/w1/LEAD-DECISIONS.md` L1 to L6), decisions 011, 020, 022, 024, 032, and the code. Where a discovery report and the code
disagree, the code won (section 2.3).

> Owner: "Build a production-ready Customer Wallet system, overriding its previous phase 2W deferral. Requirements: wallet
> balances and transaction history; top-ups through supported payment providers; wallet payments during checkout; refunds and
> administrative balance adjustments; wallet management in Admin Console; financial audit logs and reconciliation; protection
> against double spending, duplicate credits, race conditions, and unauthorized transactions. Reuse the existing ledger and
> financial infrastructure. Ensure atomic transactions, idempotency, and financial consistency."

## 0. Read me first (implementer)

- Work only in the worktree the lead names (`../backend-21`, branch `feat/backend-21`, test DB `gsm_21_test`, Redis DB 2; console:
  `../frontend-admin-21`, branch `feat/console-21`). Never run `docker compose`, `db:migrate`, `db:seed`, `src/main.ts` or
  `scripts/ci.sh` there; never touch :3000, :3100, `gsm` or `gsm_storefront`. No git command that changes state. No agents.
- Memory is tight: run targeted files (`bun test --timeout 15000 <files>`); heavy runs through the slot lock
  (`bash scripts/with-slot.sh bun run typecheck`, `bun run lint`, `bun run test`); `bun run check` once at the end of a run, in the
  foreground.
- The storefront (`/home/saifi/gsm-project/storefront`) is read only. Never edit `reference/`.
- **Preconditions (lead):** W0 is merged, so `scripts/map-additions/<id>.mjs` exists and every tool reads it (L1). Read
  `scripts/map-additions/w0.mjs` (or `docs/briefs/W0-parallel-extensions.md`) for the exact export shape before slice B1.
- Slices run in this order: **B1 → B2 → B3 → B4 → B5** (backend), then **C1** (console). Recommended split: run 1 = B1 to B3,
  run 2 = B4 and B5; C1 is its own run in the console worktree after the backend is merged.
- Money rules that are not negotiable: only `postTransaction()` writes the ledger; one transaction per use case; ledger account
  locks are taken by `postTransaction` only, in id order, and nothing locks a `ledger_accounts` row before a posting in the same
  transaction (section 5.7); balances are never cached; no floats.

## 1. Scope

In: per-customer USD wallet (ledger account), statement, top-ups through payment gateways (manual first, card behind a switch),
paying a checkout from the balance, refunds to the balance, staff adjust and freeze, top-up chargebacks (customers and merchants),
console screens, reconciliation and integrity coverage, the defects of section 8.

Out (say so in the report if you meet them): the storefront pages (section 13 is their handoff); the Stripe card-driver defects
(webhook secret field, two secrets, `refund.updated`, card details object, three-decimal currencies: a later payments feature);
cash-out; `customer_hold`; expiry of balances; staff evidence submission for top-up disputes; a job that voids stale open top-ups.

## 2. What exists today (verified)

### 2.1 Ledger and wallets

| Fact | Where |
|---|---|
| `postTransaction(tx, input, now)`: validate, insert header first (`ON CONFLICT (idempotency_key) DO NOTHING`, a replay returns before any lock), lock all accounts in one `ORDER BY id FOR UPDATE` (missing ones are opened, then locked again), guard, entries with `balance_after`, balances | `src/modules/money/application/post-transaction.ts:163-237`; `infra/ledger-writer.repository.ts:49-56`; `infra/ledger-accounts.repository.ts:64-105` |
| The guard covers `client_wallet` only; `allowBelowCreditLimit` skips it | `post-transaction.ts:206-218`, `:36-41` |
| 15 account kinds; owner types `client, supplier, customer`; `ledger_accounts_kind_owner_check` allows an owner only for `client_wallet`, `client_hold`, `supplier_prepaid` | `src/modules/money/db/schema.ts:40-56`, `:66`, `:300-305` |
| Ref types `order, payment, invoice, refund, dispute, accrual, supplier, client, system`; a stored `client` is sent as `system` | `db/schema.ts:77-87`; `domain/ref-types.ts:34-49` |
| `CREDIT_NORMAL_KINDS` feeds the SQL of the trial balance and of the reconcile; `normalSideOf` treats an unknown kind as credit | `domain/accounts.ts:39-62`; `infra/ledger-read.repository.ts:367-373`, `:417-435` |
| `PER_OWNER_ACCOUNT_KINDS` decides which kinds `bun run setup` and the seed create as system accounts | `domain/reference-data.ts:12-25` |
| Zero sum is a deferred constraint trigger; `ledger_entries` and `ledger_transactions` are append-only | `drizzle/0001_ledger_and_audit_triggers.sql:16-62` |
| Merchant wallet template: view, statement, adjust (key `adjust:<clientId>:<Idempotency-Key or random UUID>`, approval limit, replay check, audit), contracts, controller | `application/wallet.service.ts:93-333`; `contracts/wallet.contracts.ts:42-120`; `controllers/wallet.controller.ts:28-98` |
| Low-balance watch and every merchant report filter on `client_wallet` + owner `client` (customer wallets do not disturb them) | `application/wallet-low-balance-watch.ts:40`; `infra/report.repository.ts:124,156`; `src/modules/health/dashboard/dashboard-reads.ts:311` |

### 2.2 Billing, B2C and integrity

| Fact | Where |
|---|---|
| `payments.gateway_id NOT NULL`; method CHECK per purpose (top-up `bank, card, usdt, wise`; order `card, wallet, crypto`); unique `(gateway_id, gateway_txn_id)`; unique `(checkout_session_id, idempotency_key)` | `db/schema.ts:518`, `:570-574`, `:560-562`, `:591-593` |
| `invoices` has `client_id` and `customer_id`, no idempotency column | `db/schema.ts:398-449` |
| Top-up webhook: ignores an invoice without `client_id` | `application/payment-webhook.service.ts:102` |
| Crediting: refuses a non-merchant invoice; posts `deposit` (key `deposit:payment:<id>`); writes `invoice.paid`; renders the PDF | `application/payment-crediting.ts:66-122` |
| Review: locks the payment, `reviewRefusal`; reject voids a top-up invoice | `application/payment-review.service.ts:86-157`; `domain/payment-rules.ts:61-80` |
| Auto-credit job screens with the merchant's email only | `jobs/payment-auto-credit.ts:158-187` |
| Merchant top-up invoice + receipt upload (the template for customers) | `application/merchant-billing.service.ts:165-306` |
| Checkout: a guest checkout reuses **any** customer row with that email, account holders included | `src/modules/customers/application/checkout-session.service.ts:281-283` |
| `/pay` refuses manual and `b2b` gateways and gateways without a driver, but the method list offers every active `b2c|both` gateway | `application/storefront-payments.ts:150`; `infra/storefront-money.repository.ts:85-91`; `application/storefront-money.ts:158-164` |
| Capture: locks the session, places the order through `CustomerOrderPlacement.place(tx, req, onInserted)`, posts in `onInserted`, marks the session paid; a second payment of a paid session is booked and refunded | `src/modules/customers/application/checkout-capture.service.ts:78-158`; `src/modules/orders/application/customer-placement.ts:89-179`; `storefront-payments.ts:322-389`, `:460-476` |
| Refunds: `postLedger` always credits `gateway_clearing`; `leftOn` reads what was refunded from `ledgerPartsOf`, whose `gross` is the `gateway_clearing` line | `application/b2c-refunds.ts:405-442`, `:214-232`; `infra/b2c-reads.repository.ts:119-137` (`:129`) |
| `refundRoute` and `b2cPaymentMethod` know `card, wallet, crypto` only (anything else becomes `card`) | `domain/refund-rules.ts:42-50`; `domain/b2c-money.ts:124-127` |
| Dispute webhook finds **order** payments only; `DisputeLedger.lose` sets the payment `chargeback` and posts ref `order` | `application/dispute-webhook.service.ts:63`; `infra/order-payment.repository.ts:151-162`; `application/dispute-ledger.ts:43-81` |
| `DisputeSchema.orderId` is a positive id; the view sends `orderId ?? 0` | `contracts/disputes.contracts.ts:30`; `application/dispute-views.ts:105` |
| VAT report takes `gross` from `gateway_clearing` lines | `infra/b2c-reports.repository.ts:41` |
| Integrity: four checks, a closed key enum; `payments_without_entry` inner-joins `payment_gateways` | `src/modules/health/domain/integrity.ts:14-19`; `src/modules/health/contracts/integrity.contracts.ts:21`; `src/modules/health/infra/integrity-reads.repository.ts:190-225` (`:202`) |
| Editable settings are an allow-list with one validator per key | `src/modules/platform/settings/settings-registry.ts:106-112` |
| Store uploads do not exist; `FileUploadService.upload` writes `owner_type 'client'`; `StoredFiles.findOwned` already accepts `customer` | `src/common/multipart.ts:22`; `src/modules/platform/application/file-upload.service.ts:99-124`; `src/modules/platform/files/stored-files.ts:142-153` |
| Customer mails go through `NotificationService.enqueue` in the caller's transaction | `application/storefront-mails.ts:125-147` |

### 2.3 Where the code contradicts the discovery reports (the code wins)

1. **`ledgerPartsOf` (not in D3):** a refund credited to the wallet has no `gateway_clearing` line, so `leftOn` would see nothing
   refunded in USD and a second partial refund could return money twice (`b2c-reads.repository.ts:129`, `b2c-refunds.ts:226`). Fixed in B4.
2. **`REFUND_USD` (D3: "falls back correctly"):** for a partial refund the fallback converts the payment currency back and can differ
   from the journal (`b2c-reports.repository.ts:136-139`). Fixed in B4.
3. **Top-up disputes need more than a lookup (D3 §2.4):** `DisputeLedger.lose` and `win` write an order-payment status on the payment
   (`dispute-ledger.ts:79`, `:104`), which `payments_status_check` refuses for a top-up; and `/admin/disputes` cannot carry a row
   without an order (`disputes.contracts.ts:30`). Top-up disputes get their own branch and are shown on the deposit, not in
   `/admin/disputes` (section 5.6.9).
4. **Lock order of a freeze (D3 §2.9: "payment → dispute → wallet account (freeze) → ledger"):** locking the wallet row before a posting
   breaks the id order and can deadlock with a top-up credit. This plan posts first and freezes after (section 5.7).
5. **Frozen check inside the ledger guard (D3 §2.3):** staff must be able to debit a frozen wallet, so `postTransaction` only reports
   `frozen` (read under the lock); the balance payment refuses it.
6. **Turnstile on top-ups (D3 §2.11):** the map's auth vocabulary has no customer-session + Turnstile text (`scripts/lib/map.mjs:28-47`).
   None is used: the routes need a session, CSRF, a rate limit and SQL velocity limits.
7. **An advisory lock for balance pay (D3 §2.4):** not needed; the session row lock serializes every payer of one checkout.
8. **`PER_OWNER_ACCOUNT_KINDS` (not in the reports):** without `customer_wallet` in it, `bun run setup` would try to create a
   system `customer_wallet` account and fail the CHECK (`reference-data.ts:12-25`).
9. **A fifth integrity check (D3 §2.12):** the check key is a closed enum compared with the console's types
   (`integrity.contracts.ts:21`, `FA/src/features/system-health/types/integrity.ts:7-8`). No new key: the invariant is enforced by the
   database instead (section 6.2).

## 3. Requirement → status → evidence

| # | Requirement | Status today | Evidence | Closed by |
|---|---|---|---|---|
| R1 | Wallet balances | Missing: the CHECK forbids a customer-owned account | `db/schema.ts:300-305` | B1, B2 |
| R2 | Transaction history | Missing for customers; the merchant statement exists | `wallet.service.ts:148-168` | B2 |
| R3 | Top-ups through payment providers | Merchant pipeline exists; five places refuse a customer invoice | `payment-webhook.service.ts:102`, `payment-crediting.ts:70`, `payment-auto-credit.ts:183-187`, `invoice-documents.ts:42`, `invoice-outbox.ts:37` | B3 |
| R4 | Wallet payment at checkout | Missing; only gateway payments | `checkout-pay.service.ts:57-87` | B4 |
| R5 | Refunds to the wallet | Missing; refunds credit `gateway_clearing` and queue a gateway job | `b2c-refunds.ts:386-389`, `:429` | B4 |
| R6 | Administrative adjustments | Merchants only | `wallet.service.ts:188-229` | B2 |
| R7 | Wallet management in the console | Merchant Wallet tab only; customer page has no wallet | `FA/src/features/customers/lib/detailTabs.ts:4-10` | C1 |
| R8 | Financial audit logs | `AuditService.record` exists; no wallet actions for customers | `src/modules/platform/audit/audit.service.ts:63-95` | B2, B3, B5 |
| R9 | Reconciliation | Generic, but wrong for a new kind until `CREDIT_NORMAL_KINDS` knows it; balance payments invisible to `payments_without_entry` | `ledger-read.repository.ts:367-373`; `integrity-reads.repository.ts:202` | B1, B5 |
| R10 | No double spending | Ledger guard exists for merchants only | `post-transaction.ts:207-218` | B1, B4 |
| R11 | No duplicate credits | `deposit:payment:<id>` + unique gateway txn exist; reusable | `payment-crediting.ts:96`; `db/schema.ts:560-562` | B3 |
| R12 | No race conditions | Lock-order discipline exists; new flows must follow it | section 5.7 | all |
| R13 | No unauthorized transactions | A guest checkout can carry an account holder's id | `checkout-session.service.ts:281-283` | B4 |
| R14 | Reuse the ledger | Yes | section 5 | all |
| 2W.1 to 2W.5 | Accounts, events, routes, rules, console | Missing | `docs/ROADMAP.md:65-73` | B1 to B5, C1 |
| 2W.6 | Site pages | Other session | — | section 13 |
| 2W.7 | Legal and payments | Master switch off by default; manual gateways first | L5 | B1, B3 |

## 4. Decisions taken (owner defaults per L5, and planner choices)

Owner defaults (L5; the owner may change them later; each is a setting or a one-line rule):

| # | Decision | Default taken |
|---|---|---|
| O1 | Currency | USD wallet, one account per customer; the site shows conversions as approximate |
| O2 | Hold account | None; a balance payment moves money to the pooled `customer_funds`, like a card capture |
| O3 | Overdraft | None; the only negative path is a lost top-up chargeback |
| O4 | Cash-out | None (closed loop) |
| O5 | Who has a wallet | Signed-in customers with an account; a guest checkout can never use a balance |
| O6 | Master switch | `wallet.customer.enabled`, default **off**; the development seed turns it on |
| O7 | Card top-ups | `wallet.customer.card_topups`, default **off**; manual gateways (bank, CliQ) first |
| O8 | Limits | Minimum top-up $5, maximum $500, maximum balance $1,000, at most 5 top-ups and $1,000 in any 24 hours; all settings |
| O9 | VAT | At spend (the session's locked rate), never at top-up; a top-up invoice carries no tax |
| O10 | Refund destination | Balance-paid → balance, at once; card-paid → card (no store credit) |
| O11 | Top-up chargeback | Freeze at `dispute.created`; on loss claw back the credited amount (the balance may go negative), reverse our fee income, book the dispute fee as a loss; staff collect or write off with an audited adjustment |
| O12 | Dormant balances | No expiry; anonymization is refused while the balance is not zero |
| O13 | Staff permissions | `wallet:read`, `wallet:adjust`, `payments:approve` reused; no new permission |
| O14 | Customer adjust approval limit | Setting, default $500 |
| O15 | `Idempotency-Key` | Required on every customer wallet write |

Planner choices the owner should know (also listed as spec decisions in section 12):

| # | Question | Chosen | Why |
|---|---|---|---|
| P1 | What does a freeze block? | Paying from the balance, and card top-ups. Bank top-ups, credits, refunds and staff adjustments still work | Money in is safe; the customer can repay a negative balance; staff need to correct a frozen wallet |
| P2 | Does a won dispute lift the freeze? | No; staff unfreeze | The customer disputed a real top-up; a person should look first |
| P3 | Staff reason of an adjustment in the customer's statement? | No; the customer reads "Balance adjustment" | The reason is an internal note |
| P4 | Top-up dispute screens | Shown on the deposit (Finance → Deposits) and on the customer's Wallet tab; not in Refunds → Disputes | That list and its evidence pack are built on an order (section 2.3 item 3) |
| P5 | Customer top-up invoice PDF | None; the customer gets an email | No tax document is due for stored value (O9) |
| P6 | Kill switch behaviour | Off blocks new top-ups and balance payments; balances stay visible; receipts of open top-ups, credits, refunds and staff tools keep working | Money already in flight must still be booked |
| P7 | Who may change the wallet settings? | `settings:update` through `PATCH /admin/settings`, every change audited | The approval limit can be raised by the same person who adjusts: accepted, see risk K7 |
| P8 | Open top-ups at once | At most 3 unpaid top-ups per customer; the customer can cancel a manual one | Stops clutter without a cleanup job |
| P9 | Balance pay needs a checkout opened while signed in | Yes (`checkout_sessions.opened_signed_in`) | Closes the "send the victim a prepared checkout link" attack (K2) |
| P10 | Merchant adjust header | Stays optional on the server (no breaking change); the console now always sends it | L1: existing routes change only additively |

## 5. Architecture

### 5.1 Invariants

1. `postTransaction` is the only ledger writer; every money move has one deterministic idempotency key.
2. A customer wallet debit that would end below zero is refused under the account lock (`INSUFFICIENT_FUNDS`). The one exception is
   the top-up chargeback clawback, which freezes the wallet in the same transaction.
3. A customer wallet below zero is frozen: enforced by the database at commit (section 6.2).
4. Credits are never refused (money received is always booked), frozen or not, switch on or off.
5. Every customer id comes from the authenticated principal. A balance payment also requires the checkout to belong to that customer
   **and** to have been opened while signed in.
6. One balance payment per checkout session (session row lock, status check, and a unique index).
7. Nothing about a balance, a freeze, a limit decision or an idempotency result is read from Redis.

### 5.2 Module ownership

| Piece | Owner | Notes |
|---|---|---|
| `ledger_accounts` (new kind, freeze columns), wallet events, `CustomerWallets`, `CustomerTopUps`, `CustomerWalletPayments`, top-up payments and invoices, refunds and disputes branches, reports, routes `/store/v1/me/wallet*`, `/admin/customers/:id/wallet*`, `/admin/customer-wallets` | **money** | As `/admin/clients/:id/wallet` belongs to money while `/admin/clients` belongs to identity |
| `checkout_sessions.opened_signed_in`, `balancePayable` on the session view, `POST …/:token/balance-payment`, the anonymize guard, the wallet part of the data export | **customers** | Calls money's public services with its `tx` (customers imports money; money never imports customers: decision 032) |
| Order placement, order machine, dispatch | **orders** | Unchanged |
| `ScreeningInput.paymentMethod` gains `balance` (types only); risk queue method word (see L-conflict 2) | **risk** | |
| `POST /store/v1/files`, settings registry keys, the `checkout` maintenance pattern | **platform** | Small named edits |
| `payments_without_entry` join, account label | **health** | |
| Money reads `customers` (name, email, status, has_account) through `infra/foreign-directory.repository.ts` | money | The documented decision-016 deviation of that file (`foreign-directory.repository.ts:268-299`) |

Public money services added to `src/modules/money/index.ts`: `CustomerWallets`, `CustomerWalletPayments`, their input and result
types, and `WALLET_EVENT_IDS` with the builders. `MoneyAdminModule` (`money-admin.module.ts:69-125`) provides and exports them;
`CheckoutModule` already imports `MoneyAdminModule` (`src/modules/customers/checkout.module.ts:23`); `customers-accounts.module.ts:33`
adds `MoneyAdminModule` to its imports for the anonymize guard. No new Nest module; `app.module.ts` is not touched.

### 5.3 Account and state

- New account kind **`customer_wallet`**: liability, credit-normal, owner type `customer`, currency `USD`, one per customer, opened by
  the first posting (the `openAccounts` fallback) or by the first freeze. Reads answer zeros while it does not exist.
- Freeze state lives on the account row: `frozen_at timestamptz NULL`, `frozen_reason text NOT NULL DEFAULT ''`. It is read under the
  same `FOR UPDATE` that guards the debit.
- `overdraft_limit` stays 0 for every kind except `client_wallet` (new CHECK).

### 5.4 Money events (new file `domain/customer-wallet-events.ts`; `MONEY_EVENT_IDS` stays the map's 13)

`WALLET_EVENT_IDS = ['customer_topup', 'b2c_wallet_pay', 'b2c_wallet_refund', 'customer_adjust', 'topup_chargeback']`. Ledger kinds are
the console's existing words, so labels and filters work unchanged. All lines are USD; a zero line is dropped (`debitLine`/`creditLine`,
`domain/ledger-lines.ts:44-65`).

| Builder | Lines | kind | ref_type / ref_id | Idempotency key | Actor | Guard |
|---|---|---|---|---|---|---|
| `customerTopup({ customerId, amount, fee, from })` | Dr `bank` (manual gateway) or `gateway_clearing` (automatic) amount+fee / Cr `customer_wallet` amount / Cr `fee_income` fee. `amount` is the net credited, as in `deposit` (`money-events.ts:104-113`) | `deposit` | `payment` / payment id | `deposit:payment:<paymentId>` (payment ids are global, so merchants and customers share the namespace safely) | staff (approve) or system (auto-credit) | credit: always passes |
| `b2cWalletPay({ customerId, net, vat })` | Dr `customer_wallet` net+vat / Cr `customer_funds` net / Cr `vat_payable` vat | `b2c_payment` | `order` / order id | `payment:<paymentId>:capture` | `{ type: 'customer', id }` | `INSUFFICIENT_FUNDS` below zero; the caller refuses a frozen wallet |
| `b2cWalletRefund({ customerId, net, vat, from })` | Dr `customer_funds` (or `revenue` when delivered) net / Dr `vat_payable` vat / Cr `customer_wallet` net+vat | `refund` | `order` / order id | unchanged: `order:<id>:refund` (system rejection) or `refund:<refundId>` | staff or system | credit |
| `customerAdjust({ customerId, amount, direction })` | credit: Dr `adjustments` / Cr `customer_wallet`; debit: the mirror | `adjustment` | **`customer`** (new stored ref type; sent as `system`, like `client`) / customer id | `adjust:customer:<customerId>:<Idempotency-Key>` | staff | debit: `INSUFFICIENT_FUNDS` below zero |
| `topupChargeback({ owner: { type: 'customer' \| 'client', id }, net, fee, disputeFee })` | Dr the owner's wallet net / Dr `fee_income` fee / Dr `chargeback_loss` disputeFee / Cr `gateway_clearing` net+fee+disputeFee | `chargeback` | `dispute` / dispute id | `dispute:<disputeId>:chargeback` | system (webhook) | override: `allowNegativeCustomerWallet` (customer) or `allowBelowCreditLimit` (merchant) |

`b2c_deliver`, `reopenB2c`, `b2c_fee` are unchanged: after a balance payment the money sits in `customer_funds` exactly as after a
card capture, so delivery, reopen, the VAT lock and the order machine do not change. A balance payment has no gateway fee.

Pro-rata rule of the clawback (`domain/customer-wallet-events.ts`, pure, unit-tested): with a top-up of gross `G`, fee `F`, and a
disputed amount `D ≤ G`: `fee = F` when `D ≥ G`, else `round(F × D / G, 4)`; `net = D − fee`. The whole dispute returns exactly what
was credited.

### 5.5 `postTransaction` change (the only change to the writer)

`application/post-transaction.ts`, `infra/ledger-accounts.repository.ts`:

- `LockedAccount` gains `frozenAt: Date | null` (selected in `lockAccountsByIdentity`, `:94-104`).
- `PostTransactionInput` gains `allowNegativeCustomerWallet?: boolean` (TSDoc: "only the top-up chargeback clawback").
- `PostedAccount` gains `frozen: boolean` (what the account was under the lock).
- The guard loop (`:206-218`) becomes, through a pure function `walletDebitRefusal(account, before, after, flags)` in new
  `domain/wallet-guard.ts`:
  - not a debit (`after ≥ before`) → pass;
  - `client_wallet`: unchanged (`after < −overdraft_limit` → `INSUFFICIENT_FUNDS` unless `allowBelowCreditLimit`);
  - `customer_wallet`: `after < 0` → `INSUFFICIENT_FUNDS` (detail `The balance would end at <after>; a store balance cannot go below zero.`)
    unless `allowNegativeCustomerWallet`.
- Nothing else moves: header first, id-ordered locks, entries, balances.

### 5.6 Use cases (one transaction each)

Every use case below is one `DbService.runInTransaction` unless it says otherwise. Settings are read once before the transaction
through `SettingsReader.all()` and turned into a policy by the pure `customerWalletPolicy(settings)` (section 5.8).

#### 5.6.1 Read (money, `application/customer-wallets.ts`)
- `viewForCustomer(customerId)` / `viewForStaff(customerId)` (staff: `NOT_FOUND` when the customer does not exist): one read of the
  account row, one aggregate of the customer's live open top-ups, one aggregate of the last 24 hours, the policy. No lock, no cache.
- `statementForCustomer` / `statementForStaff`: entries of the wallet account, newest first by `ledger_entries.id`, optional
  `createdAt` range on `ledger_entries.created_at` (the posting time: `post-transaction.ts:196-203`), exact count; uses the index
  `ledger_entries_account_idx (account_id, id)`. `amount` is negated to the customer's side as the merchant statement does
  (`wallet.service.ts:163`). The store variant masks the memo: `customerMemo(kind, storedMemo)` returns `Balance adjustment` for
  kind `adjustment` and the stored memo otherwise (system memos name only `PAY-`, `SF-`, `RF-`, `DP-` numbers), and adds `orderId`
  when `ref_type = 'order'`.
- `list(query)` for `GET /admin/customer-wallets`: `ledger_accounts` where `kind = 'customer_wallet'`, state filter, search through
  the customer ids matching name or email, exact count, batch-loaded customers (no N+1).

#### 5.6.2 Adjust (money)
`adjust(staffId, customerId, { amount, direction, reason, idempotencyKey })`, modelled on `wallet.service.ts:188-229`:
1. Parse the amount (> 0). Read the policy.
2. tx: `findWalletCustomer(tx, customerId)` → `NOT_FOUND`. A **credit** needs `status ≠ 'anonymized'` (`ANONYMIZED`) and
   `has_account = true` (`NO_ACCOUNT`); a debit is allowed for any customer.
3. `needsSecondApprover(amount, policy.adjustApprovalLimit)` (`domain/wallet-rules.ts:78-80`) → `APPROVAL_REQUIRED`.
4. `poster.post` with `customerAdjust`, `refId = customerId`, key `adjust:customer:<customerId>:<key>`, memo
   `Manual <direction>: <reason>`, `createdBy` staff. No lock is taken before it.
5. A replay (`posted.replayed`) must be the same request: compare memo and the `customer_wallet` line through `findJournal`, else
   `IDEMPOTENCY_KEY_REUSED` (copy `wallet.service.ts:316-332`).
6. Audit: action `adjusted wallet of` (replay: `repeated wallet adjustment of`), entity `customer`, label = the customer's name or
   email, `before { balance }` from `posted.touched`, `after { balance, transactionId, amount, direction, reason }`.
7. Mail `wallet.adjusted` (not on a replay). Answer `{ transactionId, wallet }`.
`INSUFFICIENT_FUNDS` is answered as it is (402): customers have no credit limit.

#### 5.6.3 Freeze, unfreeze (money)
- `freeze(actor, customerId, reason)`: tx: customer exists; `ensureAccount` (`openAccounts` for the one identity); lock the wallet row
  `FOR UPDATE`; already frozen → no change (same answer, audited as `froze wallet of` with `after.alreadyFrozen: true`); else set
  `frozen_at = clock.now()`, `frozen_reason`, `version + 1`; audit `froze wallet of` (entity `customer`); mail `wallet.frozen`.
- `unfreeze(staffId, customerId, reason)`: tx: lock the row; not frozen → no change; `balance < 0` → `CONFLICT` ("Bring the balance to
  zero or above first."); an open top-up dispute of the customer (`disputes` ⨝ `payments` with `purpose = 'topup'`, status
  `needs_response|under_review`) → `OPEN_DISPUTE`; else clear both columns; audit `unfroze wallet of`.
- `freezeAfterPosting(tx, accountId, reason)` (used by the dispute flow): the same UPDATE on a row this transaction already holds.
- These use cases lock **only** the wallet row and post nothing afterwards.

#### 5.6.4 Top-up: create, list, read, receipt, cancel (money, `application/customer-top-ups.ts`)
A top-up is an `invoices` row (`kind 'topup'`, `customer_id`, USD, `open`) and, once paid, a `payments` row (`purpose 'topup'`,
`customer_id` set). The store sees one merged object (`TopUp`, section 7.1) with a derived status (pure `topUpStatusOf`):
invoice `paid` → `credited`; `void` with a rejected payment → `rejected`; `void` otherwise → `cancelled`; `open` with a pending
payment → `in_review`; `open` → `awaiting_payment`.

`create(customerId, { amount, gatewayId }, key)`:
1. Policy: not enabled → `WALLET_DISABLED`. `RateLimitService.enforce('wallet-topup', String(customerId))` (a hint; the truth is step 3).
2. `parseAmount` (`domain/invoice-rules.ts:118-128`).
3. tx:
   a. `pg_advisory_xact_lock(hashtextextended('wallet-topup:' || customerId, 0))` (waiting): serializes this customer's creates, so the
      limit checks cannot race. No network call happens while it is held.
   b. Replay: the customer's invoice with this `idempotency_key`. Same fingerprint (`JSON.stringify([gatewayId, amount.toWire()])`) →
      answer it again (header `idempotency-replayed: true`); another fingerprint → `IDEMPOTENCY_KEY_REUSED`. An automatic top-up whose
      `checkout_url` is still empty: younger than 60 s → `IDEMPOTENCY_IN_PROGRESS`; older → void it, clear its key, go on as new
      (the `/pay` rule, `storefront-payments.ts:244-256`).
   c. Customer: exists, `status = 'active'`, `has_account` → else `UNAUTHORIZED`.
   d. Gateway: active, audience `b2c|both`, and (manual, or `policy.cardTopUps` and `driverFor(driver)` exists) → else `422` on
      `gatewayId` (`unavailable`). Frozen wallet and an automatic gateway → `WALLET_FROZEN`.
   e. Limits (pure `checkTopUp`, each a `422` on `amount` with the code in brackets): below `max(gateway.min, policy.minTopUp)` (`min`);
      above the lower non-zero of `gateway.max` and `policy.maxTopUp` (`max`); fee ≥ amount (`fee`); live open top-ups ≥ 3 → `409 CONFLICT`
      ("You have 3 unpaid top-ups. Pay or cancel one first."); top-ups created in the trailing 24 h with status `open` (live) or `paid`,
      this one included, more than `policy.topUpsPerDay` (`daily_count`) or their amounts above `policy.topUpAmountPerDay` (`daily_amount`);
      `balance + pending net + this net > policy.maxBalance` (`max_balance`). "Live" = `open` and (manual gateway, or created less than
      24 h ago, or it has a pending payment). The 24 h window takes `clock.now()` as a parameter.
   f. `reserveInvoiceId`, `invoiceNumber`, `topupInvoiceTotals(amount, depositFee(...), '0')`, insert the invoice (`customer_id`,
      `gateway_id`, `idempotency_key`, `request_fingerprint`, `tax_rate 0`, `due_at` from `INVOICE_DUE_DAYS_KEY`).
4. Manual gateway: answer `{ ...topUp, instructions }`. Automatic: outside the transaction call `driver.createCheckout` with
   `invoiceNumber`, `returnUrl = <STORE_BASE_URL>/account/wallet?topUp=<id>` (`config.http.storeBaseUrl`) and
   `idempotencyKey = <invoice number>`; then a second short transaction stores `checkout_url` (guarded: still `open`). A gateway error
   voids the invoice (guarded: `open`, no payment), clears its key and answers `502 GATEWAY_ERROR`.

`attachReceipt(customerId, topUpId, { fileId, reference })`: a copy of `uploadReceipt` (`merchant-billing.service.ts:253-306`) for a
customer: lock the customer's invoice; `open` else `CONFLICT`; manual gateway else `CONFLICT`; a pending payment with the **same**
`receipt_file_id` → answer the top-up again (a retry); another pending payment → `CONFLICT`; the file must be the customer's own
(`StoredFiles.findOwned(tx, fileId, { type: 'customer', id })`) and a `PROOF_MIME_TYPES` type (`422` on `fileId`); a used reference →
`422` on `reference` (`taken`), also from the unique index (`isUniqueViolation`). Insert the payment: `purpose 'topup'`, `invoice_id`,
`customer_id`, `status 'pending'`, `method_type = topupMethodOf(driver, true)`, `amount`/`fee_amount` from the invoice. Ask
`TopUpScreeningHooks.screen(tx, { email, cardFingerprint: null })`; a hit sets `review_note` to its reason (a hint for the reviewer;
manual top-ups always wait for staff). Allowed while the switch is off (the customer may already have paid).

`cancel(customerId, topUpId)`: lock the invoice; already `void` → answer it (idempotent); `paid` → `CONFLICT`; automatic gateway →
`CONFLICT` ("An online top-up closes by itself."); a pending payment → `CONFLICT`; else `status = 'void'`.

#### 5.6.5 Credit, reject, auto-credit, webhook (money; existing files branch on the invoice owner)
- `PaymentWebhookService.handle` (`payment-webhook.service.ts:98-138`): accept an invoice of kind `topup` with `client_id` **or**
  `customer_id`; write `customer_id: invoice.customerId` and `card_fingerprint: event.details?.fingerprint ?? null` on the row (so
  the card screen works once the driver fills it). Everything else unchanged (unique gateway txn, mismatch → review).
- `PaymentCrediting.credit` (`payment-crediting.ts:66-122`): lock order unchanged (payment → invoice → ledger). Owner = merchant:
  unchanged. Owner = customer: `customerTopup` posting (same key, same memo form), payment `approved`, invoice `paid`, **no**
  `invoice.paid` outbox row (a merchant webhook event), **no** PDF, audit label `<net> <currency> from <customer name or email>`,
  mail `wallet.topup_credited` with the balance from `posted.touched`. An invoice with neither owner stays a `CONFLICT`.
- `PaymentReviewService.reject` (`payment-review.service.ts:104-146`): the audit label names the customer; mail `wallet.topup_rejected`
  with the reason.
- `PaymentAutoCredit` (`jobs/payment-auto-credit.ts:158-187`): `merchantEmail` becomes `ownerEmail` (merchant or customer). The
  worker's `PaymentAutoCreditModule` (`jobs/payment-auto-credit.module.ts:31-45`) imports `StorefrontMailsModule` because
  `PaymentCrediting` now needs the wallet mails.
- Deposits wire (`PaymentViews`, `payment.repository.ts:42-112`): rows carry `customerId` (from `payments.customer_id`); the view
  batch-loads customers, their wallet balances and the newest dispute of each payment; `firstDeposit` also works per customer.

#### 5.6.6 Pay a checkout from the balance (customers orchestrates, money records)
Route `POST /store/v1/checkout-sessions/:token/balance-payment`. `CheckoutBalancePayService.pay(sessionId, customerId, key)` in
`src/modules/customers/application/checkout-balance-pay.service.ts`:

Before the transaction (controller): `customerId = await OptionalCustomerSession.customerId(request)` (it authenticates the cookie
and asserts the CSRF token, `optional-customer-session.ts:32-37`); `undefined` → `401 UNAUTHORIZED`. Policy off → `WALLET_DISABLED`.

One transaction, in this order:
1. `lockCheckoutSession(tx, sessionId)` (`infra/checkout.repository.ts:82-85`) → `NOT_FOUND`.
2. Authorization, before anything is revealed or replayed: `session.customerId === customerId` and `session.openedSignedIn === true`,
   else `403 FORBIDDEN` (two details: "This checkout belongs to another account." / "Open the checkout while signed in to pay from
   your balance.").
3. Replay: `CustomerWalletPayments.replayOf(tx, sessionId, key)` finds the payment by `(checkout_session_id, idempotency_key)`. A
   balance payment of this customer → answer it again (`idempotency-replayed: true`). A payment of another kind under the key (a
   `/pay` call) → `IDEMPOTENCY_KEY_REUSED`.
4. Payable (the rules of `assertPayable`, `checkout-pay.service.ts:90-115`, on `tx`): `paid` or expired → `INVALID_TRANSITION`;
   customer not `active` → `ACCOUNT_SUSPENDED`; consents incomplete → `422` on `consent`.
5. Friendly pre-check (no lock): `CustomerWallets.peek(tx, customerId)`: frozen → `WALLET_FROZEN`; balance below the gross →
   `INSUFFICIENT_FUNDS`. The authoritative checks are in step 8.
6. `RiskScreening.assess` with `paymentMethod: 'balance'` and no card fingerprint (as `checkout-capture.service.ts:109-119`).
7. `CustomerOrderPlacement.place(tx, request, onInserted)` exactly as the capture builds it (`checkout-capture.service.ts:122-142`),
   `paidMessage: 'Payment of <display gross> <currency> received (Store balance)'`.
8. `onInserted(order)` → `CustomerWalletPayments.record(tx, { sessionId, key, customerId, order, session, displayGross })` (money):
   insert the payment (`purpose 'order'`, `method_type 'balance'`, `gateway_id NULL`, `status 'captured'`, `customer_id`, `order_id`,
   `checkout_session_id`, `idempotency_key`, `request_fingerprint 'balance'`, `amount` = the gross in the session currency
   (`fromUsd`), `currency` = the session currency, `fee_amount 0`, `brand 'Store balance'`, `captured_at`); post `b2cWalletPay`
   with `net = order.totalPrice`, `vat = order.taxAmount` (the session's lock, as `recordCapture` does, `storefront-payments.ts:336-351`);
   if the wallet in `posted.touched` is `frozen` → throw `WALLET_FROZEN`; issue the receipt invoice (`issueReceipt` with
   `gatewayId: null`) and queue `receipt.render`; set `payments.invoice_id`. `INSUFFICIENT_FUNDS` from the guard propagates. Any throw
   rolls back the order, the stock claim and the assessment.
9. `risk.linkOrder`, `markSessionPaid`. `block` → `RiskDecisionsService.refundBlocked` (the refund goes back to the balance through
   5.6.7). Otherwise `mails.orderReceived` (+ `orderCompleted` when stock delivered at once).
Answer `201 { payment, order: { id, trackingToken }, wallet: { balance, available } }`.

Why the payment row keeps the session's currency and amount: every refund path computes "what is left" in the payment currency and
converts with the session's rate (`b2c-refunds.ts:214-232`, `refund.service.ts:124-148`). The wallet itself always moves the USD the
session locked.

#### 5.6.7 Refund to the balance (money; existing flow, three branches)
- `b2cPaymentMethod('balance') = 'balance'`; `refundRoute('balance', …) = { method: 'original', note: '' }`; new pure
  `settlesAtOnce(refundMethod, paymentMethodType)` = `refundMethod === 'manual' || paymentMethodType === 'balance'`
  (`domain/refund-rules.ts`, `domain/b2c-money.ts`).
- `B2cRefunds.postLedger` (`b2c-refunds.ts:405-442`): when `payment.methodType === 'balance'` post `b2cWalletRefund` with
  `customerId = payment.customerId`; the split, the closing rule and the keys do not change.
- `B2cRefunds.dispatchAutomatic` (`:386-389`) and `RefundService.approve` (`refund.service.ts:194-195`): `settlesAtOnce` → `complete(tx, id, null)`,
  never a `refund.process` job. Timeline text: "returned to the store balance".
- Every `findGateway(tx, payment.gatewayId)` guards a null id (`b2c-refunds.ts:330,365`; `refund.service.ts:149`;
  `jobs/refund-sender.ts:70`; `dispute.service.ts:132`).
- `ledgerPartsOf` (`b2c-reads.repository.ts:129`): `gross` = lines of kind `gateway_clearing` **or** `customer_wallet`.
- Mails: `StorefrontMails.orderFailed` (`storefront-mails.ts:77-87`) sends `wallet.order_refunded` instead of `order.failed` when the
  order's payment is a balance payment (the stored `order.failed` text says "to your card"); `RefundService.approve` sends
  `wallet.order_refunded` for a delivered order refunded to the balance.
- A card-paid order is never refunded to the balance.

#### 5.6.8 VAT and payments reports (money)
- `vatRows` (`b2c-reports.repository.ts:41`): `gross` over kinds `('gateway_clearing', 'customer_wallet')`.
- `REFUND_USD` (`:136-139`): a new `fundingOf(txId)` (same kinds) replaces `clearingOf` there; `clearingOf` stays for fee and dispute journals.
- `DISPUTE_LOSS_USD` total (`:209-211`): add `and p.purpose = 'order'` (top-up disputes are not storefront payment losses).
- `B2cReportsService` `METHODS` (`b2c-reports.service.ts:16`) gains `balance` (fee 0).

#### 5.6.9 Top-up dispute (money; fixes merchants too)
`DisputeWebhookService.handle` (`dispute-webhook.service.ts:57-142`): look the payment up by `(gateway_id, gateway_txn_id)` for **any**
purpose (`findPaymentByReference`, `payment.repository.ts:122-133`) and lock it by id. Order payments keep today's branch. A top-up:
- `created`: `insertDisputeOnce` (`order_id NULL`, `customer_id = payment.customerId`); the payment keeps status `approved`; a
  customer top-up → `CustomerWallets.freezeInTx(tx, customerId, 'Dispute DP-<id> on PAY-<paymentId>')` (ensure, lock the wallet row,
  set); audit `froze wallet of` as the system; mail `wallet.frozen`. A merchant top-up: only the dispute row.
- `lost`: `DisputeLedger.loseTopUp(tx, dispute, payment)`: posts `topupChargeback` once (key `dispute:<id>:chargeback`, ref `dispute`,
  with the owner's override flag); then, for a customer, `freezeAfterPosting` when the account is not frozen yet; dispute → `lost`
  with `ledger_tx_id`; the payment stays `approved`; audit `charged back deposit of` (entity `payment`).
- `won`: dispute → `won`; nothing else (P2).
- A payment that was never credited (still `pending` or `rejected`): record and resolve the dispute, post nothing (there is nothing
  to claw back), freeze as above.
`listDisputeRows` and `findDispute` (`infra/dispute.repository.ts:33-71`) join `payments` and keep `purpose = 'order'`, so
`/admin/disputes*` never serves a top-up dispute (its staff routes answer `404` for one, as `lockOrderPayment` already makes them).

#### 5.6.10 Anonymization and export (customers)
- `CustomerPrivacyService.anonymize` (`customer-privacy.service.ts:102-144`): call
  `CustomerWallets.closeForErasure(tx, id)` as the **last** step before the audit row. It locks the wallet row (when it exists) and
  refuses with `409 CONFLICT` while the balance is not zero, a top-up payment is pending, or a top-up dispute is open; it voids the
  customer's open top-ups that have no payment. Last, because a wallet lock must never be held while other rows are still to be locked
  (section 5.7).
- `exportOf(tx, id)` adds `wallet: { currency, balance, entries: [{ at, kind, memo, amount, balanceAfter }] }` (store memo, at most
  10,000 lines) to `buildCustomerExport` (`domain/customer-export.ts`). `EXPORT_FORMAT` stays 1 (additive).

### 5.7 Locks and their order

Global rule (unchanged): order (if it exists) → checkout session → payment → refund or dispute → **ledger accounts, last, by id, taken
only by `postTransaction`**. New rule: **a transaction that will post never locks a `ledger_accounts` row itself before the posting;
a freeze after a posting reuses the lock the posting took.** Customer wallet ids are higher than the system accounts', so "wallet
first, then a posting" would invert the order against a top-up credit and deadlock.

| Flow | Locks, in order |
|---|---|
| Top-up create | advisory `wallet-topup:<customerId>` (tx-scoped) → inserts only |
| Receipt, cancel | invoice row |
| Top-up credit (approve or job) | payment → invoice → ledger (`fee_income`, `bank`/`gateway_clearing`, wallet by id) |
| Balance pay | session → (stock claim, inserts) → ledger (`vat_payable`, `customer_funds`, wallet) → ledger of a stock delivery (`customer_funds` held, `revenue`, `cogs`, `supplier_prepaid`) |
| Card capture racing a balance pay | card payment → session (waits) → finds the session paid → booked and refunded as a duplicate. The balance pay never waits for an existing payment row: no cycle |
| Refund to the balance | order → payment → refund → ledger (unchanged) |
| Adjust | ledger only |
| Staff freeze, unfreeze | wallet row only; nothing after |
| Top-up dispute `created` | payment → dispute insert → wallet row; nothing after |
| Top-up dispute `lost` | payment → dispute → ledger (posting) → freeze on the row already held |
| Anonymize | customer, orders, sessions rows … → wallet row last |

The stock-delivery postings inside a balance pay re-lock rows in a second posting; that is the shape a card capture already has
(`b2c_pay`, `b2c_fee`, `b2c_deliver` in one transaction) and no other writer takes `revenue`/`cogs` before `vat_payable`/`customer_funds`.
A deadlock Postgres still finds becomes `409 CONFLICT` (retry), as today.

### 5.8 Settings, errors, limits, audit, notifications

**Settings** (keys added to `EDITABLE_SETTINGS`, `settings-registry.ts:106-112`, each with its validator and unit test; all are JSON
booleans or whole USD numbers so the console's typed fields can edit them):

| Key | Type, range | Default |
|---|---|---|
| `wallet.customer.enabled` | boolean | `false` |
| `wallet.customer.card_topups` | boolean | `false` |
| `wallet.customer.min_topup` | integer 1 to 10000 | 5 |
| `wallet.customer.max_topup` | integer 1 to 100000 | 500 |
| `wallet.customer.max_balance` | integer 1 to 1000000 | 1000 |
| `wallet.customer.topups_per_day` | integer 1 to 100 | 5 |
| `wallet.customer.topup_amount_per_day` | integer 1 to 1000000 | 1000 |
| `wallet.customer.adjust_approval_limit` | integer 0 to 10000 | 500 |

`customerWalletPolicy(settings)` (`domain/customer-wallet-policy.ts`, pure): reads the eight keys with these defaults; a value of the
wrong type or range falls back to its default; `min_topup > max_topup` falls back to both defaults. Fixed constants in the same file:
`MAX_OPEN_TOPUPS = 3`, `AUTOMATIC_TOPUP_LIVE_HOURS = 24`. `PATCH /admin/settings` already audits and invalidates the settings cache
after commit; a switch change is seen at once, or within 60 s if Redis fails (`settings-reader.ts:10`).

**New error codes** (catalog `src/common/errors/catalog.ts`, `BACKEND_CODES` in `scripts/build-contract-docs.mjs:35-49`, then
`bun run contract:docs`): `WALLET_FROZEN` 409 "This store balance is on hold." and `WALLET_DISABLED` 409 "The store balance is
switched off." Everything else reuses existing codes (`INSUFFICIENT_FUNDS` 402, `APPROVAL_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`,
`IDEMPOTENCY_IN_PROGRESS`, `CONFLICT`, `OPEN_DISPUTE`, `NO_ACCOUNT`, `ANONYMIZED`, `INVALID_TRANSITION`, `FORBIDDEN`).

**Rate limits:** new limiter `wallet-topup` in `src/infra/rate-limit/limiters.ts` (10 points per 600 s, key = customer id) and its
name in `rate-limit.service.spec.ts:20`. Store routes keep the per-IP limits (300/min, token routes 30/min). `publicLimiterFor`
(`src/infra/rate-limit/public-ip-limit.ts:41-42`) charges the `upload` limiter (20/min per IP) for a large or multipart body on the
store surface. Velocity limits are SQL, not Redis.

**Audit** (entity words exist: `customer`, `payment`): `adjusted wallet of`, `repeated wallet adjustment of`, `froze wallet of`,
`unfroze wallet of` (entity `customer`); `approved deposit of`, `credited deposit of`, `rejected deposit of`, `sent deposit to review`
(existing), `charged back deposit of` (entity `payment`). System actions (webhook, job) are recorded with actor `system`
(`audit.service.ts:76-78`). Customer store writes write no audit row (the ledger, the payment and the invoice are the trail).

**Notifications** (L2: module-owned, English and Arabic). New `application/customer-wallet-notifications.ts` exports
`CUSTOMER_WALLET_EVENTS` (five customer-audience events, `channels ['email']`, `transactional: true`, `defaultEmail: true`) and
`CUSTOMER_WALLET_TEMPLATES` (ten rows) with `customerWalletTemplatesSql()`; a provider `CustomerWalletEventRegistration` in
`MoneyOutboxModule` registers them at boot in the API and the worker (the pattern of `src/modules/support/support-events.module.ts:16-28`;
`MoneyOutboxModule` is loaded by both processes, `money.module.ts:27`, `jobs/payment-auto-credit.module.ts:32`). New
`application/customer-wallet-mails.ts` (`CustomerWalletMails`, provided and exported by `StorefrontMailsModule`) writes them with
`NotificationService.enqueue({ tx }, …)`; amounts are `amountText(x, 'USD', 2)` (`b2c-money.ts:52-56`).

| Event | Variables | Dedupe key | Sent by |
|---|---|---|---|
| `wallet.topup_credited` | `customerName, amount, balance, reference` | `wallet.topup_credited:<paymentId>` | credit |
| `wallet.topup_rejected` | `customerName, amount, reason, reference` | `wallet.topup_rejected:<paymentId>` | reject |
| `wallet.adjusted` | `customerName, change, balance` (`change` is `+10.00 USD` or `-10.00 USD`) | `wallet.adjusted:<ledgerTxId>` | adjust |
| `wallet.frozen` | `customerName` | `wallet.frozen:<customerId>:<frozenAt ms>` | freeze |
| `wallet.order_refunded` | `customerName, orderId, amount, service` | `wallet.order_refunded:order:<orderId>` or `…:refund:<refundId>` | refund to balance |

Template texts (subject / body; paste exactly):

| Event | `en` | `ar` |
|---|---|---|
| `wallet.topup_credited` | `Your balance was topped up` / `Hi {{customerName}},\n\nWe added {{amount}} to your store balance (top-up {{reference}}). Your balance is now {{balance}}.\n\nIf you did not make this top-up, reply to this email.` | `تم شحن رصيدك` / `مرحباً {{customerName}}،\n\nأضفنا {{amount}} إلى رصيدك في المتجر (عملية الشحن {{reference}}). رصيدك الآن {{balance}}.\n\nإذا لم تقم بهذه العملية، ردّ على هذه الرسالة.` |
| `wallet.topup_rejected` | `We could not accept your top-up {{reference}}` / `Hi {{customerName}},\n\nWe could not accept your top-up of {{amount}} ({{reference}}).\n\nReason: {{reason}}\n\nNothing was added to your balance. You can start a new top-up, or reply to this email if you think this is a mistake.` | `تعذّر قبول عملية الشحن {{reference}}` / `مرحباً {{customerName}}،\n\nتعذّر علينا قبول عملية شحن الرصيد بمبلغ {{amount}} ({{reference}}).\n\nالسبب: {{reason}}\n\nلم يُضَف أي مبلغ إلى رصيدك. يمكنك بدء عملية شحن جديدة، أو الرد على هذه الرسالة إذا كنت ترى أن هناك خطأ.` |
| `wallet.adjusted` | `Your store balance changed` / `Hi {{customerName}},\n\nOur team changed your store balance by {{change}}. Your balance is now {{balance}}.\n\nIf you did not expect this, reply to this email.` | `تغيّر رصيدك في المتجر` / `مرحباً {{customerName}}،\n\nعدّل فريقنا رصيدك في المتجر بمقدار {{change}}. رصيدك الآن {{balance}}.\n\nإذا لم تكن تتوقع ذلك، ردّ على هذه الرسالة.` |
| `wallet.frozen` | `Your store balance is on hold` / `Hi {{customerName}},\n\nPaying from your store balance is on hold while we review a payment on your account. Your orders and your sign-in are not affected.\n\nReply to this email if you need help.` | `رصيدك في المتجر موقوف مؤقتاً` / `مرحباً {{customerName}}،\n\nأوقفنا الدفع من رصيدك في المتجر مؤقتاً ريثما نراجع عملية دفع في حسابك. طلباتك وتسجيل دخولك لا يتأثران.\n\nردّ على هذه الرسالة إذا احتجت إلى مساعدة.` |
| `wallet.order_refunded` | `We returned {{amount}} to your store balance` / `Hi {{customerName}},\n\nWe refunded {{amount}} for order {{orderId}} ("{{service}}") to your store balance. You can use it for another order.` | `أعدنا {{amount}} إلى رصيدك في المتجر` / `مرحباً {{customerName}}،\n\nأعدنا {{amount}} عن الطلب {{orderId}} («{{service}}») إلى رصيدك في المتجر. يمكنك استخدامه في طلب آخر.` |

**Jobs, queues, outbox types, cache keys: none new.** The mails use the existing `notification.send` path; the automatic credit is the
existing `payment_auto_credit` job; no balance, freeze state or idempotency answer is cached.

## 6. Database

One generated migration and one custom migration (L3), both created in **B1**, named `0020_customer_wallet` and
`0021_customer_wallet_rules` in the worktree (the lead renumbers at merge). Every spec that reads a migration file reads its name from
one exported constant `CUSTOMER_WALLET_RULES_MIGRATION` in `customer-wallet-notifications.ts`.

### 6.1 Generated (`bun run db:generate --name customer_wallet` after the schema edits)

`src/modules/money/db/schema.ts`:
1. `LEDGER_ACCOUNT_KINDS` += `'customer_wallet'` (16 kinds) → `ledger_accounts_kind_check`.
2. `ledger_accounts_kind_owner_check`: add `or (kind = 'customer_wallet' and owner_type is not distinct from 'customer')` and put
   `customer_wallet` in the `not in (...)` list.
3. `ledger_accounts`: `frozenAt: timestampTz()` (nullable), `frozenReason: text().notNull().default('')`;
   `check('ledger_accounts_frozen_check', frozen_at is null or kind = 'customer_wallet')`;
   `check('ledger_accounts_overdraft_kind_check', overdraft_limit = 0 or kind = 'client_wallet')`;
   `index('ledger_accounts_customer_wallet_idx').on(balance).where(kind = 'customer_wallet')`;
   `index('ledger_accounts_frozen_idx').on(frozenAt).where(frozen_at is not null)`.
4. `LEDGER_REF_TYPES` += `'customer'` → `ledger_transactions_ref_type_check`.
5. `ORDER_METHODS` += `'balance'` → `payments_method_type_check`.
6. `payments.gatewayId`: drop `.notNull()`; `check('payments_gateway_check', (method_type = 'balance') = (gateway_id is null))`;
   `uniqueIndex('payments_balance_session_uq').on(checkoutSessionId).where(method_type = 'balance')`.
7. `invoices`: `idempotencyKey: text()`, `requestFingerprint: text()`;
   `uniqueIndex('invoices_customer_key_uq').on(customerId, idempotencyKey).where(idempotency_key is not null)`.

`src/modules/customers/db/schema.ts`: `checkout_sessions.openedSignedIn: boolean().notNull().default(false)`.

No backfill: no customer has ledger rows; existing payments all have a gateway; existing sessions get `false` (they expire in 30 min).

### 6.2 Custom (`bunx --bun drizzle-kit generate --custom --name customer_wallet_rules`)

1. The invariant "a customer wallet below zero is frozen", checked at commit so the posting can come before the freeze:

```sql
CREATE FUNCTION "ledger_check_customer_wallet_frozen"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ledger_accounts" a WHERE a."id" = NEW."id" AND a."kind" = 'customer_wallet'
             AND a."balance" < 0 AND a."frozen_at" IS NULL) THEN
    RAISE EXCEPTION 'customer wallet % is below zero and not frozen', NEW."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_accounts_negative_customer_wallet_frozen';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "ledger_accounts_negative_customer_wallet_frozen" AFTER INSERT OR UPDATE ON "ledger_accounts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."kind" = 'customer_wallet' AND NEW."balance" < 0)
  EXECUTE FUNCTION "ledger_check_customer_wallet_frozen"();
```
   The `WHEN` is evaluated at the update (it only decides whether the commit-time check is queued), so ordinary postings pay nothing;
   the function re-reads the row, so a freeze later in the same transaction satisfies it. If Postgres 18 refuses `WHEN` on a
   constraint trigger, drop the clause and keep the function (it already re-checks the kind). The style follows
   `drizzle/0001_ledger_and_audit_triggers.sql:27-62`.
2. The `INSERT INTO "notification_templates" … ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;` that
   `customerWalletTemplatesSql()` writes (the pattern of `drizzle/0018_refund_declined_template.sql`).

### 6.3 Code constants and pinned tests that follow the schema

- `domain/accounts.ts:39-47`: `CREDIT_NORMAL_KINDS` += `'customer_wallet'` (**required**, or the reconcile flags every customer wallet).
- `domain/reference-data.ts:12-16`: `PER_OWNER_ACCOUNT_KINDS` += `'customer_wallet'` (**required**, or `bun run setup` fails).
- `domain/ref-types.ts:34-49`: `toWireRefType('customer') = 'system'`; `storedRefTypesOf('system') = ['system', 'client', 'customer']`.
- `test/schema/structure.test.ts:73-126` `ADDITIONS`: `ledger_accounts: ['frozen_at', 'frozen_reason']`; `invoices` += `'idempotency_key', 'request_fingerprint'`;
  `checkout_sessions: ['opened_signed_in']`.
- `domain/accounts.spec.ts:17-21` (16 kinds), `domain/reference-data.spec.ts` (still 12 system kinds), `domain/ref-types.spec.ts`.
- `test/integration/db-audit-resolutions.test.ts:158-169` keeps passing (`wallet` for a top-up and `bank`/`cash` for an order are still refused).

## 7. API

Conventions: camelCase JSON, ids are numbers, money is a 4-decimal string, times are ISO UTC with milliseconds, lists are a bare array
with `x-total-count`. `IdempotencyHeader` below = `z.object({ 'idempotency-key': z.string().trim().min(1).max(100).regex(/^[\x21-\x7e]+$/) })`
(required). No route uses Turnstile. Store routes send `Cache-Control: no-store`.

### 7.1 New routes

Shared schemas (new `contracts/customer-wallet.contracts.ts` and `contracts/customer-topups.contracts.ts`, money):

```ts
WalletLimits      = { minTopUp: Money, maxTopUp: Money, maxBalance: Money, room: Money, topUpsLeftToday: number, amountLeftToday: Money }
StoreWallet       = { enabled: boolean, cardTopUps: boolean, currency: string /* 'USD' */, balance: Money, reserved: Money /* always 0 */,
                      creditLimit: Money /* always 0 */, available: Money, frozen: { at: IsoDateTime } | null,
                      pendingTopUps: { count: number, amount: Money }, limits: WalletLimits }
AdminWallet       = { enabled: boolean, currency: string, balance: Money, reserved: Money, creditLimit: Money, available: Money,
                      frozen: { at: IsoDateTime, reason: string } | null, pendingTopUps: { count: number, amount: Money },
                      openDisputes: number, adjustApprovalLimit: Money }
StoreStatementRow = { id: Id, transactionId: Id, kind: string, memo: string, orderId: Id | null, amount: Money, balanceAfter: Money, createdAt: IsoDateTime }
TopUp             = { id: Id, number: string, status: 'awaiting_payment'|'in_review'|'credited'|'rejected'|'cancelled',
                      amount: Money, fee: Money, netAmount: Money, currency: string,
                      method: { id: Id, code: string, name: string, kind: 'manual'|'automatic', methodType: 'bank'|'card'|'usdt'|'wise' },
                      reference: string | null, receiptUploaded: boolean, rejectionReason: string | null,
                      createdAt: IsoDateTime, creditedAt: IsoDateTime | null }
TopUpDetail       = TopUp & { instructions?: string, paymentUrl?: string }   // only while awaiting_payment
WalletRow         = { customer: { id: Id, name: string, email: string, status: string }, balance: Money,
                      frozen: { at: IsoDateTime, reason: string } | null, updatedAt: IsoDateTime }
```
`available` = `0.0000` when frozen, switched off or negative, else `balance`. `room` = `max(0, maxBalance − balance − pending)`.
`reserved`/`creditLimit` exist so the site's wallet component serves merchants and customers with one shape (`WalletViewSchema`,
`wallet.contracts.ts:7-12`). The admin statement row is the existing `StatementRowSchema` (`wallet.contracts.ts:15-23`).

| # | Route | Access / permission | Request | Success | Errors | Audit | Limits |
|---|---|---|---|---|---|---|---|
| 1 | `GET /store/v1/me/wallet` | customer-session | — | 200 `StoreWallet` | `UNAUTHORIZED`, `ACCOUNT_SUSPENDED`, `IP_NOT_ALLOWED` | — | per-IP |
| 2 | `GET /store/v1/me/wallet/statement` | customer-session | list query: sort `createdAt` (default desc); filter `createdAt` (`_gte`, `_lte`, datetime) | 200 `StoreStatementRow[]` | + `VALIDATION_FAILED` | — | per-IP |
| 3 | `GET /store/v1/me/wallet/top-up-methods` | customer-session | list query: sort `name` (default asc) | 200 `PaymentMethodSchema[]` (`billing-portal.contracts.ts:8-25`; `minAmount`/`maxAmount` are the effective limits; `[]` while the switch is off) | as 2 | — | per-IP |
| 4 | `POST /store/v1/me/wallet/top-ups` | customer-session, CSRF | headers `IdempotencyHeader`; body `{ amount: string /* decimal > 0, ≤ 4 decimals */, gatewayId: Id }` | 201 `TopUpDetail` (replay: same body + `idempotency-replayed: true`) | `UNAUTHORIZED`, `ACCOUNT_SUSPENDED`, `IP_NOT_ALLOWED`, `CSRF_FAILED`, `VALIDATION_FAILED` (`gatewayId`: `unavailable`; `amount`: `format, range, min, max, fee, daily_count, daily_amount, max_balance`), `CONFLICT` (3 unpaid top-ups), `WALLET_DISABLED`, `WALLET_FROZEN`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`, `RATE_LIMITED`, `GATEWAY_ERROR` | — | per-IP + `wallet-topup` |
| 5 | `GET /store/v1/me/wallet/top-ups` | customer-session | list query: sort `createdAt` (default desc) | 200 `TopUp[]` | as 2 | — | per-IP |
| 6 | `GET /store/v1/me/wallet/top-ups/:id` | customer-session | params `{ id }` | 200 `TopUpDetail` | as 2 + `NOT_FOUND` (unknown or another customer's) | — | per-IP |
| 7 | `POST /store/v1/me/wallet/top-ups/:id/receipt` | customer-session, CSRF | headers `IdempotencyHeader`; body `{ fileId: Id, reference?: string /* ≤ 64 */ }` | 201 `TopUpDetail` (`in_review`) | as 4's session errors + `NOT_FOUND`, `CONFLICT`, `VALIDATION_FAILED` (`fileId`: `invalid`; `reference`: `length, taken`) | — | per-IP |
| 8 | `POST /store/v1/me/wallet/top-ups/:id/cancel` | customer-session, CSRF | headers `IdempotencyHeader`; no body | 200 `TopUpDetail` (`cancelled`) | session errors + `NOT_FOUND`, `CONFLICT` | — | per-IP |
| 9 | `POST /store/v1/files` | customer-session, CSRF | `multipart/form-data`, one part `file`: PDF, JPEG or PNG, 1 B to 5 MiB | 201 `StoredFileSchema` (`files.contracts.ts:43-50`) | `UNAUTHORIZED`, `ACCOUNT_SUSPENDED`, `IP_NOT_ALLOWED`, `CSRF_FAILED`, `VALIDATION_FAILED` (`file`: `empty, type`), `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `UNAVAILABLE` | — | `upload` 20/min per IP |
| 10 | `POST /store/v1/checkout-sessions/:token/balance-payment` | checkout-token **and** a customer session with its CSRF token (checked in the handler) | headers `IdempotencyHeader` (max 255 as `/pay`); no body | 201 `{ payment: { id: Id, reference: string, status: string, method: 'balance', currency: string, amount: Money, amountUsd: Money }, order: { id: Id, trackingToken: string }, wallet: { balance: Money, available: Money } }` | `NOT_FOUND`, `UNAUTHORIZED` (no customer session), `CSRF_FAILED`, `FORBIDDEN`, `VALIDATION_FAILED` (`consent`), `INVALID_TRANSITION`, `ACCOUNT_SUSPENDED`, `INSUFFICIENT_FUNDS` (402), `WALLET_FROZEN`, `WALLET_DISABLED`, `IDEMPOTENCY_KEY_REUSED` | — | token 30/min per IP; maintenance scope `checkout` |
| 11 | `GET /admin/customers/:id/wallet` | staff-permission `wallet:read` | params `{ id }` | 200 `AdminWallet` | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED` | — | — |
| 12 | `GET /admin/customers/:id/wallet/statement` | `wallet:read` | list query: sort `createdAt` (default desc); filter `createdAt` (`_gte`, `_lte`) | 200 `StatementRowSchema[]` | as 11 | — | — |
| 13 | `POST /admin/customers/:id/wallet/adjust` | `wallet:adjust`, CSRF | headers `IdempotencyHeader`; body `{ amount: Money /* > 0 */, direction: 'credit'|'debit', reason: string /* 5 to 140 */ }` | 200 `{ transactionId: Id, wallet: AdminWallet }` | `UNAUTHORIZED`, `FORBIDDEN`, `CSRF_FAILED`, `NOT_FOUND`, `VALIDATION_FAILED`, `APPROVAL_REQUIRED`, `INSUFFICIENT_FUNDS`, `IDEMPOTENCY_KEY_REUSED`, `NO_ACCOUNT`, `ANONYMIZED` | `adjusted wallet of` / `repeated wallet adjustment of`, entity `customer` | — |
| 14 | `POST /admin/customers/:id/wallet/freeze` | `wallet:adjust`, CSRF | headers `IdempotencyHeader`; body `{ reason: string /* 5 to 200 */ }` | 200 `AdminWallet` | `UNAUTHORIZED`, `FORBIDDEN`, `CSRF_FAILED`, `NOT_FOUND`, `VALIDATION_FAILED` | `froze wallet of`, entity `customer` | — |
| 15 | `POST /admin/customers/:id/wallet/unfreeze` | `wallet:adjust`, CSRF | headers `IdempotencyHeader`; body `{ reason: string /* 5 to 200 */ }` | 200 `AdminWallet` | as 14 + `CONFLICT` (negative balance), `OPEN_DISPUTE` | `unfroze wallet of`, entity `customer` | — |
| 16 | `GET /admin/customer-wallets` | `wallet:read` | list query: sorts `balance`, `updatedAt` (default `updatedAt` desc); filter `state` enum `positive|zero|negative|frozen` (eq); search `q` on `customer.name`, `customer.email` | 200 `WalletRow[]` | `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_FAILED` | — | — |

Notes:
- Routes 7, 8, 14 and 15 are idempotent by state; they take the header so every wallet write obeys one client rule (O15). Routes 4,
  10 and 13 store and compare the key.
- Route 10's `401` means "sign in to pay from the balance", not an ended session (section 13).
- Route 10 answers the replay with the wallet as it is **now**.
- Route 9: `FileUploadService` gains `uploadForCustomer(customerId, input)` (owner `customer`, the proof types only, 5 MiB);
  `/store/v1/files` joins `MULTIPART_ROUTES` (`src/common/multipart.ts:22`, spec `multipart.spec.ts:84`); the `preParsing` hook refuses a
  declared `Content-Length` above 5 MiB + 64 KiB on that route before the body is read (`413`).
- Controllers: money `controllers/customer-wallet.controller.ts` (routes 1, 2, 11 to 16) and `controllers/customer-topups.controller.ts`
  (routes 3 to 8); the customer id is `principal.kind === 'customer' ? principal.customerId : throw UNAUTHORIZED` (the `merchantIdOf`
  pattern, `wallet.controller.ts:28-31`; money cannot import the customers module's `@CurrentCustomer`). Route 9: platform
  `files.controller.ts`. Route 10: customers `checkout.controller.ts`.

### 7.2 Map additions (L1): `scripts/map-additions/21.mjs`

Use W0's export shape. Stage `21`. Spec-decision tag for every row: `B-TBD customer-wallet-routes`. English text = the summary of
section 7.1. `successStatus` is given for the routes the console calls.

| Surface | Group | Method | Path | Arabic text | Auth text | Tables | Module | successStatus |
|---|---|---|---|---|---|---|---|---|
| store | account | GET | `/store/v1/me/wallet` | رصيد الزبون: المتاح والحدود وحالة التجميد | `جلسة الزبون` | ledger_accounts, invoices | money | |
| store | account | GET | `/store/v1/me/wallet/statement` | كشف حساب رصيد الزبون مع فلترة بالتاريخ | `جلسة الزبون` | ledger_entries, ledger_transactions | money | |
| store | account | GET | `/store/v1/me/wallet/top-up-methods` | طرق شحن الرصيد المتاحة للزبون | `جلسة الزبون` | payment_gateways | money | |
| store | account | POST | `/store/v1/me/wallet/top-ups` | طلب شحن رصيد: المبلغ وطريقة الدفع مع Idempotency-Key | `جلسة الزبون` | invoices | money | |
| store | account | GET | `/store/v1/me/wallet/top-ups` | عمليات شحن الزبون وحالاتها | `جلسة الزبون` | invoices, payments | money | |
| store | account | GET | `/store/v1/me/wallet/top-ups/:id` | عملية شحن واحدة مع تعليمات الدفع | `جلسة الزبون` | invoices, payments | money | |
| store | account | POST | `/store/v1/me/wallet/top-ups/:id/receipt` | إرفاق إيصال التحويل بانتظار مراجعة الموظف | `جلسة الزبون` | payments, invoices, files | money | |
| store | account | POST | `/store/v1/me/wallet/top-ups/:id/cancel` | إلغاء عملية شحن يدوية لم يُرفق لها إيصال | `جلسة الزبون` | invoices | money | |
| store | account | POST | `/store/v1/files` | رفع ملف من حساب الزبون (إيصال تحويل) | `جلسة الزبون` | files | platform | |
| store | checkout | POST | `/store/v1/checkout-sessions/:token/balance-payment` | الدفع من رصيد الزبون: يُنشأ الطلب ويُخصم الرصيد في معاملة واحدة | `رمز الجلسة + Idempotency-Key` | checkout_sessions, payments, orders, ledger_entries | customers | |
| admin | customers | GET | `/admin/customers/:id/wallet` | رصيد الزبون: الرصيد والتجميد والشحنات المعلّقة | `wallet:read` | ledger_accounts | money | 200 |
| admin | customers | GET | `/admin/customers/:id/wallet/statement` | كشف حساب رصيد الزبون | `wallet:read` | ledger_entries, ledger_transactions | money | 200 |
| admin | customers | POST | `/admin/customers/:id/wallet/adjust` | إضافة أو خصم يدوي على رصيد الزبون مع سبب | `wallet:adjust` | ledger_transactions, ledger_entries, audit_logs | money | 200 |
| admin | customers | POST | `/admin/customers/:id/wallet/freeze` | تجميد رصيد الزبون مع السبب | `wallet:adjust` | ledger_accounts, audit_logs | money | 200 |
| admin | customers | POST | `/admin/customers/:id/wallet/unfreeze` | فك تجميد رصيد الزبون | `wallet:adjust` | ledger_accounts, audit_logs | money | 200 |
| admin | billing | GET | `/admin/customer-wallets` | قائمة أرصدة الزبائن: السالب والمجمّد | `wallet:read` | ledger_accounts, customers | money | 200 |

If W0's loader also runs `modulesForRow` on these rows, `/admin/customers/:id/wallet*` matches the customers rule
(`scripts/module-map.mjs:128`); then narrow that rule to `/^admin \S+ \/admin\/(customers|checkouts)(?!\/:id\/wallet)(\/|$)/` and say
so in the report. Route keys are final: the storefront derives its types from them (never rename a key).

### 7.3 Changed existing routes (additive unless proven safe)

| Route | Change | Compatibility |
|---|---|---|
| `GET /admin/payments`, `GET /admin/payments/:id`, approve, reject | Response adds `customer: { id, name, email, walletBalance: Money \| null } \| null` and `dispute: { id, status, reasonCode, amount: Money, fee: Money, evidenceDueAt, resolvedAt: IsoDateTime \| null, transactionId: Id \| null } \| null`. List adds filters `customerId` (id, eq) and `owner` (`merchant\|customer`, eq) and searches customer name and email. `note` may read `First top-up of this customer.` | Additive; `client` stays `null` for a customer's row, which the console already renders (`FA/src/features/finance/components/PaymentTable.tsx:64`) |
| `POST /webhooks/payments/:gateway` | Records top-ups of customer invoices | New behaviour for rows that were ignored |
| `POST /webhooks/disputes/:gateway` | Handles disputes of top-up payments (customers and merchants) | New behaviour for events that were dropped |
| `GET /admin/disputes`, `/:id`, evidence, accept | Serve order-payment disputes only | Same rows as today: no top-up dispute existed |
| `GET /store/v1/checkout-sessions/:token` and the answer of `POST /store/v1/checkout-sessions` | Adds `balancePayable: boolean` (wallet on **and** the session was opened signed in; never a balance: the token is not an identity). `paymentMethods` lists only gateways `/pay` accepts | Additive field; the removed entries could never be paid (`storefront-payments.ts:150`) |
| `GET /store/v1/config` | `paymentMethods`: the same filter (through `StorefrontMoney.paymentMethods`; no storefront-module edit) | As above |
| `POST /admin/customers/:id/anonymize` | New refusal `409 CONFLICT` | Additive error |
| `GET /admin/customers/:id/export` | The file adds `wallet` | Additive |
| `GET /admin/refunds*` (5 routes) | `payment.method` may be `balance` | Enum widening: section 12, L-conflict 1 |
| `GET /admin/reports/payments` | `methods` has a fourth row `balance`; `payments[].method` and the `method` filter accept it | Same |
| `GET /admin/reports/vat` | Correct for balance payments and refunds to the balance | Bug fix |
| `GET /admin/ledger/*` | Kind `customer_wallet`; a stored `customer` ref type is sent as `system` | The console types the account kind as `string` (`FA/src/features/finance/types/accounts.ts:11`) |
| `PATCH /admin/settings` | Accepts the eight wallet keys | Additive |
| `POST /admin/clients/:id/wallet/adjust` | Unchanged contract (header stays optional) | — |
| `GET /admin/risk/queue` | `paymentMethod` may be `balance` | Section 12, L-conflict 2 |

## 8. Existing defects fixed by this feature

| # | Defect | Where | Fix | Slice |
|---|---|---|---|---|
| D1 | VAT report computes taxable sales from `gateway_clearing` only | `b2c-reports.repository.ts:41` | Section 5.6.8 | B4 |
| D2 | `CREDIT_NORMAL_KINDS` and `PER_OWNER_ACCOUNT_KINDS` must list every new kind or reconcile and setup break | `accounts.ts:39-47`; `reference-data.ts:12-16` | Section 6.3 | B1 |
| D3 | `payments_without_entry` hides payments without a gateway | `integrity-reads.repository.ts:202` | `left join`, gateway name `coalesce(g.name, 'Store balance')` | B5 |
| D4 | Top-up disputes are dropped, for merchants too | `dispute-webhook.service.ts:63`; `order-payment.repository.ts:159` | Section 5.6.9 | B5 |
| D5 | The console's wallet adjust sends no `Idempotency-Key`, so a retry posts twice | `FA/src/features/merchants/api/wallet.ts:55-61`; `wallet.service.ts:204-207` | The console sends one per dialog opening (merchant and customer) | C1 |
| D6 | Checkout lists manual gateways that `/pay` refuses | `storefront-money.repository.ts:85-91` vs `storefront-payments.ts:150` | `StorefrontMoney.paymentMethods` keeps active, `b2c\|both`, not manual, with a driver | B3 |
| D7 | `ledgerPartsOf` and `REFUND_USD` assume `gateway_clearing` (new finding) | `b2c-reads.repository.ts:129`; `b2c-reports.repository.ts:136-139` | Section 5.6.7 and 5.6.8 | B4 |

Left for a later payments feature (the wallet is designed for them): the five Stripe driver defects; "a confirmation for an invoice
that is no longer open is acknowledged and not recorded" (`payment-webhook.service.ts:106-111`), which is why an online top-up cannot be
cancelled by the customer.

## 9. Risks and how the design closes them

| # | Risk | Closure |
|---|---|---|
| K1 | Double spend: two payments on one balance | The debit guard runs under the wallet row lock taken in id order; a balance cannot go below zero; test: parallel payments never overspend |
| K2 | Unauthorized spend: a guest checkout carries an account holder's id, or a victim is sent a prepared checkout link | The customer id comes from the cookie session with its CSRF token; it must equal the session's customer; the session must have been opened signed in; no balance is ever shown behind a checkout token |
| K3 | Duplicate credit: webhook twice, approve racing the job, receipt twice | Unique `(gateway_id, gateway_txn_id)`; payment row lock + status re-check; ledger key `deposit:payment:<id>`; one pending payment per top-up |
| K4 | Duplicate balance payment: double click, retry, two tabs | Session row lock + `paid` check; unique `(checkout_session_id, idempotency_key)`; unique one-balance-payment-per-session index; ledger key `payment:<id>:capture` |
| K5 | Duplicate adjustment | Required header → ledger key `adjust:customer:<id>:<key>`; a reused key with another body is refused; a merchant key (`adjust:<id>:…`) can never equal a customer key |
| K6 | Deadlocks | One lock order (section 5.7); the freeze never precedes a posting; ledger locks last |
| K7 | A staff member with `settings:update` and `wallet:adjust` raises the approval limit, then adjusts | Both writes are audited with before and after; the limit is capped at $10,000; the Owner decides who holds `settings:update` (owner decision) |
| K8 | Card top-up fraud (stolen card, spend, chargeback) | Card top-ups off by default; `hold_hours` delay; blocklist screen; freeze at `dispute.created`; clawback with a database-enforced freeze; frozen wallets cannot top up by card |
| K9 | Regulatory (stored value) | Closed loop, USD, no cash-out, master switch off by default, limits as settings |
| K10 | Silent reporting errors | D1, D2, D3, D7 fixed; reconcile and integrity tests include customer wallets |
| K11 | Stranded money on an anonymized or disabled wallet | Anonymization refused while the balance is not zero or money is in flight; staff tools work while the switch is off; `GET /admin/customer-wallets` lists every wallet |
| K12 | Personal data in the ledger | Ledger rows keep only ids; names come from the customer row; the store statement never shows staff reasons |
| K13 | Performance | No new hot row except the customer's own account; every list has an index (section 6.1) and an exact count; batch reads in `PaymentViews`; nothing cached |
| K14 | Backward compatibility | Existing routes change additively (section 7.3); merchant flows keep their code path (owner branch on the invoice); route keys are never renamed |
| K15 | Upload abuse on a public surface | Session + CSRF, 5 MiB, three media types, `upload` limiter, early `Content-Length` refusal |
| K16 | A cached setting delays the kill switch | The settings cache is invalidated after commit; worst case 60 s; credits are never blocked by the switch |
| K17 | Scope and memory | Five backend slices with their own tests; targeted test files; one full check per run |

## 10. Slices

Sizes: S ≈ half a day, M ≈ a day, L ≈ two days of a Sonnet run. A slice is done when its acceptance list holds and its tests pass.

### B1 Ledger and migration (M)

Steps:
1. `scripts/map-additions/21.mjs` with the 16 rows; add the 16 keys to `test/contract/pending.ts` in feature 21's block; `bun run routes:build`,
   `bun run coverage:build`, `bun run contract:docs`.
2. Schema edits of section 6.1; generate `0020_customer_wallet`; write the custom migration of section 6.2.
3. Constants of section 6.3; `domain/customer-wallet-events.ts` (builders, `WALLET_EVENT_IDS`, `WALLET_EVENT_KINDS`, the pro-rata
   function); `domain/wallet-guard.ts`; the `postTransaction` change of section 5.5.
4. `domain/customer-wallet-policy.ts`; the eight settings validators; the two error codes; the `wallet-topup` limiter.
5. `application/customer-wallet-notifications.ts` (events, templates, SQL, the migration-name constant) and the registration provider
   in `MoneyOutboxModule`.
6. `domain/b2c-money.ts`: export `GATEWAY_ORDER_METHODS = ['card', 'wallet', 'crypto'] as const` and point `refunds.contracts.ts:40` and
   `b2c-reports.contracts.ts:66,75,100` at it, so the wire does not widen until B4. Fix the null-gateway type errors the nullable
   `payments.gatewayId` raises (section 5.6.7 list; `payment-review.service.ts:152`, `jobs/payment-auto-credit.ts:104`,
   `storefront-payments.ts:257`, `payment-views.ts:50,61`): a top-up without a gateway is a programming error (throw); a view tolerates null.

Files: create `scripts/map-additions/21.mjs`, `drizzle/0020_*`, `drizzle/0021_*` (+ `drizzle/meta`), `src/modules/money/domain/{customer-wallet-events,wallet-guard,customer-wallet-policy}.ts` (+ `.spec.ts`), `src/modules/money/application/customer-wallet-notifications.ts` (+ `.spec.ts`). Edit `src/modules/money/db/schema.ts`, `src/modules/customers/db/schema.ts`, `src/modules/money/domain/{accounts,reference-data,ref-types,b2c-money}.ts` (+ specs), `application/post-transaction.ts`, `infra/ledger-accounts.repository.ts`, `money-outbox.module.ts`, `index.ts`, the null-gateway sites, `src/common/errors/catalog.ts`, `scripts/build-contract-docs.mjs`, `src/modules/platform/settings/settings-registry.ts` (+ spec), `src/infra/rate-limit/limiters.ts`, `src/infra/rate-limit/rate-limit.service.spec.ts`, `test/schema/structure.test.ts`, `test/contract/pending.ts`.

Acceptance: `bun run db:check` green; `bun run routes:check` green with 16 pending routes; a customer wallet can be credited and
debited through `postTransaction` in a test; a debit below zero is refused; the override needs the freeze to commit; `bun run setup`'s
system-account list is unchanged (12); reconcile shows no difference for a customer wallet; every merchant ledger test still passes.

### B2 Read side, adjust, freeze (M)

Steps: `infra/customer-wallet.repository.ts`; `application/customer-wallets.ts`; `application/customer-wallet-mails.ts` (in
`StorefrontMailsModule`); `findWalletCustomer` and `findCustomerIdsByNameOrEmail` in `infra/foreign-directory.repository.ts`;
contracts and controller for routes 1, 2, 11 to 16; customers: anonymize guard and export (section 5.6.10); remove the built keys from
`pending.ts`; `bun run docs:openapi`.

Files: create `src/modules/money/{infra/customer-wallet.repository.ts, application/customer-wallets.ts, application/customer-wallet-mails.ts, contracts/customer-wallet.contracts.ts, controllers/customer-wallet.controller.ts}`. Edit `money-admin.module.ts`, `storefront-mails.module.ts`, `index.ts`, `infra/foreign-directory.repository.ts`, `src/modules/customers/{application/customer-privacy.service.ts, domain/customer-export.ts, contracts/customer-privacy.contracts.ts, customers-accounts.module.ts}`.

Acceptance: the eight routes answer as section 7.1; `403` without the permission; an adjustment posts once per key and is audited;
freeze twice changes nothing; unfreeze is refused below zero; the store statement never shows a staff reason; anonymize answers `409`
while the balance is not zero.

### B3 Top-ups (L)

Steps: `infra/customer-topup.repository.ts`; `application/customer-top-ups.ts`; contracts and controller for routes 3 to 8; platform
route 9 (section 7.1 notes); the owner branches of section 5.6.5; deposits wire (section 7.3); D6; `TopUpScreeningModule` imported by
`MoneyAdminModule`; `StorefrontMailsModule` imported by `PaymentAutoCreditModule`; the development seed
(`scripts/seed/customer-wallet.ts`, called from `dev-seed.ts` in development only: `wallet.customer.enabled = true`, one manual `b2c`
gateway `cliq` "CliQ transfer" (min 5, max 500, no fee), one credited $50 top-up and one top-up in review for two seeded customers with
accounts, posted through `postTransaction`).

Files: create `src/modules/money/{infra/customer-topup.repository.ts, application/customer-top-ups.ts, contracts/customer-topups.contracts.ts, controllers/customer-topups.controller.ts}`, `scripts/seed/customer-wallet.ts`. Edit `application/{payment-webhook.service,payment-crediting,payment-review.service,payment-views,billing-wire,storefront-money}.ts`, `jobs/{payment-auto-credit.ts,payment-auto-credit.module.ts}`, `infra/{payment.repository,storefront-money.repository}.ts`, `contracts/payments.contracts.ts`, `money-admin.module.ts`, `src/modules/platform/{contracts/files.contracts.ts, controllers/files.controller.ts, application/file-upload.service.ts}`, `src/common/multipart.ts` (+ spec), `src/infra/rate-limit/public-ip-limit.ts` (+ spec), `scripts/seed/dev-seed.ts`.

Acceptance: a customer creates a top-up, uploads a receipt, staff approve it in Deposits, the wallet shows the credit, the customer
gets one email; every limit refuses with its code; the same key answers the same top-up; a duplicate webhook credits once; approve
racing the job credits once; a merchant top-up behaves exactly as before (existing tests untouched); checkout no longer lists a
manual gateway.

### B4 Balance pay, refunds, VAT (L)

Steps: customers: `openedSignedIn` set in `CheckoutSessionService.open` (`account !== undefined`, `checkout-session.service.ts:155-178`),
`balancePayable` on the view (`:220-245`, contract `checkout.contracts.ts:84`), `CheckoutBalancePayService`, route 10; money:
`application/customer-wallet-payments.ts`, `issueReceipt` with a nullable gateway (`storefront-payments.ts:397-432`), section 5.6.7 and
5.6.8; risk input type; `CHECKOUT_START` pattern in `src/modules/platform/maintenance/maintenance-state.ts:103-106`; widen the method
enums to `ORDER_METHODS` and add the allowlist entries (section 12, L-conflict 1); with the lead's OK also L-conflict 2.

Files: create `src/modules/customers/application/checkout-balance-pay.service.ts`, `src/modules/money/application/customer-wallet-payments.ts`. Edit `src/modules/customers/{application/checkout-session.service.ts, contracts/checkout.contracts.ts, contracts/checkout-pay.contracts.ts, controllers/checkout.controller.ts, checkout.module.ts}`, `src/modules/money/{application/storefront-payments.ts, application/b2c-refunds.ts, application/refund.service.ts, application/refund-views.ts, application/storefront-mails.ts, application/b2c-reports.service.ts, domain/refund-rules.ts, domain/b2c-money.ts, infra/b2c-reads.repository.ts, infra/b2c-reports.repository.ts, contracts/refunds.contracts.ts, contracts/b2c-reports.contracts.ts, jobs/refund-sender.ts, money-admin.module.ts, index.ts}`, `src/modules/risk/{application/risk-screening.ts, domain/risk-scoring.ts}`, `src/modules/platform/maintenance/maintenance-state.ts`, `test/contract/allowlist.ts`.

Acceptance: a signed-in customer pays an open checkout from the balance and gets the order at once; the ledger shows Dr wallet / Cr
customer funds / Cr VAT; every refusal of route 10 answers its code and writes nothing; a rejected balance-paid order returns the
whole amount to the wallet in the same transaction with no gateway job; two partial refunds never exceed the payment; the VAT report
is right for balance payments and wallet refunds; card flows are unchanged (existing b2c tests untouched).

### B5 Disputes and integrity (M)

Steps: section 5.6.9; `DisputeLedger.loseTopUp`; `dispute.repository.ts` purpose filter; the `dispute` field of the deposits wire; D3
and the account label `Customer wallet · <name>` (`src/modules/health/domain/integrity.ts:88-95`); the scenario tests; READMEs
(`money`, `customers`, `platform`, `health`), `docs/queues.md` (the five customer mails in the notification table),
`src/infra/rate-limit/README.md`, `docs/contract/ALIGNMENT.md § 7` (the routes that need `Idempotency-Key`); `bun run docs:openapi`,
`bun run coverage:build`, `bun run format`, `bun run check`.

Files: edit `src/modules/money/{application/dispute-webhook.service.ts, application/dispute-ledger.ts, application/payment-views.ts, infra/dispute.repository.ts, infra/payment.repository.ts, infra/b2c-reports.repository.ts}`, `src/modules/health/{infra/integrity-reads.repository.ts, application/ledger-integrity-check.ts, domain/integrity.ts}`, the READMEs and docs above.

Acceptance: a top-up dispute freezes the customer's wallet; a loss takes the credited amount back (below zero when it was spent), and
the wallet is frozen at commit; a merchant top-up loss debits the merchant wallet; order disputes behave as before; the reconcile and
the nightly integrity pass with customer wallets, balance payments and clawbacks in the books; `bun run check` is green.

### C1 Console (L) — `FA/` worktree, after the backend is on `main`

Follow `FA/CLAUDE.md`: all HTTP through `src/lib/api`; one exported function per endpoint with `@route METHOD /path`; components ≤ ~200
lines; components never call the API; no demo data outside mocks; the server is the authority; `npm ci` first; done =
`npm run typecheck && npm run lint && npm run build && npm test`. New `@route` tags appear as "unknown tag" in the console's non-strict
coverage report: accepted (L1).

1. **Customers → Wallet tab** (`features/customers`):
   - `api/wallet.ts`: `getCustomerWallet` (`@route GET /admin/customers/:id/wallet`), `listCustomerWalletStatement`
     (`GET /admin/customers/:id/wallet/statement`), `adjustCustomerWallet(id, body, idempotencyKey)` (`POST …/wallet/adjust`),
     `freezeCustomerWallet`, `unfreezeCustomerWallet`; the key travels in `init.headers['Idempotency-Key']` (`FA/src/lib/api/client.ts:11`).
   - `types/wallet.ts`: `CustomerWallet` (= `AdminWallet`), `WalletStatementRow`, `AdjustWalletBody`, `FreezeWalletBody`, `AdjustWalletResult`.
   - `lib/detailTabs.ts`: add `{ id: 'wallet', label: 'Wallet', permission: 'wallet:read' }` and per-tab permission gating (the merchants
     pattern, `FA/src/features/merchants/lib/detailTabs.ts:12-17`); `components/CustomerView.tsx` renders it.
   - Components: `WalletTab`, `WalletSummary` (balance, available, pending top-ups, open disputes, frozen badge with reason and date,
     "switched off" note), `WalletStatementTable` (date range, page, sort; "View journal" needs `ledger:read`),
     `WalletJournalDialog` (uses `JournalLines` and `getLedgerTransaction` from `@/features/finance`), `AdjustWalletDialog` (shows the
     approval limit; the key is `crypto.randomUUID()` made once per dialog opening and reused by every retry of that opening),
     `FreezeWalletDialog`, `UnfreezeWalletDialog`. Buttons need `wallet:adjust`. The dialogs show the server's message.
   - Hooks: `useCustomerWallet`, `useCustomerWalletStatement`, `useWalletMutations`, query keys in `hooks/keys.ts`.
   - Mocks: `mocks/walletHandlers.ts` + store rows (the seeded customers' $50 and in-review top-ups), registered in `mocks/index.ts`.
   - Customers must not be imported by finance (it would close an import cycle: customers already imports finance).
2. **Merchants (D5; small, clearly separated edit in feature 20's area):** `features/merchants/api/wallet.ts:55-61` takes an
   `idempotencyKey` and sends the header; `AdjustWalletDialog.tsx` makes one per opening; `useWalletMutations.ts` passes it. If
   feature 20 merges first, re-apply on top (three files, about ten lines).
3. **Finance:** `types/payments.ts` adds `customer` and `dispute`; `PaymentTable.tsx` shows the customer (name, email) when `client` is
   null, with a plain `/customers/<id>?tab=wallet` link and a dispute chip; `PaymentFilterBar` gets an owner filter; the payment dialog
   shows the dispute; `api/payments.ts` filters `owner`, `customerId`; `lib/accounts.ts` adds
   `customer_wallet: { name: 'Customer wallets', type: 'Liability' }`; a new tab `wallets` "Customer wallets" in `lib/tabs.ts`
   (permission `wallet:read`) with `api/customerWallets.ts` (`@route GET /admin/customer-wallets`), a table, the state filter and search.
4. **Refunds:** `types/index.ts:11` `PaymentMethod` += `'balance'`; `lib/labels.ts` label `Store balance`, `PAYMENT_METHODS`, the method
   filter; the approve dialog and the timeline text say the money returns to the store balance, at once.
5. **Settings:** `lib/wallet.ts` with the eight specs (two booleans, six whole numbers with the ranges of section 5.8); `SettingSpec`
   gains `type: 'boolean'`; a "Customer wallet" panel on the System tab (`components/SystemTab.tsx`) saving one key at a time through
   `PATCH /admin/settings`; the keys join `HANDLED_KEYS` (`lib/system.ts:44-49`).
6. **Risk (only with the lead's OK, L-conflict 2):** `features/risk/types/index.ts:13` += `'balance'`, label `Store balance`,
   `refundDestination` answers "store balance".
7. Tests: section 11.3. Log the assumed-contract notes in `FA/docs/MISMATCHES.md` through `HANDOFF.md` as the console's rules say.

Acceptance: a staff member with `wallet:read` sees the tab, without it does not; adjust, freeze and unfreeze work against the mocks
and show the server's refusals; a second submit of one dialog opening sends the same key; Deposits shows and filters customer top-ups;
the four console checks are green.

Lead steps after C1 merges (not the implementer's): `bun run routes:build && bun run contract:extract && bun run contract:docs`,
fixtures or `known-gaps` for the new console GETs (`test/contract/fixtures.test.ts:39-48`), remove the then-stale allowlist entries,
`npm run mocks:live`.

## 11. Tests

### 11.1 Unit (`src/**/*.spec.ts`)
- `domain/customer-wallet-events.spec.ts`: each builder with exact numbers (top-up 48.50 + fee 1.50 from `bank` and from
  `gateway_clearing`; pay net 12.49 VAT 2.50; refund from `customer_funds` and from `revenue`; adjust both ways; chargeback gross 50,
  fee 1.50, dispute fee 15 → Dr wallet 48.50, Dr fee_income 1.50, Dr chargeback_loss 15, Cr gateway_clearing 65; a partial dispute;
  the merchant owner), balanced, right owners, zero lines dropped.
- `domain/wallet-guard.spec.ts`: credit passes; debit to zero passes; below zero refused; override; merchant rule unchanged.
- `domain/customer-wallet-policy.spec.ts`: defaults, bad values, `min > max`, every `checkTopUp` refusal, liveness, `topUpStatusOf`,
  `customerMemo`, `available`, `room`.
- Extend `accounts.spec.ts`, `reference-data.spec.ts`, `ref-types.spec.ts`, `refund-rules.spec.ts` (`balance` route, `settlesAtOnce`),
  `b2c-money.spec.ts`, `settings-registry.spec.ts`, `rate-limit.service.spec.ts`, `multipart.spec.ts`, the maintenance scope spec,
  `src/modules/health/domain/integrity.spec.ts`.
- `application/customer-wallet-notifications.spec.ts`: every event has `en` and `ar` email templates, variables ⊆ the event's, the
  migration holds exactly `customerWalletTemplatesSql()`.

### 11.2 Integration and scenarios (`test/integration`, real Postgres and Redis, `TestClock`)
| File | Covers |
|---|---|
| `db-customer-wallet.test.ts` | Every new CHECK and index; the deferred trigger (negative unfrozen fails at commit; negative frozen in the same transaction passes; unfreeze below zero fails) |
| `ledger-post-customer-wallet.test.ts` | Parallel debits never overspend; a duplicate key posts once; opposite postings do not deadlock; merchant id N and customer id N adjust keys do not collide |
| `customer-wallet-admin.test.ts` | Routes 11 to 16: success, each refusal, `403`, list filters, sorts, search, `x-total-count`, adjust replay, key reuse, approval limit, audit rows |
| `customer-wallet-store.test.ts` | Routes 1 and 2: zeros, figures, date range, masked memo, another customer's data never visible, switch off |
| `customer-topups.test.ts` | Routes 3 to 8: success, each refusal, limits with the clock, replay, key reuse, two parallel creates respect the limits, receipt retry, cancel |
| `store-files.test.ts` | Route 9: success, type, size, no session, no CSRF |
| `customer-topup-review.test.ts` | Approve and reject a customer top-up; deposits wire and filters; mails; merchant rows unchanged |
| `customer-topup-webhook.test.ts` | Automatic gateway: webhook → pending → job credits; duplicate webhook; approve racing the job; mismatch → review |
| `balance-pay.test.ts` | Route 10: success; every refusal; replay; double click; ten parallel checkouts on a balance that covers three; a card capture racing the balance payment; a guest checkout typed with an account email; another customer's token; a session not opened signed in; frozen; switch off; risk hold and block |
| `balance-refunds.test.ts` | Rejection refund; staff refund before and after delivery; two partials then closing; no outbox job; payment status; mails |
| `b2c-reports-balance.test.ts` | VAT report and payments report with balance payments and refunds |
| `topup-disputes.test.ts` | Customer and merchant: created, lost (negative), won, repeated events; order disputes unchanged; `/admin/disputes` excludes them |
| `integrity-customer-wallet.test.ts` | Reconcile and the nightly check with every new posting; a balance payment without a journal is found |
| `customer-anonymize-wallet.test.ts` | The guard and the export |
| `customer-wallet-seed.test.ts` | The development seed posts balanced journals and is idempotent |
| extend `storefront` checkout/config tests | D6 |
| `test/scenarios/wallet-topup-manual.e2e.test.ts`, `wallet-balance-paid.e2e.test.ts`, `wallet-balance-refund.e2e.test.ts`, `wallet-topup-chargeback.e2e.test.ts` | Step by step like `b2c-paid.e2e.test.ts`; each asserts the journal kinds and `ledgerTotals().sum === '0.0000'` (`test/support/money.ts:97`). They are beyond the map's 13 scenarios (the coverage table ignores them) |

Contract tests: route parity passes once the keys leave `pending.ts`; OpenAPI examples validate; shape parity passes with the
allowlist entries of section 12. Never put a `tx` or an object graph in an assertion message.

### 11.3 Console (`FA/`, vitest)
`features/customers/api/wallet.test.ts` (paths, bodies, the header); `lib/detailTabs` gating; `pages/CustomerPage.test.tsx` (tab
visible only with `wallet:read`; summary; statement paging); `components` tests for the three dialogs (validation, server refusal
shown, one key per opening); `features/merchants` adjust sends the header; `features/finance` Deposits with a customer row, the owner
filter, the dispute chip, the wallets tab, `lib/accounts.test.ts`; `features/refunds/lib` labels; `features/settings/pages/System.test.tsx`
wallet panel; mocks seed test.

## 12. Spec decisions for the lead's B-entries, and lead decision conflicts

Spec decisions (prose; the lead numbers them at merge):
1. A sixteenth account kind `customer_wallet` (owner `customer`); no `customer_hold`.
2. Stored ref type `customer`, sent as `system`.
3. Five wallet money events beyond the map's 13, reusing the kinds `deposit`, `b2c_payment`, `refund`, `adjustment`, `chargeback`.
4. Order payment method `balance`; `payments.gateway_id` nullable for it only; one balance payment per checkout session.
5. Sixteen routes beyond the map (section 7.2).
6. Error codes `WALLET_FROZEN`, `WALLET_DISABLED`.
7. Freeze state on `ledger_accounts`; "below zero ⇒ frozen" enforced by a deferred constraint trigger.
8. `Idempotency-Key` required on customer wallet writes; the merchant adjust keeps it optional.
9. The customer statement masks staff reasons.
10. Top-up disputes: clawback from the wallet, payment stays `approved`, shown on the deposit, no automatic unfreeze.
11. VAT at spend; top-up invoices carry no tax and no PDF.
12. Checkout and `/config` list only gateways `/pay` accepts.
13. Eight wallet settings in the editable registry.
14. Wire value `balance` on refunds, the payments report (and the risk queue).
15. A balance payment needs a checkout opened while signed in (`checkout_sessions.opened_signed_in`).
16. Anonymization refused while the wallet is not empty or money is in flight.
17. No Turnstile on wallet routes.
18. Top-up limits: trailing 24 hours, live open top-ups, three unpaid at most.
19. Five customer notification events with English and Arabic templates.

**Lead decision conflict 1 (L3 × shape parity).** `GET /admin/refunds*` and `GET /admin/reports/payments` must be able to say
`balance`. The console's type is `'card' | 'wallet' | 'crypto'` (`FA/src/features/refunds/types/index.ts:11`) until C1 merges, and
backend worktrees compare against the main console checkout, so `test/contract/shape-parity.test.ts` reports an `enum` deviation. Only
an allowlist entry that cites an existing B-id passes (`test/contract/lib/allowlist-check.ts:80-81`), while L3 assigns B-numbers at
merge. **Default taken so the build is never blocked:** in B4 the implementer appends one provisional entry to
`docs/contract/lead-decisions.json` `extra[]` ("customer wallet: wire value `balance`"), runs `bun run contract:docs`, and writes the
allowlist entries with the id read from one constant `CUSTOMER_WALLET_MISMATCH` in `test/contract/allowlist.ts`. The lead renumbers at
merge by changing that constant, exactly as L3 does for migration names. If the lead hands over a reserved id before B4, use it
instead and do not edit `lead-decisions.json`. Until B4, slices B1 to B3 keep the old enum (`GATEWAY_ORDER_METHODS`), so no entry is
needed earlier. The entries become stale after C1 and the lead removes them.

**Lead decision conflict 2 (L4: "risk (input types only)").** A balance-paid order held for review would show "Card" in the Risk
queue and "refund to card" (`src/modules/risk/domain/queue-view.ts:15-18`; `FA/src/features/risk/lib/queue.ts:65-66`). Correct is one
more enum value in `risk-queue.contracts.ts:24`, `queue-view.ts`, `risk-queue.service.ts:37` and three console lines in
`features/risk`, under the same allowlist id. **Default:** do it in B4 and C1 only if the lead says yes; otherwise leave the files
alone and repeat this note in the report (the order and its money are right either way; only the label is wrong).

**Note on L5 "`Idempotency-Key` required on every wallet write":** followed for the customer wallet's seven writes. The merchant adjust
route keeps the header optional (L1: additive only); the console sends it.

## 13. Storefront handoff (for the other session; nothing here edits the storefront)

- **Switch.** Call `GET /store/v1/me/wallet` after sign-in. `enabled: false` → hide "Add Funds" and "Pay from balance" but still show
  a non-zero `balance`. `cardTopUps` says whether an automatic method can appear. The wallet is not in `/store/v1/config`.
- **Shape.** `balance`, `reserved`, `creditLimit`, `available` have the merchant wallet's names (`GET /client/wallet`), so one
  component serves both account types; for a customer `reserved` and `creditLimit` are always `0.0000`. The wallet is **USD**; show
  other currencies as approximate with `/config` rates. `balance` can be negative (after a chargeback): show it and the hold.
- **Statement.** `GET /store/v1/me/wallet/statement?createdAt_gte=…&createdAt_lte=…&_start=0&_end=25`; `kind` is one of `deposit`,
  `b2c_payment`, `refund`, `adjustment`, `chargeback` (translate by kind; `memo` is English); `orderId` links to the order when set.
- **Add Funds.** `GET …/top-up-methods` → `POST …/top-ups` `{ amount, gatewayId }` with a fresh `Idempotency-Key` per attempt
  (reuse it when retrying the same attempt) → manual: show `instructions`, upload the receipt with `POST /store/v1/files`
  (multipart, one part `file`, PDF/JPEG/PNG, ≤ 5 MiB), then `POST …/top-ups/:id/receipt` `{ fileId, reference? }` → status
  `in_review` until staff decide (`credited` or `rejected` with `rejectionReason`; an email is sent). Automatic: send the browser to
  `paymentUrl`; it returns to `<STORE_BASE_URL>/account/wallet?topUp=<id>`; poll `GET …/top-ups/:id` gently.
  `POST …/top-ups/:id/cancel` closes an unpaid manual top-up. Limits are in `limits`; refusals are `422` on `amount` with codes
  `min`, `max`, `fee`, `daily_count`, `daily_amount`, `max_balance`, or `409 CONFLICT` (three unpaid top-ups).
- **Pay from balance.** The checkout must be **opened while signed in** (send the session cookie and `X-CSRF-Token` on
  `POST /store/v1/checkout-sessions`); the session then says `balancePayable: true`. Compare `wallet.available` with
  `amounts.usd.gross`. Pay with `POST /store/v1/checkout-sessions/:token/balance-payment` (headers `X-CSRF-Token`,
  `Idempotency-Key`; no body) → `201` with `order.trackingToken`: the order exists **at once**, no webhook, no polling. Errors:
  `401` = not signed in (do **not** treat it as an ended session: ask the user to sign in); `403 FORBIDDEN` = another account's
  checkout or a guest-opened checkout (open a new checkout while signed in); `402 INSUFFICIENT_FUNDS`; `409 WALLET_FROZEN`;
  `409 WALLET_DISABLED`; `409 INVALID_TRANSITION` (paid or expired: read the session); `422` on `consent`. `/pay` stays for
  gateways; its answer never says `balance`.
- **Changed lists.** `paymentMethods` (checkout session and `/config`) now holds only methods `/pay` accepts: the `not_offered`
  filter the site applies becomes unnecessary but harmless.
- **Every wallet POST needs `Idempotency-Key`** (1 to 100 printable ASCII characters, no spaces) and the store `X-CSRF-Token`. CORS
  already allows both headers. `idempotency-replayed` is not readable cross-origin.
- **Errors to translate:** `WALLET_FROZEN`, `WALLET_DISABLED` (new), `INSUFFICIENT_FUNDS`, plus the field codes above.
- **Caching:** never cache any wallet answer (`Cache-Control: no-store`); refetch the wallet after a top-up, a payment or a refund.
- **Emails the customer receives:** top-up credited, top-up rejected, balance adjusted, balance on hold, refund to the balance
  (English and Arabic by the customer's `locale`).
- **Types:** regenerate from `docs/contract/openapi.json` after the backend merge; operation ids are new, none was renamed.
- **Refunds:** an order paid from the balance is refunded to the balance, at once; an order paid by card is refunded to the card.

## 14. Review against the code, and approval

Checked once more against `bd32229` after writing:
- Every posting goes through `postTransaction`; the only change to it is the guard and two reported fields (section 5.5).
- No flow locks a ledger account before a posting; the freeze-after-posting order is consistent with the commit-time trigger.
- The balance payment reuses `CustomerOrderPlacement.place` and the capture's order of steps; the session row lock is the single
  serialization point with a card capture, whose duplicate path already refunds the loser.
- Refund math is untouched; the three readers that assumed `gateway_clearing` are listed and fixed.
- Money imports nothing from customers; customers calls money with its `tx` (decision 032 holds).
- Existing routes change additively; the two enum widenings are named with their mechanism.
- Merchant flows keep their branch; their tests are the regression guard and are not edited except for the pinned kind counts.
- Open points that are not blockers: W0 must be merged first (lead); L-conflicts 1 and 2 have defaults; the Stripe driver defects
  keep card top-ups off in practice, which matches O7.

**Approved by Fable 5.2 (2026-11-10).** After implementation I review the financial integrity independently (ledger postings, lock
order, idempotency keys, the trigger, the concurrency tests and the reconcile results) before the lead merges.
