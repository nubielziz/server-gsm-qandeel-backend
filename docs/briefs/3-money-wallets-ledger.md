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
- Account resolution: system accounts by kind and currency, client wallet and hold per merchant and currency (unique
  identity of decision 024). A merchant's accounts are opened with the merchant, not on first use: see
  `MerchantAccounts.open` below; creation on first use stays only as a safety fallback.
- **`MerchantAccounts.open(tx, { clientId, currency: 'USD', creditLimit, overdraftAllowed })`**, a public service exported from
  `src/modules/money/index.ts` (resolution ip-1; the lead writes the signature before wave 1, you implement and merge first).
  It inserts `client_wallet` (`owner_type 'client'`, `overdraft_limit = creditLimit ?? '0.0000'`) and `client_hold`
  (`overdraft_limit 0`) as raw inserts with `ON CONFLICT (ledger_accounts_identity_uq) DO NOTHING`: no `postTransaction`, no
  money event. It applies user rule 2 itself (below), and returns the wallet view `{ balance: '0.0000', reserved: '0.0000',
  creditLimit, available: creditLimit }`. Feature 2a calls it from `POST /admin/clients` with the entered limit and 2b from
  `POST /client/auth/register` with `0`. The credit-limit setter of `PATCH /admin/clients/:id/credit-limit` takes
  `overdraftAllowed` too and throws the same error, so both routes answer alike.

## Public service for features 2a and 2b (resolution identity-platform-1, user decision)
```ts
// src/modules/money/index.ts: opens a merchant's ledger accounts inside the caller's transaction.
MerchantAccounts.open(tx: DbExecutor, input: {
  clientId: number; currency: string /* 'USD' */; creditLimit: Money /* '0.0000' allowed */; overdraftAllowed: boolean;
}): Promise<{ balance: Money; reserved: Money; creditLimit: Money; available: Money }>
```
Inserts `client_wallet` (overdraft_limit = creditLimit) and `client_hold`, `ON CONFLICT (ledger_accounts_identity_uq)
DO NOTHING`, no ledger transaction; refuses `creditLimit > 0` when `overdraftAllowed` is false with `422
VALIDATION_FAILED` on `creditLimit` (user rule 2; the same check as the credit-limit route). Feature 3 merges before 2a
and 2b use it.

**Already built by the lead** (`src/modules/money/application/merchant-accounts.ts`, exported, tested): keep its
signature; extend it only if your ledger core needs to (e.g. reuse the account-resolution helpers).

## Routes (14; remove them from `test/contract/pending.ts`)
`GET /admin/clients/:id/wallet`, `GET /admin/clients/:id/statement`, `POST /admin/clients/:id/wallet/adjust`,
`PATCH /admin/clients/:id/credit-limit`, `GET /admin/ledger/transactions`, `GET /admin/ledger/transactions/:id`,
`GET /admin/ledger/accounts`, `POST /admin/ledger/reconcile`, `GET /admin/currencies`, `GET /admin/currencies/:id`,
`POST /admin/currencies`, `PATCH /admin/currencies/:id`, `GET /client/wallet`, `GET /client/wallet/statement`.

## Rules that matter
- User rule 2 (PROGRESS "Business rules answered by the user"): lowering a credit limit below the credit in use is
  allowed (new orders are refused until a top-up); a limit above zero on a group without `overdraft_allowed` is
  `422` `errors[{field:'creditLimit', message:'This group does not allow credit.'}]`, raised in one place
  (`MerchantAccounts.open` and the credit-limit setter, resolution ip-3). A negative limit is `422` on `creditLimit`.
- **Ledger wire (resolutions money-1, money-6, money-15).** The stored `ref_type` set is `order, payment, invoice, refund,
  dispute, accrual, supplier, client, system` (no `ledger_transaction`). Manual adjustments keep `ref_type 'client'`
  (`ref_id` = client id) in the database and `toWireRefType()` (in the ledger read service) sends it as `refType 'system'`
  with `refId` = the client id; a wire filter `refType=system` matches stored `system` and `client`; every other value goes
  out unchanged, and a contract enum test covers `LedgerTransaction.refType`. Reversals carry the ref of the record they
  reverse; the reversed transaction id goes into the memo ('Reversal of JRN-<id>') and the idempotency key
  ('reverse:<txId>'). `ledger_transactions.ref_id` is `NOT NULL DEFAULT 0`: a system posting stores `0` and
  `postTransaction` rejects `0` for any other `ref_type` (`LEDGER_REF_REQUIRED`, a programming error that is never
  exposed); `refId` is always a number on the wire. A numeric `q` on the list matches `id = q OR ref_id = q` (after the
  console strips `JRN-`/`#` and leading zeros); a text `q` matches memo, kind and the owner names of the lines.
- **Currencies (money-13).** `decimals` is an integer 0 to 4 (CHECK and validation agree, `422` outside); `rate_updated_at` is
  never null on the wire; `isStale` = a non-base currency whose `rate_updated_at` is older than 24 h (age only).
- Adjust posts a balanced transaction against `owner_capital` or the account the endpoints doc names, requires a
  reason, is audited, and carries an idempotency key.
- Reconcile: Σ entries per account = balance, global Σ = 0 per currency; runs as a job (`job_runs`, decision 020)
  started by the route (`RECONCILE_RUNNING` while one runs); the report shape follows the endpoints doc.
- Balances, statements and ledger lists are never cached (decision 022). Money is `Money` on the wire (4 decimals).
- The seed gains the demo's wallets and ledger history (`scripts/seed/money.ts`), posted through `postTransaction`
  so the zero-sum and balance rules hold, and first opens the accounts of every demo merchant through
  `MerchantAccounts.open` (with the credit limit the demo mocks show). Merchants (`clients`) are seeded by feature 2a, built
  in parallel: post only for merchants that exist (skip the others with one log line), and let tests create their own
  merchants through `test/support/fixtures.ts`.

## Resolutions of your routes
Findings to carry (`docs/contract/RESOLUTIONS.md`, they win over older text): ip-1 and ip-3 (`MerchantAccounts.open`, the
credit rule), money-1 and money-6 (ref types, `refId`), money-13 (currencies), money-15 (ledger search). The migration `0003`
(lead) ships their schema changes: the `ledger_transactions_ref_type_check` without `ledger_transaction`,
`ref_id NOT NULL DEFAULT 0` with its CHECK, and `currencies_decimals_check` 0 to 4.

## Out of scope
Invoices, payments and gateways (8), order holds and completion postings (5/6 use the builders), FX refresh (14b).
