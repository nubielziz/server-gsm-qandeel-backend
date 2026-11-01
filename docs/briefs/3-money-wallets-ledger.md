# 3 money-wallets-ledger

Phase 3, map stage 3. Read `_common.md` and `_feature.md` first. Module: money. This feature builds the ledger core
every later money feature uses, so its domain layer is complete even where no route of this stage needs it yet.
Decisions 011 (money) and 024 (ledger) are the core; also 022 (no cache for balances or ledger), 027.

## Ledger core (domain + application)
- `postTransaction(tx, { kind, refType, refId, idempotencyKey, lines, memo, createdBy })`: the only writer of ledger
  rows (decision 024): validate (≥ 2 lines, positive debit or credit, Σ debit = Σ credit, one currency, else
  `LEDGER_UNBALANCED`), idempotency by `idempotency_key` (a replay returns the first transaction), lock the accounts
  `FOR UPDATE` in id order, check overdraft (`client_wallet` may go below zero only down to its credit limit),
  write header and entries with `balance_after`, update balances, all in the caller's transaction. Concurrency tests:
  parallel posts on one wallet never overspend; a duplicate idempotency key posts once.
- Money event builders for **all 13 money events of the map** (`docs/slices/money.json`, decision 024): pure functions
  returning the lines exactly as the map writes them, each unit-tested with the map's numbers. Later features call
  them; this feature uses deposit/adjust ones.
- Account resolution: system accounts by kind and currency, client wallet and hold per merchant and currency (created
  on first use, unique identity of decision 024).

## Routes (14; remove them from `test/contract/pending.ts`)
`GET /admin/clients/:id/wallet`, `GET /admin/clients/:id/statement`, `POST /admin/clients/:id/wallet/adjust`,
`PATCH /admin/clients/:id/credit-limit`, `GET /admin/ledger/transactions`, `GET /admin/ledger/transactions/:id`,
`GET /admin/ledger/accounts`, `POST /admin/ledger/reconcile`, `GET /admin/currencies`, `GET /admin/currencies/:id`,
`POST /admin/currencies`, `PATCH /admin/currencies/:id`, `GET /client/wallet`, `GET /client/wallet/statement`.

## Rules that matter
- User rule 2 (PROGRESS "Business rules answered by the user"): lowering a credit limit below the credit in use is
  allowed (new orders are refused until a top-up); a limit above zero on a group without `overdraft_allowed` is
  `422` on `creditLimit`.
- Adjust posts a balanced transaction against `owner_capital` or the account the endpoints doc names, requires a
  reason, is audited, and carries an idempotency key.
- Reconcile: Σ entries per account = balance, global Σ = 0 per currency; runs as a job (`job_runs`, decision 020)
  started by the route (`RECONCILE_RUNNING` while one runs); the report shape follows the endpoints doc.
- Balances, statements and ledger lists are never cached (decision 022). Money is `Money` on the wire (4 decimals).
- The seed gains the demo's wallets and ledger history (`scripts/seed/money.ts`), posted through `postTransaction`
  so the zero-sum and balance rules hold. Merchants (`clients`) are seeded by feature 2a, built in parallel: post
  only for merchants that exist (skip the others with one log line), and let tests create their own merchants
  through `test/support/fixtures.ts`.

## Out of scope
Invoices, payments and gateways (8), order holds and completion postings (5/6 use the builders), FX refresh (14b).
