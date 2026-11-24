# 064: One account type

Status: accepted, 2026-11-24. Builds on decisions 016 (one module per domain), 018 (the sign-in steps), 024 (the ledger), 025 (order states),
027 (database conventions: append-only tables), 032 (the barrels), 035 (routes beyond the map), 037 (live streams), 039 (English only),
044 to 056 (dispatch, origins, money, risk, sign-in limits, abuse limits, logs, the production stack, the second pass over money and access),
061 to 063 (merchant verification retired, retired features, the price grid).

**Context.** The product had two kinds of person with two tables, two sign-in paths, two session cookies, two sets of one-time links, two
wallets with two owner words, two inboxes, two kinds of ticket requester and two privacy paths: merchants (the `clients` table, the portal,
the Dhru endpoint, a prepaid or credit wallet, hold-and-settle orders) and customers (the `customers` table, the shop, pay-first orders, a
store balance). A buyer whose business changed had to be created twice, and every cross-cutting feature (notifications, tickets, files,
audit, privacy, reports) had to say "merchant or customer" in every place. From this release a merchant and a customer are **one account
type held in one table**, told apart by the **rank** of the account. The change ships in two releases: an *expand* release (this decision,
two migrations, the new code and the old routes answering 410 where they were retired) and, days later, a *contract* release that drops what
the expand release left unread (see "The contract release" below).

## The model

- **One accounts table, `clients`.** Merchants keep their ids. Every customer row is copied into it with a new id drawn after the greater of
  the largest `clients.id` and the largest `customers.id`, so an old customer number never names a converted customer. An old customer
  number is never an account id: it is read only through the legacy id map.
- **The rank is the `client_groups` row.** Kinds are closed to `b2b` and `b2c_retail` (a check and the `RANK_KINDS` array). Only `b2b` is a
  merchant; anything else has retail rights (fail closed: `rankKindOf`). The wire says `merchant` and `retail`. The retail rank never
  allows credit (a check on the table, a 422 on `overdraftAllowed` in the ranks admin).
- **A guest is a row with `has_account = false`.** A shop checkout without a login, a support ticket of the public form and the account of a
  data request made before this release are guest rows. A guest row has the retail rank, no password and no username. A guest checkout never
  attaches to a login account; the records of a guest row reach an account only through the claim after a proven mailbox (below).
- **One stored type word, `account`.** It replaces `client` and `customer` in every (type, id) pair: sessions and one-time links (`SUBJECT_TYPES`),
  ledger account owners, notification recipients and inbox owners, ticket requesters and authors, consent subjects, file owners, refund
  requesters and alert subjects. Mutable rows were rewritten and their checks narrowed in the expand migration. **Append-only rows keep the words
  they were written with**: their checks were widened by `account`, they are read through `account_legacy_ids`, and a **NOT VALID** check
  (`*_current_check`) refuses the old words in every new row: `audit_logs_actor_type_current_check`,
  `order_events_actor_type_current_check`, `ledger_transactions_created_by_type_current_check` and
  `ledger_transactions_ref_type_current_check`. A NOT VALID check is never validated: validating it would scan the old rows it exists to
  tolerate (a tooling test fails if one of them loses `NOT VALID` in the migration or is validated in a database). Writers use the
  `CURRENT_*` arrays; a tooling test fails on a written pair with `client` or `customer` and on an audit entity or actor of the old words.
- **One buyer column per table, `account_id`.** It is NOT NULL on orders, invoices, payments, disputes and data requests, and nullable on
  refunds, checkout sessions, risk assessments and blocklist entries (a refund that names a payment carries that payment's account, an orderless
  return included). **The door of an order is `orders.source`** (the shop's door is `store`; the others are the merchant doors): no reader
  infers the kind of buyer from a null `client_id` or `customer_id` (a tooling test fails on it), and one helper pair (`isPrepaidOrder`,
  `prepaidOrderSql`) says what the shop's door is. `client_id` is still written for hold-and-settle orders and merchant invoices during
  the expand release and never read; `customer_id` columns are unwritten and unread (`retiredCustomerId` in the schema).
- **The legacy id map, `account_legacy_ids`** (identity, append-only): one row per merchant (the account id is the old id) and one per customer
  (a customer merged into a merchant by an approved pair is marked `merged`). Accounts made later have no row. It is never dropped.
  `LegacyAccounts` resolves an old number to an account, lists the old numbers of an account, and gives readers of never-rewritten rows two SQL
  fragments (`legacyAccountIdSql`, `accountHistorySql`). An unknown pair reads as an unknown account, never as another person.
  `GET /admin/legacy-accounts/:type/:id` answers the account of an old merchant or customer number, or 404.
- **The old customer tables stay, frozen and unread** (`customers` and `customer_credentials`, in TypeScript `retiredCustomers` and
  `retiredCustomerCredentials`) until the contract release; `forbid_retired_write()` triggers (`customers_retired`,
  `customer_credentials_retired`) refuse every insert, update and delete.
- **One live wallet per account, of the kind of its rank** (money, below), and **one rank change** (`POST /admin/clients/:id/rank`).
- **No compatibility adapters and no merchant-only list default.** The console and the shop of the merged model ship under the same deploy
  hold as the backend; a call to a retired route is an error, not a translation.

## Modules meet at seams

Modules meet at seams. Each module may have a `ports` folder: abstract classes that other modules inject as tokens (the implementation lives in
the owning module and is bound at wiring), and small registries that modules fill at boot (rank change checks, account create checks, guest claim
participants, the account list's two SQL fragments). A registry throws on a repeated name and on a read before registration, so a missing entry is a
boot error. Pure helpers that other modules share (the wallet kind of a rank kind, the order door) sit in the owner's `domain` folder, and the
account top-up advisory lock `topup:<accountId>` in money's `infra`. The seams: identity (`AccountSessions`, `ApiKeyRevocation`,
`AccountAuthTokens`, `AccountMailOutbox`, `AccountSignIn`, `AccountTwoFactorSetup`, `AccountOwnPassword`, `AccountLinkSignIn`,
`AccountEmailVerification`, `OptionalAccountSession`, `AccountAccessEffects`, `AccountOwnProfile`, the registries `AccountCreateGuards`,
`GuestClaimParticipants` and `AccountListSql`), money (`AccountWallets`, `WalletErasure`, the registry `RankChangeGuards`), orders (`ShopOrders`),
customers (`AccountPrivacyReads`) and catalog (`RankGroupReads`, implemented by `ClientGroupDirectory`). Wiring: the account records and the three
account registries are one global identity module (`AccountsModule`) that both processes load, the live wallet reads one global money module
(`AccountWalletsModule`), every abstract port is bound with `useExisting` (the port is the instance the services inject), and the API
refuses to boot while a registry lacks an entry (`AccountWiringCheckModule`; the test apps leave that check out, as they leave out the other boot
checks of the real processes). No module of identity names `CatalogModule` in a decorator (the catalog is global).

## One directory, and the rule for an email

Accounts have one directory. `AccountDirectory` of the identity module is the only reader of an account by email and the only writer of guest
rows. Rows with a login and guest rows are two partitions of `clients`, each with its own unique index on `lower(email)`
(`clients_login_email_uq`, `clients_guest_email_uq`), so one email may belong to one row of each. **The email lookup rule:**
`findLoginByEmail` reads only the login partition: password sign-in, forgot password, the sign-in lock and the sign-in limiter use it, so a guest
row is never what they find. `findGuestByEmail` and `findOrCreateGuest` read and write only the guest partition (`INSERT ... ON CONFLICT
(lower(email)) WHERE NOT has_account DO NOTHING`, then read, one retry when the row became an account in between). `lockGuestNoWait` takes the
guest row `FOR UPDATE NOWAIT` for the claim. Only `account-directory.repository.ts` compares `clients.email` (a tooling test fails on an
equality lookup anywhere else). The rank kind of a record comes from `RankGroupReads`. `canAct` and `sessionStateOf` are the one reading of
`clients.status` (only `active` acts; `suspended` and `blocked` end sessions with 403; `anonymized` is gone, 401; any other word counts as suspended; a
tooling test fails on a status compared with `suspended` elsewhere). The status `pending` no longer exists: the expand migration converted
every pending row to `suspended` with a fixed reason and narrowed the status check to `active`, `suspended`, `blocked` and `anonymized`.

The rules around it: the migration never merges two rows by itself (a customer row without a login stays a guest row even when a merchant has its
email; two login rows with one email stop the migration unless the owner approved that pair, below); a staff create with the email of a login row is
409 `EMAIL_TAKEN`; with the email of a guest row only, a retail create is 409 `EMAIL_TAKEN` with code `guest` (use "make an account") and a
merchant create is allowed (it leaves the guest row alone and voids its open sign-in links in the same transaction); making an account of a guest is a staff action
(`POST /admin/clients/:id/account`, 409 code `login_exists` when a login row holds the email); an email change is refused when another login row holds
the new address. Any write that gives an email a login row voids the open sign-in links of the guest row of that email, so a mail sent to the guest
row earlier can no longer turn it into a second login row. A shop checkout without a session first asks for the login row of the typed email: a
login row that may not act (suspended, blocked, erased) is refused with the answer of a blocklist hit and no guest row is made; otherwise the
checkout belongs to the guest row of the email, made or reused, never to the login account that holds the same email, whatever its rank.

## The rank gate

A route that needs a session says whom it serves. A merchant-session route serves merchant ranks and a customer-session route serves the retail
rank; a route that every account may call says `rank: 'any'`, and its key is also written in `test/contract/rank-open-routes.ts`, so opening a
route to every account is a reviewed change of two files and a contract test fails when they differ. The refusal is 403 `RANK_NOT_ALLOWED`, which
never ends a session. `rank: 'any'` is allowed on the two session access kinds only; a compiled contract of any other access kind has no rank.
The pinned routes of the expand release: `POST /client/auth/2fa`, `POST /client/auth/logout`, `POST /client/auth/password/change`,
`POST /store/v1/auth/logout`, `POST /store/v1/me/data-export` and `POST /store/v1/me/data-delete`. The same release adds `RANK_CHANGE_BLOCKED`
(409), `RANK_CHANGED` (409) and `ROUTE_RETIRED` (410), and renames the titles of `ACCOUNT_EXISTS`, `ANONYMIZED`, `NO_ACCOUNT` and `WALLET_FROZEN` so they
speak of accounts.

The check comes after the stage and the suspension checks and before CSRF: 401 for no or a dead session, 403 `ACCOUNT_SUSPENDED`, 401 for the wrong
stage, 403 `RANK_NOT_ALLOWED`, then CSRF, permission and Turnstile. A rank whose kind cannot be read (the view has no rank), a guest row and an
erased account have no session (the gate fails closed). The upload pre-check applies the same rule before a multipart body is read. Placement from a
wallet, the store balance, the checkout and the creation of an API key read the rank again under their own locks. `pendingMerchant` on a contract
is accepted and ignored; `ACCOUNT_PENDING_APPROVAL` is never produced by the session guard (the code stays in the catalog during the expand release;
the contract release removes it).

## Sessions, cookies and sign-in

Every account has one session cookie, `gsm_client_session`, read by both URL families (the shop's old session cookie is never read). The readable
CSRF cookie is named by the kind of the account's rank (`csrf_token_client` for a merchant rank, `csrf_token_store` for the retail rank); the other
name and the shop's old session cookie are cleared on every sign-in and sign-out. The session view carries the rank, and the cached view has a new
name (`gsm:{env}:identity:session:{tokenHash}:v2`, the API key view `api-key:{keyHash}:v3`) so a view of the old shape is never read. Every session
that existed at the migration ends (one sign-in for everyone). The eight sign-in routes of the portal family that every account uses count as the
shop's audience as well for IP rules, so a block on the shop also stops a blocked buyer from signing in; store maintenance does not cover them.
The contact permission for masking addresses is `clients:read` for every account.

One use case serves the three password sign-in routes and both ranks (`POST /client/auth/sign-in` is the one sign-in; its answer is the next step
and the rank, and `kind` stays until the contract release). It looks the email up through the login lookup only. One argon2 verify runs per attempt
(against a dummy hash when no login row with a password exists), every failure is one 401, one counter per email and network and one lock per email
cover the three routes, and a status that cannot act is refused with 403 only after a correct password. The session opens in a transaction that reads
the account again under its row lock and asks the same status helper. Two-step sign-in, the forced password change and the password links are the
same for both ranks; an account without a password is told to choose one first (409 `CONFLICT`) instead of being signed out. The shop family gains
the two-step routes (`POST /store/v1/me/2fa/setup`, `POST /store/v1/me/2fa/enable`, `POST /store/v1/me/2fa/disable`) that run the same use case.
The merchant forgot-password route always needs a Turnstile token (the rollout switch no longer governs it).

Both "me" routes answer one account shape (`AccountMe`: the account with its rank, whether it has a password, whether a password change is forced,
whether two-step sign-in is on, the shown currency, the marketing choice, and the profile fields, empty text when empty, never null):
`GET /client/auth/me` for the merchant family and `GET /store/v1/me` for the retail family. The inbox owner and the live stream viewer are the
account, whatever its rank, with one key per account (`u:account:<id>`). The retail account's own orders are listed through the orders module.

**The emailed sign-in link belongs to the retail rank only.** Asking for it never tells whether an address has an account: every email runs the
same statements and a run that sends nothing is rolled back. Using it proves the mailbox: it makes an account of a guest row, stamps the address,
voids the account's other sign-in links and opens the session, with a code step first when two-step sign-in is on. When the address gained another
login row after the mail was sent, the exchange answers 410 and changes nothing. **The claim of guest records.** A visitor who ordered without
signing up may ask, in the same exchange (`claimGuestOrders`), to move the records of the guest row of that address to the account. The move
runs in a savepoint and never waits for a lock: the guest row and every participant's rows are taken `FOR UPDATE NOWAIT`, and a conflict, or a
participant that refuses because the guest row has an open checkout session, a pending payment or a ledger account, ends the claim with a
`busy` answer while the sign-in still succeeds. Participants: orders, checkout sessions and consents (customers), payments, invoices, refunds
and disputes (money), risk assessments (risk), tickets, messages and their files (support, platform). Email verification is one flow for every
account: an account without a password is only stamped; otherwise the holder must send its own full session with the verification, or the
password and the second step end and a password link is mailed.

## One-time links and their mails

One-time links are one kind of credential for every account: an invitation, a password reset, an email verification and the sign-in link share one
subject type (`account`), one lifetime (one hour), one use and one service. Only a keyed hash is stored; the request issues a placeholder token
nobody receives and the mail job replaces it on the same row, so no clear token is ever stored or logged. The mail of a link is chosen when it
is queued, by the rank kind of the account, read under the account row lock: a merchant rank gets the `merchant.*` events, a retail rank the
`customer.*` events (the sign-in link is for the retail rank only); the stored templates keep their names and there are no new events. The job
carries `accountId` and `tokenId`; a job that names only an old customer number is discarded and the number is never read as an account id. Every
link points at the shop (`/sign-in`, `/set-password`, `/verify-email`); the pages of the signed-in area are under `/account`. Every link exchange
and the email verification answer 410 `TOKEN_INVALID` unless the account may act, so the reset and the password-set routes answer 410 for the
link of a suspended, blocked or erased account as for a used link. At the migration the open links of every former customer and of every account
that may not act were voided; the invitation and reset links of active merchants stayed usable. Suspension and reactivation mails stay
merchant-only.

## API keys

API keys follow the rank. A key works only for an active account of a merchant rank. The checks run in this order: revoked, expired, suspended
or blocked (answered as account suspended), not active (answered as authentication failed), not a merchant rank (authentication failed), allowed
addresses, per-minute limit. The rank kind is part of the cached key view and is read through the catalog's rank seam, never from the ranks table;
a view without it is refused. Both ways of creating a key (the account's own and staff's) take the advisory lock `api-keys:<accountId>` first
and then lock the account row, and refuse from that locked read: for the account's own request a rank that is not a merchant rank is 403
`RANK_NOT_ALLOWED` and a suspended or blocked account 403 `ACCOUNT_SUSPENDED`; for staff a rank that is not a merchant rank is 409 `CONFLICT` and a
status that cannot act 409 `NOT_ACTIVE`. A rank change that leaves the merchant kind, and an erasure, revoke every live key in their own
transaction through `ApiKeyRevocation`, without taking the advisory lock (the one named exception to the order of locks, because both creations
take it before the row); a later change back never restores a key. Audit entries about keys name the entity `account`. The staff list of keys
answers for an account of any rank. On the Dhru surface a key of a not-active account or of a non-merchant rank answers Authentication Failed.

## Staff reads and writes of accounts

**One list.** The staff list of accounts is one list. `GET /admin/clients` returns every account, whatever its rank, guests included; without a
`rankKind` filter nothing is left out. A row names its rank (`rank.kind` is `retail` or `merchant`), whether it has a login (`hasAccount`), whether
an invitation waits (`invitationPending`) and the count and date of its orders (`ordersCount`, `lastOrderAt`, both doors, any status). Filters:
`rankKind`, `rankId`, `hasAccount`, `country`, `invitationPending`, a repeated `status`; sorts: `rank`, `ordersCount`, `lastOrderAt`, `balance`. The wallet and the
30-day figures are sent only to staff who hold `wallet:read`, and so is the sort by `balance` (403 without it). The order figures and the wallet
balance reach the list as SQL fragments the orders and money modules register (`AccountListSql`), so a sort by them is one query, and the wallet of
a whole page is read in a fixed number of statements. `GET /admin/clients/counts` returns the numbers of the chips from one aggregate, never cached.

**One write use case each.** `ClientWriteService` creates an account of any rank: an omitted rank is the retail rank, a merchant rank is the
Owner's and is checked before anything is read for writing, the email follows the rule of the two partitions, the checks other modules registered
(`AccountCreateGuards`: the blocklist) run before the first write, and the password is an emailed invitation or a temporary password returned
once (with `Cache-Control: no-store`; `password.mode` replaces the old `invite` flag). The same rule and the same checks judge the new address of an
edit. A status write through `PATCH /admin/clients/:id` is only `active` or `suspended`; the rank never travels in the edit (422 field `groupId`, code
`use_rank_route`). Every status or rank change reaches sessions, links, API keys and invitations through `AccountAccessEffects`, in the same
transaction: a status that may not act ends every session and voids every link, an erasure also revokes every key, a rank change across kinds
ends every session, leaving the merchant kind revokes every key, and an account without a password raised to a merchant rank is sent an
invitation. The staff security tools work on any account with a login; a guest has nothing to secure. The sessions list shows staff and account
sessions under the subject types `staff` and `account` (the filters `client` and `customer` are 422).

## Block, privacy, export and erasure

Block, the privacy read, the export and the erasure of an account are routes of `/admin/clients/:id` in the customers module, over the one
account row: block, privacy read and export serve every rank, the erasure the retail rank only (a merchant rank is refused until the rank change
settles its wallet). A block ends the sessions and stops the API keys through the access effects of the identity module, and adds to the blocklist
the email, the card fingerprints of the account's payments and the IMEIs of its shop orders and checkouts, never the IMEIs of portal or Dhru
orders. The erasure writes the address `deleted-account-<id>@redacted.invalid` (an account id and an old customer number are different things, so
the old pattern could collide), clears the password and the two-step secret and closes the money side last. When the account is retail, has a login
and has a proven email, the guest row of that email is the same person's earlier shopping: the export lists it in its own section and the erasure
removes it in the same transaction, the account row locked first and the guest row second, and refuses the whole erasure while the guest row has an
open checkout or a pending payment. The export is format 4 (`profile.rank`, `files`, `merchant` and `ordersPlacedAsGuest` are added;
`profile.firstOrderAt` and `profile.totalSpent`, which nothing wrote, are removed; the file is `account-<id>.json`) and the export of a privacy
request holds **every wallet of the account that has entries**, whatever its rank is today. The consent `document` of the privacy read is an empty
string when the purpose has no legal document. **Erasure blockers** (`WalletErasure.closeForErasure`) refuse the erasure while any wallet or hold
of either kind is not zero, a wallet is on hold (even at zero), a top-up waits for review, a top-up dispute is open, a balance-paid order is open
or a refund to the balance waits; an open order paid by card does not hold the erasure (the rule the product had). A copy of the data can be asked
by an account of any rank (`POST /store/v1/me/data-export`); an erasure only by the retail rank (`POST /store/v1/me/data-delete` answers 409
`CONFLICT` for a merchant rank and stores nothing). The request takes the account row lock first, so the rank it judges is the current one.
Both routes are pinned as open to every rank. The old customer routes that did these things answer 410 (below), and the blocklist check of the
staff create is registered with the account create guards.

## Files, audit and the quota

A stored file belongs to a staff member or to an account (`owner_type` is `staff` or `account`), whatever the rank of the account. The upload quota
follows the rank kind of the account that uploads, not the route: 500 files and 5 GiB in 24 hours for a merchant rank, 30 files and 100 MiB for
any other rank (receipts and ticket-link uploads count together); there is no quota for an account that waits for approval, because that status is
gone. Uploads are serialised per owner by the transaction lock `upload-quota:account:<id>`. Staff opening an upload that no record uses need
`clients:read` for every account. A guest row's files move to the account that claims its records. The audit log writes the entity and actor word
`account` for every merchant and customer; rows written before keep `merchant`, `client` and `customer`. `GET /admin/audit-logs` takes `accountId`, reads
`entityType=account` and `actorType=account` as the three words of each through the legacy map, and every row carries `account: {id} | null`; the
same field on the lines of `GET /admin/orders/:id/events` resolves the old actor words of order events.

## Money

**A wallet belongs to an account.** The ledger owner of every wallet and hold is the pair (`account`, id), whatever the rank, so an account has at
most one wallet of each kind (`ledger_accounts_identity_uq`); which kind is live follows the kind of the rank: `client_wallet` with `client_hold` for
a merchant rank (credit when the rank allows it, hold and settle) and `customer_wallet` for the retail rank (no credit, pay first, freeze, never
below zero except a chargeback clawback). `walletKindOfRank` is the one mapping. New journals say `account` in their reference and actor words;
journals written before the merge keep the old words and are named through the legacy number map, so an old customer number is never read as the
account that has the same number. A wallet of the other kind may remain from a rank change; it must hold zero and be unfrozen, and a fifth part
of the nightly integrity check (`wallets_follow_rank`) flags any other state. A frozen merchant wallet takes no new hold (the order placement asks
`AccountWallets.assertNotFrozen` after it holds the account row, before the hold is posted; 409 `WALLET_FROZEN`); settlement and release of
existing holds, credits and staff debits still post. The account list reads the live wallet of a whole page in a fixed number of statements.

**One lock order for every money path of an account:** the account row first (`FOR UPDATE` by the rank change, the status writers, the guest claim
and the erasure; `FOR KEY SHARE` by every path that reads the rank kind to move money or to choose a wallet, so the kind is read only after the
lock), then the rows of the path (order, checkout session, invoice, payment, dispute), then the advisory locks (`topup:<accountId>`, fingerprint and
stock locks, `upload-quota:account:<id>`, the staff adjustment lock first in a staff adjustment), then the ledger accounts `FOR UPDATE` in id order.
Crediting, the dispute webhook and refund approval hold their payment and invoice rows already and take the account row after them; this is safe
because the rank change and the status writers never lock those rows and the guest claim takes them only with `NOWAIT`. The one named exception is
`api-keys:<accountId>`, taken before the account row by both key creations (above). The staff freeze, unfreeze and credit limit take the account row
`FOR KEY SHARE` before they read the live kind. The rank change locks the account row, then the account's ledger accounts in id order, then
`topup:<accountId>`; it cannot deadlock with the top-up creates, which take the account row before the advisory lock and post nothing while holding it.

**The store balance** belongs to an account of the retail rank (a `customer_wallet` owned by (`account`, id)); both store routes refuse a merchant
rank with 403 `RANK_NOT_ALLOWED`; `GET /admin/customer-wallets` lists the live store wallets (the owner's rank is not a merchant rank) and its
`customer.id` is the account id; a balance payment is recorded under the buyer's `account_id` and posted by (`account`, id).

**Staff wallet actions.** Staff reach the wallet of any account at one address, whatever its rank. The wallet read, the statement, the manual
adjustment, the credit limit, the freeze and the unfreeze work on the live wallet, whose kind follows the kind of the rank, and each of them reads
the kind only after it holds the account row (`FOR KEY SHARE`), so a write that races a rank change lands on the wallet that is live after it. The
manual adjustment key is `adjust:<accountId>:<key>` for both kinds and the header is required; a key of the earlier customer form is found through
the legacy map before anything is posted. The approval limit of a staff member's credits is counted per wallet kind over 24 hours, the credits made
before the change included. **`wallet_action_keys`:** the freeze, the unfreeze and the credit limit require an `Idempotency-Key` that is stored with
the request hash and the first answer in `wallet_action_keys` (append-only, unique on the account and the key) in the transaction of the change: the
same key and request replays the first answer (`idempotency-replayed: true`) and changes nothing, another request under the key is refused with
`IDEMPOTENCY_KEY_REUSED` (409, the catalog's status). A credit limit exists on the merchant kind only (422 on a store balance), and a wallet on hold
of the merchant kind takes no raise of its credit limit (409 `WALLET_FROZEN`). The routes are `GET /admin/clients/:id/wallet`,
`GET /admin/clients/:id/statement` (a `wallet` parameter of `live`, `merchant` or `store`, and `createdAt_gte` and `createdAt_lte`),
`POST /admin/clients/:id/wallet/adjust`, `PATCH /admin/clients/:id/credit-limit`, `POST /admin/clients/:id/wallet/freeze` and
`POST /admin/clients/:id/wallet/unfreeze` (body `{reason}` of 5 to 200 characters, permission `wallet:adjust`, 409 `CONFLICT` and `OPEN_DISPUTE` on the
unfreeze). The system freeze of a dispute webhook carries no key (the dispute id is its guard).

**The rank change.** The rank change is one route, `POST /admin/clients/:id/rank`, owned by the money module. Only the Owner may call it and it needs
an `Idempotency-Key` (a replay is marked `idempotency-replayed: true`). The rank is the only thing that tells a merchant from a retail account, so a
change between the two kinds is the one moment money changes wallet. The use case locks the account row, then the account's ledger accounts in id
order, then the top-up lock of the account; it collects every reason the change cannot be made now and answers them together (409
`RANK_CHANGE_BLOCKED`, `errors[]` with field `groupId`) with nothing written: `guest`, `open_hold`, `live_order` (registered by orders), `open_topup`,
`open_dispute`, `open_refund`, `open_checkout` (registered by customers), `frozen`, `negative_balance` and `credit_limit`. Otherwise the whole balance moves in
one journal of kind `wallet_transfer` under the key `rank:<account>:<key>` (posted through `postTransaction` directly, so closing a wallet raises no
low-balance alert), the credit limit of a merchant wallet that is left becomes zero, every session ends, the live API keys are revoked when the
account leaves the merchant kind, and an account without a password raised to a merchant rank is sent an invitation. Inside the merchant kind only
the rank changes, and a rank without credit is refused while the credit limit is above zero. Every change is kept in `account_rank_changes` with the
names and kinds of both ranks, and the two rank ids carry no foreign key, so the history stays readable after a rank is deleted. The answer is
`{rank, wallet, movedAmount, transactionId, sessionsEnded, apiKeysRevoked}` with `wallet` and `transactionId` nullable. The group no longer travels
through `PATCH /admin/clients/:id`. A reuse of the key with another body answers `IDEMPOTENCY_KEY_REUSED` with the catalog's status, 409.

**Top-ups and invoices.** Every invoice names its account (`account_id`), and a top-up or manual invoice names the wallet kind it fills
(`wallet_kind`); `client_id` is still written for a merchant invoice until the contract release. Both top-up creates (`POST /client/invoices` and
`POST /store/v1/me/wallet/top-ups`) take the account row `FOR KEY SHARE`, then one advisory lock `topup:<accountId>` (it replaces
`merchant-topup:<clientId>` and `wallet-topup:<customerId>`), and read the rank only after both; both receipt uploads take the same lock after the
invoice row, and the rank change takes it too. `POST /client/invoices` takes an optional `Idempotency-Key`: the same request answers the same invoice
with `idempotency-replayed: true`, another request under the key is 409 `IDEMPOTENCY_KEY_REUSED`, and a top-up whose payment page is still opening
is 409 `IDEMPOTENCY_IN_PROGRESS` (after a minute the retry voids the stale invoice and starts again). Both routes use the one unique index
`invoices_account_key_uq`; a key is bound to the request's gateway, amount and wallet kind. The portal shows the invoices of the merchant wallet
only, the store shows the top-ups of the store balance only. Staff-issued invoices are for a merchant rank only (422 on `clientId`, code
`not_merchant`). `GET /admin/invoices` filters by `accountId` (`clientId` is its alias). The store top-up limiter key is `a:<accountId>`.

**Crediting and disputes of top-ups.** A top-up belongs to the account of its invoice and fills the wallet its invoice names. Crediting locks the
payment, then the invoice, then the account row for key share, reads the rank kind under that lock and credits the live wallet: a merchant wallet
through the deposit event (with the paid-invoice event and the invoice PDF), a store balance through the store top-up event (with its email). A
credit is never refused for the kind; when the invoice named the other kind, the audit row records both. A dispute of a card top-up freezes the
live wallet of either kind when it opens; a lost dispute takes the credit back from the live wallet (a merchant wallet may pass its credit limit,
a store balance may go below zero and is frozen after the posting). The account row is locked after the payment and the dispute rows, and the kind
is read only then. `GET /admin/payments` filters by `accountId` (`clientId` is its alias) and `owner` (the wallet kind); `customerId` is 422.

**Refunds.** A refund goes back to the wallet the account holds now. A payment made from the store balance is refunded to the store balance while
the account has a retail rank and to the merchant wallet after a change to a merchant rank, under the same keys; the kind is read after the
account row is locked, so a rank change that races a refund lands first or waits. What is left to refund counts the lines of both wallets
(`gateway_clearing`, `customer_wallet` and `client_wallet`), and so does the payments report. Every refund that names a payment names that payment's
account, an orderless return included. A guest's payments, receipt invoices, refunds and disputes move to the account that proves the mailbox,
without waiting for any row, and not while a payment of the guest is pending or the guest holds a ledger account.

**Reports.** Reports and the dashboard follow the door of an order (`orders.source`), not the rank of its buyer. The top accounts list
(`GET /admin/reports/top-clients`) ranks every account that ordered in the window, whatever its rank, guests included and anonymized accounts left
out, with its rank and the balance of its live wallet. The wallet exposure keeps the merchant-rank wallets in its totals and adds the store
balances beside them (`storeBalances`). The dashboard no longer carries a list of best buyers (`topCustomers`). The integrity check has a fifth part,
"every wallet follows the rank of its account" (`wallets_follow_rank`, counter `walletsOffRank`).

## Orders and checkout

**Orders.** The buyer of every order is an account, whatever its rank; the door (`source`) decides the money path of an existing order, never the
rank held today. Placement from a wallet locks the buyer's account row first and refuses a retail rank (403 `RANK_NOT_ALLOWED`), an account that may
not act (403 `ACCOUNT_SUSPENDED`) and a frozen merchant wallet (409 `WALLET_FROZEN`) before it writes anything. Every transition that moves money takes
the same lock; a refund of a completed order held from a wallet credits the wallet that is live now; a reopen after the account left the merchant
rank is refused (409 `RANK_CHANGED`, "Refund the order instead."); reject and cancel cannot meet a crossing because a rank change is blocked while any
order of the account is in flight. `order.status_changed` carries the buyer account and the door (`accountId`, `source`); merchant notices go only for
orders held from a wallet. The buyer of an order is its account on every read: a staff order row names it as `account` (id, name, address, `rank`
with its kind, and `guest` for an address that ordered without a login); the keys `client` and `customer` are gone. `channel` is told by the door the
order came through, never by the rank the buyer has today. Staff filter orders by `accountId` (`clientId` is its alias, because a merchant's number is
its account number) and by `rankId`; `customerId` is refused with 422, because an old customer number is not an account number. The address is shown
in full only to a caller who may read accounts, and the search reads names, never addresses. An event written before the accounts merged keeps
its old actor word; the answer resolves it through the map of old numbers, and a number the map does not know names nobody. The portal, its
dashboard, its export, cancel and verify and the Dhru status read the account's orders of the merchant doors only; the account's own shop order is
not found there (404) and is listed by `GET /store/v1/me/orders`. The count, the date and the total of the orders of an account reach the account
list as SQL registered by the orders module.

**Checkout.** The shop checkout belongs to an account row. A signed-in account of the retail rank opens its own checkout (its row is held with a
key-share lock, and the rank is read after the lock); a signed-in account of a merchant rank is refused with 403 `RANK_NOT_ALLOWED` and nothing is
written. A signed-out buyer is the guest row of the typed email (above). Paying from the store balance takes the account row (key share), then the
session, and needs the retail rank at that moment; the capture of a card payment takes the payment, then the account row (key share), then the
session, and never refuses for rank. Consent records carry the subject (`account`, id) of the session's account; the guest creation of the consent
route is gone. The customers module registers the blocker `open_checkout` with the rank change and its participant of the guest claim.

## Risk

The risk module names the buyer by account. An assessment, a blocklist entry and a data request carry the account's number (`account_id`) whatever
its rank, a guest checkout names its guest row, and the old customer columns are never written. The velocity rules (orders in 24 hours from one
email, orders in one hour from one device, the first order) and the review queue count shop orders only, so the orders a merchant account holds from
its wallet never raise them and its portal history is not its shopping history; the card of the queue keeps its `customer` key and holds the account
number. When staff refund a held guest order and block its email, the entry is limited to guest checkouts if a login account holds that email and
existed before the order (made by staff, or its mailbox proven earlier), because the guest row is not that account; the account keeps signing in.
The assessments of a guest row move to the account that proves its mailbox in the link exchange, taken `FOR UPDATE NOWAIT` so the claim never
waits for a reviewer or a payment. `GET /admin/data-requests` rows carry `accountId` and `accountName`; the filter `customerId` is 422.

## Ranks and prices

Every rank answers its kind (`rankKind`, `merchant` for the stored kind `b2b`, `retail` for any other) and the number of accounts in it
(`accountCount`, every account of the rank, guests included, the retail rank too); `merchantCount` is gone. The retail rank never allows credit:
the table refuses it and the ranks admin answers 422 on `overdraftAllowed` (code `retail_no_credit`). Fixed client prices exist for accounts of a
merchant rank only: a create or a change for a retail account is 422 on `clientId` (`retail_rank`), as is the price resolver; the rows of an account
that was lowered stay, can be deleted, and apply again after a raise. The shop always prices from the one retail rank. The price change scan reads
accounts of a merchant rank and their orders through the merchant doors only, never a shop order. A rank is deleted only while no account is in it;
the rank history keeps the ids and names of both ranks without a foreign key and never blocks the delete. `ClientGroupDirectory` is the one reader
of `client_groups` for other modules (`RankGroupReads`: `kindOf`, `retailGroupId`, `nameOf`, `rankOrder`).

## Support and notifications

A support ticket and its messages belong to an account of either rank: the requester and the author are stored as `account`. A merchant rank
reads its tickets in the portal by id (a ticket opened there has no link token); a retail rank reads them through the ticket page and its link
token. The rule of decision 053 holds for every account: a ticket of the public form that was filed with a typed address stays off the account's
lists, live streams, replays and id routes until the link mailed to that address is used (the portal routes answer 404 for it meanwhile). The
public form files a ticket under the login account of the typed address, whatever its rank, and otherwise under the guest row of the address; an
order link files it under the account that owns the order. The address of a requester is masked for staff without the account-read permission, for
every rank. When a guest row is claimed, its tickets and messages move to the account, locked without waiting.

A notification goes to a staff member or to an account of either rank. The text of a message is chosen by the audience it was made for: an order,
payment or refund mail by the door of the order, a wallet mail by the kind of the wallet, a support reply by the rank of the asker, and every other
message by the rank of the account; the choice is kept in the message (`payload.audience`), so a later rank change never swaps its text. Campaign
groups are staff, accounts of a merchant rank, and accounts of any other rank with the guests; a person added by hand is an account and is reached
by the group of its rank. The inbox, the session doorbell and the live stream of an account share one key per account, whichever door it came
through. New unsubscribe tokens sign the account id under a prefix of their own; a token sent before the merge names an old customer number and is
read only through the legacy id map.

## The migration

The expand release is two migrations. `0066_accounts_expand.sql` is assembled from the drizzle-kit output by
`bun scripts/accounts-merge/assemble.ts expand` (the phase map `scripts/accounts-merge/expand/phase-map.json`, the hand statements in
`scripts/accounts-merge/expand/phases/*.sql`); it is never edited by hand, every generated statement is marked
`-- accounts-merge:generated <key>`, and every phase sits between `-- accounts-merge:phase:<n>:begin` and `:end`. The phases: 0 preflight (reads
only; it stops the whole migration, with nothing changed, on any finding), 1 additive tables and columns and the widened checks, 2 the id map,
3 the copy of the customers, 4 the rewrite of the mutable type pairs, 5 the owner columns, 6 the ledger owners, 7 the append-only words (the four
NOT VALID checks), 8 accounts and ranks (every `pending` account becomes `suspended`, then the status check is narrowed), 9 sessions and links
(every session ends; the open links of former customers and of accounts that may not act are voided), 10 the freeze of the old customer tables.
Every phase is a no-op on an empty database and a second run applies nothing. `0067_account_permissions.sql` is data only: it stops and names a
stored role that holds the merchant and customer permissions unevenly, whether the role would lose a right or gain one (a role with
`clients:update` and `clients:security` but not `customers:suspend` would gain the suspension of retail accounts); change it in Admins and access
first. Then it adds `clients:block` where `customers:block` is held and `customers:privacy` where only `customers:*` grants it.

**The preflight and the approvals.** The preflight stops on: an approved pair whose customer has a wallet balance or a frozen wallet (E1), money in
flight, an order in progress or waiting for its verification, or a checkout opened signed in that is still open (E2: the last two are the
rank change's `live_order` and `open_checkout` tests), differing statuses (E3), an open data request (E4), a merchant and a customer with a login
that share an email when the pair is not approved (E5), a stale approval (E6), two invoices of an approved pair with one key (E7), an
unprocessed outbox event of the old customer aggregate (G1), an orphan polymorphic row (G2), an order whose door and client column disagree
(G3), an invoice, payment or dispute with no owner (G4), a rank kind outside the two (G5), a refund whose customer maps to another account
than its payment's (G6), a notification campaign that is queued or sending (G7), and a retail rank that allows overdraft (G8). The message is
`accounts merge stopped, nothing changed:
<findings> (<n> finding(s))` with ids, never emails. `bun scripts/accounts-merge-check.ts` runs the same block read only against a database
(from the release image, see docs/OPERATIONS.md) and prints the approvals the settings row already holds, and `--approve <file>` writes the
owner's approvals (JSON lines, ids only: `{"clientId": 12, "customerId": 40, "action": "one_account"}`) to the settings row
`accountsMerge.approvedPairs`, which phase 0 reads and phase 10 deletes; a migration that stops leaves the row, and the runbook's way back
deletes it. `--rehearse <database>` migrates a scratch copy on the same server (the rehearsal and the restore test) and refuses the live
database, so the runbook never points the migrate service itself at a copy. The migration never merges two accounts the owner has not approved.

**What stays in the database.** The `retiredTables` seam of the module map lets a table stay owned by its module while the schema tests no longer
expect it; it is empty in the expand release. Nothing is dropped in the expand release: the old customer tables, the retired columns and the NOT
VALID checks stay, so the contract release alone decides when they go.

## Tooling that keeps it so

Tooling tests fail on a written type word `client` or `customer`, on a raw comparison of an account status with `suspended`, on a buyer inferred from a
null client or customer id, on an equality lookup of the email of an account outside the account directory, on a reference to a retired table,
and on a current check that is not NOT VALID. The module map gains `retiredTables` and `account_legacy_ids`, `account_rank_changes` and
`wallet_action_keys` are append-only tables. Test helpers keep their names: a customer helper writes a retail-rank row of the one account table,
a merchant helper a merchant-rank row, a guest is a retail row without a login. One session cookie opens an account of any rank; the readable CSRF
cookie is named by the rank kind. The development seed writes the demo's merchants as the accounts 1 to 20 and its customers as retail accounts,
the customer number plus 100 (101 to 130); each old number has its row in the legacy id map. A guest of a left checkout is a guest row from number
900000 that never moves the id sequence of the accounts, so the next account made in a development database is 131. Thirteen routes beyond the map
are added in `scripts/map-additions/48-accounts.mjs` (decision 035): `GET /admin/clients/counts`, `GET /admin/legacy-accounts/:type/:id`,
`POST /admin/clients/:id/account`, `POST /admin/clients/:id/rank`, `POST /admin/clients/:id/block`, `GET /admin/clients/:id/privacy`,
`GET /admin/clients/:id/export`, `POST /admin/clients/:id/anonymize`, `POST /admin/clients/:id/wallet/freeze`,
`POST /admin/clients/:id/wallet/unfreeze`, `POST /store/v1/me/2fa/setup`, `POST /store/v1/me/2fa/enable` and `POST /store/v1/me/2fa/disable`.

## The closed edge

The edge can be closed to every client address but one. Every public host of the Caddyfile imports a snippet first; the snippet reads one
optional file of a folder that the compose file mounts read-only, and while that file exists any other client address is answered 503 with a
problem+json body before any route and any proxy. The file names the address with Caddy's client-address matcher, so behind a CDN it is the
address the CDN's header names, taken only from the CDN's ranges. A host script (`gsm-edge-gate`) writes or removes the file, has Caddy check and
load its Caddyfile, and reads the running configuration to see the gate on every host; a refused change leaves the file as it was. The deployer
installs the script. The closed edge is an operating tool for a release that needs one person to try the real hosts before anybody else; it is
not an access rule. It ships ahead of this release, as a small release of its own from the main branch that the deployer deploys (it installs
the script and loads the Caddyfile whose hosts import the gate), and this release does not start before the gate runs on production and was
tried once; docs/OPERATIONS.md section 1 describes it.

## The old routes: 410 now, retired in the contract release

During the expand release the old customer routes stay registered (route parity holds) and answer **410 `ROUTE_RETIRED`**, change nothing and
name their replacement. The twelve rows of the map for `/admin/customers`: `GET /admin/customers`, `GET /admin/customers/:id`,
`POST /admin/customers`, `PATCH /admin/customers/:id`, `POST /admin/customers/:id/account`, `POST /admin/customers/:id/password`,
`POST /admin/customers/:id/sessions/revoke`, `POST /admin/customers/:id/suspend`, `POST /admin/customers/:id/reactivate`,
`POST /admin/customers/:id/block`, `GET /admin/customers/:id/export` and `POST /admin/customers/:id/anonymize` (replaced by the routes of
`/admin/clients`). The five wallet routes of a customer, which were additions: `GET /admin/customers/:id/wallet`,
`GET /admin/customers/:id/wallet/statement`, `POST /admin/customers/:id/wallet/adjust`, `POST /admin/customers/:id/wallet/freeze` and
`POST /admin/customers/:id/wallet/unfreeze` (replaced by `/admin/clients/:id/wallet*`). The rows of the map are listed in
`test/contract/retired.ts` with this decision; the additions are deleted from the route list by the contract release.

## The retired keys to come

The contract release (at least seven days after the expand release; no call of a retired route in the API logs for 72 hours; one nightly backup
and one restore drill after the expand release) drops what the expand release left unread: the columns `client_id` of orders and invoices and
every `customer_id` column, the tables `customers` and `customer_credentials` and the other retired tables and columns named in decisions 061 and
062, the idempotency indexes on the dropped columns, and the compatibility classes and aliases named by the contract release. It narrows only
mutable value lists (the sign-in-link purposes, the order sources, the invoice kinds) and deletes the two settings rows of the customer session
lifetimes (`sessions.customer_absolute_minutes`, `sessions.customer_idle_minutes`, no longer read). Append-only checks are never narrowed;
`account_legacy_ids`, `account_rank_changes`, `wallet_action_keys`, the `account_id` columns, `wallet_kind` and the NOT VALID checks stay forever. The
aliases that go with it: `POST /client/auth/login` (the map's old sign-in route; `POST /client/auth/sign-in` stays), the four shop aliases
`POST /store/v1/auth/login`, `POST /store/v1/auth/password/forgot`, `POST /store/v1/auth/password/set` and `POST /store/v1/auth/logout`, the use of
`POST /store/v1/me/password` in a `pending_password` session, the purpose `verify_email` on `POST /store/v1/auth/verify` (accepted in the expand
release only), the `kind` field of the sign-in answer, the `pendingMerchant` marker, the code `ACCOUNT_PENDING_APPROVAL`, the seven retired
`customers:*` permissions of stored roles, and the aliases `MerchantPrincipal` and `CurrentMerchant`. The pinned list of routes open to every rank
loses `POST /store/v1/auth/logout`.

## Consequences

- One person is one account whatever they buy; a rank change is the one place where the wallet kind changes, and it is a reviewed, idempotent
  money move. Reads and reports follow the door of an order, not the rank held today.
- Nothing that carries an old customer number is ever read as an account number again: sessions and links were ended at the migration, queued
  jobs and old unsubscribe tokens are read through the map, ledger rows keep their words.
- The console and the shop of the merged model ship with this release (decision 023 of the console and decision 002 of the shop); they call the
  routes of `/admin/clients` and the one sign-in, and read the rank, not a type.
- The migration rewrites rows that the old code reads (types, owners, statuses, sessions), so the old image must never run on a migrated
  database: the release is deployed by hand with the automatic deploys on hold, and docs/OPERATIONS.md holds the order, the checks and the two
  failure paths.

**Open.** (1) Suspension and reactivation mails stay merchant-only; the staff status write must skip them for a retail rank. (2) The privacy
export must read every wallet of the account with entries, whatever its rank. (3) The ledger kind `wallet_transfer` needs a label in the
console's finance words. (4) The contract release removes the compatibility code named above and the documented `ACCOUNT_PENDING_APPROVAL`
errors of the portal and Dhru contracts.
