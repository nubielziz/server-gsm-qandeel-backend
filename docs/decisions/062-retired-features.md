# 062: Retired features of the merchant side

Status: accepted, 2026-11-23. Builds on decisions 061 (the retired-route list and a data-only migration), 035 (routes beyond the map),
046 (the hold on machine credentials), 053 (the clean-ups and limits of public abuse) and 016 (one module per domain).

**Context.** Merchant accounts are made by the owner, ranks are set by hand, and merchants work through the portal and the Dhru endpoint.
Several features of the merchant side served none of that: nobody signs up or waits for an approval, no plan pays a commission, no merchant
integrates with the REST API v1 or receives outgoing webhooks, nobody is reminded of an abandoned checkout, the free IMEI check has no lookup
service behind it, and Telegram, the ticket survey, the typing indicator, the per-device session list and the promotion by spend are used by
no one. Each of them is kept code, tests, routes, permissions and stored rows that cost upkeep and widen the surface. They go together, in one
release, with one data-only migration.

**Decision.** Each removal below takes its routes, contracts, use cases, queries, jobs, schedulers, mails, permissions, seeds and tests with it.
Routes that are rows of the read-only map stay in the route manifest and are listed in `test/contract/retired.ts` (they are not built and no
console function calls them); routes that were additions are deleted from `scripts/map-additions`. Permissions that lose their last route leave
the catalog. Removing a feature never rewrites ledger history: account kinds, transaction kinds and reference types that old journals carry stay
valid, and nothing in `postTransaction`, the append-only rules, the idempotency keys or the lock order changes.

- **Public merchant sign-up and the approval step.** `POST /client/auth/register` is retired with its address limiter, its anti-bot flag and the
  referral code it accepted. A merchant made by staff (`POST /admin/clients`) is inserted `active`, with its wallet and its one-hour invitation
  link; until the merchant chooses a password the console reads the invitation as pending from the security block of the row. The approval mail
  `merchant.approved`, the dashboard item and the sidebar count of merchants waiting for approval go. *Kept:* the email-verification routes (a
  staff change of an address uses them), the invitation, the shop's page that explains how to apply, and, dormant until the accounts model
  rewrites the session guard, the status `pending`, its guard `ACCOUNT_PENDING_APPROVAL`, the pending markers of the routes and the pending upload
  quota. A change from `pending` to `active` stays valid for a row written before, sends no mail and is audited as an activation. The service
  that keeps verification and resend is `MerchantEmailVerificationService`.
- **Commissions and referral links.** The plans, their assignments, the accruals an order produced on completion or refund, the bulk approval that
  paid them, the merchant's two portal pages, the dashboard item of accrued commissions and the in-process hook that ran the engine inside an
  order's transaction go. Retired routes: `GET /client/referrals`, `GET /client/commissions`, `GET /admin/commission-plans`,
  `GET /admin/commission-plans/:id`, `POST /admin/commission-plans`, `PATCH /admin/commission-plans/:id`, `DELETE /admin/commission-plans/:id`,
  `GET /admin/commission-assignments`, `GET /admin/commission-assignments/:id`, `POST /admin/commission-assignments`,
  `PATCH /admin/commission-assignments/:id`, `DELETE /admin/commission-assignments/:id`, `GET /admin/commission-accruals`,
  `GET /admin/commission-accruals/:id`, `POST /admin/commission-accruals/approve`. The permissions of the area `commissions` leave the catalog;
  the error codes `ALREADY_ASSIGNED`, `HAS_PENDING`, `PLAN_IN_USE` and `PLAN_LOCKED` leave the error catalog. The wire loses `referralCode` and `referredBy` on the
  merchant row and `referralCode` on `GET /client/auth/me`. The map's money event `commission` has no builder, so nothing can post one, and a refund or a reopen of an order whose commission was already approved
  and paid into a wallet no longer takes that commission back: the credit stays with the merchant. *Kept:*
  the journals the commissions posted, with the kind `commission`, the reference type `accrual` and the account `commission_expense`, which every
  statement and journal view still reads; `allowBelowCreditLimit` of `postTransaction` (the chargeback clawback of a top-up sets it).
- **The REST API v1 for merchants.** Retired routes: `GET /v1/account`, `GET /v1/services`, `GET /v1/services/:id`, `POST /v1/orders`,
  `POST /v1/orders/bulk`, `GET /v1/orders`, `GET /v1/orders/:id`, `POST /v1/orders/:id/cancel`, `POST /v1/orders/:id/verify`, `POST /v1/files`,
  `GET /v1/files/:id`, `GET /v1/transactions`. Gone with them: the Bearer key access kind, the per-key `RateLimit-*` headers, the cursor paging
  helpers, the `v1` surface (metrics label, traffic list, IP audience, per-IP limiter), the `apiKey` security scheme and the v1 section of the public
  document, the `/v1/*` path of the API host, and the idempotency key written on an order. A key is a Dhru credential: its scopes are no longer
  written, read or sent, and a creation body that still carries `scopes` is accepted with the field ignored. *Kept:* API keys and their routes, the
  Dhru endpoint `POST /api/index.php` and its actions, the portal's own Idempotency-Key with the table `idempotency_keys` and the daily purge (it now
  deletes stored answers only), the order source `v1` and the idempotency scopes `order` and `bulk` for the rows stored earlier. The result file of a
  Dhru file order is opened from the portal (`GET /client/files/:id`).
- **Outgoing webhooks to merchants.** Retired routes: `GET /client/webhooks`, `POST /client/webhooks`, `PATCH /client/webhooks/:id`,
  `DELETE /client/webhooks/:id`, `POST /client/webhooks/:id/test`, `GET /client/webhooks/:id/deliveries`, `GET /admin/webhook-deliveries`,
  `GET /admin/webhook-deliveries/:id`, `POST /admin/webhook-deliveries/:id/retry`, and the three outgoing events of the map
  `EVENT order.status_changed`, `EVENT wallet.low_balance`, `EVENT invoice.paid`. Gone with them: signing, fan-out, delivery and retry, the
  `merchant-webhooks` queue, the daily clean-up of old deliveries, the lost-work pass of deliveries, the test call and the retry limiters, the
  error code `DELIVERY_SUCCEEDED`, the alert metric `webhooks.success_rate` (old alerts that fired with it still read), the notice that an endpoint
  was switched off, the permissions of the area `webhooks`, the `webhooks` section of the public document with its signature scheme, and the
  `outgoing` half of `GET /admin/system/webhooks`. *Kept:* every outbox event of those facts, now consumed by the notifications queue alone, with the
  low-balance mail, the daily prices-changed mail and the order notices; incoming webhooks of payment gateways and suppliers; the outbox; the hold
  of decision 046 on API keys.
- **The abandoned-checkouts list and its reminders.** Retired routes: `GET /admin/checkouts/abandoned`, `POST /admin/checkouts/recover`. Gone
  with them: the automatic reminder every five minutes, its outbox event and customer mail `checkout.abandoned`, the storefront policy that held
  its delay, and the permissions of the area `growth`. *Kept:* `checkout_sessions` and everything checkout needs, the saved basket by its token,
  the funnel report, the marketing consent records and the campaign audience that reads them.
- **The free IMEI check, two risk signals and the customer risk level.** Retired routes: `POST /store/v1/imei/check`, `GET /admin/imei-checks`,
  `GET /admin/imei-checks/:id`. Gone with them: the check log and its staff reader, the nightly retention job, the settings `imeiRetentionDays` and
  `imeiPrecheck`, the IMEI-check step of the funnel and of the dashboard, the guards that protected the log's rows (a supplier delete, a service
  delete, a TAC change), the signals "VPN or proxy" and "blacklisted IMEI" with the rule `blockBlacklistedImei` (they never fired: no data source),
  and the customer risk level (the field, the list filter and sort, the writes of Block and Unblock). The customer export is format 3. *Kept:* the
  blocklist of every kind, the Blocked status with Block and Unblock, the held-order queue, the screening of paid payments with its other signals,
  data requests, the cut of an order's IMEI to its TAC at anonymization, and the TAC catalogue.
- **Telegram for merchants and campaigns.** Retired routes: `POST /client/telegram/link`, `POST /webhooks/telegram/:secret`. Gone with them: the
  linking and the bot's two answers, the Telegram switch of the notification preferences, the Telegram channel of campaigns (its audience rule,
  counters, recipient list and send rate), the Telegram reply of a ticket, the merchant's Telegram texts, `TELEGRAM_BOT_USERNAME`,
  `TELEGRAM_WEBHOOK_SECRET` and the registration script. Values older data may hold are read as "not sent", never as an error. *Kept:* email and the
  inbox; Telegram for the operations alerts to the staff chat (`TELEGRAM_BOT_TOKEN`, `ALERTS_TELEGRAM_CHAT_ID`, the staff texts), which a scenario
  of the map names.
- **The satisfaction survey and the typing indicator of a ticket.** Retired route: `POST /store/v1/tickets/:token/csat`; the three typing routes
  were additions and are deleted. Gone with them: the survey mail and its outbox kind, `csatScore` and `canRate` on the ticket, the dashboard's
  satisfaction figure, the `ticket.typing` live event and its short-lived cache key. A resolve sends nothing. *Kept:* the seen marks and the reply
  mail sweep that reads them, the live stream of new messages, attachments, reply templates, the receipt and the reply mails.
- **The per-device session list of a merchant, the promotion by spend, and unused data.** Retired routes: `GET /client/sessions`,
  `DELETE /client/sessions/:id`. The staff sessions page (`GET /admin/sessions`, `DELETE /admin/sessions/:id`) now lists and ends staff sessions
  only. The nightly promotion of merchants by spend, its scheduler and the spend reader go, and a rank no longer shows or takes an upgrade
  threshold. Gone with them, because nothing used them: the buyer's note of an order (`clientNote`), the order source `admin` for new orders, the
  invoice kind `statement` as a list filter, the notification event `deposit.approved` with its templates, and the unused sign-in counters of
  customers. *Kept:* "sign out everywhere" for a merchant by staff (`POST /admin/clients/:id/sessions/revoke`), ranks set by hand,
  and every value an old row may hold (an order with source `admin`, an invoice of kind `statement`, a consent of subject `client`). The portal
  has no route of its own that ends another session of a merchant: a merchant ends its other sessions by changing its password (which ends them
  all), or asks staff; a portal route for it belongs to the accounts model, if the owner wants one. The Drizzle types `WithdrawalRequest` and
  `NewWithdrawalRequest` are removed because no code names them; the table stays.

**Kept on purpose, beside each removal.** Dhru and API keys, the portal's idempotency, incoming webhooks, the low-balance and prices-changed mails,
seen marks and the live stream of tickets, sign out everywhere by staff, the funnel report, invoices written by staff, the blocklist and risk screening of
payments, checkout, wallets, credit, top-ups, refunds, disputes, guest checkout, privacy export and erasure, consents, two-step sign-in, suspension
and the audit log.

**The migration.** `0065_retired_features.sql`, data only and safe to run twice and on an empty database: merchants still `pending` become
`suspended` with one fixed reason (never `active`), after their sessions end and their open links are cancelled; the permissions of the areas
`commissions`, `webhooks` and `growth` leave every stored role, keeping the order of the others; keys that held scopes without `dhru` are revoked,
so a key made for the retired API does not become a Dhru credential; the stored templates of `merchant.approved`, `webhook.endpoint_disabled`,
`checkout.abandoned`, `support.csat_survey` and `deposit.approved`, and every merchant Telegram text, are deleted; unrelayed outbox events of
retired kinds are marked handled; queued reminders and queued merchant or customer Telegram messages end as failed with a fixed reason; alert rules
on the retired metric are deleted the way the console deletes one; campaigns lose the Telegram channel (a scheduled one that had only it is
cancelled); the retired rule leaves the stored risk rules; the stored settings that are no setting any more, the chat-link tokens and the Telegram
switches of stored preferences are removed; and the rows of the IMEI check log are deleted (they hold an IMEI and an address that nothing erases
any more, and their RESTRICT keys would turn a supplier or service delete into a database error now that the guards are gone). The worker removes
the retired schedulers (`webhook-delivery-retention`, `checkout-recovery-sweep`, `data-retention`, `client-group-promotion`) from Redis at boot.

**What stays in the database, and until when.** These stay in the database and in the Drizzle schema, unread and unwritten, each marked with this
decision, until the migration of the accounts model drops them in one non-additive step: the tables `commission_plans`, `commission_assignments`,
`commission_accruals`, `webhook_endpoints`, `webhook_deliveries`, `imei_checks` and `withdrawal_requests`; the columns `clients.referral_code`
(still NOT NULL and unique, so a new merchant carries its own username in it), `clients.referred_by_id`, `clients.telegram_chat_id`,
`api_keys.scopes`, `orders.idempotency_key` with its two indexes, `orders.client_note`, `refunds.client_id`, `checkout_sessions.recovery_emailed_at`,
`customers.risk_level`, `customer_credentials.failed_attempts`, `customer_credentials.locked_until`, `client_groups.earn_threshold`,
`support_tickets.csat_score` and `support_tickets.survey_sent_at`. Values that old rows may hold stay valid in the CHECK constraints (the order
sources `v1` and `admin`, the invoice kind `statement`, the consent subject `client`, the token purpose `telegram_link`, the Telegram channel values
of campaigns and tickets). A drop is not additive and the map tooling has no seam for a retired table yet; whoever drops `commission_accruals`
keeps the journals it points at.

**Consequences.** The console and the shop stop calling the retired routes and stop reading the removed fields before the backend release
(both work against the backend before and after it); the shop regenerates its API types afterwards. Merchant integrations that used `/v1` or
outgoing webhooks stop at the release. A role cached before the migration (300 seconds) may still grant a retired permission that nothing checks. The cached view of an API key lives under a
new cache key version (`:v2`, `docs/cache-keys.md`), so the new code never reads a view that was cached under the old access rule while the migration
revokes keys in Postgres only; the views of before expire by themselves. What to check on the server before the release, and the one step to take
there (the bot's webhook), is in `docs/OPERATIONS.md`, "Release with decision 062".
The queue Redis may keep jobs of the removed `merchant-webhooks` queue; nothing reads them and they can be deleted by hand.

**Retired routes.** `POST /client/auth/register`, `GET /client/referrals`, `GET /client/commissions`, `GET /admin/commission-plans`,
`GET /admin/commission-plans/:id`, `POST /admin/commission-plans`, `PATCH /admin/commission-plans/:id`, `DELETE /admin/commission-plans/:id`,
`GET /admin/commission-assignments`, `GET /admin/commission-assignments/:id`, `POST /admin/commission-assignments`,
`PATCH /admin/commission-assignments/:id`, `DELETE /admin/commission-assignments/:id`, `GET /admin/commission-accruals`,
`GET /admin/commission-accruals/:id`, `POST /admin/commission-accruals/approve`, `GET /v1/account`, `GET /v1/services`, `GET /v1/services/:id`,
`POST /v1/orders`, `POST /v1/orders/bulk`, `GET /v1/orders`, `GET /v1/orders/:id`, `POST /v1/orders/:id/cancel`, `POST /v1/orders/:id/verify`,
`POST /v1/files`, `GET /v1/files/:id`, `GET /v1/transactions`, `GET /client/webhooks`, `POST /client/webhooks`, `PATCH /client/webhooks/:id`,
`DELETE /client/webhooks/:id`, `POST /client/webhooks/:id/test`, `GET /client/webhooks/:id/deliveries`, `GET /admin/webhook-deliveries`,
`GET /admin/webhook-deliveries/:id`, `POST /admin/webhook-deliveries/:id/retry`, `EVENT order.status_changed`, `EVENT wallet.low_balance`,
`EVENT invoice.paid`, `GET /admin/checkouts/abandoned`, `POST /admin/checkouts/recover`, `POST /store/v1/imei/check`, `GET /admin/imei-checks`,
`GET /admin/imei-checks/:id`, `POST /client/telegram/link`, `POST /webhooks/telegram/:secret`, `POST /store/v1/tickets/:token/csat`,
`GET /client/sessions`, `DELETE /client/sessions/:id`.
