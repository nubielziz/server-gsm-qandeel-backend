# Checkout, the shop's account routes and the privacy of accounts (`customers`)

Map domain I. The storefront checkout (pay first, then dispatch), the consent records, the retail account's own shop routes and the staff routes
that block, export and erase an account. Since decision 064 **there is no customer table in use**: a customer is an account of the retail rank
in the identity module's `clients` table, a guest is an account row without a login, and `customers` and `customer_credentials` stay in the database,
frozen and unread, until the contract release. This module owns `checkout_sessions` and `consent_records` only.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 010 ids and tokens, 018 authentication, sessions and CSRF, 019 encryption, 034 Turnstile, 053 abuse limits, 054 secrets at rest, 064 one account type, 070 order forms draw only the custom fields and 073 IMEI is a field type. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (feature 14a, storefront-checkout): the checkout, 3 of the 13 storefront routes (`POST /store/v1/checkout-sessions`,
`GET /store/v1/checkout-sessions/:token`, `POST /store/v1/checkout-sessions/:token/consents`). Paying a session (`.../pay`) and creating the order are feature 16 (below). Checkout files:
`checkout.module.ts` (routes), `application/checkout-session.service.ts`, `application/consent.service.ts`,
`application/checkout-token.resolver.ts`, `infra/checkout.repository.ts`, `infra/consent.repository.ts`, `domain/checkout.ts`.

- **Open** (scenario b2c-paid steps 2 and 3): body `{ serviceId, email, country, region?, currency?, quantity?, imei?, inputs?,
  utm? }`. In one transaction: the policy `guestCheckout` (off answers `401 UNAUTHORIZED` "Sign in to check out." to a guest; a
  signed-in account is not a guest, see **Who the buyer is** below); the service must be one the shop sells, lists
  (a switched-on `service_listings` row) and has priced (`StorefrontQuotes`, else `422` on `serviceId`; a `file` service cannot be ordered online yet); the quantity and the
  order fields are checked with the orders module's placement rules (`quantityProblem`, `inputProblems`), each by its own type, Required tick and pattern (decision 073: the service type `imei` forces nothing; a field of type `imei` holds one IMEI, 15 digits with Luhn, else `INVALID_IMEI` with `invalid_imei` on `inputs.<key>`, and is stored as digits, `normalizedInputs`). Decision 070: the shop draws only the custom fields; on an IMEI service an `imei` sent with text (older pages) is the value of the main-input field (the one flagged `isMainInput`, decision 065; `bridgedImeiOf`: it wins over a value under that key, its problems on `imei`), or, without such a field, the main input as typed. An optional main input may be left empty and an IMEI service without fields takes none. The main input of an IMEI service (`mainInputOf`) is stored as `imei_enc` (context `checkout_sessions.imei_enc`, never returned: the answer shows its last
  four characters). The blocklist is asked about the main input and the value of every field of type `imei`, each read as digits, whenever that is a valid IMEI, whatever the type of the field the main input was typed into (`blockableImeisOf`). The buyer is an account row (see **Who the buyer is** below); the typed email is trimmed and lower-cased. A failed open rolls
  everything back (no guest row is left behind). The session stores USD `net_amount`, `tax_rate`, `tax_amount`, `gross_amount`
  (RULES customers 6), the `currency` and the locked `fx_rate` (8 decimals, the markup included), `tax_country`, the encrypted
  IMEI, `inputs`, `utm`, `ip` (the trusted-proxy address) and the user agent; the token is 128 random bits (base64url, 22
  characters), `expires_at` is 30 minutes after the clock's time (`CHECKOUT_SESSION_TTL_MINUTES`). Maintenance with scope
  `checkout` or `store` already answers `503 MAINTENANCE` before this runs (the pipeline hook). Decision 050: right after the
  guest-checkout switch, `CustomerProfileRules.assertCheckoutCountry` refuses a `country` without a tax window in force while the shop
  has a window for any country (the profile's own refusal: `422` on `country`, code `unsupported`, "Choose a country."); a shop with no
  window in force accepts every country without tax. While the country has a regional tax window in force
  (`StorefrontMoney.taxRegionAccepted`), `region` must name a region that has one, compared trimmed and in upper case; a missing or other
  region is `422` on `region` (code `unsupported`, "Choose a region."), and the national window alone does not settle the tax then (staff
  give a region without tax a 0 % window). The region is the buyer's own statement: no input of the shop confirms it, so it is not checked
  against the card or the visitor's country the way the country is. The session also keeps `ip_country`, the visitor's country read by the controller
  from the header named by `GEOIP_COUNTRY_HEADER` (`countryFromHeader`, only when the setting is set, else null; the edge removes a
  visitor's own copy of that header). A guest is refused by a blocklist entry limited to guest checkouts (the same neutral
  `ACCOUNT_SUSPENDED`); a signed-in account is not.
- **Status** (RESOLUTIONS b2c-14): `open | paid | expired`; an `open` session past `expires_at` reads `expired` for every reader at
  once without a job (`effectiveStatus`); `paid` is feature 16's.
- **Read** (`GET`): the capability guard of the identity module resolves the token (`CheckoutTokenResolver`, registered in
  `onModuleInit`): the row is found by the keyed hash of the token (`checkout_sessions.token_hash`, decision 054) and the stored hash is
  compared with the presented token's in constant time; a session written before decision 054 is found by its plain `token` until the
  seal pass ran. The token is stored only as that hash and an AES-GCM copy (`token_enc`, AAD `checkout_sessions.token_enc`), which the
  session view reveals (`CapabilityTokenVault`). One
  answer (`404 NOT_FOUND`, "This link is not valid.") for an unknown, malformed or nearly-right token; lookups are limited to 30 a
  minute per address by the pipeline. The view: status, expiry, the service, quantity, masked IMEI and email, the country, currency,
  rate and tax rate, the amounts in USD and in the buyer's currency (`gross` is what is charged), the consent state and the active
  B2C payment methods. The locked numbers never change after the session opens, whatever staff do to prices, tax or rates.
- **Consents** (RESOLUTIONS b2c-12, b2c-14): body `{ consents: [{ purpose, granted }] }`; purposes `terms`, `privacy`,
  `refund_policy`, `withdrawal_waiver`, `marketing`. Each record stores the subject (`account` and the id of the checkout session's account, the guest row of a guest checkout included), the current legal
  document of the purpose's type, the version in force (`terms`, `privacy`, `refund_policy` -> `terms`, `privacy`, `refund`; the waiver and
  marketing have no document), the session, the buyer's IP and user agent and the clock's time. Records are
  append only: a withdrawal is a new row with `granted = false`, the latest row of a purpose decides, and repeating the same
  answer for the same text is a retry that writes nothing. Required before payment: `terms`, `privacy` and, while the policy
  `withdrawalWaiver` is on, `withdrawal_waiver` (`consent.complete`). `422` for a purpose listed twice or without a published
  text; `409 INVALID_TRANSITION` on a paid or expired session. The route needs no anti-bot token: the capability token in the path
  is the credential.
- **Who the buyer is** (decision 064; scenario b2c-account). A checkout belongs to one account row, and `checkout_sessions.account_id` names it. `OptionalAccountSession` (identity's port,
  called by `CheckoutController`) answers the retail account of a usable full session, after the CSRF check (`403 CSRF_FAILED` before anything is written),
  or nothing; a session of a merchant rank is refused with `403 RANK_NOT_ALLOWED` and nothing is written (a merchant orders through the portal).
  - **Signed in (retail rank):** `CheckoutSessionService` holds the account row `FOR KEY SHARE` and reads the rank after the lock. **Open** answers
    `422 VALIDATION_FAILED` on `email` ("Use the email of your account, or sign out to check out as a guest.") when the typed email is not the account's (any
    case), skips the `guestCheckout` switch, sets `opened_signed_in` and the session's account. **Consents** records `marketing` for an account holder
    only when the request carries the signed-in session of the checkout session's own account, and then also sets `clients.marketing_opt_in` to the
    recorded answer (as `PATCH /store/v1/me` does); any other request keeps the guest rule. The screening of the payment of a signed-in checkout uses the
    account's own history; a guest checkout's does not, even with the email of an account (decision 050).
  - **Signed out:** the buyer is the **guest row** of the typed email, made or reused through `AccountDirectory.findOrCreateGuest` (guest partition only;
    `ON CONFLICT DO NOTHING` on the unique guest `lower(email)` index, so two checkouts racing on a new email make one guest row). It is never the login account
    that holds the same email, whatever its rank, and its checkouts, consents and payments attach to nothing of that account until the mailbox is proven
    (the claim, below). First the login row of the typed email is asked for: one that may not act (suspended, blocked, erased) is refused with the answer of a
    blocklist hit (`403 ACCOUNT_SUSPENDED` with one neutral detail, scenario b2c-account step 8) and **no guest row is made**.
  - **Pay from the store balance** takes the account row (key share), then the session, and needs the retail rank at that moment; the **capture** of a card payment
    takes the payment, then the account row (key share), then the session, and never refuses for rank (the money is already there).
  - **Consent records** carry the subject (`account`, id) of the session's account; the old guest creation of the consent route is gone.
  - **Rank change and claim.** This module registers two things at boot (API process): the rank change blocker `open_checkout` (`OpenCheckoutGuard`: a checkout
    opened signed in by the account, neither paid nor expired; a checkout of a guest row blocks nothing) and its participant of the guest claim
    (`CustomersGuestClaimParticipant`, name `customers`: checkout sessions and consents move to the account; rows are taken `FOR UPDATE NOWAIT`, and an open
    checkout session of the guest row refuses the claim with `GuestClaimBusy`).
- **Anti-bot**: opening a session is `turnstile: true` (decision 034).
- **Pay** (feature 16, scenario b2c-paid steps 4 and 5): `POST /store/v1/checkout-sessions/:token/pay`, body `{ gateway, returnUrl }`, header `Idempotency-Key` (required, ALIGNMENT § 7), answer `201 { payment, gateway, paymentUrl }`.
  `CheckoutPayService` judges the checkout and hands the money side to the money module's `StorefrontPayments.start`: a replay of an earlier call (same key, same body) answers before any check, so a retry after the session expired still receives the page it missed
  (`Idempotency-Replayed: true`); otherwise the session must be `open` (`409 INVALID_TRANSITION` for a paid or expired one), its account `active` (`403 ACCOUNT_SUSPENDED`), its service still on sale (sellable, listed and with a retail price, `assertServiceOnSale`: else `409 INVALID_TRANSITION` "This service is no longer available. Start again.", before any payment row or gateway call; a changed price is not a reason, the lock holds, and money that already arrived is still captured) and every required consent granted (`422` on `consent`), the method one of the shop's whose limits take the amount
  (`422` on `gateway`); another body under the key is `409 IDEMPOTENCY_KEY_REUSED` (also after the payment was captured, failed or held), a call still opening its page `409 IDEMPOTENCY_IN_PROGRESS` (a call whose page is still empty after 60 s starts over), a page that opens after its payment was written off `409 INVALID_TRANSITION`; a gateway that cannot open its page is `502 GATEWAY_ERROR` and frees the key. 3-D Secure is asked of a card when the policy `require3ds` is on (the default) and the gateway supports it.
  Decision 048: `returnUrl` must be on a shop origin (the origin of `STORE_BASE_URL`, of `PORTAL_BASE_URL` or one of `SHOP_ORIGINS`; no user name or password), else `422` on `returnUrl` (`not_shop`), checked first (a replay with such an address is refused too; `isShopAddress` in `domain/checkout.ts`); a checkout keeps at most 3 live payment pages (`429 RATE_LIMITED`, `Retry-After: 60`; a page that failed, was paid or is held frees its place); an amount the method cannot charge exactly is `422` on `gateway` (`not_chargeable`); the card page closes 30 minutes after the checkout's price lock ends (`lockEndsAt` = `expires_at`).
  **No order exists after this call**: B2C never dispatches before payment.
- **Capture** (scenario b2c-paid steps 6 to 8): `CheckoutCaptureService` fills the money module's capture slot at boot; the signed payment confirmation calls it inside its own transaction, under the payment row's lock, with the gateway's own record of the payment read before the transaction (decision 048). The order of checks: a payment whose money is being sent back (or was) changes nothing; a record that names another checkout: held before any other check, whatever else the record says, nothing sent back and its reference left free (it is that checkout's payment, and its own confirmation still captures); a record whose latest charge was refunded (in full or in part) or is disputed since: held, nothing sent back, marked as money received; the session's lock (no checkout: held, money sent back when possible); a record that does not say paid (or could not be read for 24 hours): held; the record's or the event's amount and currency must be the quote's and stated: else held and sent back; a gateway reference another payment has: held. Then it
  records a second confirmation for a paid session as a duplicate and refunds it, and otherwise places the order through the orders module's `CustomerOrderPlacement` (locked net, VAT and rate from the session, the IMEI decrypted with `CHECKOUT_IMEI_AAD`, a 22-character tracking token,
  stock codes delivered at once), books the payment and marks the session `paid` with its `order_id`. A payment made more than 30 minutes after the session's price lock ended (judged on the gateway's charge time, else the event's own time, else when the payment opened) is not used at the old price: the screening gets the review reason "Paid N minutes after the checkout's price lock ended", the order is placed `held` and refunded at once as the system when the gateway can refund (`refundBlocked` with `LATE_REFUND_REASON`, `order.failed`, no `order.received`), else it waits in the risk queue. Every captured payment is first screened by the risk module (`RiskScreening.assess`, feature 18): `review` places the order `held` (no dispatch, the hold sentence on the timeline), `block` places it `held` and refunds it at once as the system (`RiskDecisionsService.refundBlocked`, no `order.received` email); the buyer's `order.received` email (and `order.completed` for an order delivered from stock) is written in this transaction by the money module's `StorefrontMails`, and the receipt PDF is a `receipt.render` job queued here.

## The shop's account routes (feature 14b, decision 064)

Built: the retail account's sign-in and own routes on the `/store/v1` family, the staff routes that block, export and erase an account, and the 410 answers of
the old customer routes. The sign-in itself belongs to the identity module (one use case for every rank); the controllers here only call its ports.

- **Layout.** `CustomersAccountsModule` (database and cache; listed in `NEEDS_DATABASE_AND_CACHE` of `test/support/app.ts`) holds the controllers
  (`controllers/store-auth.controller.ts`, `store-account.controller.ts`, `store-two-factor.controller.ts`, `smart-sign-in.controller.ts`,
  `account-privacy.controller.ts` and the two retired ones, `customers.controller.ts` and `customer-privacy.controller.ts`), the use cases (`application/`), contracts
  in `contracts/`, pure rules in `domain/` and Drizzle queries in `infra/`. It imports `MerchantAuthModule` (which binds and exports the identity ports
  `AccountSignIn`, `AccountLinkSignIn`, `AccountOwnPassword`, `AccountTwoFactorSetup` and `AccountOwnProfile`), the risk services, the money admin services
  (`WalletErasure`) and the failed-sign-in lock; customers may import identity, never the reverse (decisions 032 and 052). The module sends no mail itself: the
  links of an account are identity's (`AccountMailOutbox`), and `CustomerSecurityNotices` (`application/mail/`) is kept without an injector.
- **Sign-in routes** (all answer `Cache-Control: no-store`; `store-auth.controller.ts`): `POST /store/v1/auth/magic-link` and `POST /store/v1/auth/verify` (the emailed sign-in
  link, retail rank only; asking never tells whether an address has an account, and `verify` takes `claimGuestOrders` and answers `next`, `claimedOrders` and
  `claimSkipped`), `POST /store/v1/auth/login`, `POST /store/v1/auth/password/forgot`, `POST /store/v1/auth/password/set` and `POST /store/v1/auth/logout` (aliases of the use
  cases of `/client/auth/*`, retired by the contract release), and `POST /store/v1/me/password` (the retail own change). `magic-link`, `login` and `password/forgot`
  are `turnstile: true` (decision 034); `POST /store/v1/auth/verify` and `/login` need an `Origin` of the shop (`originCheck`, decision 045). `POST /auth/magic-link`
  sets the HttpOnly cookie `gsm_store_link` (`__Host-` when secure; one hour like the link; a value it made before is kept) for every email alike, and the link row keeps
  its keyed hash (`auth_tokens.browser_hash`); `verify` signs that browser in as before (`requestedHere: true`), a link asked for elsewhere is `409 CONFLICT` while the
  browser holds a live session of another account, and both answers carry `maskedEmail`. Rate limits, the email lock, the one argon2 verify per attempt, the two-step
  code step and the claim are described in the identity README ("Accounts, sign-in and the rank gate"); this module does not repeat them.
- **The one sign-in form** (`POST /client/auth/sign-in`, `SmartSignInController`, `contracts/smart-sign-in.contracts.ts`, feature 24A). The route sits under `/client`
  for the Origin check (login CSRF), the per-IP limit and no shop-maintenance scope; every account signs in from it. Its answer is `{ kind, next, rank }` (`rank.kind`
  tells the shop which area to show; `kind`, `merchant` or `customer`, stays until the contract release), with `Cache-Control: no-store`. The use case is identity's
  `AccountSignIn.signIn`.
- **Account** (`CustomerAccountService`, `StoreAccountController`): `GET|PATCH /store/v1/me` answer `AccountMe`, the same shape as `GET /client/auth/me` (identity's
  `AccountOwnProfile.meOf`; name, phone and country with the staff edit's rules, feature 24B: `domain/profile-edit.ts` judges "changed" against the locked row,
  `CustomerProfileRules` refuses a changed country with no current tax rate (`422` on `country`) and re-derives the currency unless the request sends one; email is not editable;
  no audit row; the currency (a store-visible one) and the marketing consent, whose change writes an immutable `consent_records` row with the request address). The profile
  write goes through `AccountOwnProfile.saveRetailProfile` under the account row lock. `GET /store/v1/me/orders` lists the account's shop orders through the orders module's
  `ShopOrders` port (the door `store` only; a merchant's portal order is not listed there). A merchant rank is refused on these routes with `403 RANK_NOT_ALLOWED`: it reads its
  account and orders on the `/client` family.
- **Two-step sign-in** (`StoreTwoFactorController`): `POST /store/v1/me/2fa/setup`, `/enable` and `/disable` run identity's `AccountTwoFactorSetup`, the same use case as
  `/client/security/2fa/*`; an account without a password is told `409 CONFLICT` "Choose a password first."; answers that carry a secret say `Cache-Control: no-store`.
- **Retired routes** (`customers.controller.ts`, `customer-privacy.controller.ts`; decision 064): the twelve rows of the map under `/admin/customers` stay registered during the
  expand release and answer `410 ROUTE_RETIRED` naming the account route to use, with nothing read or written (`routeRetired` in `application/customer-errors.ts`). The access check
  of the route (session, permission, CSRF token) and the validation of its old contract still come first, so a request the old contract refuses is `422` and a valid one is `410`.

  | Retired route | Use instead |
  |---|---|
  | `GET /admin/customers`, `GET /admin/customers/:id` | `GET /admin/clients`, `GET /admin/clients/:id` |
  | `POST /admin/customers`, `PATCH /admin/customers/:id` | `POST /admin/clients`, `PATCH /admin/clients/:id` |
  | `POST /admin/customers/:id/account` | `POST /admin/clients/:id/account` |
  | `POST /admin/customers/:id/password`, `POST /admin/customers/:id/sessions/revoke` | `POST /admin/clients/:id/password`, `POST /admin/clients/:id/sessions/revoke` |
  | `POST /admin/customers/:id/suspend`, `POST /admin/customers/:id/reactivate` | `PATCH /admin/clients/:id` with `status` |
  | `POST /admin/customers/:id/block`, `GET /admin/customers/:id/export`, `POST /admin/customers/:id/anonymize` | the routes of the next section |

  The contract release deletes the controllers; the rows are listed in `test/contract/retired.ts` with this decision.
- **Foreign reads** (decision 016 deviation, one file `infra/foreign-reads.repository.ts`): `currencies`, `tax_rates`, `orders`, `sessions`, `legal_documents`,
  `risk_assessments`, `refunds`, `disputes`, `support_tickets` and `blocklist_entries` are read with plain selects; replace the bodies with their services as they appear.
  The account rows themselves are read through identity's `AccountDirectory` and `CustomerDirectory` (below), never by an equality on `clients.email` here.
- **Seed** (`scripts/seed/customers.ts`, decision 064): the demo's customers are retail accounts, the customer number plus 100 (`c1` is account 101), each with its row in the legacy
  id map, and the guests of left checkouts are guest rows from number 900000. `seedCustomerDevCredentials` gives the retail accounts that came from a demo customer the password
  `demo-password` in development only (on the `clients` row; the report line is `clients (passwords)`). The storefront orders (and so `ordersCount` and `total_spent`) come with 14a and 16.

### Block, privacy read, export and erasure of an account (feature 18, decision 064)

`AccountPrivacyController` (in `CustomersAccountsModule`) holds the four staff routes of `/admin/clients/:id` that were the customer page's; the use cases are
`application/customer-block.service.ts` and `application/customer-privacy.service.ts`, the pure rules in `domain/customer-privacy.ts` and `domain/customer-export.ts`, and
the reads and writes that reach other modules' tables in one file, `infra/privacy-reads.repository.ts` (decision 016 deviation, like the foreign-reads file). They work on
the one account row: block, the privacy read and the export serve every rank; the erasure serves the retail rank only.

- **Block** (`POST /admin/clients/:id/block`, `clients:block`, RESOLUTIONS b2c-5, B48): `{ blocked: true, reason }` (one of the console's four reasons) sets `blocked`, appends
  `Blocked: <reason>` to the internal notes and, through identity's `AccountAccessEffects.statusChanged`, ends every session and stops every live API key. Through the risk module's
  `Blocklist` it adds manual entries with the reason, the caller and `account_id`: the email, each distinct card fingerprint of the account's payments, and each distinct IMEI (the main input, and decision 073 the values of fields of type `imei`) still
  stored on its **shop** orders and checkout sessions, **never the IMEIs of portal or Dhru orders** (a merchant orders for other people's devices); each insert is
  `ON CONFLICT DO NOTHING`, so an existing entry stays as it is and is not linked. `{ blocked: false }` sets `active` and deletes only the manual entries `WHERE account_id = :id`.
  `ALREADY_BLOCKED`, `NOT_BLOCKED`, `ANONYMIZED` are `409`.
- **Privacy read** (`GET /admin/clients/:id/privacy`, `clients:read`): the marketing choice, the consent records of the latest shop order and the risk signals of the account,
  through the port `AccountPrivacyReads` (`privacyOf`; implemented by `AccountPrivacyReadsService`, so the identity module's staff detail reads it without importing this
  module). A consent's `document` is an empty string when its purpose has no legal document (the console reads empty as none; the old customer detail sent null).
- **Export** (`GET /admin/clients/:id/export`, `customers:privacy`, RESOLUTIONS b2c-8): the download `account-<id>.json`, **format 4**: the profile (with `rank`), orders with their IMEI,
  payments without card data, consents, checkout sessions, support tickets with their public messages (only a ticket whose requester's address is confirmed:
  `requesterProven()` of the support schema, decision 053), files, data requests (what the account gave and did: no internal notes, suspension reason or blocklist entries), a
  `merchant` section for a merchant rank and the `wallet` figures; `profile.firstOrderAt` and `profile.totalSpent` are gone (nothing wrote them). When the account is retail,
  has a login and has a proven email, the guest row of that email is the same person's earlier shopping: the export lists it in its own section (`ordersPlacedAsGuest`). It
  closes the account's waiting export request, is audited `exported data of` and keeps no copy of the file. The contract sets `originCheck: true`: the CSRF guard asks for
  `Sec-Fetch-Site: same-origin` or an `Origin` that is one of the console's origins (`CONSOLE_ORIGINS`), else `403 CSRF_FAILED`.
- **Anonymize** (`POST /admin/clients/:id/anonymize`, `customers:privacy`, B50, RESOLUTIONS b2c-4): irreversible and **for the retail rank only** (`409 CONFLICT` for a merchant rank:
  its wallet, hold, credit and keys are settled by the rank change first). The account row is locked first. Name `Deleted account`, email
  `deleted-account-<id>@redacted.invalid` (an account id and an old customer number are different things, so the old pattern `deleted-<id>@...` could collide), phone and
  notes cleared, marketing off, the account closed (the password and the two-step secret cleared, sessions revoked, links voided, every API key revoked); the IMEI of its orders and
  checkout sessions is cut to the TAC and a mask; the sessions' visitor country (`ip_country`) is cleared with the address (decision 050); the erasure request is completed; payments
  and ledger entries stay. **The guest row of the same proven email is erased in the same transaction** (the account row locked first, the guest row second), and the whole erasure is
  refused while that guest row has an open checkout or a pending payment. The money side closes last through money's `WalletErasure.closeForErasure` (refused while a wallet or a hold of
  either kind is not zero, a wallet is on hold, a top-up waits for review, a top-up dispute is open, a balance-paid order is open or a refund to the balance waits for staff; an open
  order paid by card does not hold the erasure). The audit row names the account by number (the log is append-only). Other modules clear what they hold through
  `AccountErasureHooks` (run in the same transaction; the support module registers its ticket-link hook and this module's inbox hook, below). Afterwards the account's checkout links
  (`CheckoutTokenResolver`) and order tracking links (the status, the result and the receipt, through `TrackingCustomerPorts` of the orders module) answer `404` like unknown links, and the
  ticket form refuses their order link (`422`).
- **Blocklist check of a staff create.** `AccountBlocklistGuard` registers the check `blocklist` with identity's `AccountCreateGuards` (API process only): staff cannot create an account for a
  blocked email (`422 VALIDATION_FAILED` on `email`, "This email is blocked.").

## Funnel report (feature 19)

Built: `GET /admin/reports/funnel`. Files: `growth.module.ts` (the route), `controllers/growth.controller.ts`, `contracts/growth.contracts.ts`,
`application/funnel-report.service.ts`. Rules: RULES checkouts, ANSWERS checkouts, resolutions `b2c-10` and `b2c-14`.

- **Funnel**: `FunnelReportService` calls `storefrontFunnel(db, now, days)` for `days` 7, 30 (default) or 90 (`422` on `days` otherwise), the same
  function as the dashboard's storefront block.
- **Seed**: `scripts/seed/growth.ts` writes the demo's 238 checkouts (ids 3000 and up, one guest customer per address, the mock's marketing answers);
  the paid ones have no order until feature 16's seed.

### Retired: the abandoned-checkouts list and the reminder (decision 062)

The list of abandoned checkouts for staff, the manual recovery email, the automatic reminder (job `checkout_recovery_sweep`, scheduler
`checkout-recovery-sweep`, outbox event `checkout.recovery`), the customer email `checkout.abandoned`, the storefront policy `abandonedMinutes` and the
staff permissions `growth:read` and `growth:send` are gone. `GET /admin/checkouts/abandoned` and `POST /admin/checkouts/recover` are rows of the
map, so they stay in the route manifest and are listed in `test/contract/retired.ts`. The column `checkout_sessions.recovery_emailed_at` stays in the database
and in the Drizzle schema, unread and unwritten. The worker lists the old scheduler as retired (`WorkerModule`), so it is removed from Redis
at boot. The checkout itself, the funnel and the marketing consent (below) are unchanged.

## Notification center audience (feature 23)

`notifications/customer-audience.ts` is the retail audience provider of the platform's notification center, registered with
`NotificationAudiences` by `CustomerNotificationsModule` at boot (imported by `CustomersModule` and the worker). It selects active
accounts of every rank except a merchant rank, guests included (suspended, blocked and anonymized ones never), by account and country, and for a marketing campaign only those
whose `marketing_opt_in` is on and whose latest marketing consent record grants it (`consentSql` in `infra/consent.repository.ts`, a condition over `clients` with the subject (`account`, id): the latest `marketing` record is a grant AND the account's own `marketing_opt_in` is on; a switch turned off by staff stops the mail even without a withdrawal record). **No campaign of any purpose (a service campaign
too) reaches a customer whose address was never proven** (`provenAddressSql`, decision 053: `clients.email_verified_at` is set by a used sign-in or verification link or an accepted invitation, or a checkout of the customer has `status = 'paid'`), so guest
rows made from typed addresses that nobody confirmed are never written to (the answer recorded at a guest checkout stays as proof and counts from the moment the address is proven; every marketing mail carries the unsubscribe link and header); the preview's "no consent" count keeps that condition. The
same predicate answers the preview count, the fan-out's pages and the send-time check, so consent withdrawn after the fan-out stops the
message. The provider only reads `clients` and `consent_records`.

The same module holds the other two customer parts of the center. **Unsubscribe:** `POST /store/v1/marketing/unsubscribe/:token`
(`notifications/unsubscribe.*`, public, no CSRF, no anti-bot token: mailbox providers call it for RFC 8058 one-click, the site's page
with no body) verifies the token (a keyed MAC over the account id, `marketingUnsubscribeToken` in the platform: a new token signs `marketing-unsubscribe:account:<id>`, and a token sent before the merge names an old customer number and is read only through the legacy id map), and in one transaction
under the account's row lock sets `marketing_opt_in` false and adds a `consent_records` row (`granted: false`, the caller's address and
user agent) when the account had consented; idempotent, `204` for an unknown or anonymized account, `410 TOKEN_INVALID` for a bad
token. **Erasure:** `CustomerInboxErasure` registers with `AccountErasureHooks` (`eraseAccount`) and calls the platform's `NotificationPrivacy` inside
`POST /admin/clients/:id/anonymize`'s transaction: the account's inbox items are deleted and their log rows' payloads emptied.

## Public API (`index.ts`)

Exports the checkout rules `CHECKOUT_SESSION_TTL_MINUTES`, `CHECKOUT_IMEI_AAD`, `LEGAL_TYPE_OF_PURPOSE`, `effectiveStatus`,
`requiredConsents`; `storefrontFunnel(db, now, days)` (`storefront-funnel.ts`, resolution b2c-10: a read-only count of the
storefront funnel, checkouts started, paid, delivered, over the last `days` days, shared by the dashboard's storefront
block of feature 9 and the funnel report of feature 19); the modules `CustomersModule`, `CheckoutModule`,
`CustomersAccountsModule`, `GrowthModule` (the app's test builder replaces those that need a database when there is none), `CustomerErasureModule` and
`AccountErasureHooks` (a global class token; modules that hold personal data of an account register an `AccountErasureHook` with `eraseAccount(tx, accountId)`
that runs when the account is anonymized), `CustomerNotificationsModule` and `CustomerAudience`, the one-off `CheckoutTokenSeal` with its job names, and the port
`AccountPrivacyReads` with its types `AccountPrivacy` and `AccountConsentRecord` (below). The mails of an account's links are not exported from here any more: they are
identity's (`AccountMailOutbox`, decision 064), and the module list of the worker no longer holds a customer mail module.
`CustomerDirectory` with its `OrderLinkStanding` type (`application/customer-directory.ts`, no constructor arguments) and `CustomerDirectoryModule`
(`customer-directory.module.ts`): the buyer facts the orders, support and money modules ask about the buyer of a shop order, read from `clients` by account id
(`buyerOf`, `isErased`, `orderLinkStanding`). A guest row is made or found through identity's `AccountDirectory.findOrCreateGuest` (it is gone from this class), so no
module inserts into `clients` outside identity. `orderLinkStanding` answers for a storefront order link, with the `OrderLinkStanding` type: whether the link speaks
for the order's buyer (the account opened the checkout signed in, or the buyer row has no login), whether the account was anonymized, and whom the order's receipt names (the
account's stored name only for a checkout opened signed in, else the address the checkout was opened with). `CustomerDirectoryModule` (loaded by the API and the worker)
registers it in the slots of orders (`TrackingCustomerPorts`) and money (`ReceiptBuyerPorts`).
Feature 16 reads a session through its own use case in this module. Add the services other modules may call here, and nothing
else: other modules import only `src/modules/customers/index.ts` (lint rule `gsm/module-boundaries`).

**The privacy port.** `AccountPrivacyReads.privacyOf(db, accountId)` (`ports/account-privacy-reads.ts`, a class with no dependencies) answers the marketing choice, the
consent records of the latest shop order and the risk signals of an account; `AccountPrivacyReadsService` implements it and the module binds it with `useExisting`. The staff
detail of the identity module and `GET /admin/clients/:id/privacy` read it.

## Owned tables

Only this module reads and writes these 2 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts`. The old `customers` and
`customer_credentials` tables stay in this schema file as `retiredCustomers` and `retiredCustomerCredentials` (frozen by the `customers_retired` and `customer_credentials_retired`
triggers, unread and unwritten) until the contract release drops them and joins them to the module map's `retiredTables`.

| Table | What it holds |
|---|---|
| `checkout_sessions` | The payment session before any order exists: the price, tax and exchange rate are locked in, and the order is created after payment. `account_id` names the account row (a guest row for a guest checkout) and replaces `customer_id` (`retiredCustomerId`, unwritten). |
| `consent_records` | Proof of consent: terms, privacy, marketing and the withdrawal-right waiver, with the IP address and the time. The subject is (`account`, id); the proof columns of a row never change. |

## Routes

Admin: `GET /admin/reports/funnel` and the four routes of `/admin/clients/:id` for block, privacy read, export and anonymize (`POST /admin/clients/:id/block`,
`GET /admin/clients/:id/privacy`, `GET /admin/clients/:id/export`, `POST /admin/clients/:id/anonymize`, routes beyond the map: `scripts/map-additions/48-accounts.mjs`, decision 035); the twelve rows
of the map under `/admin/customers` are registered and answer `410 ROUTE_RETIRED` (above). Store: the checkout (6 routes with `/pay` and `/balance-payment`), the shop's sign-in and account
routes (above), the three two-step routes and `POST /store/v1/marketing/unsubscribe/:token`. Source of the map's rows: `docs/slices/customers.json` (generated from the map;
`bun run routes:build`); the endpoint pages under `docs/contract/endpoints/` are generated.

### Storefront (B2C)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /store/v1/checkout-sessions/:token` | checkout-token | Session status, the locked price and the available payment methods. | 14 |
| `GET /store/v1/me` | customer-session (retail rank) | My account: details, rank, currency and marketing consent (`AccountMe`). | 14 |
| `PATCH /store/v1/me` | customer-session (retail rank) | Change name, phone, country, currency and marketing consent. | 14 |
| `GET /store/v1/me/orders` | customer-session (retail rank) | My shop orders. | 14 |
| `POST /store/v1/auth/login` | public | Sign in with email and password (alias of the one sign-in; retired by the contract release). | 14 |
| `POST /store/v1/auth/logout` | customer-session, any rank | End the session (alias of the one sign-out). | 14 |
| `POST /store/v1/auth/magic-link` | public | Email a sign-in link instead of a password (retail rank only; the answer never says whether the address has an account). | 14 |
| `POST /store/v1/auth/password/forgot` | public | Request a password reset link; the answer is always the same, so no registered email is revealed. | 14 |
| `POST /store/v1/auth/password/set` | link-token | Set the password with an invitation or reset token (valid one hour, single use); ends older sessions. | 14 |
| `POST /store/v1/auth/verify` | link-token | Exchange a sign-in link token for a session; verifies the email on first use; may claim the records of the guest row of the address. | 14 |
| `POST /store/v1/checkout-sessions` | public + optional session | Open a checkout as a guest or from the account (service, IMEI, email, country); locks the price, tax rate and exchange rate. | 14 |
| `POST /store/v1/checkout-sessions/:token/consents` | checkout-token | Record consent to the terms, the privacy policy and the waiver of the withdrawal right. | 14 |
| `POST /store/v1/checkout-sessions/:token/pay` | checkout-token | Start payment (3DS card, wallet or crypto); the order is not created before the webhook confirms the payment. | 16 |
| `POST /store/v1/checkout-sessions/:token/balance-payment` | checkout-token + retail session and CSRF | Pay the checkout from the signed-in account's store balance. | 21 |
| `POST /store/v1/me/password` | customer-session (retail rank) | Change the password from the account by entering the current one; signs out the other devices. | 14 |
| `POST /store/v1/me/2fa/setup`, `/enable`, `/disable` | customer-session (retail rank) | Two-step sign-in, the same use case as `/client/security/2fa/*` (routes beyond the map). | 14 |
| `POST /client/auth/sign-in` | public, Turnstile, Origin check | The one sign-in form for every account: answers `{ kind, next, rank }` and opens the one session. | 24A |

### Paying from the store balance (feature 21)

`CheckoutBalancePayService` (route `POST /store/v1/checkout-sessions/:token/balance-payment`, plan 21 § 5.6.6): the account id comes from
the cookie session (`OptionalAccountSession`, CSRF checked; none is `401`; a merchant rank is `403 RANK_NOT_ALLOWED`), never from the checkout row; the checkout must belong to that
account and have been opened signed in (`checkout_sessions.opened_signed_in`, set by `open`; else `403`). One transaction: take the account row `FOR KEY SHARE` and read the rank after it
(the retail rank is required at that moment) → lock the session → replay by `Idempotency-Key` (a `/pay` key is `IDEMPOTENCY_KEY_REUSED`) → switch (`WALLET_DISABLED`) → the `/pay` checks (paid,
expired or no longer on sale `INVALID_TRANSITION`, consents) → a friendly balance/hold pre-check → risk screening (`paymentMethod: 'balance'`) →
`CustomerOrderPlacement.place` whose `onInserted` calls money's `CustomerWalletPayments.record` (payment row, `b2c_wallet_pay` guarded
under the wallet lock, receipt) → `markSessionPaid` → mails, or `refundBlocked` (back to the balance). The checkout view has
`balancePayable` (switch on and opened signed in; never the balance). Maintenance scope `checkout` covers the route. Anonymize calls
`WalletErasure.closeForErasure` last (see "Block, privacy read, export and erasure of an account"); the data export adds `wallet`.

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/e2e/`).

- `b2c-paid`: Paid storefront order (tables: `checkout_sessions`, `consent_records`, accounts)
- `b2c-chargeback`: Chargeback dispute that we lose (tables: `consent_records`, accounts)
- `b2c-account`: Managing a storefront account (tables: `checkout_sessions`, accounts; the map's `customer_credentials` is retired)
- `ip-rules`: IP block list and allowlist (tables: `checkout_sessions`)
- `system-integrity`: Ledger mismatch and maintenance mode (tables: `checkout_sessions`)

## Permissions

Staff permissions this module's admin routes require: `clients:block` (block), `clients:read` (the privacy read), `customers:privacy` (export, anonymize) and `reports:growth` (the funnel). The
twelve retired customer routes keep their old permissions (`customers:*`, `customers:password`, `customers:suspend`, `customers:update`, `customers:block`, `customers:privacy`) for their access check only. Audit entity type written: `account`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events and jobs

Outbox events produced: none. The links of an account (sign-in, invitation, reset, verification) and their mails are identity's: the event types `customer.magic_link`,
`customer.password_reset`, `customer.invited` and `customer.email_verification` (and the `merchant.*` family for a merchant rank) are queued by `AccountMailOutbox` and handled by `AccountMailJobs`
(`docs/queues.md`, notifications); a job that names only an old customer number is discarded and the number is never read as an account id. The checkout routes write none.
This module registers one job: the one-off `checkout_tokens_seal` (below, "Link tokens at rest").

## Cache keys

None of its own. The email lock is identity's (`SignInLock`, key `gsm:{env}:identity:sign-in-failures:{emailHash}`, decision 052). Sessions use identity's session keys
(`gsm:{env}:identity:session:{tokenHash}:v2`), and the per-email-and-network sign-in limit uses the rate-limit keys of decision 021. A checkout session, its consents and the
guest row are decision-making state and are read from Postgres every time.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-1` · GET /admin/customers, GET /admin/customers/:id, POST /admin/customers, PATCH /admin/customers/:id
- `b2c-4` · POST /admin/customers/:id/anonymize
- `b2c-5` · POST /admin/customers/:id/block
- `b2c-8` · GET /admin/customers/:id/export
- `b2c-10` · GET /admin/reports/funnel
- `b2c-11` · GET /admin/customers/:id, GET /admin/risk/queue
- `b2c-12` · GET /admin/customers/:id
- `b2c-14` · GET /admin/customers/:id, GET /admin/legal-documents
- `b2c-16` · POST /admin/customers, PATCH /admin/customers/:id

The `/admin/customers` addresses named in this list answer `410 ROUTE_RETIRED` since decision 064; the same rules hold on the routes of `/admin/clients/:id` that replace them.

## Link tokens at rest (decision 054)

The checkout token is stored as `token_hash` (`CapabilityTokenVault.hashOf('checkout', …)`, keyed with `LOOKUP_HASH_KEY`) and `token_enc`
(AES-GCM, AAD `checkout_sessions.token_enc`); `token` keeps the plain form only for rows written before, and a check keeps exactly one
form per row. The tracking tokens of `GET /store/v1/me/orders` are revealed from `orders.public_token_enc` (or the plain column of an
order placed before). The one-off pass `CheckoutTokenSeal` (job `checkout_tokens_seal` on `maintenance`, `CheckoutTokenSealModule`, worker
only) is asked for once by migration `capability_tokens_seal`: it seals each row that still holds a plain token in one guarded `UPDATE`
(`updated_at` kept) and records a `job_runs` row (trigger `event`).
