# 054: Logs and secrets

Status: accepted, 2026-11-20 (feature 44). Builds on decisions 010, 012, 015, 019, 020 and 033, and amends them where noted there.

**Context.** A failed database statement carried its text and its bound values into every place an error is written: log lines, error
reports, job records, the stored failures of queue jobs and the pages that show them. The reverse proxy wrote full request addresses,
Referers and some credential headers into its access log. The shop's link tokens (checkout, order tracking, support ticket) were stored as
issued, and a ticket link never stopped working. The Telegram webhook's header value equalled the secret in its address. One key made
both the credential hashes and the hashes kept for later matching. Log redaction covered a fixed list of names at fixed depths, the
error reporter's masks did unbounded work, and two documents described a key re-encryption job that does not exist.

**Decision.**
- **One error sanitiser** (`src/common/errors/safe-error.ts`). A database failure is described by its SQLSTATE, the identifiers Postgres
  names (table, constraint, column, the function of a trigger) and a fixed sentence per SQLSTATE or class; never by the statement, its
  values, or the Postgres message and detail. Any other error keeps its message, with an embedded statement cut. The logger, the
  exception filter's development detail, the queue workers (a job's stored failure is the sanitised error), `job_runs`, the run texts of
  bulk publish and Quick add, the queue pages and the error reporter use it; the queue pages and the jobs list also clean what was stored
  before.
- **Logs.** The error serializer rebuilds a database failure from the error itself; a formatter applies one secret-name rule (shared with
  the audit log and the settings route) and the e-mail, phone and IMEI masks at every depth; a last check on every written line removes
  any statement text that reached a message.
- **Proxy access logs.** Every host imports one snippet of `deploy/Caddyfile`: the token segments of the shop's link pages and API paths,
  the Telegram webhook path, and the values of the query parameters `token`, `q`, `order`, `next`, `imei` and `apiaccesskey` are replaced
  in the request address and the Referer; the CSRF, anti-bot, idempotency, webhook-secret and signature headers are not written, nor
  the two headers in which the shop's pages send their own address (`Next-Url`, `Next-Router-State-Tree`); a redirect's `Location`
  gets the same path rules and loses its whole query string.
- **The shop's link tokens at rest.** A checkout, tracking or ticket token is found by a keyed hash and kept as an AES-GCM copy (AAD: its
  column) for the pages and mails that show the link again; a database copy alone opens no link. Rows written before were converted once,
  by a pass per owning module asked for by a migration; until then the old form is still read. A ticket link stops working 180 days
  after the ticket was resolved (the default retention of a resolved ticket's files); reopening the ticket opens it again.
- **Lookup key.** `LOOKUP_HASH_KEY` keys every hash stored for later matching: the blocklist, IMEI checks, inventory and open-order
  duplicates, unsubscribe links, Idempotency-Key requests, webhook event ids and the link tokens above. Outside production it defaults to
  `TOKEN_PEPPER`; production requires it, and an installation that has data sets it to its current `TOKEN_PEPPER`. `TOKEN_PEPPER` keys
  credentials only (sessions, one-time links, API keys) and short-lived limiter keys.
- **Telegram webhook.** The address segment and the header value are two values derived from `TELEGRAM_WEBHOOK_SECRET` with different
  labels; the secret itself never travels, and the address alone does not authenticate a call. `scripts/telegram-webhook.ts` registers
  both with Telegram.
- **Notification log.** The data a message was built from is shown to holders of `notifications:*`; others see its keys with hidden
  values. A provider's refusal text is kept without addresses, links or token-like strings.
- **Encryption keys.** No job re-encrypts stored values. An old key stays in `ENCRYPTION_KEYS` for as long as values sealed by it are
  kept; after a suspected key leak the secrets themselves are changed (entering them again seals them with the active key).

**Consequences.** Logs, error reports, job records and queue pages show which table and rule refused a statement, not what was in it; a
developer reproduces a failure from its request id, route and SQLSTATE. Production needs one more secret, and an upgrade of an installation
with data must copy the pepper into it. The Telegram bot's webhook must be registered again after this release and after any change of its
secret, bot token or API host; this release also gives `TELEGRAM_WEBHOOK_SECRET` a new value, because until now the secret was part of the
webhook address and so of the access logs written before the release. Ticket links in old mails end 180 days after their ticket was
resolved. A later release removes the plain token columns and the reads of the old form, once production has run the passes.

**Details settled before building (2026-11-20).**
- **Boot check of the lookup key.** The API and the worker compare `LOOKUP_HASH_KEY` with a marker when they start: the first start stores
  `HMAC(LOOKUP_HASH_KEY, a fixed label)` in the platform module's settings table (key `system.lookupKeyCheckHash`, which the settings
  routes never list or change; written with an insert that does nothing on conflict, so two processes starting together store one).
  When a later start finds a different marker, production refuses to start with a message that names the setting (never a value) and
  says that the stored lookups would stop matching; other environments write one configuration warning line and go on. `db:migrate`
  does not write the marker. Changing this key is not supported; the first production deploy on an installation with data sets it equal
  to `TOKEN_PEPPER`.
- **Development and tests.** Outside production an unset `LOOKUP_HASH_KEY` is `TOKEN_PEPPER`, so a development database keeps matching.
- **Log walk bounds.** The formatter's walk is bounded in depth (6) and in the number of values it visits (5,000 per line), never throws,
  and replaces what lies beyond the bounds with `[truncated]`.

**Choice made while building it (feature 44, after review).** A production start whose check of the lookup key gets no answer from the
database stops (compose starts the process again once Postgres is healthy, and that start checks again), so no production process runs
with an unchecked key; in development and tests one configuration warning line, and the start goes on. Only a connection failure counts as
no answer; any other failure of the check stops the start everywhere, with the sanitised text of the failure.
