# 12a notifications

> **Lead, before launching the implementer:** (1) write decision 033, mail delivery: SMTP through `nodemailer` (works with
> any provider, SES or Postmark or Mailgun SMTP, no vendor lock-in; the version pinned at least two weeks old), config
> `MAIL_SMTP_URL` and `MAIL_FROM` (decision 013), Telegram through its Bot API over `OutboundHttp` (no SDK), config
> `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`; (2) add Mailpit to `compose.yaml` (SMTP 1025, web
> UI 8025, image pinned by digest like MinIO) and start it, since implementers never run `docker compose`. Portal specs:
> done, MISMATCHES **B165** (preferences, Telegram link, the Telegram webhook).

Phase 3, map stage 12 (admin surface, merchant portal, incoming Telegram webhook). Read `_common.md` and `_feature.md` first:
this brief only names the scope. Module: platform (notifications, templates, delivery), with identity's merchant columns
(`telegram_chat_id`, `notification_prefs`) through identity's public service. Wave 5, after 7b (low balance and price change
events) and 8 (deposits, invoices); in parallel with 11; before 12b (which notifies through this feature). Decisions 019
(token hashing), 020 (outbox, queues, jobs), 023 (outbound HTTP), 031 (clock), 033 (mail delivery, see above).

## Routes (12; remove them from `test/contract/pending.ts`)
- Templates: `GET|POST /admin/notification-templates`, `GET|PATCH|DELETE /admin/notification-templates/:id`,
  `POST /admin/notification-templates/:id/preview`.
- Log: `GET /admin/notifications`, `GET /admin/notifications/:id`.
- Merchant portal (B165): `GET|PUT /client/notification-preferences`, `POST /client/telegram/link`.
- Incoming: `POST /webhooks/telegram/:secret` (B165).

Per-route semantics: `docs/contract/endpoints/platform.md`; shapes: `docs/contract/frontend-endpoints.json`; console callers
(read-only): `FRONTEND_DIR/src/features/settings` (Customer emails and Notification log tabs) with its `types/` and `mocks/`.

## Rules that matter (beyond the endpoint docs)
- **One delivery path.** An event registry (key, audience `staff|merchant|customer`, the variables it fills, transactional or
  not) is the only list of events: templates may be created only for registered events (422 on `event`), preferences list
  the merchant ones (B165). Producers write an outbox row (their transaction); a `notifications` processor renders the active
  template of (event, channel, audience, recipient locale, falling back to `en`), writes the `notifications` row (status
  `queued`, then `sent` with `sent_at` or `failed` with the error, M172) and sends by email (SMTP) or Telegram (Bot API,
  only to a linked chat). Retries per decision 020 with the attempt on the row; a send is at least once and the row's id
  dedupes a repeat. An inactive template sends nothing; a missing template is logged and sends nothing.
- **Merchant mail (2b) becomes real.** The verification, reset and invitation mails carry a link with a token that
  `auth_tokens` stores only as a hash: issue the token inside the mail job (the outbox row keeps the token id; the job
  rotates the token and sends the new clear value), so no clear token is ever stored or logged (Wave 1 merge note).
- **One event, several queues.** Today an outbox event type goes to one queue (`OutboxRouteRegistry.register` throws on a
  second route). Extend the registry and the relay so one type may route to several queues (one job per route; the same type
  and queue twice still throws; decision 020 amended), then route `order.status_changed`, `wallet.low_balance`,
  `service.price_changed` and `invoice.paid` to `notifications` as well as `merchant-webhooks`: their producers do not change.
- **Events wired now.** The 2b merchant mails; `wallet.low_balance` (the threshold is `notification_prefs.lowBalanceThreshold`);
  the price change digest of user rule 9 (a merchant who ordered a service in the last 30 days gets at most one email or
  Telegram digest per day of the `service.price_changed` events it received); `deposit.approved` and `invoice.paid` (8);
  `order.completed` and `order.failed` (from `order.status_changed`) for merchants who opted in. A registry entry for each,
  with its default template seeded (English).
- **Templates (RULES settings 10, identity-platform-11, M170, M171).** Unique per (event, channel, audience, locale) → 422
  on `event`; email needs a subject; event, channel, audience and locale are fixed after create; `{{placeholders}}` only from
  the event's variables; preview renders without sending, leaves unknown placeholders visible and returns `format`
  (`html|text`); `sentLast30Days` per identity-platform-11; audited with before and after (RULES settings 12) with the demo's
  verb phrases (ANSWERS audit Q3).
- **Log (RULES settings 11, M172).** Read-only; recipients masked server-side (`r***@example.com`, `@u***`); statuses
  `queued|sent|failed` with an error text for failures.
- **Telegram (B165).** Link tokens: a new auth token purpose `telegram_link` (migration for the CHECK); the webhook checks
  both secrets in constant time, answers 200 fast, dedupes by `update_id`.
- **Health.** The `mail` component check of feature 9 calls the transport's verify; expose it from this feature.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
identity-platform-11, -16. Migration 0003 ships their schema changes; add a migration only for what it lacks.

## Out of scope
Alert notifications to staff (12b uses this path), support replies (17), refund decline emails (16), storefront customer
mails (14a, 16), abandoned-checkout recovery (19).
