# Support module (`support`)

Map domain J. Support for accounts of either rank (decision 064): tickets, their messages and reply templates. A ticket's requester and a message's author are stored as `account` (or `staff` or `system`).

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

Feature 28 turns the ticket into a live conversation on the real-time layer of feature 27 (decision 037; plan
`docs/briefs/28-support-live-chat.md`): live messages, seen marks, attachments, an email fallback for unseen replies, the
signed-in customer's own ticket list and the merchant portal's tickets (15 more routes, 28 in all). Added to the layout: `realtime/`
(`TicketRealtimeSource`: the ticket events and their two views), `jobs/` (the reply-mail sweep and the attachment retention), `domain/`
(`attachment-rules.ts`, `seen.ts`, `reply-mail.ts`), `application/` (`TicketThreadService`, `TicketEvents`, `TicketReadService`,
`TicketAttachmentService`, `ReplyMailSweep`, and for the account surfaces `AccountTicketOpener`,
`MyTicketsService`, `ClientTicketService` with their pure views), `infra/account-ticket.repository.ts` (the two account lists and the
ownership check). Two Nest modules more: `SupportClientModule` (the customer's list and the merchant routes; it lists the chat-engine services itself, like
`SupportAdminModule`, and needs the database, so a database-less test app replaces it too) and `SupportJobsModule` (the two scheduled jobs,
loaded by the worker only). `SupportStoreModule` also holds the ticket source of the live streams.

## Public API (`index.ts`)

Exports the modules, the statuses' wire words (`WIRE_TICKET_STATUSES`, `toWireStatus`), the reply targets (`PRIORITY_TARGET_MS`,
`defaultPriority`, `slaDueAt`: the dashboard's late-ticket rule and the seed use the same numbers), the notification events
(`SUPPORT_EVENTS`, the two event keys), their default templates (`SUPPORT_DEFAULT_TEMPLATES`, `supportTemplatesSql`) and the ticket mail
job (`TICKET_MAIL_EVENT`, `TicketMailJobs`, `TicketMailProcessor`), and from feature 28 the doorbell topic (`TICKET_TOPIC`), the jobs module with its
two scheduler ids and job names. Other modules
import only `src/modules/support/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 3 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` (feature 17 added `support_tickets.token`, migration `0016`; decision 053 added `support_tickets.requester_proven_at`: when the requester's address was proven, null for an unconfirmed contact-form ticket). The columns `support_tickets.csat_score` and `support_tickets.survey_sent_at` belong to the retired satisfaction survey: nothing reads or writes them, and they stay until the migration of the accounts model drops them.

| Table | What it holds |
|---|---|
| `support_tickets` | Support tickets from accounts of either rank (a guest row included), linked to an order, with an SLA deadline; `requester_type` is `account`. |
| `ticket_messages` | Ticket messages from the requester, a staff member or the system, plus internal notes; `author_type` is `account`, `staff` or `system`. |
| `reply_templates` | Ready-made reply templates for staff, by category. |

## Routes

28 endpoints (admin 13, store 9, client 6). Source: `docs/slices/support.json` (generated from the map; `bun run routes:build`). Every route is a contract under `contracts/`.

### Admin console (13)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/reply-templates/:id` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `GET /admin/reply-templates` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `GET /admin/reply-templates/:id` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `GET /admin/support-tickets` | staff-permission · `support:*` | Support inbox: priority, assignment, status and SLA timers. | 17 |
| `GET /admin/support-tickets/:id` | staff-permission · `support:*` | Support inbox: priority, assignment, status and SLA timers. | 17 |
| `GET /admin/support-tickets/:id/files/:fileId` | staff-permission · `support:read` | Download an attachment of the ticket (presigned link). | 28 |
| `PATCH /admin/reply-templates/:id` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `PATCH /admin/support-tickets/:id` | staff-permission · `support:*` | Support inbox: priority, assignment, status and SLA timers. | 17 |
| `POST /admin/reply-templates` | staff-permission · `support:*` | Canned replies (macros) with order variables. | 17 |
| `POST /admin/support-tickets/:id/files` | staff-permission · `support:reply` | Upload an attachment for a reply or a note. | 28 |
| `POST /admin/support-tickets/:id/note` | staff-permission · `support:reply` | Internal note that the customer does not see. | 17 |
| `POST /admin/support-tickets/:id/read` | staff-permission · `support:read` | Mark the requester's messages as seen. | 28 |
| `POST /admin/support-tickets/:id/reply` | staff-permission · `support:reply` | Reply to the customer by email or Telegram. | 17 |

### Storefront (B2C) (9)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /store/v1/me/tickets` | customer-session | The signed-in customer's own tickets, with the link token of each. | 28 |
| `GET /store/v1/tickets/:token` | ticket-token | Ticket conversation (without internal notes). | 17 |
| `GET /store/v1/tickets/:token/files/:fileId` | ticket-token | Download an attachment of the ticket (presigned link). | 28 |
| `GET /store/v1/tickets/:token/stream` | ticket-token | The ticket's live events (server-sent events). | 28 |
| `POST /store/v1/me/tickets` | customer-session | Open a ticket when signed in (no anti-bot check; the answer carries the ticket link token). | 28 |
| `POST /store/v1/tickets` | public | Open a ticket from the order page or the contact page; it is linked to the order. | 17 |
| `POST /store/v1/tickets/:token/files` | ticket-token | Upload an attachment for the ticket. | 28 |
| `POST /store/v1/tickets/:token/messages` | ticket-token | The customer's reply on the ticket. | 17 |
| `POST /store/v1/tickets/:token/read` | ticket-token | Mark support's messages as seen. | 28 |

### Merchant portal (6)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /client/tickets` | merchant-session | The merchant's own tickets. | 28 |
| `GET /client/tickets/:id` | merchant-session | One of the merchant's tickets with its conversation. | 28 |
| `GET /client/tickets/:id/files/:fileId` | merchant-session | Download an attachment of one of the merchant's tickets (presigned link). | 28 |
| `POST /client/tickets` | merchant-session | Open a ticket from the merchant portal. | 28 |
| `POST /client/tickets/:id/messages` | merchant-session | Write on one of the merchant's tickets. | 28 |
| `POST /client/tickets/:id/read` | merchant-session | Mark support's messages of one of the merchant's tickets as seen. | 28 |

## Rules (RULES support, RESOLUTIONS b2c-2 and b2c-9, scenario b2c-ticket)

- **Whose ticket it is (decision 064).** A ticket and its messages belong to an account of either rank: `support_tickets.requester_type` and `ticket_messages.author_type` are `account` (`TICKET_REQUESTER_TYPES` = `account`; `TICKET_AUTHOR_TYPES` = `staff`, `account`, `system`). A merchant rank reads its tickets in the portal by id (a ticket opened there has no link token); a retail rank reads them through the ticket page and its link token. The rule of decision 053 holds for every account: a ticket of the public form filed with a typed address stays off the account's lists, live streams, replays and id routes until the link mailed to that address is used. The public form files a ticket under the login account of the typed address, whatever its rank, and otherwise under the guest row of the address; an order link files it under the account that owns the order. The rank kind of a requester is read when it is needed (`rankKindOfRequester(groupId, retailGroupId)`), never stored on the ticket. The upload quota of a requester follows the rank kind of the account (`uploadQuotaFor(rankKind)`, `platform/files/upload-quota.ts`); the files area is `tickets-<id>/account-<id>/`. The mails follow the rank kind: `TicketMailJobs` reads it with the variables; a support reply and the receipt use the text of the asker's rank; **the merchant audience also receives a receipt**, `support.ticket_received` for `audience: merchant` (the secret link, transactional; its template row ships in the expand migration, `MERCHANT_RECEIPT_TEMPLATE` and `supportMerchantReceiptSql()` in `application/support-templates.ts`). Constructors that gained a class: `TicketAttachmentService`, `StoreTicketService` and `TicketMailJobs` take `AccountDirectory`; `TicketAdminService` and `TicketRealtimeSource` take `RankGroupReads`.
- **The guest claim** (`SupportGuestClaimParticipant`, name `support`, `application/guest-claim.participant.ts`, API process only): when an account that proved the mailbox claims the records of its guest row, the guest row's tickets and messages move to the account and the files of its tickets with them (platform's `moveGuestClaimFiles`), the rows locked `FOR UPDATE NOWAIT` so the claim never waits.

- **Statuses.** Stored `new | open | pending_customer | resolved` (there is no `closed`); the console and the storefront get `pending` for
  `pending_customer` through one codec (`domain/ticket-status.ts`), and the list filter `status=pending` and a PATCH body of `pending` are
  translated back. PATCH accepts `new|open|pending|resolved` (anything else is 422 on `status`) with these moves: from `new` to `open`,
  `pending` or `resolved`; from `open` and `pending` to each other and to `resolved`; from `resolved` only to `open` (a reopen, which clears
  `resolved_at`); nothing goes back to `new`. A value equal to the current one is ignored.
- **A requester's address (decision 047, extended by decision 064 to every rank).** A staff answer shows the address masked unless the caller holds `clients:read`, whatever the requester's rank (the map and decision 047 kept a merchant's address in full)
  (identity's `customerContactOf`; the controller passes the `contact` down to `toTicketView` and `toDetailView`): the list rows, the single read and the answer of
  `PATCH /admin/support-tickets/:id` mask a requester's `requester.email` of **every rank** (`customerEmailIn`). A requester without a name is labelled by
  the masked address for every caller (`requesterOf` and `authorNameOf` in `infra/ticket.repository.ts`: the requester name and the author of their messages, never the full address).
  The inbox's `q` matches a requester's whole address only for a caller who holds `clients:read`. The staff wire carries `requester.rankKind` (`merchant` or `retail`, `rankKindOfRequester` in `domain/requester-rank.ts`; a missing row reads as retail) and the list filter `rankKind`; `requesterType` accepts `account` only. The live staff frame (`ticket.updated`, one broadcast to every staff stream) is built with `'masked'`, whatever the stream holds.
  `support.ticket_received` is flagged `secretLink` (its `{{link}}` is the ticket's token link: a template keeps the link rules of decision 047), and
  `SupportEventRegistration` registers `SUPPORT_DEFAULT_TEMPLATES` with the event registry as the shipped texts (the fallback of a link mail whose stored template breaks the rules).
- **Reply target.** `sla_due_at` is the last public requester message plus the priority's target (high 2 h, normal 8 h, low 24 h) while the
  ticket is `new` or `open`, else null; it is recomputed when the ticket is created, when the customer writes, when the priority or status
  changes and when a ticket is reopened (`domain/ticket-sla.ts`). `late` is `sla_due_at < now` on a ticket that is not resolved; the list's
  `late` filter and sort decide it in SQL against the clock's time, never `now()`. The dashboard's late-ticket rule reads the same columns.
  A new ticket's priority comes from its category (failed unlock and refund high; pre-sale, how-to and other low; the rest normal).
- **Replies.** Email only (a merchant's linked chat was retired with decision 062: the chat column is read by nothing); an
  anonymized customer cannot be answered. A channel outside `replyChannels` is 422 on `channel`, checked before the resolved-ticket check
  (409 `TICKET_RESOLVED`, as in the console's mock). A reply stamps `first_response_at` once, moves a new or open ticket to
  `pending_customer`, clears the target and assigns an unassigned ticket to the sender; the text is stored and sent as given. The reply is
  delivered by a job: the use case writes the outbox event `support.ticket_mail` (ids only) in the same transaction, so the message exists
  if and only if the reply does, and `TicketMailJobs` sends it through the platform's `NotificationService.sendNow` (event `support.reply`).
- **Notes** are internal (`is_internal`), change no status, also take an unassigned ticket, and are allowed on a resolved ticket.
- **Resolve** (PATCH `status: resolved`) writes `resolved_at` and the internal system message `Marked resolved by <name>.` in one
  transaction. **Reopen** clears `resolved_at`.
- **Storefront.** `POST /store/v1/tickets` needs Turnstile (decision 034). The body names a subject, a message, an optional category and
  either an `orderToken` (the order's tracking token: the ticket links to that order and belongs to its customer; the typed email is
  ignored; the order link of an anonymized customer is `422` on `orderToken` like an unknown one) or an `email` (a known address finds the login account of that address, whatever its rank, and otherwise the guest row of the address, made through `AccountDirectory.findOrCreateGuest`). The ticket token (128 random bits,
  decision 010) is the whole credential of the token routes; it is stored only as a keyed hash (`token_hash`) and an AES-GCM copy
  (`token_enc`, AAD `support_tickets.token_enc`) that the mails and the account list reveal (decision 054). The receipt email holds
  its link; the 201 answer carries `token` only on an `orderToken` path that speaks for the order's customer: the account opened the checkout
  signed in, or the customer has no account (`CustomerDirectory.orderLinkStanding`; a guest checkout can be opened with any address, an
  account's included, and is then filed unproven like a typed address). On the `email` path the
  answer has no token: the ticket is filed under whoever owns the address and Turnstile only stops bots, so a token in the body would let a
  stranger who knows an address read that customer's thread. The receipt goes to an address anyone can type, so besides Turnstile and the
  per-IP limit one email address (case-insensitive) gets at most 3 new tickets an hour (limiter `ticket-email`, decision 021): the fourth is
  `429 RATE_LIMITED` with `Retry-After`. Decision 053: the count is made for the typed `email`, and with an `orderToken` for the address of the order's customer (a
  customer without an address, anonymized, is counted under the order), after the order link is checked and before anything is written, so both paths share the cap. `TicketTokenResolver`
  registers with identity's `CapabilityTokenResolvers`, finds the ticket by the keyed hash (a ticket opened before decision 054 by its plain
  token until the seal pass ran) and compares in constant time. **A ticket's link stops working 180 days after the ticket was resolved**
  (`TICKET_LINK_DAYS_AFTER_RESOLUTION`, `domain/ticket-link.ts`; the default of `support.attachmentRetentionDays`): the guard answers the same
  `404` as for an unknown token; reopening clears `resolved_at` and opens it again. A customer message on a ticket that waited on the
  customer makes it `open`, on a `new` ticket leaves it `new` (a resolved ticket takes none: see the next rule). The storefront's view carries no staff name, assignee, priority, timer or internal message.
- **A resolved ticket is closed for its requester (B220, owner decision 2026-11-15; it replaces ANSWERS support Q8, where a customer
  message reopened it).** The requester's message (`POST /store/v1/tickets/:token/messages`, `POST /client/tickets/:id/messages`, the one
  path `TicketThreadService.write`) and the ticket page's file upload (`POST /store/v1/tickets/:token/files`) are `409 TICKET_RESOLVED`
  with the detail `This ticket is closed. Open a new ticket if you still need help.`: nothing is written, rung or mailed, the status stays
  `resolved` and the message does not take a point of the `ticket-message` limiter. Read marks are unchanged (they are not writes on the conversation). Staff keep the way back: `PATCH`
  resolved to `open` (a reopen), after which the requester can write again; a staff reply on a resolved ticket stays `409`, and a note is
  still allowed. The account opener (`POST /store/v1/me/tickets`, `POST /client/tickets`) only opens new tickets, so it has nothing to
  refuse; a signed-in customer writes on an existing ticket through its link token. The lock is one helper, `application/requester-lock.ts`.
- **An unproven ticket (decision 053).** A ticket of the public form opened with a typed `email` (no order link), or with the order link of a guest checkout filed under an
  account, has `support_tickets.requester_proven_at` null: anyone can type an
  address, so the ticket stays off the account of the customer who owns it until the link that was mailed to that address is first used. While it is null: the ticket is not in
  `GET /store/v1/me/tickets`, its live events reach only the streams opened with its link (not the requester's account stream), the account stream's replay leaves it out. The ticket is not in the customer's data export (`GET /admin/customers/:id/export`) and is not an evidence line of a dispute of the customer's orders either: all of these reads (the account list, the stream replay, the export and the evidence) use one condition, `requesterProven()` of `db/schema.ts`, which the other modules reach through the schema barrel. The anonymization of a customer still covers every ticket of the customer, confirmed or not. The ticket link itself works as before. The address proves itself when the
  holder of the link opens the ticket page (`GET /store/v1/tickets/:token`) or writes on it (`POST /store/v1/tickets/:token/messages`): a guarded update sets the time once
  (`WHERE requester_proven_at IS NULL`; `updated_at` stays, it is not activity for staff). Every other ticket is proven when it is made (an order link that speaks for its customer, a signed-in requester,
  a merchant; the migration gave every existing ticket its `created_at`). Staff see it in the thread: an internal system note after the first message ("Opened on the contact form by
  someone who typed this email address. The address is not confirmed yet: ...") and another when the link proves the address ("The requester opened the link from the receipt email: the
  email address is confirmed."), both ringing the staff stream like the resolve note.
- **The receipt repeats nothing a visitor typed (decision 053).** The event `support.ticket_received` offers `ticketNumber` and `link` only; the job passes `{ ticketNumber }` and the link
  as the secret, for every receipt (public form, order link, account). The default text is fixed wording plus the number and the link (`RECEIPT_BODY`); the feature-43 migration
  replaces it only where the row still holds the text migration `0016` shipped, so a template staff edited keeps their words (a `{{customerName}}` or `{{subject}}` left in it is shown
  as written, and the editor refuses to save it again until it is removed).
- **Anonymization (B175, feature 18).** `SupportAccountErasure` (`application/support-account-erasure.ts`) registers an `AccountErasureHook` with the customers module's `AccountErasureHooks` in `onModuleInit`: when an account is anonymized, in the same
  transaction, the `token` of every ticket the account opened is set to NULL (`clearTicketTokensOfAccount`), so the old link answers `404`; the tickets and messages stay.
- **Templates.** The shortcut is trimmed; `''` is stored as NULL and read back as `''`; it must be `''` or `/word`; unique ignoring case among
  the non-empty ones (`409 SHORTCUT_TAKEN`, detail names the owner). The server renders no variables.

### The live chat (feature 28, B217 to B219)

- **Live both ways (rule 1).** Every use case that changes a ticket rings a doorbell after its commit (`TicketEvents`, topic `ticket`: `message`,
  `updated`, `read`, `revoked`; ids only). `TicketRealtimeSource` (API only) re-reads and renders two views: the staff view to
  `support:staff` (every message, the inbox row) and the requester view to `ticket:<id>` (the ticket link's
  stream) and the requester's account stream (`u:account:<id>`, one key per account whichever family it connects through): public messages only, never a note, a system message, a staff
  name, the assignee, the priority or a timer, and no ticket token (a customer's event has `ticketId: null`, match by `number`). The stream
  route `GET /store/v1/tickets/:token/stream` keeps the token in the path (an `EventSource` cannot send a header), has no cookie and
  `originCheck`, and is capped at 3 streams per ticket and 30 per address; the proxy's log hides the token (`deploy/Caddyfile`). Events and
  frames: `docs/contract/realtime-events.md`.
- **Read marks and the token limit.** The ticket page's read marks count against the limiter `ticket-chat` (120 a minute per address), not
  `token`.
- **Seen (rule 3).** One mark per side on the ticket (`requester_seen_message_id`, `staff_seen_message_id` with their times), moved forward
  only by one guarded `UPDATE`; the message must be one the other side wrote and the caller may see, else `422 unknown_message`. Staff are one
  party: the requester learns that support saw it, never who. A requester's read never touches `updated_at`. `hasUnread` is never stored:
  for staff `last_requester_message_id > coalesce(staff_seen_message_id, 0)`, for the requester `last_staff_message_id >
  coalesce(requester_seen_message_id, 0)`.
- **My tickets (rule 6, B217).** `GET /store/v1/me/tickets` lists the tickets whose requester is the signed-in account (retail rank) (those filed as a
  guest with the same address included, because the address belongs to the customer who owns it); each row hands out the ticket's link token
  and the page stays the token page, so no new credential exists. A customer's ticket without a token (cleared by an erasure) is not listed.
  `POST /store/v1/me/tickets` opens a ticket without Turnstile and answers with the token at once; the receipt email is still queued. The
  order picked must be the customer's own (`422 orderId`, `unknown_order`, for any other order, an unknown id included).
- **Merchant support (rule 7, B217).** The ticket of an account of a merchant rank, opened in the portal, has no link token: the session is the credential and the routes take the ticket
  id, and another merchant's ticket (or an unknown id) is `404`, never `403`. List, open, the public conversation, reply, read mark
  and the download are `/client/tickets*`; a suspended one is refused by the session guard (the status `pending` no longer exists, decision 064). **A ticket whose address is not proven yet** (a ticket of the public form filed with a typed address, below) is `404` on `GET /client/tickets/:id` and the three routes under it, as it is off every list, stream, replay and id route of the account. The merchant's message goes through the same `TicketThreadService` as the ticket page's, so
  the status moves, the reply target, the 20 messages a minute per ticket (`ticket-message`), the doorbell and the refusal of a resolved
  ticket (`409 TICKET_RESOLVED`, B220) are the same. The conversation
  is the storefront's view with `id`; a merchant gets no receipt email.
- **Opening from an account.** `AccountTicketOpener` is the one path of routes `POST /store/v1/me/tickets` and `POST /client/tickets`: the
  limiter `ticket-open` (5 an hour per account, key `account:<id>`, `429 RATE_LIMITED` with `Retry-After`) is taken first, before
  anything is read, so a refused attempt counts too and order and file ids cannot be probed; then, in one transaction, the order check, the
  attachments check, the ticket (priority and reply target of its category, `new`), the first message, `last_requester_message_id`, the
  customer's receipt event and the doorbell. The first message may be files only (`message: ''` with `fileIds`).
- **Attachments (rule 8).** PDF, JPEG or PNG, at most 5 MiB each and 5 per message; the content must start with the type's magic bytes
  (`domain/attachment-rules.ts`). The ticket page and the console have their own upload routes (the file belongs to the ticket's customer or
  the staff member; a link's holder attaches only the uploads of its own ticket, the area `tickets-<id>`, and none for a resolved ticket: `409 TICKET_RESOLVED`); a merchant or a signed-in customer
  uploads with the existing `POST /client/files` and `POST /store/v1/files`, and the type and size are checked again when the file is
  attached (`422 fileIds`: `unknown_file`, `not_yours`, `type`, `too_large`). Nothing is scanned for viruses: files are never shown inline and
  every download is a 5-minute presigned link with `Content-Disposition: attachment`. A requester downloads the files of the public messages of
  their own ticket, staff with `support:read` every file of the ticket (a file that is also an identity document or a payment proof leaves the same audit row as the platform's file route,
  `auditStaffFileOpening`, decision 047; an ordinary attachment leaves none); anything else is `404`.
- **Email fallback (rule 9).** A staff reply on channel `email` writes no outbox event at once: it sets `reply_mail_due_at` to the reply time
  plus `support.replyEmailDelayMinutes` (default 5; `0` mails at once, as before feature 28). The job `support_reply_mail_sweep` then queues
  one `support.ticket_mail` event that carries every reply the requester has not seen (`fromMessageId` to `messageId`). An event
  written before the Telegram channel was retired (`payload.channel` `telegram`) is skipped as `channel_retired`. The receipt is unchanged.
- **Erasure and retention (rule 10).** Anonymizing a customer also deletes the attachments of their tickets (the texts stay, B175) and ends
  their ticket streams (`ticket revoked`). The job `ticket_attachment_retention` deletes the attachments of a ticket
  `support.attachmentRetentionDays` (default 180, `0` keeps them) after it was resolved.

## Foreign reads

`infra/support-foreign-reads.ts` is the only file that names tables of other modules (decision 016 deviation, like the order read model's):
`clients` (the requester's name and address: the account of either rank or the guest row a first-time visitor becomes, made by identity's `AccountDirectory.findOrCreateGuest`, so support only reads the table), `staff_users` (an assignee must be active; author names) and `orders` (by tracking
token, for the link; and, for the account routes, whether an order is the caller's own: `orders.account_id`). Replace the bodies with calls to the owners' services when identity and orders export them.

## Links

Ticket links in emails are `<STORE_BASE_URL>/support/tickets/<token>` (`STORE_BASE_URL`, the same config key feature 14b adds for the
customer sign-in links); the storefront page at that path shows the ticket and the reply form. A merchant's reply
mail links to `<STORE_BASE_URL>/account/support/<ticket id>`, the conversation page of the account area (feature 28, decision 064).

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/e2e/`).

- `b2c-refund`: Refund before delivery (tables: `reply_templates`, `support_tickets`, `ticket_messages`)
- `b2c-ticket`: Support ticket about a delay (tables: `reply_templates`, `support_tickets`, `ticket_messages`)

## Permissions

Staff permissions the map requires on this module's admin routes: `support:*`, `support:reply`. The contracts use the per-action words of
RULES support 9 (M7): `support:read` (the inbox, one ticket, the templates), `support:update` (PATCH), `support:reply` (reply and note),
`support:create` and `support:delete` (templates; a template change is `support:update`). Feature 28: the read mark and the file download are
`support:read`, the file upload `support:reply`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Events

One outbox event type, `support.ticket_mail` (queue `notifications`, aggregate `support_tickets`, payload `kind` = `received` | `reply`, plus `messageId` and `channel` for a reply, and `fromMessageId` for one email that carries every unseen reply from that message to
`messageId`), written by `TicketMailOutbox` in the use case's transaction by `POST /store/v1/tickets` and `POST /store/v1/me/tickets` (the
receipt), a staff reply on channel `email` when the delay is `0`, the `support_reply_mail_sweep` job (the batched email). The route is registered by `TicketMailRoutes` (`SupportEventsModule`), which the API
and the worker both load. Why a job and not `NotificationService.enqueue`: the ticket link holds the ticket token, and what a notification
stores in its `variables` is shown in the console's notification log, so the job builds the link and hands it over as a secret.

Live events (feature 28, not outbox events): the doorbells of topic `ticket` on the cache Redis (`ticket.message.created`, `ticket.updated`,
`ticket.read`, and the end of a ticket link's streams), documented with both views in `docs/contract/realtime-events.md`.

Notification events registered here (`SUPPORT_EVENTS`, loaded by the API and the worker through `SupportEventsModule`): customer
`support.ticket_received` (email; variables `ticketNumber` and `link` only, decision 053), the same event for the merchant audience (decision 064, above), and merchant `support.reply` (email, transactional: never a
preference). The customer's `support.reply` is built into the platform's list (12a registered it for the Customer emails tab; this feature
widened its variables to the name, the ticket number, the subject, the reply and the link). Default English templates for all four are in
`SUPPORT_DEFAULT_TEMPLATES` and inserted by migration `0012`.

## Jobs and schedules

`support.ticket_mail` on the `notifications` queue (`TicketMailProcessor`, loaded by the worker through `SupportMailModule`; docs/queues.md):
re-reads the ticket, the requester and the message, then sends through `NotificationService.sendNow` (dedupe key `outbox-<event id>:<channel>`,
so a repeat of a delivered message is skipped). The queue's policy applies (5 attempts, exponential backoff from 30 s): a transient failure
is retried, a refusal that cannot change (a missing template) ends the job, a malformed event is an
`UnrecoverableError`, and a customer anonymized since the event, a ticket that is gone or a message that is not a public staff message of
that ticket is skipped. That job has no scheduler.

Feature 28 adds two scheduled jobs on the `maintenance` queue (`SupportJobsModule`, the worker only; `docs/queues.md`):
`support_reply_mail_sweep` (every minute: mails the unseen email replies of the tickets whose `reply_mail_due_at` has come, one mail per
ticket, `FOR UPDATE SKIP LOCKED`, 100 a pass) and `ticket_attachment_retention` (daily 03:30 UTC: batches of 200 tickets, at most 25 a
run). Both are idempotent and record their runs in `job_runs`.

## Cache keys

Tickets and templates are read from Postgres on every request (the inbox stays cheap through the indexes on status, updated time,
`sla_due_at` and the requester). The module has no cache key (`docs/cache-keys.md`).

## Audit

Staff writes use the demo's lower-case verb phrases with `entityType` `ticket` and the label `<number>, <subject>`: `assigned ticket`
(also when the assignee is cleared: the assignee is then none), `changed priority of ticket`, `resolved ticket`, `reopened ticket`, `changed status of ticket` (any other move),
`replied to ticket` and `added note to ticket` (both with `after.fileIds` when files are attached), `attached file to ticket` (a staff upload,
`{ fileId, filename, size }`), and `edited ticket` for a PATCH that changed nothing (every staff write leaves one entry). The
reply templates use `created|edited|deleted reply template` with the new entity type `reply_template`. The storefront and merchant routes write no audit
rows (no staff actor), and neither does the console's read mark (`audit: false`: the staff side's own read mark).

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-2` · POST /admin/support-tickets/:id/reply, GET /admin/support-tickets
- `b2c-9` · GET/POST/PATCH /admin/reply-templates

## Link tokens at rest (decision 054)

`support_tickets.token` keeps the plain form only for tickets opened before decision 054; new tickets have `token_hash` and `token_enc`
(checks: never both forms, hash and copy together). Anonymization clears all three. The one-off pass `TicketTokenSeal` (job
`ticket_tokens_seal` on `maintenance`, `TicketTokenSealModule`, worker only) is asked for once by migration `capability_tokens_seal`: it seals
each ticket that still holds a plain token in one guarded `UPDATE` (`updated_at` kept) and records a `job_runs` row (trigger `event`).
