# 024: Ledger: one entry point, append-only, zero-sum, accounts locked in id order

Status: accepted, 2026-10-31.

**Context.** `system.mjs` defines 14 accounts and 13 money events with their exact journal lines (`entry:
[account, debit, credit]`). Tables: `ledger_accounts (kind, owner_type, owner_id, currency, balance, overdraft_limit,
version)`, `ledger_transactions (kind, ref_type, ref_id, memo, idempotency_key, created_by_type, created_by_id)`,
`ledger_entries (transaction_id, account_id, amount, balance_after)`.

**Decision.**
- Accounts: one system account (no owner) each for `fee_income, vat_payable, chargeback_loss, bank, gateway_fees,
  gateway_clearing, customer_funds, revenue, cogs, adjustments, commission_expense`, plus `owner_capital` (equity,
  credit-normal; not in the map) as the counterpart of opening balances; per merchant `client_wallet` and
  `client_hold`; per supplier `supplier_prepaid`. Unique `(kind, owner_type, owner_id, currency)`; owner accounts are
  created inside the transaction that first needs them.
- Normal side from the map's kinds: asset and expense are debit-normal; liability and income are credit-normal.
- Entries: `amount` is signed (debit > 0, credit < 0), `CHECK (amount <> 0)`, Σ amount = 0 per transaction.
  `ledger_accounts.balance` is kept in the account's normal sign (debit-normal `+= amount`, credit-normal
  `-= amount`); `balance_after` is that balance right after the entry.
- Wallet figures on the wire: `balance` = client_wallet balance, `reserved` = client_hold balance, `creditLimit` =
  `overdraft_limit`, `available` = balance + creditLimit (a hold already moved its amount out of the wallet).
- `postTransaction(tx, input)` in the money module is the only writer, always inside the caller's DB transaction:
  1. validate: ≥ 2 lines, each a positive debit or credit, Σ debit = Σ credit, one currency (`LEDGER_UNBALANCED`);
  2. insert the header; `idempotency_key` is unique, and a conflict returns the existing transaction (a replay
     returns the first result and posts nothing);
  3. lock every affected account `SELECT … FOR UPDATE ORDER BY id` (one global order: no deadlocks);
  4. guard: a `client_wallet` may not end below `-overdraft_limit` (`INSUFFICIENT_FUNDS`), except events the map
     allows to (credits, reversals);
  5. insert entries with `balance_after`, update balances and `version`.
- `ref_type` ∈ `order, payment, invoice, refund, dispute, accrual, supplier, client, system, ledger_transaction` (the
  map lists only the first four; the console finds deposits by `payment`, commission batches by `accrual`).
- Rules beyond the 13 map events: approving a top-up through a manual gateway (`is_manual`) debits `bank` instead of
  `gateway_clearing`; reopen moves revenue back to the hold (B2B) or customer funds (B2C) and keeps cogs; a B2B refund
  of a completed order moves revenue straight back to the wallet, cogs kept; each is a reversing entry.
- One builder per map event (`deposit, order, complete, reject, topup, commission, adjust, b2c_pay, b2c_fee,
  b2c_deliver, b2c_refund, b2c_chargeback, payout`) returns the lines exactly as the map writes them; a zero-amount
  line (no supplier cost) is dropped. Each builder has a unit test with the map's numbers.
- Database enforcement: a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `ledger_entries` checks Σ amount = 0
  per transaction at commit; `BEFORE UPDATE OR DELETE` triggers reject changes to `ledger_entries` and
  `ledger_transactions`. Corrections are reversing transactions (`ref_type = 'ledger_transaction'`).
- Integrity job (nightly and `POST /admin/system/integrity/run`): Σ entries per account = balance, global Σ = 0,
  `balance_after` chains, holds of finished orders; results in `job_runs`, failures raise alerts.
- Balances, holds and ledger rows are never cached and are read inside the transaction that decides.

**Consequences.** Concurrency safety comes from row locks in id order plus the unique idempotency key; the
concurrency tests (two orders on one wallet, duplicate webhook) prove it. `customer_funds` is one system account;
B2C traceability is per order through `ref_type/ref_id`.
