# Support module (`support`)

Map domain J. Support for storefront customers: tickets, their messages and reply templates.

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built in feature 17 (all 14 routes, scenario `b2c-ticket`): the storefront ticket routes, the staff inbox and the reply templates.
Layout: `contracts/` (one `defineRoute` per route), `controllers/` (thin), `application/` (use cases, the outbox writer and the job
behind it, the ticket token resolver, the notification events and their default templates), `jobs/` (the `notifications` queue
processor), `domain/` (the status codec and moves, the reply targets, the reply channels, the shortcut rule: pure, with unit tests),
`infra/` (Drizzle queries, and one file of foreign reads). Four Nest modules: `SupportAdminModule` (staff routes) and `SupportStoreModule`
(storefront routes and the ticket token resolver) need the database and the cache, as does `SupportMailModule` (the sending job), so a
test app built without them leaves them out; `SupportEventsModule` registers the notification events and the outbox route and needs
neither. The API loads all four; the worker loads `SupportEventsModule` and `SupportMailModule`.

## Public API (`index.ts`)

Exports the modules, the statuses' wire words (`WIRE_TICKET_STATUSES`, `toWireStatus`), the reply targets (`PRIORITY_TARGET_MS`,
`defaultPriority`, `slaDueAt`: the dashboard's late-ticket rule and the seed use the same numbers), the notification events
(`SUPPORT_EVENTS`, the three event keys), their default templates (`SUPPORT_DEFAULT_TEMPLATES`, `supportTemplatesSql`) and the ticket mail
job (`TICKET_MAIL_EVENT`, `TicketMailJobs`, `TicketMailProcessor`). Other modules
import only `src/modules/support/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 3 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` (feature 17 added `support_tickets.token` and `support_tickets.survey_sent_at`, migration `0016`).

| Table | What it holds |
|---|---|
| `support_tickets` | Support tickets from storefront customers and merchants, linked to an order, with an SLA deadline. |
| `ticket_messages` | Ticket messages from the customer, a staff member or the system, plus internal notes. |
| `reply_templates` | Ready-made reply templates for staff, by category and language. |

## Routes

14 endpoints (admin 10, store 4). Source: `docs/slices/support.json` (generated from the map; `bun run routes:build`). Every route is a contract under `contracts/`.

### Admin console (10)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/reply-templates/:id` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `GET /admin/reply-templates` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `GET /admin/reply-templates/:id` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `GET /admin/support-tickets` | staff-permission · `support:*` | Support inbox: priority, assignment, status and SLA timers. | 17 |
| `GET /admin/support-tickets/:id` | staff-permission · `support:*` | Support inbox: priority, assignment, status and SLA timers. | 17 |
| `PATCH /admin/reply-templates/:id` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `PATCH /admin/support-tickets/:id` | staff-permission · `support:*` | Support inbox: priority, assignment, status and SLA timers. | 17 |
| `POST /admin/reply-templates` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `POST /admin/support-tickets/:id/note` | staff-permission · `support:reply` | Internal note that the customer does not see. | 17 |
| `POST /admin/support-tickets/:id/reply` | staff-permission · `support:reply` | Reply to the customer by email or Telegram. | 17 |

### Storefront (B2C) (4)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /store/v1/tickets/:token` | ticket-token | Ticket conversation (without internal notes). | 17 |
| `POST /store/v1/tickets` | public | Open a ticket from the order page or the contact page; it is linked to the order. | 17 |
| `POST /store/v1/tickets/:token/csat` | ticket-token | Satisfaction rating after the ticket is closed. | 17 |
| `POST /store/v1/tickets/:token/messages` | ticket-token | The customer's reply on the ticket. | 17 |

## Rules (RULES support, RESOLUTIONS b2c-2 and b2c-9, scenario b2c-ticket)

- **Statuses.** Stored `new | open | pending_customer | resolved` (there is no `closed`); the console and the storefront get `pending` for
  `pending_customer` through one codec (`domain/ticket-status.ts`), and the list filter `status=pending` and a PATCH body of `pending` are
  translated back. PATCH accepts `new|open|pending|resolved` (anything else is 422 on `status`) with these moves: from `new` to `open`,
  `pending` or `resolved`; from `open` and `pending` to each other and to `resolved`; from `resolved` only to `open` (a reopen, which clears
  `resolved_at`); nothing goes back to `new`. A value equal to the current one is ignored.
- **Reply target.** `sla_due_at` is the last public requester message plus the priority's target (high 2 h, normal 8 h, low 24 h) while the
  ticket is `new` or `open`, else null; it is recomputed when the ticket is created, when the customer writes, when the priority or status
  changes and when a ticket is reopened (`domain/ticket-sla.ts`). `late` is `sla_due_at < now` on a ticket that is not resolved; the list's
  `late` filter and sort decide it in SQL against the clock's time, never `now()`. The dashboard's late-ticket rule reads the same columns.
  A new ticket's priority comes from its category (failed unlock and refund high; pre-sale, how-to and other low; the rest normal).
- **Replies.** Email always; Telegram only to a merchant with a linked chat (`clients.telegram_chat_id`); a customer is email only and an
  anonymized customer cannot be answered. A channel outside `replyChannels` is 422 on `channel`, checked before the resolved-ticket check
  (409 `TICKET_RESOLVED`, as in the console's mock). A reply stamps `first_response_at` once, moves a new or open ticket to
  `pending_customer`, clears the target and assigns an unassigned ticket to the sender; the text is stored and sent as given. The reply is
  delivered by a job: the use case writes the outbox event `support.ticket_mail` (ids only) in the same transaction, so the message exists
  if and only if the reply does, and `TicketMailJobs` sends it through the platform's `NotificationService.sendNow` (event `support.reply`).
- **Notes** are internal (`is_internal`), change no status, also take an unassigned ticket, and are allowed on a resolved ticket.
- **Resolve** (PATCH `status: resolved`) writes `resolved_at`, the internal system message `Marked resolved by <name>. A satisfaction
  survey is emailed to the customer.`, and the survey (event `support.csat_survey`) in one transaction; a merchant's ticket (no ticket page)
  and an already rated ticket get no survey and the message omits that sentence. The survey is sent once per ticket: a ticket resolved
  again after a reopen gets none, rated or not (`support_tickets.survey_sent_at`, set once in the resolve transaction, is the record). **Reopen** clears `resolved_at`.
- **Storefront.** `POST /store/v1/tickets` needs Turnstile (decision 034). The body names a subject, a message, an optional category and
  either an `orderToken` (the order's tracking token: the ticket links to that order and belongs to its customer; the typed email is
  ignored) or an `email` (a known address finds its customer, a new one becomes a guest customer). The ticket token (128 random bits, stored
  as issued like the checkout and tracking tokens, decision 010) is the whole credential of the three token routes. The receipt email holds
  its link; the 201 answer carries `token` only on the `orderToken` path (the caller already holds the order link). On the `email` path the
  answer has no token: the ticket is filed under whoever owns the address and Turnstile only stops bots, so a token in the body would let a
  stranger who knows an address read that customer's thread. The receipt email repeats the visitor's subject to the address they typed, so
  besides Turnstile and the per-IP limit one email address (case-insensitive) opens at most 3 tickets an hour on the `email` path (limiter
  `ticket-email`, decision 021): the fourth is `429 RATE_LIMITED` with `Retry-After`. `TicketTokenResolver`
  registers with identity's `CapabilityTokenResolvers` and compares in constant time. A customer message on a resolved ticket reopens it, on
  a ticket that waited on the customer makes it `open`, on a `new` ticket leaves it `new`; the rating is once, 1 to 5, only when the ticket
  is resolved, and the ticket stays resolved. The storefront's view carries no staff name, assignee, priority, timer or internal message.
- **Anonymization (B175, feature 18).** `SupportErasureModule` registers a customer erasure hook: when a customer is anonymized, in the same
  transaction, the `token` of every ticket the customer opened is set to NULL, so the old link answers `404`; the tickets and messages stay.
- **Templates.** The shortcut is trimmed; `''` is stored as NULL and read back as `''`; it must be `''` or `/word`; unique ignoring case among
  the non-empty ones (`409 SHORTCUT_TAKEN`, detail names the owner). The server renders no variables.

## Foreign reads

`infra/support-foreign-reads.ts` is the only file that names tables of other modules (decision 016 deviation, like the order read model's):
`customers` (the requester's name and address; the guest a first-time visitor becomes is made by the customers module's
`CustomerDirectory.findOrCreateGuest`, so support only reads the table),
`clients` (a merchant requester, its Telegram chat), `staff_users` (an assignee must be active; author names) and `orders` (by tracking
token, for the link). Replace the bodies with calls to the owners' services when identity and orders export them.

## Links

Ticket links in emails are `<STORE_BASE_URL>/support/tickets/<token>` (`STORE_BASE_URL`, the same config key feature 14b adds for the
customer sign-in links); the storefront page at that path shows the ticket, the reply form and, once resolved, the rating.

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/scenarios/`).

- `b2c-refund`: Refund before delivery (tables: `reply_templates`, `support_tickets`, `ticket_messages`)
- `b2c-ticket`: Support ticket about a delay (tables: `reply_templates`, `support_tickets`, `ticket_messages`)

## Permissions

Staff permissions the map requires on this module's admin routes: `support:*`, `support:reply`. The contracts use the per-action words of
RULES support 9 (M7): `support:read` (the inbox, one ticket, the templates), `support:update` (PATCH), `support:reply` (reply and note),
`support:create` and `support:delete` (templates; a template change is `support:update`).

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

One outbox event type, `support.ticket_mail` (queue `notifications`, aggregate `support_tickets`, payload `kind` = `received` | `reply` |
`survey`, plus `messageId` and `channel` for a reply), written by `TicketMailOutbox` in the use case's transaction by `POST /store/v1/tickets`
(the receipt), a staff reply and a resolve (the survey). The route is registered by `TicketMailRoutes` (`SupportEventsModule`), which the API
and the worker both load. Why a job and not `NotificationService.enqueue`: the ticket link holds the ticket token, and what a notification
stores in its `variables` is shown in the console's notification log, so the job builds the link and hands it over as a secret.

Notification events registered here (`SUPPORT_EVENTS`, loaded by the API and the worker through `SupportEventsModule`): customer
`support.ticket_received` and `support.csat_survey` (email), and merchant `support.reply` (email and Telegram, transactional: never a
preference). The customer's `support.reply` is built into the platform's list (12a registered it for the Customer emails tab; this feature
widened its variables to the name, the ticket number, the subject, the reply and the link). Default English templates for all five are in
`SUPPORT_DEFAULT_TEMPLATES` and inserted by migration `0012`.

## Jobs and schedules

`support.ticket_mail` on the `notifications` queue (`TicketMailProcessor`, loaded by the worker through `SupportMailModule`; docs/queues.md):
re-reads the ticket, the requester and the message, then sends through `NotificationService.sendNow` (dedupe key `outbox-<event id>:<channel>`,
so a repeat of a delivered message is skipped). The queue's policy applies (5 attempts, exponential backoff from 30 s): a transient failure
is retried, a refusal that cannot change (a missing template, a Telegram chat that was unlinked) ends the job, a malformed event is an
`UnrecoverableError`, and a customer anonymized since the event, a ticket that is gone or a message that is not a public staff message of
that ticket is skipped. There is no scheduler.

## Cache keys

None: tickets and templates are read from Postgres on every request (the inbox is polled every 30 s and stays cheap through the indexes on
status, updated time, `sla_due_at` and the requester).

## Audit

Staff writes use the demo's lower-case verb phrases with `entityType` `ticket` and the label `<number>, <subject>`: `assigned ticket`
(also when the assignee is cleared: the assignee is then none), `changed priority of ticket`, `resolved ticket`, `reopened ticket`, `changed status of ticket` (any other move),
`replied to ticket`, `added note to ticket`, and `edited ticket` for a PATCH that changed nothing (every staff write leaves one entry). The
reply templates use `created|edited|deleted reply template` with the new entity type `reply_template`. The storefront routes write no audit
rows (no staff actor).

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-2` · POST /admin/support-tickets/:id/reply, GET /admin/support-tickets
- `b2c-9` · GET/POST/PATCH /admin/reply-templates
