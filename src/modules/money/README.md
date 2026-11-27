# Money module (`money`)

Map domain E. The double-entry ledger and everything that moves money: wallets and statements, currencies, invoices, payment gateways and payments, withdrawals, refunds, disputes and tax rates. `postTransaction()` is the only ledger writer (decision 024).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 011 money, 024 ledger. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Stage 3 is built (feature 3): the ledger core, merchant wallets, the ledger screens, reconciliation and currencies (14
routes). Stage 8 billing is built (feature 8, below): gateways, invoices, top-up payments, the payment webhook and the
automatic credit. The exchange-rate refresh (`POST /admin/currencies/refresh-fx`) is built (feature 14b, below). Feature 11
adds the five stage-11 reports (below), the client statement PDF (`GET /admin/reports/client-statement/:clientId`) included.
Refunds, disputes and the VAT and payments reports arrive with 16.

## One account type in the money module (decision 064)

This section holds the rules of the one account type; where an older bullet below says "merchant wallet", "customer wallet" or names the owner words `client` and `customer`, read it with this section.

- **A wallet belongs to an account.** The ledger owner of every wallet and hold is the pair (`account`, id), whatever the rank (`ACCOUNT_OWNER_TYPE`; `walletAccountOf`, `holdAccountOf`, `storeWalletAccountOf` build the refs; `customerWalletAccount(accountId)` is the same pair with the kind `customer_wallet`), so an account has at most one wallet of each kind (`ledger_accounts_identity_uq`). Which kind is **live** follows the kind of the rank (`walletKindOfRank(rankKind)`, `domain/wallet-kinds.ts`): a merchant rank has `client_wallet` and `client_hold` (credit when the rank allows it, hold and settle), the retail rank `customer_wallet` (no credit, pay first, freeze, never below zero except a chargeback clawback). A wallet of the other kind may remain from a rank change; it holds zero and is unfrozen, and the fifth integrity check (health) flags any other state. New journals say `account` in their reference and actor words (`ref_type`, `created_by_type`, the audit entity); journals written before the merge keep the old words and are named through the legacy number map (`loadActorNames(db, ActorRef[])` in `infra/foreign-directory.repository.ts`, where an old `customer` number is read only through `account_legacy_ids`), so an old customer number is never read as the account that has the same number. The wire sends every stored ref type `account`, `client` and `customer` as `system` (`toWireRefType`, `storedRefTypesOf('system')` lists all four); the ledger line owner type on the wire is `account` or `supplier`, and `createdBy.type` may be `account` (older rows keep `client` or `customer`). The input keys `clientId` and `customerId` of the event builders stay; their values are account ids.
- **The `AccountWallets` seam** (`ports/account-wallets.ts`, implemented by `AccountWalletsService` in `application/account-wallets.ts`, bound by the global `AccountWalletsModule`): `kindOf(tx, accountId)` (`merchant` or `store`, read after the account row lock), `viewsOf(db, accountIds)` (the live wallet of a whole page in a fixed number of statements; an account that never had a wallet answers zeros with the rank's kind; the view is `{kind, currency, balance, reserved, creditLimit, available, creditAllowed, frozen, enabled, pendingTopUps, openDisputes, adjustApprovalLimit}`, money as strings) and `assertNotFrozen(tx, accountId)` (409 `WALLET_FROZEN`, a plain read with no lock on purpose, called by the order placement after the account row lock and before the hold; a frozen merchant wallet takes no new hold, while settlement and release of existing holds, credits and staff debits still post). `WalletErasure.closeForErasure(tx, accountId)` is the other seam (implemented by `CustomerWallets`): it refuses the erasure of an account while a wallet or hold of either kind is not zero, a wallet is on hold (even at zero), a top-up waits for review, a top-up dispute is open, a balance-paid order is open or a refund to the balance waits; an open order paid by card does not hold it. The registry `RankChangeGuards` is provided here (`register(name, check)`, `blockersOf`; entries: `live_order` by orders, `open_checkout` by customers), and the `walletBalanceSql` fragment is registered with identity's `AccountListSql` at module init.
- **One lock order for every money path of an account.** (1) The account row: `FOR UPDATE` by the rank change, the status writers, the guest claim and the erasure; `FOR KEY SHARE` by every path that reads the rank kind to move money or to choose a wallet (portal and Dhru placement, both top-up creates, the store balance payment, checkout capture, crediting, chargeback postings, refunds to a wallet, staff freeze, unfreeze and credit limit), so a path reads the rank kind only after it holds the lock. (2) The rows of the path (order, checkout session, invoice, payment, dispute; the refund path locks the payment, then the refund, then the account row). Crediting, the dispute webhook and refund approval hold their rows already and take the account row after them; that is safe because the rank change and the status writers never lock those rows, and the guest claim takes them only with `NOWAIT`. (3) The advisory locks: `topup:<accountId>` (`lockAccountTopUps` in `infra/topup-lock.repository.ts`: both top-up creates, both receipt uploads after the invoice row, and the rank change), fingerprint and stock locks, `upload-quota:account:<id>`; `wallet-adjust:staff:<staffId>` stays first in a staff adjustment (nothing that holds an account row waits for it). (4) The ledger accounts `FOR UPDATE` in id order (`postTransaction`). The rank change takes the account row `FOR UPDATE`, then the account's ledger accounts in id order, then `topup:<accountId>`; it cannot deadlock with a top-up create, which takes the account row before the advisory lock and posts nothing while holding it. The one named exception is identity's `api-keys:<accountId>`, taken before the account row by both key creations.
- **Staff wallet actions** (`application/account-wallet-admin.ts`, `AccountWalletAdmin`): staff reach the wallet of any account at `/admin/clients/:id`, whatever its rank: `GET /admin/clients/:id/wallet` (the `AccountWalletView` above), `GET /admin/clients/:id/statement` (the live wallet; a `wallet` parameter of `live`, `merchant` or `store` reads an inactive wallet's history, plus the `createdAt_gte` and `createdAt_lte` filters and an optional `orderId` on a row), `POST /admin/clients/:id/wallet/adjust`, `PATCH /admin/clients/:id/credit-limit`, `POST /admin/clients/:id/wallet/freeze` and `POST /admin/clients/:id/wallet/unfreeze` (body `{reason}` of 5 to 200 characters; `wallet:adjust`; `409 CONFLICT` and `OPEN_DISPUTE` on the unfreeze). Each reads the wallet kind only after it holds the account row `FOR KEY SHARE`, so a write that races a rank change lands on the wallet that is live after it. **The manual adjustment** key is `adjust:<accountId>:<Idempotency-Key>` for both kinds and the header is required (422 without); before posting, `LegacyAccounts.legacyIdsOf` gives the old customer numbers and a transaction with the key of the earlier form `adjust:customer:<oldId>:<key>` is replayed through the same-adjustment check. The approval limit of a staff member's credits is counted per wallet kind over 24 hours (`wallet.adjust_approval_limit` for the merchant wallet, `wallet.customer.adjust_approval_limit` for the store balance), the credits made before the merge included (`staffCreditsSince(db, staffId, 'merchant' | 'store', since)` counts the three ref types); `wallet_transfer` journals never count. **The credit limit** exists on the merchant kind only (422 on `creditLimit`, code `not_allowed`, for a store balance), needs an `Idempotency-Key`, and a raise on a wallet on hold is `409 WALLET_FROZEN`. **Keys of freeze, unfreeze and credit limit** are stored in `wallet_action_keys` (append-only; unique on `(account_id, idempotency_key)`; the action, a keyed hash of the validated body and the first answer) in the transaction of the change: the same key and request replays the first answer (header `idempotency-replayed: true`) and applies nothing again, another request under the key is `409 IDEMPOTENCY_KEY_REUSED` (the status the error catalog gives it). The system freeze of a dispute webhook carries no key (the dispute id is its guard). A write that raced on a new key retries once.
- **The rank change** (`application/account-rank-change.service.ts`, `AccountRankChange.change(staff, accountId, groupId, idempotencyKey)`, controller `AccountRankController`, contract `changeAccountRank`, pure rules in `domain/rank-change.ts`, queries in `infra/rank-change.repository.ts`): **`POST /admin/clients/:id/rank`**, body `{groupId}` only, header `Idempotency-Key` required (422 without), permission `clients:update` and the Owner role itself (`assertMayChangeRank`, checked before anything is read for writing). One transaction: lock the account row `FOR UPDATE` (404 when missing, 409 `ANONYMIZED`); a row of `account_rank_changes` with the same key and target replays its result (a reuse with another body is `409 IDEMPOTENCY_KEY_REUSED`); the target rank is read (422 on `groupId`: `unknown_rank` or `same_rank`). **Inside the merchant kind** only the rank changes, and a rank without credit is refused (`credit_limit` blocker) while the credit limit is above zero. **Across kinds:** open the missing target wallets, lock the account's `client_wallet`, `client_hold` and `customer_wallet` in id order, then take `topup:<accountId>`; collect **every** reason the change cannot be made now and answer them together as `409 RANK_CHANGE_BLOCKED` with `errors[{field: 'groupId', code}]` and nothing written. The codes (`RankBlockerCode`) and who owns each: money `guest` (the row has no login), `open_hold` (a `client_hold` that is not zero), `open_topup`, `open_dispute`, `open_refund` (a balance refund requested or processing), `frozen`, `negative_balance` and `credit_limit`; orders `live_order`; customers `open_checkout`. Otherwise the whole balance moves in one `postTransaction` of kind `wallet_transfer`, ref type `account`, key `rank:<accountId>:<Idempotency-Key>` (Dr source, Cr target: merchant to retail debits `client_wallet` and credits `customer_wallet`), **posted directly so closing a wallet raises no low-balance alert**; the credit limit of a merchant wallet that is left becomes zero; `AccountRanks.setRank` writes the rank (and `ensureUsername` for retail to merchant); `AccountAccessEffects.rankChanged` ends every session across kinds, revokes every live API key when the account leaves the merchant kind and invites an account without a password that is raised to a merchant rank; one `account_rank_changes` row records both ranks' ids, names and kinds (no foreign key on the two rank ids, so the history stays readable after a rank is deleted), the moved amount, the transaction, the counts and the staff member; one audit row (entity `account`). The answer is `{rank, wallet, movedAmount, transactionId, sessionsEnded, apiKeysRevoked}` with `wallet` and `transactionId` nullable; a replay answers the stored change with the wallet as it is now and `idempotency-replayed: true`. After the commit the session and API key views are dropped. No cache key, queue or job.
- **Top-ups and invoices** (`MerchantBillingService`, `CustomerTopUps`, `infra/topup-lock.repository.ts`). Every invoice names its account (`account_id`), and a top-up or manual invoice names the wallet kind it fills (`wallet_kind`: `client_wallet` or `customer_wallet`; a manual invoice is always `client_wallet`); `client_id` is still written for a merchant invoice until the contract release. Both creates (`POST /client/invoices` and `POST /store/v1/me/wallet/top-ups`) take the account row `FOR KEY SHARE`, then the one lock `topup:<accountId>` (it replaces `merchant-topup:<clientId>` and `wallet-topup:<customerId>`), and read the rank only after both; both receipt uploads take the account row `FOR KEY SHARE`, then the same lock, then the invoice row (then the receipt content lock), so an upload never waits for the account row while it holds the lock or the invoice that a rank change or an erasure waits for. `POST /client/invoices` takes an optional `Idempotency-Key`: the same request answers the same invoice with `idempotency-replayed: true`, another request under the key is `409 IDEMPOTENCY_KEY_REUSED`, and a top-up whose payment page is still opening is `409 IDEMPOTENCY_IN_PROGRESS` (after a minute, `TOPUP_OPENING_GRACE_MS`, the retry voids the stale invoice and starts again); the key is bound to the request's gateway, amount and wallet kind (`topUpFingerprint`, `judgePriorTopUp`) by the unique index `invoices_account_key_uq` (both routes). The portal lists the invoices of the merchant wallet only; the store lists the top-ups of the store balance only. Staff-issued invoices are for a merchant rank only (`422` on `clientId`, code `not_merchant`). `GET /admin/invoices` filters by `accountId` (`clientId` is its alias); rows keep `client` and `customer` with account ids (client: merchant-wallet invoices and statements; customer: store top-ups and receipts). The store top-up limiter key is `a:<accountId>` and the mail unique key `wallet.frozen:<accountId>:<ms>`.
- **Crediting after a change of rank kind** (`PaymentCrediting`: `creditPlan`). Crediting locks the payment, then the invoice, then the account row `FOR KEY SHARE`, reads the rank kind under that lock and credits the **live** wallet: a merchant wallet through the deposit event (with the paid-invoice event and the invoice PDF), a store balance through the store top-up event (with its email). A credit is never refused for the kind (an invoice with no `wallet_kind` is `409 CONFLICT`); when the invoice named the other kind the audit row records both (`invoiceWallet`, `creditedWallet`). **Disputes of top-ups** (`DisputeWebhookService`, `DisputeLedger`, `clawbackRulesOf`): a dispute that opens on a card top-up freezes the live wallet of either kind (and a pending top-up is sent to review so the automatic credit skips it); a lost dispute takes the credit back from the live wallet (a merchant wallet may pass its credit limit, `allowBelowCreditLimit`; a store balance may go below zero and is frozen after the posting, `allowNegativeCustomerWallet` and `freezeAfterPosting`), key `dispute:<id>:chargeback`; the account row is locked after the payment and the dispute rows and the kind is read only then. **The payments list:** `GET /admin/payments` filters by `accountId` (`clientId` is its alias) and `owner` (the wallet kind); `customerId` answers `422`; its two joins follow the wallet kind of the invoice and both carry the account id.
- **Refunds** (`B2cRefunds`, `domain/refund-rules.ts`): a refund goes back to the wallet the account holds **now**, or through the gateway. A payment made from the store balance is refunded to the store balance while the account has a retail rank and to the merchant wallet after a change to a merchant rank (`holdOrderRefundPosting`, `b2cWalletRefundPosting`, the `wallet` option of the builders), under the same keys; the kind is read after the account row is locked, so a rank change that races a refund lands first or waits. What is left to refund counts the lines of kind `gateway_clearing`, `customer_wallet` **and `client_wallet`** (`ledgerPartsOf`, and the payments report's `fundingOf`), so the report keeps tying to the books. Every refund that names a payment names that payment's account (`refunds.account_id`), an orderless return of a held payment included; `GET /admin/refunds` and the payments report keep the `customer` key for the buyer account (any rank, a guest included) and word `requestedBy.type` `account`. A reopen of a completed hold-path order is a new debit, not a refund: it is refused with `409 RANK_CHANGED` when the account's live kind is no longer merchant (orders).
- **The guest claim** (`application/guest-claim.participant.ts`, name `money`, `moveGuestClaimMoney(tx, {guestId, accountId})`, the last line of the barrel): a guest's payments, receipt invoices, refunds and disputes move to the account that proves the mailbox, taking the rows `FOR UPDATE NOWAIT` and refusing with `GuestClaimBusy` while a payment of the guest is pending or the guest holds a ledger account.
- **Reports and integrity** (decision 064, `ReportService`, `B2cReportsService`): the reports follow the door of an order (`orders.source`), not the rank of its buyer. `GET /admin/reports/top-clients` ranks every account that ordered in the window (`scope` `all`, `b2b` or `b2c` by door), guests in and anonymized accounts out, rows `{id, name, country, rank {id, name, kind}, hasAccount, orders, spend (before VAT), profit, walletBalance}`. Two spend figures exist on purpose: `spend` of this report and the 30-day `spend` of the account list (orders' `OrderClientStats`) are before VAT (`orders.total_price`, the revenue the reports count), while `totalSpent` of the account list and record is what the buyer paid, VAT included (`total_price + tax_amount`), both over the orders that were not rejected. `GET /admin/reports/wallet-exposure` keeps the merchant-rank wallets in `totals` and adds `storeBalances {accounts, balance, negative, frozen}` beside them. The client statement PDF is the live wallet's: the merchant wallet and its invoices for a merchant rank, the store balance and its top-ups (no credit limit row) for the retail rank; an inactive wallet's history is on `GET /admin/clients/:id/statement?wallet=`. The nightly integrity check's fifth part (health) reads the wallets against their ranks; the console's check list gains `wallets_follow_rank`.
- **The store balance** (`CustomerWallets`, feature 21, below): a `customer_wallet` owned by (`account`, id) of an account of the retail rank; both store routes refuse a merchant rank with `403 RANK_NOT_ALLOWED` (`accountIdOf`, alias `customerIdOf`); `GET /admin/customer-wallets` lists the live store wallets (the owner's rank is not a merchant rank) and its `customer.id` is the account id; the five staff routes of `/admin/customers/:id/wallet*` (read, statement, adjust, freeze, unfreeze) answer `410 ROUTE_RETIRED` until the contract release deletes their rows; a balance payment is recorded under the buyer's `account_id` (`CustomerWalletPayments.record(tx, {sessionId, key, accountId, order, session})`) and posted by (`account`, id). The low-balance event payload carries `accountId` and `clientId` (the same value).
- **Ledger writer.** `postTransaction(tx, input, now)` (and the injectable `LedgerPoster.post(tx, input)`, which reads the
  Clock) is the only writer of `ledger_transactions`, `ledger_entries` and account balances (decision 024): at least two
  positive lines in one currency that balance (`LEDGER_UNBALANCED`), the header first so a repeated `idempotency_key` returns
  the first transaction and posts nothing, every account locked `FOR UPDATE` in id order (missing accounts are opened, then
  all are locked again in one statement), a `client_wallet` debit refused below `-overdraft_limit` (`INSUFFICIENT_FUNDS`;
  credits always pass, user rule 2), entries with `balance_after`, balances and versions updated. `ref_id 0` is only for
  `system` (`LedgerRefRequiredError`, a programming error).
- **Money events.** `domain/money-events.ts` has a pure builder for each of the map's money events that can still be posted, 12 of its 13 (`deposit`, `topup`,
  `order`, `complete`, `reject`, `adjust`, `payout`, `b2cPay`, `b2cDeliver`, `b2cFee`, `b2cRefund`,
  `b2cChargeback`); each returns the map's lines and is unit-tested with the map's numbers. Later features spread one into
  `LedgerPoster.post`. Beyond the 13 (decision 024, "rules beyond the 13 map events"; feature 5): `reopen` (B2B: revenue back to
  the merchant hold, kind `adjustment`), `reopenB2c` (revenue back to customer funds) and `refund` (B2B: revenue to the wallet, kind
  `refund`), all keeping the cost booked, with their own id type (`REVERSAL_EVENT_IDS`) so the map-parity test of the 13 stays
  exact; unit tests in `test/unit/modules/money/domain/order-reversals.spec.ts`. `OrderSettlements.liveOf(db, orderId)` finds the settlement of an order
  that no `reverse:<id>` transaction has reversed, so the orders module posts a reversal under that key.
- **Wallets.** `MerchantAccounts.open` opens `client_wallet` and `client_hold` with the merchant (resolution ip-1; user rule
  2 checked there and by the credit-limit route); `WalletService` serves the wallet view, the statement (JSON or CSV), manual
  adjustments (`adjust` event, ref type `account` since decision 064, reason in the memo, `APPROVAL_REQUIRED` when a staff member's credits to merchant
  wallets within 24 hours, or a single debit, exceed `wallet.adjust_approval_limit` (an Owner is not limited; the sum is read under the
  staff member's advisory lock, `infra/adjustment.repository.ts`), `CREDIT_LIMIT_EXCEEDED`, `IDEMPOTENCY_KEY_REUSED`) and the credit
  limit (a limit above that approval limit needs an Owner when it is a raise, decision 049). The part by which a staff member raises a
  credit limit, on the credit-limit route or at an invitation (`MerchantAccounts.open` with a `grant`), is recorded in
  `credit_limit_raises` and counts in the same 24-hour sum as their credit adjustments (`staffMerchantCreditSince`); a raise above the
  sum is `403 FORBIDDEN` for anyone but an Owner. The credit-limit route locks the merchant row first (`findMerchant` with
  `lockMerchant`), so a group move of the same merchant and the change wait for each other (user rule 2).
- **Ledger screens.** `LedgerReadService` lists journals (wire `refType` through `toWireRefType`: stored `account`, `client` and `customer` go out as
  `system`, resolutions money-1/6; numeric and text `q`, money-15) and accounts with their owners' names.
- **Reconciliation.** `ReconcileService.run` compares every stored balance with the sum of its entries in one repeatable-read
  snapshot, records a `job_runs` row of job `ledger_reconcile` (`RECONCILE_RUNNING` while one runs) and audits the run. It is
  synchronous (ANSWERS finance Q4) and never corrects anything.
- **Currencies.** `CurrencyService`: CRUD with `decimals` 0 to 4 and `isStale` for a non-base rate older than 24 h
  (money-13), and also while a refresh holds the rate (`rate_held_at`; a typed `rateToBase` ends the hold). Adding a currency, or
  changing a rate, markup or decimals, also needs `currencies:update` (decision 046). A typed rate more than `fx.max_refresh_move_percent`
  from the stored one, or from the provider's (a first rate too; when the provider offers one, asked before the transaction by anyone
  but an Owner), needs an Owner (`403 FORBIDDEN`, nothing stored; the comparison of the refresh, decision 049). `StorefrontMoney` offers only currencies whose rate is not
  held and not older than `fx.max_rate_age_hours` (decision 049); `byCode` (a locked session) still finds every row.
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
  A provider rate that moved more than `fx.max_refresh_move_percent` (default 20; the ratio of the larger rate to the smaller, so a fall
  counts like a rise) from the stored one is held: not stored, listed in `failed` ("Held: ..."; the message names both rates, the judged move and the bound), `rate_held_at` set the first time, the
  audit row's `after.held`; a refresh that held a rate is never `502`. The refresh reports a newly held currency once, after the commit
  (an error log line and `ErrorReporter`), whether the route or the job ran it; the job counts `held` in its run. Production refuses
  `openexchangerates` without `FX_API_KEY` at start (decision 049).
- **Tax rates** (stage 14, built ahead of feature 14b by the lead): `TaxRateService` lists, reads, adds and changes the
  windows of `tax_rates` (`/admin/tax-rates`, permissions `tax:read|create|update`): country two capital letters, rate 0 to
  100 with four decimals, `taxType` vat | gst | sales_tax | none, `validTo` after `validFrom` (exclusive end), and one window
  at a time per country and region (422 on `validFrom`; changes of one pair serialised by an advisory lock; a region is stored trimmed
  and in upper case, `normalizeTaxRegion`, so two spellings of one region are one pair). No delete
  (M163): a rate that stops applying gets an end. The seed loads the demo's 12 rates as the console's mock maps them.
- **Credit reads for the groups (feature 4a).** `MerchantWallets.idsWithCreditLimit(db)` lists the merchants whose credit limit is above zero (the
  catalog's `overdraftAllowed: false` guard). `findMerchant` takes `FOR SHARE` on the merchant's group row, so a credit limit
  change and a change of the group's overdraft flag never interleave.
- **Reports (feature 11).** `ReportService` (`application/report.service.ts`, SQL in `infra/report.repository.ts`, pure figures in
  `domain/report-figures.ts`) answers four read-only reports, never cached (decision 022), every amount a 4-decimal USD string, days are
  UTC days (no business time-zone setting exists yet) and every window ends at the injected clock (decision 031):
  `GET /admin/reports/profit` (completed orders by completion day, split `day` oldest first, `service`, `supplier` or `client` by profit;
  revenue is `orders.total_price`, for a storefront order less what its `refund` journals took back on `revenue` and the `chargeback`
  journals of disputes on the order's own payment on `customer_funds` and `chargeback_loss` (never below zero), cost `orders.total_cost`; key `0` is "No supplier" or "Storefront customers"; the dates used are echoed;
  default the 30 days ending today), `GET /admin/reports/wallet-exposure` (`client_wallet` balance, `client_hold` reserved, credit limit,
  `overdraftUsed = max(0, -balance)` not capped at the limit; totals over every merchant, the 50 largest wallets as rows),
  `GET /admin/reports/suppliers` (one row per supplier, idle ones too: orders, completed, rejected, spend, rejection rate, mean seconds from
  `coalesce(sent_at, created_at)` to completion, plus the extra figures `calls`, `errorCalls` and `timeoutCalls` from feature 6's
  `supplier_api_logs.outcome`) and `GET /admin/reports/top-clients` (spend of the non-rejected orders created in the last `days x 24 h`,
  profit of the completed ones, wallet balance; every account that ordered, whatever its rank, by door: see "One account type in the money module"). Permission `reports:read`.
  The reports that read more than once (exposure, suppliers, top merchants) run their queries in one read-only `REPEATABLE READ`
  transaction (`runInTransaction(..., { isolation: 'repeatable read', readOnly: true })`), so their parts describe one moment; the
  profit report is a single query.
- **Client statement PDF (feature 11).** `ClientStatementService` (`application/client-statement.service.ts`, reads in
  `infra/client-statement.repository.ts`, totals and layout in `domain/client-statement.ts`) answers
  `GET /admin/reports/client-statement/:clientId?from&to` (`reports:read` and `wallet:read`, decision 046) with `application/pdf` and
  `Content-Disposition: attachment; filename="statement-<clientId>-<from>-<to>.pdf"`, of the account's live wallet (decision 064): account header, period, opening balance, the
  wallet lines oldest first (date, `JRN-<id>`, kind, memo, debit, credit, balance after), totals, closing balance, credit limit and the
  invoices issued in the period, drawn by the platform's `PdfRenderer` (decision 030). Everything is read in one read-only
  `REPEATABLE READ` transaction, never cached, made on the spot and not stored. Days are UTC days, both included; the default period is the
  whole history (the day of the first wallet line to today). Lines are ordered by ledger entry id (the order `balance_after` follows)
  and the opening balance is the `balance_after` of the entry before the first line shown, so the closing balance is the wallet's. Without
  `from`, a history of more than 10,000 lines is cut to the most recent 10,000 and the period starts on the day of the first of them, and
  more than 10,000 invoices are cut to the newest 10,000. `404` for an unknown merchant; `422` on `from` for a reversed period, or for an
  explicit period of more than 10,000 lines or more than 10,000 invoices (never without `from`); every download writes an audit row (`exported statement of`, entity `merchant`). `originCheck`: same-origin or a console `Origin` (decision 045).
- **Commissions are retired (decision 062).** The map's `commission` event has no builder and nothing posts one; the journals it wrote
  stay in the ledger, with the account kind `commission_expense`, the kind `commission` and the reference type `accrual`, and every
  statement and journal view still reads them. `PostTransactionInput.allowBelowCreditLimit` stays: the merchant top-up chargeback
  clawback sets it.
- **Merchant machine surface (feature 7a).** `MerchantApiAccount` (`application/merchant-api-account.ts`) binds Dhru's
  `accountinfo` to the `DhruGateway`: `{ message: 'Your Accout Info', AccoutInfo: { credit, mail, currency } }` where `credit` is the
  available balance (balance plus credit limit, what an order may spend now; the same wallet view as the portal). Never cached (decision 022).
- **Seed.** `scripts/seed/money.ts` opens the accounts of every demo merchant and posts the demo's ledger history through
  `postTransaction`, skipping merchants the identity seed has not created.

- **Billing (feature 8).** 18 routes. Contracts `contracts/{gateways,invoices,payments,billing-portal,payment-webhook}.contracts.ts`; use cases
  `application/`: `PaymentGatewayService` (CRUD, secrets encrypted by `GatewayCredentialsVault`, audit `added|changed|removed payment method`, and `turned on|turned off payment method` when a change only moves the switch, the demo's phrases; only an Owner adds an automatic method, changes `isManual` or the driver of a method that is automatic before or after the change, or sets, replaces or removes a method's secrets, decision 046; the plain fields of an automatic method, and a `secondaryWebhookSecret: null` for a method without a second secret, keep the route's own permission), `InvoiceAdminService` (list, read, issue a manual invoice, audit `issued invoice for`),
  `PaymentReviewService` (list, read, approve, reject; audit `approved|rejected deposit of`) with `PaymentViews` (the wire around a page: merchant, group, wallet, gateway, reviewer, hints) and `PaymentCrediting` (the one place that credits a top-up),
  `MerchantBillingService` (the portal: payment methods, invoices, a new top-up invoice, the receipt), `PaymentWebhookService` and `PaymentWebhookVerifier` (the incoming confirmation), `InvoiceDocuments` (PDF) and `InvoiceOutbox` (`invoice.paid`).
  - **Limits (decision 049).** A receipt's file, or a copy with the same SHA-256, backs at most one pending or approved payment
    (`application/receipt-proofs.ts`, the partial unique index `payments_receipt_live_uq`; lock order the account row, the account's top-up lock `topup:<accountId>`,
    the invoice row, the receipt content lock); a merchant holds at most five live unpaid top-up invoices and five top-up receipts in review
    (`MERCHANT_OPEN_TOPUPS`, counted under `lockAccountTopUps`, the lock `topup:<accountId>`; the invoice is reserved before an automatic method's page is opened and
    voided when the gateway fails); a staff-issued invoice records `issued_by` and its issuer cannot approve its payment unless an Owner;
    what one staff member who is not an Owner credits by approving top-ups that merchants or customers made through a manual method
    within 24 hours (net of fees; `isTransferTopUp`, summed by `staffReceiptApprovalsSince` under the staff member's adjustment lock)
    is capped by `wallet.receipt_approval_limit` (default $10,000; `409 APPROVAL_REQUIRED` above it);
    card top-ups ask for 3-D Secure under `require3ds` (`asks3ds`, also used by shop card payments); an amount an automatic method
    cannot charge exactly (a card page takes two decimals at most) is `422` on `amount` (`not_chargeable`, `checkChargeableAmount`)
    before an invoice or a customer top-up is reserved or a page is asked for, while a manual method keeps the amount as typed.
  - **Receipts and bank references.** A transfer receipt (merchant and storefront routes) is a file its owner uploaded itself (area
    `files`, `UPLOAD_AREA`); a document the platform stored for that owner (an invoice PDF, a tax receipt) is `422` on `fileId`
    (`invalid`). A bank reference of a manual method is compared and stored in one form (`normalizeBankReference`: NFKC, digits of
    any script as ASCII digits, upper case, no white space, dashes and invisible (control, format and default-ignorable) characters; a row
    stored before is compared with its white space and `-` removed and in upper case, `findLiveBankReference`; staff search finds a
    reference typed in either form); a reference that still holds a character other than a printable ASCII one (U+0021 to U+007E) in that form is `422` on
    `reference` (`invalid`, `bankReferenceProblem`: as the bank printed it, in Latin letters and digits); a pending or approved payment
    of the gateway holds it and a rejected one releases it (the partial unique index `payments_gateway_txn_uq`, which keeps a
    gateway's own reference, on a payment without a receipt, unique whatever its status).
  - **Money rules.** A deposit posts the map event `deposit` (Dr `bank` for a manual gateway or `gateway_clearing` for an automatic one, Cr `client_wallet` net, Cr `fee_income` fee) with ref `payment`, key `deposit:payment:<id>`, memo
    `Deposit PAY-<id> (<method>)`. Lock order everywhere: the payment row, then its invoice, then the ledger accounts. Approve and reject re-check under the lock: not pending → `409 PAYMENT_ALREADY_REVIEWED`; an automatic gateway
    whose payment was not sent to review → `409 PAYMENT_AUTO_CREDIT_PENDING` (user rule 6). Reject voids a top-up invoice and leaves a staff-issued manual invoice open.
  - **Invoices.** `INV-<year>-<id padded to 4>` (a top-up invoice is written before an automatic gateway's checkout is opened, so the checkout carries its number; a failed checkout leaves the invoice void, decision 049), due in 14 days (setting `billing.invoice_due_days`), tax at the B2B VAT rate
    (setting `billing.b2b_vat_rate_percent`, default 0, a bad value reads as 0), base currency, `kind` manual or topup. A top-up invoice: `fee = amount × percent + fixed`, `net = amount − fee`, `total = amount`; a manual one: no fee, `total = net + tax`.
    The PDF (decision 030, the platform's `PdfRenderer`) is rendered after the commit of an issue and again after the payment, stored through `StoredFiles` as the merchant's file, and a failure only logs (the money never waits for a document).
  - **Drivers** (`infra/gateway-drivers/`): `payment_gateways.driver` names the code behind a gateway: `card` / `stripe` (Stripe Checkout protocol: form-encoded calls with a bearer key, webhooks `t=<unix>,v1=<hmac>` in `stripe-signature`, signed with
    the webhook secret) and `crypto` / `usdt` (a JSON invoice API; header `x-gsm-signature`; confirmed only at the required confirmations); `bank` and `wise` are manual (staff review the receipt). A driver verifies, reads an event, opens a checkout and
    asks the gateway about a payment (`checkStatus`, or the record `verifyPayment` reads for a card top-up, decision 048) for the job. API calls go through `OutboundHttp` (`target: gateway`, 10 s, SSRF guard); the gateway's API address is `config_enc.apiBase` (default of the card driver: `https://api.stripe.com`);
    tests provide `GATEWAY_HTTP_POLICY` to reach a local server.
  - **Webhook** `POST /webhooks/payments/:gateway`: the guard verifies the signature through the driver, the 5-minute window and the event-id replay filter; the handler records a confirmed payment of an open invoice of that gateway once (unique
    `(gateway_id, gateway_txn_id)`; two racing deliveries create one) as `pending`, `captured_at` = now, `auto_credit_at` = now + max(setting `payments.auto_credit_delay_minutes` (10), `hold_hours`); an amount or currency that differs from the invoice
    goes to review (`review_required`, the reason in `review_note`) and can never be credited: the row keeps the invoice's amount and fee, `PaymentCrediting` re-reads the stored gateway event (`raw`) with the driver and refuses
    a different amount or currency (and an event it can no longer read) with `409 CONFLICT`, for staff approval and for the job alike; staff reject it and adjust the wallet by hand. Decision 048: an event that does not state its currency or its amount is a mismatch too (review, never credited); a confirmation for an owned invoice of that gateway that is `paid` or `void` is recorded the same way for review (`closedInvoiceNote`: never credited, approval answers `409 CONFLICT`, a reject keeps the invoice as it is; the reason staff type when they reject it is mailed to the customer). Everything else is acknowledged with `200`.
  - **Automatic credit job** `payment_auto_credit` (queue `maintenance`, every minute; `docs/queues.md`): asks the gateway again, then credits, sends to staff or asks again later. Decision 048: a card top-up is judged on the gateway's record of the payment, read once with `verifyPayment` (the storefront capture's read, given the 10-second limit of any gateway call, `GATEWAY_CALL_TIMEOUT_MS`, instead of the webhook's 3 seconds): it credits only when the record says paid, names this invoice when it states a reference (`metadata[reference]`), shows nothing refunded or disputed since (`afterPayment`) and shows the invoice's amount and currency as received (`topUpRecordProblem`); any difference sends it to staff review with a note that names it, and a record that ended unpaid (`ended`) counts as no longer confirmed. Other automatic gateways keep `checkStatus`. Under the payment's lock, just before the credit, it asks `TopUpScreeningHooks` (a leaf list in `application/top-up-screening-hooks.ts`, module `TopUpScreeningModule`, exported from `index.ts`; money cannot import risk, decision 032): the risk services module registers `RiskScreening.reviewTopUp` at boot (the blocklist's card fingerprint and the merchant's email), and a flagged top-up gets `review_required=true`, `review_note` = the reason and `auto_credit_at=null` with the audit `sent deposit to review`, and posts nothing (money-3). The worker loads `RiskServicesModule` for this; a screen that throws fails that payment for the tick (it stays due). An empty hook list (a process without the risk module) sends every due top-up to staff review with `TOP_UP_SCREENING_UNAVAILABLE` as its note, and the worker logs one error at boot (decision 050).
  - **Group cleanup.** `PaymentGateways.dropGroup(tx, groupId)` (exported, global) takes a deleted merchant group out of `payment_gateways.allowed_group_ids`; the catalog's group delete calls it in its own transaction (a leaf file, `application/payment-gateways.ts`, so that it loads before the catalog import cycle, decision 032).
  - **Seed.** `scripts/seed/billing.ts`: the demo's 4 gateways (ids 1-4, codes card, crypto, bank, wise), its 54 top-ups with an invoice each (`PAY-1000` is payment 1000, invoice 1), linked to the deposit journals the money seed replayed, 3 manual invoices.
    No receipt files or PDFs (no objects to download).

Known deviations (tech debt, PROGRESS): `infra/report.repository.ts` reads `orders`, `clients`, `services`, `suppliers` and
`supplier_api_logs` with plain selects (no reader exists for these figures; nothing outside the file knows), and `infra/foreign-directory.repository.ts` reads merchant (name, email, country, group), group, supplier, customer
and staff names, and the fx rate of a storefront payment's checkout (`orders`, `checkout_sessions`), with plain selects because those modules export no directory yet; replace its bodies with their public
services as they appear (identity, catalog 4a, suppliers 6, customers 14b). Nothing outside that file knows.

- **Storefront money (feature 16).** 11 routes: the refunds (`GET /admin/refunds`, `/:id`, `POST .../approve|decline|retry`), the disputes (`GET /admin/disputes`, `/:id`, `POST .../evidence|accept`) and `POST /webhooks/disputes/:gateway`, and the two reports
  (`GET /admin/reports/vat|payments`). Contracts `contracts/{refunds,disputes,b2c-reports}.contracts.ts`; controllers `refunds|disputes|b2c-reports.controller.ts`. The paying itself is the customers module's (`POST /store/v1/checkout-sessions/:token/pay`) over
  `StorefrontPayments` (this module: opens the hosted page, records the capture) and the receipt over `OrderReceipts`.
  - **Paying.** `StorefrontPayments.start` writes one `pending` order payment per `Idempotency-Key` (unique per checkout, kept on the row with the request's fingerprint, gateway and return address, in its own column `request_fingerprint`, migration 0012: capture, failure and review overwrite `raw`, so a replay after them still matches and answers the stored page with the payment's current status, `captured` included), asks the gateway's driver for a hosted page (the payment's reference `PAY-<id>` is the gateway's `client_reference_id` and its idempotency key) and stores the address;
    a gateway that refuses marks the payment `failed` and frees the key; a call that died before the gateway answered (page still empty after 60 s), or whose payment was written off meanwhile, frees the key on the next call and starts over, and a call that comes back after its payment failed never hands out its page (`409 INVALID_TRANSITION`). The signed confirmation (`POST /webhooks/payments/:gateway`, a reference that starts with `PAY-`) goes to `StorefrontCaptures`, filled by the customers module at boot (`CheckoutCaptureService`): in the
    webhook's transaction the order is placed (`CustomerOrderPlacement`), `recordCapture` books `b2c_pay` (key `payment:<id>:capture`) and `b2c_fee` (key `payment:<id>:fee`) in the session's locked USD with ref `order`, stores the brand line, 3-D Secure flag and card fingerprint the driver read and
    issues the paid tax receipt (`invoices.kind = 'receipt'`; its gross and total are the payment's own amount and currency, what the card was charged); a second payment confirmed for a paid checkout is booked and refunded in full and issues no receipt of its own (an order has one paid receipt). Decision 048: before the capture's transaction the webhook reads the gateway's own record of the payment (`verifyPayment`: the card driver's PaymentIntent with its latest Charge, or the Checkout Session; the crypto driver's invoice; 3-second timeout); a record that cannot be read answers `502 GATEWAY_ERROR` (the replay mark is released, the gateway delivers again) until the confirmation is 24 hours old (its own `created`, else when the payment opened), then the payment is held. The capture holds the payment (see "Held storefront payments" below) when the record names another checkout (`metadata[reference]` / `client_reference_id`; checked before anything else, nothing is sent back and the reference is not kept), it has no checkout, the record does not say paid, the record or the event states another amount or currency or none, or another payment has its gateway reference. A payment made more than 30 minutes after the checkout's price lock ended (judged on the charge time, else the event's time, else when the payment opened) is not used at the old price: its order is placed held with the review reason "Paid N minutes after the checkout's price lock ended" and refunded at once like a blocked payment when the gateway can refund (`order.failed`, no `order.received`), else it waits in the risk queue. A confirmation is money received: it captures a `pending` payment and also a `failed` one (a crypto checkout that expired and was paid late); a failure event never marks a held payment failed. `/pay` (decision 048): the return address must be on a shop origin (`not_shop`), an amount the card method cannot charge exactly is refused (`not_chargeable` on `gateway`), a checkout keeps at most 3 live pages (pending, not held; counted under the advisory lock `pay-session:<id>` taken after the key's try-lock; a fourth is `429 RATE_LIMITED`, `Retry-After: 60`), the card page closes 30 minutes after the price lock (`expires_at`, never sooner than 31 minutes after it opened) and carries the payment's reference in `payment_intent_data[metadata][reference]`, and a checkout address that is not https is `502 GATEWAY_ERROR` (the payment fails, its key is freed). The receipt PDF is drawn once by the `receipt.render` job (`ReceiptRenderProcessor` on the `files` queue, `OrderReceipts.render`), queued by the capture through `ReceiptOutbox` in the same transaction so the gateway's webhook never waits for the render or the upload, and stored in `files` (`invoices.pdf_file_id`); it names the account's stored name and address only when the account itself opened the checkout signed in, else the address the checkout was opened with and no stored name (`ReceiptBuyerPorts`, filled by the customers module); every download serves those stored bytes, and a copy that is missing (the job has not run yet, or storage was down for every attempt) is made by the first download under the invoice's row lock (`503 UNAVAILABLE` while storage is down). A failed payment (`payment.failed`) and the capture (`order.received`) write the customer's email in their own transaction (see Customer emails below).
  - **Refunds.** Lock order: the order, then the payment, then the refund, then the ledger accounts (a rejection takes the order first through its guarded update, so an approval takes it first too: `lockOrderForRefund`, `FOR NO KEY UPDATE`). Approving checks the amount against what is left on the payment (`REFUND_NOT_PENDING`, `VALIDATION_FAILED` on `amount`), posts the one `b2c_refund` journal (key `refund:<id>`; from `revenue` after delivery, from `customer_funds` before it, the VAT share rounded to cents,
    the refund that takes all that is left takes exactly the USD and VAT left), cancels an undelivered order through the state machine (`refundApproved`, via the `StorefrontOrderPorts` slot orders fills at boot) and either completes a hand payout (crypto, a gateway that cannot refund) or writes the `refund.process` outbox row.
    **Lost sends (decision 055):** `RefundReconcilePass` (kind `refunds`, in `RefundProcessModule`) watches refunds `processing`, paid back to the original payment, with no gateway reference and unchanged for 10 minutes; when their `refund.process` job is gone it writes a new event (`RefundOutbox.refundAgain`, `reconcile: true`), at most three times. Then, or once the current send started more than 20 hours ago (the gateway keeps an idempotency key 24 hours), the refund is failed with `REFUND_SEND_LOST_NOTE` as a failure whose outcome is unknown: the key is kept, so the console's retry sends under the same key, and the start of the send counts as an unanswered send (below). A refund whose gateway refund id is stored by the time the give-up holds its lock (the job was still running and the gateway answered it) is left as it is (`RefundOutcome.lost`): the gateway's answer settles it.
    `RefundSender` (worker) calls the gateway with the key `refund-<id>` (`refunds.send_attempt`, migration 0014: `refund-<id>-<n>` after the gateway refused the refund for good, because the same key would only replay the refusal; a timeout or a 5xx leaves the key, so a refund the gateway may already have made is not made twice, and records the start of that send in `refunds.unanswered_send_at` on every attempt (cleared when the key moves on): the gateway remembers a key 24 hours, so 20 hours after it neither the retry (`409 REFUND_NOT_FAILED`, check the payment at the gateway) nor the job (`UNANSWERED_SEND_NOTE`) sends under that key again (`resendNeedsGatewayCheck`, `REFUND_RESEND_WINDOW_MS`); a 4xx other than 408, 409, 425 and 429 is a `GatewayRefusalError`, which fails the refund at once and ends the job with an `UnrecoverableError`); the gateway's answer or its signed `refund.updated` (final status) / `refund.failed` event settles it once (`RefundSettlement`; the call puts the refund id and the send attempt in the gateway refund's metadata, and a `refund.failed` of an earlier attempt than `refunds.send_attempt` is ignored under the refund's lock, so a late or repeated failure of the first gateway refund cannot fail the retry that replaced it and move the key on again); the payment becomes `partial_refund` or `refunded`. The settlement locks the payment, then the refund. The gateway's success for the current send attempt of a refund that failed without a definite answer completes it (money moved); any other success for a refund that is not `processing` is logged as an error and changes nothing. The gateway's refusal for good of that same send moves the key on instead (`recordRefusalOfFailedRefund`: the refund stays `failed`, the gateway's text is added to its note), so a later success of that send is stale and the retry sends under the new key. A retry posts nothing (B83) and clears the gateway refund id of the failed send. Approving when nothing is left answers `Nothing is left to refund on this payment.` A `failed` refund keeps its posted reversal, so it still counts against what can go back (`takenRefundsOfPayment`): the way out of a failure is the retry, never a second approval. `B2cRefunds.onOrderRefund` is also what the order
    engine calls when it rejects a paid order (a staff reject, a supplier rejection): the payment is the one the approved refund names, or else the one linked to the order's first receipt invoice (a duplicate payment, booked and refunded at once, is never the order's payment), and the whole of what is left goes back and a `processing` refund records it. That is for a rejection a person decides; one the system decides (a supplier's rejection) follows the storefront policy `autoRefundFailed` (read by the orders module's `OrderLedger` through `StorefrontPolicies`, default on): off, `onOrderRefund` runs in `request` mode and opens a refund `requested` by the system (no journal, no job, the order is `rejected` and its money stays in customer funds), and approving that request posts the journal from customer funds (`B2cRefunds.postRejected`) instead of cancelling an order that is already rejected.
  - **Disputes.** `DisputeWebhookService` (created, won, lost; the unique `(payment_id, gateway_dispute_id)` makes a repeat harmless; event types it does not use are acknowledged with 200; the card driver reads a card network inquiry (a status that starts with `warning_`) as no event, and an update of a dispute that is open at the gateway (`charge.dispute.updated` or `charge.dispute.funds_withdrawn`, `needs_response` or `under_review`) as `created`, so an inquiry the network turns into a dispute is recorded then; decision 048: an event that names a payment not recorded yet, a payment held for staff, or a dispute whose opening was not recorded yet answers `503 UNAVAILABLE` while it is younger than 24 hours, then it is acknowledged, logged at error level and reported (a held payment's note records it); a `won` after staff accepted the loss changes nothing and is logged; a delivery whose transaction the database ended as a deadlock or a serialization failure writes nothing and answers `503 UNAVAILABLE`, so the gateway delivers it again and the replay mark is freed) and `DisputeService` (the evidence pack of six lines built by `domain/dispute-rules.ts`, the submission to the gateway and a stored PDF, the accept).
    `DisputeLedger` is the one place a loss posts `b2c_chargeback` (key `dispute:<id>:chargeback`, kept in `disputes.ledger_tx_id`), whether the accept or the gateway's `lost` comes first; for an order that was never delivered (`rejected`) the journal gives back the disputed share of what the sale booked as customer funds and VAT (`chargebackReturn` in `domain/dispute-rules.ts`, never more than the refunds that went out left), and only the rest and the dispute fee go to `chargeback_loss` (the VAT report subtracts that VAT, the payments report's loss reads the `chargeback_loss` line, less the give-back journals of orders rejected after a loss); a later loss of a rejected order also counts what its rejection gave back; a win posts nothing and returns the payment to the status its completed refunds leave, unless another dispute of the payment is lost (`chargeback`) or still open (`disputed`) (`paymentStatusAfterDispute`). Decision 048: when a loss books the chargeback, `B2cRefunds.closeNotSent` first closes every refund of the payment the gateway has not paid (`requested`, `processing` without a gateway id, `failed`) as `rejected` with the note "Not sent: the payment was charged back." (`CHARGEBACK_NOT_SENT_NOTE`; `closesAtChargeback` picks them from an unlocked read, and only those are locked, in id order, each checked again and changed by a guarded update under its lock; the refund settlement takes the same order, the payment and then the refund, and closes the same way, with its journal reversed, a refund whose failure arrives after the chargeback (`B2cRefunds.closeUnsent`)) and reverses its journal in the same transaction (the mirrored lines of `reversalLines`, same kind and reference, key `reverse:<journal id>`); each closed refund gets a timeline line. A completed refund stays, and so does one the gateway acknowledged and has not answered. The alert to staff about the deadline (12a) and the blocklist
    entries a chargeback may add (feature 18, RESOLUTIONS b2c-5) plug in right after the stored dispute / the lost step in `DisputeWebhookService` and `DisputeLedger.lose`.
  - **Reports.** `GET /admin/reports/vat` adds up the signed `vat_payable` lines (and, as the taxable amount, the `customer_funds` and `revenue` lines) of the storefront `b2c_payment`, `refund` and `chargeback` journals by tax country and the month each was booked, so a month already reported never changes (decision 048: a refund journal reversed later, key `reverse:<journal id>`, stays in its month and the reversal counts in its own); `GET /admin/reports/payments` the order payments with money received, per method, with the USD figures taken from the books (the session's locked gross, the fee, refund and chargeback journals).
  - **Customer emails.** `StorefrontMails` (`StorefrontMailsModule`, imported by the money admin module, the order engine and the checkout) writes the storefront customer's emails with `NotificationService.enqueue` in the transaction of the change: `order.received` (the capture; `order.completed` too when stock delivered the order at once), `order.completed` and `order.failed` (every order transition that delivers, or rejects and refunds, a storefront order; for a rejection that only opened a refund request, when staff approve it), `payment.failed` (the gateway's failure event for a pending payment) and `refund.declined` (`RefundService.decline`). The address is the customer's (`customers.email`; mails are English, decision 039); `customerName` is `there` for a guest; `device` is empty until the catalog exports a TAC reader. `order.received`, `order.completed`, `order.failed`, `payment.failed` and `refund.declined` all have a default English template in migration 0015 (the demo's texts without the receipt sentence: no mail carries a file); staff edit them in Settings, and a template switched off sends nothing. The development seed only sets the demo's on/off switch on them (the payment failed mail is off).
  - **Deviation.** `infra/b2c-reads.repository.ts` reads `orders`, `checkout_sessions`, `consent_records`, `legal_documents` and `support_tickets` with plain selects (the owners export no such reads and orders imports money: decision 032); nothing outside that file knows.
  - **Seed.** `scripts/seed/b2c.ts` (see the storefront money seed test): the storefront orders, sessions, payments, receipts, refunds and disputes of the demo, linked to the journals the money seed replayed.
- **Held storefront payments (decision 048).** A confirmation that cannot pay its checkout is held: the payment is `pending` with
  `review_required`, the reason in `review_note`, the event in `raw` and the gateway reference (unless another payment has it, or the
  gateway's record names another checkout); no order, no journal. When money arrived (another amount or currency, no stated amount, no
  checkout: not a "not paid", "could not be asked" or reference hold, and never when the record names another checkout, whose money it is), the gateway can refund it (`B2cRefunds.sendsBack`: card or wallet, a
  gateway with refunds and a driver that refunds) and its record states what it collected, the whole of it goes back at once
  (`B2cRefunds.openReturn`): a refund without an order (`order_id` null, `account_id` the payment's account, `processing`, requested by the system, reason
  "Sent back automatically: ...") and its `refund.process` job; the note ends "Sent back in full automatically (RF-<id>)." A payment with
  a refund never pays its checkout. A record whose latest charge was refunded in full or in part, or is disputed (`afterPayment`), is
  held with `aftermathNote` and nothing is sent back. The hold stores, with the event in `raw` (`gsmHold.moneyReceived`,
  `withHoldMark` / `holdMarkOf` in `domain/b2c-money.ts`), whether the gateway's record showed money received for this payment (another
  amount or currency, no checkout, money refunded or disputed since; not for a "not paid", "could not be asked", reference or
  another-checkout hold); once set it stays set. Until its money is back (a refund `processing` or `completed`) a held payment is a finding of the
  integrity check "Every confirmed payment has an entry" (health). Staff close one with `POST /admin/held-payments/:id/close`
  (`refunds:approve`, `HeldPaymentsService`): `returned` records a `completed` hand refund without an order (`manual`, the staff's note),
  `not_received` makes the payment `failed` (a later real confirmation can still capture) and is `409 CONFLICT` when the mark says money
  was received (a payment held before the mark accepts both); audit `closed held payment` (entity
  `payment`). A return without an order that the gateway fails after it completed (`refund.failed` on a completed refund,
  `RefundSettlement`) is `failed` again (`failLateReturn`), so its payment is a finding again; its `send_attempt` moves on, as for any refusal for good, so a later success of that gateway refund changes nothing. The held payment and the gateway's fee on it are never booked. The webhook logs every hold at error level and reports it to
  the error reporter. Order-engine refunds of a disputed payment (staff reject, supplier rejection, risk refund) open a
  refund request instead of paying out (`RefundPosting.disputed`, a timeline line says why); once the payment is charged back they open
  nothing (no request could ever be approved) and post the give-back part of `b2c_chargeback` instead (`returnAfterChargeback` in
  `application/chargeback-return.ts`: Dr customer_funds, Dr vat_payable / Cr chargeback_loss, the disputed share of what the refunds left as
  `chargebackReturn` works it out, less what the payment's chargeback journals gave back; key `order:<id>:chargeback-return`, so once per
  order; `RefundPosting.chargedBack`); `RefundSender` does not send a refund whose
  payment is disputed at send time (it fails without a gateway call and keeps its key, so staff retry it after the dispute); one whose payment is charged back is closed unsent instead. A refund the gateway already accepted (its id is stored) is skipped by the job on such a payment, and after a chargeback only the gateway's refusal of it closes it: the gateway may still pay it. The loss gave nothing back while that refund's journal was in place, so when the refusal closes a refund of an order that was never delivered (`rejected`), the settlement books the same give-back in its transaction (`B2cRefunds.returnAfterLateClose`, under the same key); a delivered order keeps the plain loss.
- **Customer wallet (feature 21, plan `docs/briefs/21-customer-wallet.md`; the owner is the account since decision 064, see above).** A USD store balance per account of the retail rank:
  ledger kind `customer_wallet` (liability, owner (`account`, id), opened by its first posting or freeze), freeze state on the account row
  (`frozen_at`, `frozen_reason`), no hold, no overdraft, closed loop. Five events beyond the map's 13 (`domain/customer-wallet-events.ts`,
  kinds `deposit`, `b2c_payment`, `refund`, `adjustment`, `chargeback`): `customerTopup` (key `deposit:payment:<id>`), `b2cWalletPay`
  (Dr wallet / Cr customer funds / Cr VAT, key `payment:<id>:capture`), `b2cWalletRefund` (keys `order:<id>:refund` or `refund:<id>`),
  `customerAdjust` (stored ref type `account`, sent as `system`; key `adjust:<accountId>:<Idempotency-Key>`, the earlier `adjust:customer:<oldId>:<key>` is still found; the staff routes are `/admin/clients/:id/wallet*` now) and
  `topupChargeback` (customers and merchants; key `dispute:<id>:chargeback`, ref `dispute`; `clawbackSplit` takes the fee pro rata).
  `postTransaction` refuses a `customer_wallet` debit below zero (`INSUFFICIENT_FUNDS`) unless `allowNegativeCustomerWallet` (the clawback
  only) and reports each account's `frozen` read under its lock; the deferred trigger `ledger_accounts_negative_customer_wallet_frozen`
  refuses a commit that leaves a customer wallet below zero and not frozen. Lock order: a transaction that posts never locks a wallet row
  before the posting; a freeze after a posting reuses its lock. Services: `CustomerWallets` (views, statement with staff reasons masked
  for the customer, list, adjust with approval limit and replay check, freeze/unfreeze, the anonymize guard and the export part; the
  approval limit `wallet.customer.adjust_approval_limit` caps a staff member's credits to customer balances over 24 hours and any single
  debit, an Owner is not limited, decision 049),
  `CustomerTopUps` (create under the account's `topup:<accountId>` lock with SQL velocity limits, receipt, cancel), `CustomerWalletPayments` (records a
  balance payment inside the customers module's checkout transaction: `payments.method_type 'balance'`, no gateway, one per checkout),
  `CustomerWalletMails` (five customer events). Refunds of a balance payment go back to the balance and complete at once
  (`settlesAtOnce`, no `refund.process` job); `ledgerPartsOf`, the VAT report and `REFUND_USD` read the `customer_wallet` line as the gross.
  Top-up disputes (`DisputeWebhookService` top-up branch, `DisputeLedger.loseTopUp`/`winTopUp`): `created` records the dispute without an
  order and freezes the live wallet of the account, of either kind (a pending top-up is sent to review so the automatic credit skips it); `lost` claws the credit back from the live wallet
  (the payment stays `approved`; a never-credited one is rejected and its invoice voided); `won` leaves the hold for staff. They show on
  the deposit (`GET /admin/payments*` field `dispute`) and the Wallet tab, never in `/admin/disputes*`. Eight settings
  `wallet.customer.*` (master switch and card top-ups off by default). Audit: `adjusted wallet of`, `repeated wallet adjustment of`,
  `froze wallet of`, `unfroze wallet of` (entity `account` since decision 064; a replayed key writes `repeated wallet freeze of`, `repeated wallet
  unfreeze of` or `repeated credit limit change of`), `charged back deposit of` (entity `payment`). No new queue, job or cache key.
- **Payment provider fixes (feature 24C, plan `docs/briefs/24C-payment-fixes.md`).** No new route, table or migration.
  - **Amounts.** The Stripe protocol counts in each currency's minor unit (`infra/gateway-drivers/stripe-amounts.ts`, from
    docs.stripe.com/currencies), both ways: checkouts and refunds send `toMinor` (rounded half up to what the gateway can charge, never
    truncated; a rounded amount is logged), events are read with `fromMinor` and the event's currency.

    | Currencies | Digits | 10 units on the wire | Step charged |
    |---|---|---|---|
    | BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF | 0 | `10` | 1 |
    | BHD JOD KWD OMR TND | 3 | `10000` | 0.010 (last digit 0) |
    | ISK UGX | 2 (always `00`) | `1000` | 1 |
    | every other currency | 2 | `1000` | 0.01 |

    The mismatch guards stay exact: a charge the gateway had to round is held for staff. Decision 048: while an active automatic storefront
    card method exists, a currency's decimals may not exceed what it charges exactly (`chargeableDecimals`: 0 for the zero-decimal and
    whole-unit currencies, 2 for every other; `422` on `decimals`, code `not_chargeable`, on create and when `decimals` is sent or
    `isStorefront` or `isActive` is switched on), and `/pay` refuses an amount with more significant decimals than that.
  - **Refund results.** Stripe sends no `refund.succeeded`: a refund completes on `refund.updated` (or the older `charge.refund.updated`)
    with `status` `succeeded`, fails on `refund.failed` or a `failed`/`canceled` status; `pending`/`requires_action`, `refund.created` and
    `charge.refunded` change nothing. A failure of a refund that already completed (Stripe's late failure) is appended once to the refund's
    note ("… failed after it was completed … Refund the customer another way.") and logged as an error; nothing is reversed automatically.
  - **Card details.** The checkout event has no card: before any transaction the webhook reads `GET /v1/payment_intents/<pi>?expand[]=latest_charge`
    (3-second timeout, the gateway HTTP policy) and takes brand (or the wallet name: Apple Pay and Google Pay become `wallet`), last 4,
    fingerprint, 3-D Secure (`authenticated` or `attempt_acknowledged`), the issuing country (two upper-case letters) and the funding (`credit`,
    `debit`, `prepaid`, `unknown`; the screening's evidence for the IP-country rule, the tax-country check, the country blocklist and the
    prepaid-card signal, decision 050) from the Charge's `payment_method_details.card`; a value the gateway writes in another form is read as
    absent. A read that
    fails never stops the payment: a storefront payment gets the risk signal "Card details unavailable from the gateway" (10 points, never
    a hold by itself), a card top-up waits for staff review ("Card details could not be read from the gateway."); the counter
    `gateway_card_details_unavailable_total{gateway}` counts them. Decision 048: a storefront payment's card details come from the gateway
    check (`verifyPayment`, the same read); a read that fails is then a `502` (see Paying), so the fail-open read and the counter concern
    card top-ups only.
  - **Webhook setup.** Register one endpoint at the provider, `/webhooks/payments/<code>`, with every event (checkout, refund and
    dispute events): the payments endpoint also handles dispute events (the dispute handler is idempotent per gateway dispute id, so the
    same dispute sent to `/webhooks/disputes/<code>` too is recorded once). A gateway keeps up to two webhook signing secrets in
    `webhook_secret_enc` (a JSON list; a legacy plain secret reads as one) and a delivery passes when either verifies. Admin wire:
    `webhookSecretHint`, `secondaryWebhookSecretHint` (hints), write-only `webhookSecret` (replaces the first, keeps the second) and
    `secondaryWebhookSecret` (`null` removes it; `422` without a first). Rotation: save the new secret as the second, roll the secret at
    the provider, save it as the first, then remove the second.
  - **Crypto driver.** Stays off: it needs an `apiBase` no admin field sets, speaks a custom protocol, and the licence question is open
    (ROADMAP). Not changed.
- **Ready-made payment methods with logos (feature 32, decision 041, spec B232).** A catalog of eight methods lives in code
  (`domain/gateway-presets.ts`: `GATEWAY_PRESETS`, `presetOf`, `presetProblems`): bank transfer, crypto transfer, Vodafone Cash, Fawry,
  InstaPay and Binance Pay (manual, available) and NOWPayments and Binance Pay (automatic) as *not available* (coming soon). Each entry has a
  key, a name, its kind, the driver name, the top-up method it stands for (`bank` or `usdt`; `METHOD_BY_NAME` in `gateway-rules.ts` reads the four
  `usdt` drivers) and a template of the transfer details with blanks. Nothing is inserted by a migration: every environment starts with no method.
  - **Data** (migration `0040_payment_method_presets`): `payment_gateways.preset` (CHECK `payment_gateways_preset_check` over `GATEWAY_PRESET_KEYS`, null for a
    custom method) and `payment_gateways.logo_file_id` (a public picture, `ON DELETE SET NULL`, indexed). `POST /admin/payment-gateways` takes an
    optional `preset`: an unknown key is `422` on `preset` (`unknown`), an entry that is not available is `422` on `preset` (`unavailable`), `isManual`
    other than the entry's kind is `422` on `isManual` (`preset_kind`), a `driver` other than the entry's is `422` on `driver` (`preset_driver`). Several
    methods may come from one preset; `PATCH` never changes it (the key is stripped) and keeps its promise: the merged `isManual` and `driver` of a preset-made method must still be the entry's (`422` `preset_kind` / `preset_driver`; no `unknown` or `unavailable` check, an existing row stays editable).
  - **The code is made by the server (decision 077).** `code` is optional on `POST /admin/payment-gateways`. Sent, it is judged as before (format, `422` on
    `code` when taken). Left out, the create makes it in its own transaction: the preset's key for a method made from a preset, else the name as an
    identifier (`madeGatewayCode` in `domain/gateway-rules.ts`, on `identifierFrom` of `src/common/identifier.ts`: lower case, accents dropped, each run
    of other characters one `_`, cut to 40, `method` when nothing is left), then `_2`, `_3`, ... while another method holds it. The loop is
    `firstFreeIdentifier` with `insertGatewayIfCodeFree` (`ON CONFLICT (code) DO NOTHING`), so two creates at once never share a code and a made code is
    never refused as taken. The row, the answer and the audit row carry the final code; it is still the webhook address and `PATCH` still cannot change it.
  - **Routes beyond the map** (`scripts/map-additions/32.mjs`, `payments:gateways`): `GET /admin/payment-gateway-presets` (the catalog, a plain array),
    `POST /admin/payment-gateways/:id/logo` (multipart part `file`; `PublicImages.store`: a clean JPEG, PNG or WebP of at most 2 MiB and 64 to 4096 pixels on each side, stored once under
    its SHA-256 as the listing picture is; the `422` codes on `file`, `413`, `415`; `/admin/payment-gateways/:id/logo` is in `MULTIPART_ROUTES`) and
    `DELETE /admin/payment-gateways/:id/logo` (`204` also when there was none). Audit `uploaded logo for` and `removed logo of`, entity `payment_gateway`.
  - **Wire.** The gateway row of the five admin routes, `PaymentMethodSchema` (`GET /client/payment-methods`, `GET /store/v1/me/wallet/top-up-methods`) and the
    items of `paymentMethods` (`GET /store/v1/config`, a checkout session) answer `preset` (the key or `null`) and `logoUrl` (`/store/v1/media/<name>` or
    `null`). A reader shows `logoUrl`, else the bundled logo of `preset`, else an icon. `StorefrontMoney` takes `PublicImages` as an optional dependency
    (it lives in the global module that a database-less test app loads without the files module).
  - **Money rules do not change.** A method made from a preset is an ordinary gateway row: the ledger, fees, limits, crediting, the review of a top-up, the
    webhook and the checkout are untouched. A manual method tops up a merchant wallet or a store balance through the existing review (the payment's
    `method_type` is `bank` or `usdt` as `topupMethodOf` reads from the driver); a shop order is still paid by an automatic gateway with a driver or from the store
    balance. None of the eight driver names has code behind it (`driverFor` answers `undefined`), so a later feature adds each automatic driver and flips `available`.

### An account's address in staff answers (decision 047)

The staff answers of this module show an account's address masked (`ja•••@example.com`, `customerEmailIn` of
`src/common/customer-contact.ts`) unless the caller holds `clients:read` (the one contact permission for every rank since decision 064); identity's `customerContactOf(caller)` decides it and each controller passes the
`contact` down. Rule A, the address fields: payments (list, single read and the answers of approve and reject; `PaymentViews.build(db, rows, contact)`), invoices
(list, single read and issue), and the customer wallets list. Their searches follow it: `q` of payments and wallets matches a customer's name only
(`findCustomerIdsByNameOrEmail(db, pattern, matchEmail)`), and refunds and disputes drop `customer.email` from the search fields (`withoutSearchFields`). Rule B, a
name never falls back to the full address (for every caller): refunds, disputes and the storefront payments report label a customer without a name by the masked address
(`customerNameForStaff`). The evidence pack that staff read (`DisputeViews.pack(db, dispute)`, masked by default) writes the masked address into its delivery line;
`DisputeService.submitEvidence` builds the pack with `'full'`, so the text sent to the card gateway (and the stored evidence PDF) names the buyer in full, as before.
`PaymentReviewService.approve` and `reject` and `InvoiceAdminService.issue` take the staff member first (decision 049) and work out the `contact` of their answer
from it (`customerContactOf(caller)`); they take no `contact` parameter.

## Public API (`index.ts`)

`MoneyModule` (global: `MerchantAccounts`, `LedgerPoster`, `MerchantWallets`, `OrderSettlements`, `PaymentGateways`, `StorefrontMoney`; it also provides `RankChangeGuards` in the API process and registers the guest-claim participant `money` and the wallet balance fragment of the account list), `AccountWalletsModule` (global; both processes load it through `MoneyModule` and `MoneyOutboxModule`: binds the port `AccountWallets`), the seams `AccountWallets`, `WalletErasure` and `RankChangeGuards` (with the types `AccountWalletKind`, `AccountWalletView`, `RankBlockerCode`, `RankChangeCheck`), `walletKindOfRank`, `lockAccountTopUps`, the owner helpers `ACCOUNT_OWNER_TYPE`, `walletAccountOf`, `holdAccountOf`, `storeWalletAccountOf`, `liveWalletFigures`, the refund postings `b2cWalletRefundPosting` and `holdOrderRefundPosting`, `GUEST_CLAIM_MONEY_NAME` and `moveGuestClaimMoney` (last line of the barrel), `MoneyOutboxModule`, `PaymentAutoCreditModule` (worker), `FxRefreshJobModule` (worker), `INVOICE_PAID_EVENT`, `GATEWAY_HTTP_POLICY`, `topupMethodOf`, `postTransaction`, the 12 money event builders that can still be posted and their ids, the reversal builders `reopen`, `reopenB2c` and `refund`,
the account helpers (`walletViewOf`, `balanceDelta`, `normalSideOf`, `toDebitPositive`, `BASE_CURRENCY`), the ledger line
helpers, the wire ref types (`toWireRefType`, `storedRefTypesOf`) and the stale-rate rule `isRateStale` (the System health dashboard's `fx_stale` item reads it, so it agrees with the currencies page). `StorefrontPayments`, `OrderReceipts`, `B2cRefunds` (what the order engine calls to reverse a refunded storefront order), `orderPaymentStatus` (the status of the payment that paid a storefront order: the order engine does not release or send an order whose payment is disputed, charged back or refunded in full), `StorefrontCaptures` and `StorefrontOrderPorts` (the slots the customers and orders modules fill at boot, decision 032), `RefundProcessModule` and `RefundSender` (worker), `REFUND_PROCESS_EVENT`/`RefundOutbox`, and the pure helpers `brandLine`, `paymentFacts`, `storefrontMismatch`. `StorefrontMoney` (feature 14a, read only, takes the caller's
database handle): `currencies` / `offered` / `defaultCurrency` / `byCode` (the currencies the shop offers, `is_storefront` and
`is_active`), `taxInForce(db, country, at, region?)` and `taxRatesInForce(db, at)` (the tax window whose `valid_from` is at most the
moment and whose `valid_to` is empty or after it; a regional window wins over the national one; the region compares trimmed and in upper
case), `taxRegionAccepted(db, country, region, at)` (false while the country has a regional window in force and the region has none: the
checkout's refusal on `region`), `paymentMethods` (active gateways
for the B2C or both audiences: code, name, 3DS support, `preset`, `logoUrl`). `WalletService` is exported by `MoneyAdminModule`
(the routes and the services that read the database; a database-less test app leaves it out). Other modules import only
`src/modules/money/index.ts` (lint rule `gsm/module-boundaries`).

The reference data of a working system (P4b, `domain/reference-data.ts`): `BASE_CURRENCY_DEFINITION` (USD, rate 1, no markup, shown on the
storefront, two decimals), `SYSTEM_LEDGER_ACCOUNT_KINDS` (the 12 system accounts of decision 024), `PER_OWNER_ACCOUNT_KINDS` and
`systemLedgerAccountRows()`. `bun run setup` (first run on a server) and the development seed both build their rows from them, so a fresh
production database and a seeded one hold the same currency and accounts (README "First run on a server").

## Owned tables

Only this module reads and writes these 14 tables (`scripts/module-map.mjs`, `credit_limit_raises`, `account_rank_changes` and `wallet_action_keys` among its additions); other modules call its public service. Schema: `db/schema.ts`.

| Table | What it holds |
|---|---|
| `currencies` | Currencies and exchange rates, with a markup and psychological (charm) rounding for the storefront display; `rate_held_at` marks a rate a refresh held (decision 049). |
| `ledger_accounts` | Accounts: wallet, hold, revenue, customer funds and tax payable. The owner of a wallet or hold is (`account`, id) (decision 064); a freeze is allowed on `client_wallet` and `customer_wallet`. |
| `ledger_transactions` | The journal entry header, with an idempotency key. |
| `ledger_entries` | Journal entry lines; they always sum to zero. |
| `invoices` | Top-up invoices and statements, and B2C tax receipts with a PDF copy; `issued_by` names the staff member who issued a manual invoice (decision 049); `account_id` names the account and `wallet_kind` the wallet a top-up or manual invoice fills (decision 064). |
| `payment_gateways` | Payment gateways with their fees and limits, split by audience (B2B or B2C). |
| `payments` | Payments and their confirmation: a wallet top-up or a B2C order payment. |
| `withdrawal_requests` | Withdrawal requests, for a later phase. |
| `refunds` | Refunds: full or partial, to the card, the wallet or store credit; `account_id` is the payment's account (null only when there is no payment). |
| `disputes` | Chargeback disputes: the deadline, the evidence pack and the outcome. |
| `tax_rates` | Tax rates per country for digital services, including the OSS scheme. |
| `credit_limit_raises` | The record of credit-limit raises, read for a staff member's 24-hour sum (decision 049). |
| `account_rank_changes` | The rank history of an account (append-only; decision 064): both ranks' ids, names and kinds as snapshots with no foreign key on the two rank ids, the moved amount, the ledger transaction, the counts of sessions ended and keys revoked, the key and the staff member; unique on the account and the key. |
| `wallet_action_keys` | The idempotency keys of staff freeze, unfreeze and credit-limit actions (append-only; decision 064): the action, a keyed hash of the request and the first answer; unique on the account and the key. |

## Routes

The map has 53 endpoints of this module (admin 43, client 7, dhru 1, hooks 2); decision 064 adds the rank change and the freeze and unfreeze of the live wallet, and the five staff wallet routes of a customer answer 410 (below); the two `/v1/account` and `/v1/transactions` rows and the two `EVENT` rows (`wallet.low_balance`, `invoice.paid`) of the map are retired (see `test/contract/retired.ts`). Source: `docs/slices/money.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

Beyond the map (decision 064, `scripts/map-additions/48-accounts.mjs`): `POST /admin/clients/:id/rank`, `POST /admin/clients/:id/wallet/freeze` and `POST /admin/clients/:id/wallet/unfreeze` (described in "One account type in the money module"); the staff wallet routes of a customer below were replaced by the routes of `/admin/clients/:id` and answer `410 ROUTE_RETIRED` in the expand release.

Beyond the map (feature 21, `scripts/map-additions/21.mjs`, built): `GET /store/v1/me/wallet`, `GET /store/v1/me/wallet/statement`,
`GET /store/v1/me/wallet/top-up-methods`, `POST|GET /store/v1/me/wallet/top-ups`, `GET /store/v1/me/wallet/top-ups/:id`,
`POST /store/v1/me/wallet/top-ups/:id/receipt|cancel` (customer session; writes need CSRF and `Idempotency-Key`),
`GET /admin/customers/:id/wallet`, `GET /admin/customers/:id/wallet/statement`, `GET /admin/customer-wallets` (`wallet:read`),
`POST /admin/customers/:id/wallet/adjust|freeze|unfreeze` (`wallet:adjust`, `Idempotency-Key`). Changed additively: `GET /admin/payments*`
(`customer`, `dispute`, filters `owner`, `customerId`), the refund and payments-report wires (method `balance`), the dispute webhook
(top-up disputes). `POST /store/v1/checkout-sessions/:token/balance-payment` is the customers module's (it calls `CustomerWalletPayments`).

Beyond the map (feature 38, `scripts/map-additions/38.mjs`, built): `POST /admin/held-payments/:id/close` (`refunds:approve`, `204`,
audited; decision 048). Changed: the descriptions and error lists of `POST /webhooks/payments/:gateway` (`GATEWAY_ERROR`, `UNAVAILABLE`),
`POST /webhooks/disputes/:gateway` (`UNAVAILABLE`), `POST /admin/currencies` and `PATCH /admin/currencies/:id` (`not_chargeable`); the descriptions
of `POST /admin/disputes/:id/accept` and of the refund's `status` and `note` (a refund closed unsent by a chargeback).

Beyond the map (feature 32, `scripts/map-additions/32.mjs`, built): `GET /admin/payment-gateway-presets`, `POST|DELETE /admin/payment-gateways/:id/logo`
(`payments:gateways`). Changed additively: the gateway row (`preset`, `logoUrl`), `POST /admin/payment-gateways` (`preset`), `GET /client/payment-methods`,
`GET /store/v1/me/wallet/top-up-methods` and the shop's `paymentMethods` (`preset`, `logoUrl`).

### Admin console (43)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/payment-gateways/:id` | staff-permission · `payments:gateways` | Payment gateways: fees, limits and merchant groups. | 8 |
| `GET /admin/clients/:id/statement` | staff-permission · `wallet:read` | Statement of the account's live wallet, of any rank (parameter `wallet`: `live`, `merchant` or `store`). | 3 |
| `GET /admin/clients/:id/wallet` | staff-permission · `wallet:read` | The live wallet of the account, of either kind: available balance, reserved balance, limit, freeze state, pending top-ups and open disputes. | 3 |
| `GET /admin/currencies` | staff-permission · `settings:update` | Currencies and exchange rates. | 3 |
| `GET /admin/currencies/:id` | staff-permission · `settings:update` | Currencies and exchange rates. | 3 |
| `GET /admin/disputes` | staff-permission · `disputes:read` | Card disputes (chargebacks) and the evidence deadline. | 16 |
| `GET /admin/disputes/:id` | staff-permission · `disputes:read` | Card disputes (chargebacks) and the evidence deadline. | 16 |
| `GET /admin/invoices` | staff-permission · `invoices:*` | Invoices; filter `accountId` (alias `clientId`); creating one issues a manual invoice for an account of a merchant rank. | 8 |
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
| `PATCH /admin/clients/:id/credit-limit` | staff-permission · `wallet:credit_limit` | Credit limit (overdraft) of a merchant wallet; needs an `Idempotency-Key`. | 3 |
| `PATCH /admin/currencies/:id` | staff-permission · `settings:update` | Currencies and exchange rates. | 3 |
| `PATCH /admin/payment-gateways/:id` | staff-permission · `payments:gateways` | Payment gateways: fees, limits and merchant groups. | 8 |
| `PATCH /admin/tax-rates/:id` | staff-permission · `tax:*` | Tax rates by country and their effective dates. | 14 |
| `POST /admin/clients/:id/wallet/adjust` | staff-permission · `wallet:adjust` | Manually add to or deduct from the live wallet, with a reason; needs an `Idempotency-Key` for both kinds. | 3 |
| `POST /admin/clients/:id/wallet/freeze` | staff-permission · `wallet:adjust` | Put the live wallet on hold, with a reason and an `Idempotency-Key` (decision 064, route beyond the map). | 64 |
| `POST /admin/clients/:id/wallet/unfreeze` | staff-permission · `wallet:adjust` | Lift the hold on the live wallet, with an `Idempotency-Key` (decision 064, route beyond the map). | 64 |
| `POST /admin/clients/:id/rank` | staff-permission · `clients:update` (Owner only) | Change the rank of an account; across kinds the balance moves to the wallet of the new kind (decision 064, route beyond the map). | 64 |
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

### Account portal (7; merchant rank)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /client/invoices` | merchant-session | My invoices. | 8 |
| `GET /client/invoices/:id` | merchant-session | An invoice and its payments. | 8 |
| `GET /client/payment-methods` | merchant-session | Payment gateways available to my client group, with fees and limits. | 8 |
| `GET /client/wallet` | merchant-session | Available and held balance and credit limit. | 3 |
| `GET /client/wallet/statement` | merchant-session | Account statement; ?format=csv exports it. | 3 |
| `POST /client/invoices` | merchant-session | Top-up invoice; returns a payment link or bank transfer instructions. | 8 |
| `POST /client/invoices/:id/receipt` | merchant-session | Upload a bank transfer receipt for review. | 8 |

### Dhru Fusion API (1)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DHRU accountinfo` | dhru-credentials | Account info: available balance, email and currency. | 7 |

### Incoming webhooks (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `POST /webhooks/disputes/:gateway` | gateway-signature | New or resolved dispute from the gateway; records the dispute with its evidence deadline and posts the loss when the dispute is lost. | 16 |
| `POST /webhooks/payments/:gateway` | gateway-signature | Payment confirmation: check the signature and idempotency, then credit the merchant wallet or, for the storefront, create the order and dispatch it once confirmed. | 8 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/e2e/`).

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

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

Outbox events produced: `wallet.low_balance` (queue `notifications`, aggregate `ledger_accounts`, payload `{ clientId, currency, available, threshold }`), written by
`WalletLowBalanceWatch` inside `LedgerPoster.post` (feature 7b) in the posting's own transaction: for each `client_wallet` a debit took from an available balance (balance
plus credit limit) at or above the merchant's threshold to below it, once per crossing. The threshold is `clients.notification_prefs.lowBalanceThreshold`, a money string
(the map names no field; feature 12a's notification preferences are where a merchant sets it; no threshold, no alert). The route is registered by the platform module (`NotificationRoutes`).
`postTransaction` itself writes no alert: only the injectable `LedgerPoster` does. `refund.process` (queue `maintenance`, aggregate `refunds`, payload `{ refundId }`), written by `RefundOutbox.refund` in the transaction of an approval, a retry or an automatic refund; the processor is `RefundProcessProcessor` (worker). Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

`invoice.paid` (queue `notifications`, aggregate `invoices`, payload `{ invoiceId, clientId }`), written by `InvoiceOutbox.paid` in the transaction that credits a top-up (a staff approval and the automatic credit
job); the route is registered by the platform module (`NotificationRoutes`) and the notification job re-reads the invoice.

## Jobs and schedules

`payment_auto_credit` (queue `maintenance`, every minute; see `docs/queues.md`): credits the confirmed top-ups of automatic gateways after the delay. `refund.process` (queue `maintenance`, event-driven by the outbox): sends an approved storefront refund to its gateway. `POST /admin/ledger/reconcile` runs in the request and records a `job_runs` row of job `ledger_reconcile`
(trigger `manual`, overlap refused: `RECONCILE_RUNNING`); the nightly integrity job of feature 12b reuses its comparison
through the exported `compareLedgerBalances(db, ranAt)` (which `ReconcileService.compare` calls too).

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
