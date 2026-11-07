# 033: Mail and Telegram delivery

Status: accepted, 2026-11-07 (lead, before feature 12a). Builds on decisions 013 (configuration), 019 (secrets), 020 (outbox,
queues, jobs) and 023 (outbound HTTP).

**Context.** Feature 12a sends the platform's notifications (the merchant mails of 2b, low balance, the price change digest,
deposits, invoices, order results) by email and Telegram. Nothing in the stack sent mail yet, and local development needs a
way to see what would be sent without sending it.

**Decision.**
- **Email over SMTP** through `nodemailer` 10.2.1 (exact pin; it ships its own types). SMTP works with any provider (SES,
  Postmark, Mailgun and the like expose SMTP), so there is no vendor lock-in and no provider SDK. One `MailTransport` service in
  the platform module wraps it: `send({ to, subject, text, html })` and `verify()` (the `mail` health check of feature 9 calls
  it). Messages carry a text part always and an HTML part when the template has one.
- **Configuration (decision 013):** `MAIL_SMTP_URL` (secret: `smtp://` or `smtps://` with credentials) and `MAIL_FROM` (the
  sender address and name). Development defaults to `smtp://localhost:1025` (Mailpit, below) and `GSM <noreply@gsm.local>`;
  production requires both (the config refuses to start without them). Tests replace the transport with an in-memory one
  (no SMTP at all).
- **Local mail catcher:** Mailpit in `compose.yaml` (`axllent/mailpit:v1.32.0`, pinned by digest): SMTP on 1025, a web UI on
  8025 with every message. Nothing leaves the machine.
- **Telegram** through its Bot API (`https://api.telegram.org/bot<token>/<method>`) over `OutboundHttp` (target `telegram`,
  explicit timeout, no SDK): `sendMessage` to a linked chat. Configuration: `TELEGRAM_BOT_TOKEN` (secret),
  `TELEGRAM_BOT_USERNAME` (for the link `https://t.me/<username>?start=<token>`), `TELEGRAM_WEBHOOK_SECRET` (secret: the path
  segment and the `X-Telegram-Bot-Api-Secret-Token` header of `POST /webhooks/telegram/:secret`, B165). Without a token
  (development), Telegram sends are recorded as `failed` with the reason 'Telegram is not configured.' and nothing is called.
- **Delivery semantics (decision 020):** a send happens in a queue job, never in a request; a failure is retried with backoff
  and the attempt is on the `notifications` row; a send is at least once, so the message id (the `notifications` row id) is
  the dedupe key a provider sees where it supports one. A secret, a clear token or a full recipient address is never logged.

**Consequences.** Feature 12a builds `MailTransport`, the Telegram client and the delivery processor on this; feature 9's
`mail` check calls `MailTransport.verify()`. Running `docker compose up -d` gives every developer a mailbox at
`http://localhost:8025`.
