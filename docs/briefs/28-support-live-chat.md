# Feature 28: Support as a live chat (on the real-time layer of feature 27)

Plan by Fable 5.2 (planner), 2026-11-15, against backend `main` @ `562fa52`, console `main` @ `4811a7a`, storefront `main` @
`2cb1a0a`, **after feature 27 is merged** (`docs/briefs/27-realtime-notifications.md`, decision 037: SSE for server to browser,
`POST` for everything the browser sends, a Redis doorbell with ids, re-read with the viewer's rights). Owner request
(2026-11-15): the support ticket should be a real conversation between staff and users, not email plus `POST` and a reload.
Read first: `backend/CLAUDE.md`, `docs/briefs/_common.md`, `_feature.md`, brief 27 §3 and §5, `src/modules/support/README.md`;
console slices `frontend-admin/CLAUDE.md`; storefront slices `storefront/CLAUDE.md`. Paths are backend-relative; `FA/` = the
console worktree, `SF/` = the storefront worktree. No agent commits, runs git that changes state, or spawns agents. Money,
orders and the ledger are not touched.

## 1. What exists (verified in the code)

| # | Fact | Evidence |
|---|---|---|
| 1 | A ticket has a requester (`requester_type` `customer` or `client`, `requester_id`), a status, and `token` (128 bits, the whole credential of the storefront page; NULL for a merchant's ticket and after an erasure) | `support/db/schema.ts`, `application/store-ticket.service.ts` |
| 2 | Customer side: `POST /store/v1/tickets` (Turnstile; the answer has the token only on the `orderToken` path), `GET …/:token`, `POST …/:token/messages`, `POST …/:token/csat`. A ticket filed with an email belongs to the customer who owns the address | `contracts/store-tickets.contracts.ts`, README "Storefront" |
| 3 | Merchants have no ticket route at all; signed-in customers have no list of their tickets | `docs/slices/support.json`, `SF/app/[lang]/account`, `SF/app/[lang]/(portal)/merchant` |
| 4 | A staff reply writes the outbox event `support.ticket_mail` (`kind: 'reply'`, `messageId`, `channel`) and the job mails it at once (email always; Telegram for a merchant with a linked chat). Nothing tells staff that a customer wrote: the console polls every 30 s | `application/ticket-conversation.service.ts`, `ticket-mail-outbox.ts`, `ticket-mail.jobs.ts`, `FA/src/features/support/hooks/keys.ts` |
| 5 | `ticket_messages.file_ids` (bigint array) exists and is always empty; the admin message shape already sends `fileIds` | `db/schema.ts`, `contracts/shared.ts` |
| 6 | Files: `files.owner_type` is `client`, `staff` or `customer`; `StoredFiles.store/metaOf/findOwned` are public; uploads exist for merchants (`POST /client/files`, any type, 25 MiB) and signed-in customers (`POST /store/v1/files`, PDF/JPEG/PNG, 5 MiB); there is no staff upload, no upload for a guest and no customer download | `platform/files/stored-files.ts`, `platform/contracts/files.contracts.ts`, `common/multipart.ts` (`MULTIPART_ROUTES`) |
| 7 | Every `ticket-token` request on the store costs one point of the limiter `token` (30 a minute per address): a typing ping every few seconds would use it up | `infra/rate-limit/public-ip-limit.ts`, `limiters.ts` |
| 8 | The API's access log writes the route template, never the path; **Caddy's access log writes the full URI**, so a ticket token already reaches the proxy's log today | `infra/logging/access-log.ts`, `deploy/Caddyfile` (`log`) |
| 9 | The erasure hook of support only clears the tokens of the customer's tickets; tickets and messages stay (B175) | `support/support-erasure.module.ts` |
| 10 | The merchant's `support.reply` event has no `link` variable (there was no page); the customer's has `link` (the token page) | `application/support-events.ts`, platform `BUILT_IN_EVENTS` |
| 11 | The console thread is `TicketThread` → `MessageList` → `MessageBubble`, with `Composer`; the storefront page renders `TicketMessages` (server) and `TicketReplyForm` (client, then `router.refresh()`) | `FA/src/features/support/components/`, `SF/components/support/` |

## 2. Product rules

1. **Live both ways.** A message appears at once on the open ticket page (customer), the open portal thread (merchant) and the
   console (thread, list, counts). The page works without the stream as today (it then refetches every 30 s).
2. **Typing** is ephemeral: a throttled `POST`, never stored, never replayed. Staff typing a **reply** is shown to the
   requester ("Support is typing…"); staff typing a **note** is shown to other staff only; the requester's typing is shown to
   staff.
3. **Seen.** One mark per side, stored on the ticket: the highest public staff message the requester has seen, and the highest
   requester message staff have seen (staff are one party: the customer learns that support saw it, never who). The own last
   message shows `Sent` or `Seen`. Notes and system messages have no receipt.
4. **Staff collision.** No lock. The console shows `<name> is replying…` / `<name> is writing a note…` from other staff's
   typing, and for 30 s after another staff member's public reply arrives while a draft is open: `<name> just replied`.
   No "is viewing" presence.
5. **Console alerts.** For a requester message or a new ticket (assigned to me or unassigned): a short sound (Web Audio, no
   asset) and, when the tab is hidden and the staff member allowed it, a desktop notification `New message on T-1042` with the
   requester's name (no message text). Two switches in the console's display preferences (browser storage): sound (default
   on), desktop (default off; turning it on asks the browser). Only the tab that holds the stream alerts.
6. **My tickets (signed-in customer).** `/account/tickets` lists the tickets with `requester_type = 'customer'` and
   `requester_id` = the customer (tickets filed with their email as a guest included). Each row links to the existing token
   page. A signed-in customer opens a ticket without Turnstile and gets the token at once. Guests keep the emailed link.
7. **Merchant support.** The portal gets `/merchant/support` (list, new, thread). Merchant tickets have no token: the session is
   the credential and the routes take the ticket id (a foreign id is 404).
8. **Attachments.** PDF, JPEG or PNG, at most 5 MiB each, at most 5 per message; the content must start with the type's magic
   bytes; a message may be files only. No virus scan (none in the stack): files are never shown inline, every download is a
   presigned link with `Content-Disposition: attachment` (5 minutes), and the console says `Files are not virus-scanned.` under
   a requester's attachment. Who may download: the requester (files of public messages of their own ticket) and staff with
   `support:read` (every file of the ticket, notes included).
9. **Email fallback.** A staff reply on channel `email` is no longer mailed at once. If the requester has not seen it after
   `support.replyEmailDelayMinutes` (default **5**; `0` = at once, as before), **one** email carries every unseen reply of the
   ticket. A reply on channel `telegram` (merchant with a linked chat) is sent at once as today and is not repeated by email.
   The receipt mail and the survey are unchanged. CSAT is unchanged (customers only).
10. **Erasure and retention.** Anonymizing a customer also deletes every attachment of their tickets (both sides' files; the
    texts stay, B175) and closes their ticket streams. Attachments are deleted `support.attachmentRetentionDays` (default
    **180**; `0` = keep) after their ticket was resolved.

## 3. Backend design

### 3.1 Tables (migration `0031_support_live_chat`, generated with `bun run db:generate --name support_live_chat`; the lead renumbers)

`support_tickets` gains (all nullable, no default): `requester_seen_message_id` bigint, `requester_seen_at` timestamptz,
`staff_seen_message_id` bigint, `staff_seen_at` timestamptz, `last_requester_message_id` bigint, `last_staff_message_id`
bigint (the newest **public staff** message), `reply_mail_due_at` timestamptz, `reply_mailed_message_id` bigint; index
`support_tickets_reply_mail_due_idx (reply_mail_due_at) where reply_mail_due_at is not null`. `ticket_messages` gains
`notify_channel` text null, check `in ('email','telegram')` (set on a public staff message; NULL otherwise). The migration
back-fills `last_*` from `ticket_messages` and sets both seen ids and `reply_mailed_message_id` to them (old tickets are
neither unread nor mailed again); existing public staff messages get `notify_channel = 'email'`. The eight columns and
`notify_channel` go to `ADDITIONS` of `test/schema/structure.test.ts`. No new table.

Migration `0032_support_reply_link` (hand-written, guarded): the merchant `support.reply` default templates (email and Telegram,
each language) get the line `Open the conversation: {{link}}` appended **only where the body still equals the shipped
default**; `SUPPORT_EVENTS` adds the variable `link` to the merchant event.

`hasUnread` is never stored: for staff `last_requester_message_id > coalesce(staff_seen_message_id, 0)`; for the requester
`last_staff_message_id > coalesce(requester_seen_message_id, 0)`.

### 3.2 Routes

Rows in `scripts/map-additions/28.mjs` (§5). `:token` routes are `ticket-token`; `/store/v1/me/*` `customer-session`;
`/client/*` `merchant-session` with `pendingMerchant: 'allow'`; admin routes `staff-permission`.

| # | Route | Access · permission | Answer | What |
|---|---|---|---|---|
| 1 | `GET /store/v1/tickets/:token/stream` | ticket-token | 200 `text/event-stream` | the ticket's live events (§3.4) |
| 2 | `POST /store/v1/tickets/:token/typing` | ticket-token | 204 | "the requester is typing" |
| 3 | `POST /store/v1/tickets/:token/read` | ticket-token | 204 | body `{ upToMessageId: Id }` |
| 4 | `POST /store/v1/tickets/:token/files` | ticket-token | 201 `StoredFile` | multipart, one part `file` |
| 5 | `GET /store/v1/tickets/:token/files/:fileId` | ticket-token | 302 | presigned download |
| 6 | `GET /store/v1/me/tickets` | customer-session | 200 list | my tickets |
| 7 | `POST /store/v1/me/tickets` | customer-session | 201 `StoreTicket & { token }` | open a ticket when signed in |
| 8 | `GET /client/tickets` | merchant-session | 200 list | the merchant's tickets |
| 9 | `POST /client/tickets` | merchant-session | 201 `ClientTicket` | open a ticket |
| 10 | `GET /client/tickets/:id` | merchant-session | 200 `ClientTicket` | thread |
| 11 | `POST /client/tickets/:id/messages` | merchant-session | 201 message | reply |
| 12 | `POST /client/tickets/:id/read` | merchant-session | 204 | `{ upToMessageId }` |
| 13 | `POST /client/tickets/:id/typing` | merchant-session | 204 | typing |
| 14 | `GET /client/tickets/:id/files/:fileId` | merchant-session | 302 | presigned download |
| 15 | `POST /admin/support-tickets/:id/read` | `support:read` | 204 | `{ upToMessageId }`; `audit: false` (the staff side's own read mark) |
| 16 | `POST /admin/support-tickets/:id/typing` | `support:reply` | 204 | body `{ mode: 'reply' \| 'note' }`; `audit: false` (ephemeral, nothing stored) |
| 17 | `POST /admin/support-tickets/:id/files` | `support:reply` | 201 `StoredFile` | multipart; audited `attached file to ticket` |
| 18 | `GET /admin/support-tickets/:id/files/:fileId` | `support:read` | 302 | presigned download |

**Shapes** (new keys on existing answers are `.optional()` with the text "Always sent; optional in the schema until the
console merge", as feature 25 did; the lead makes them required after the merges):

```ts
Attachment        = { id: Id; filename: string; mime: string; size: number }
StoreMessage      = { id; from: 'you' | 'support'; body; createdAt; attachments: Attachment[] }          // + attachments
StoreTicket       = { …today…, seenByYou: Id | null; seenBySupport: Id | null; seenBySupportAt: IsoDateTime | null }
MyTicketRow       = { number; subject; category; status; orderId: Id | null; createdAt; updatedAt;
                      lastMessageAt: IsoDateTime | null; lastMessageFrom: 'you' | 'support' | null; hasUnread: boolean; token: string }
ClientTicketRow   = MyTicketRow without token, plus id: Id
ClientTicket      = StoreTicket without canRate/csatScore, plus id: Id                                    // messages as StoreMessage
TicketMessage     (admin) + attachments: Attachment[]                                                     // fileIds stays
TicketRow         (admin) + hasUnread: boolean; requesterSeenMessageId: Id | null; requesterSeenAt: IsoDateTime | null;
                            staffSeenMessageId: Id | null; staffSeenAt: IsoDateTime | null
```
- Message bodies (`POST …/:token/messages`, route 11, admin `reply` and `note`) gain `fileIds: z.array(zId).max(5,
  'Attach at most 5 files.').optional()`; `body` may be `''` only when `fileIds` has an entry (else the route's own empty-text
  message). Bodies of routes 7 and 9: `{ subject, message, category?, orderId?, fileIds? }` with the texts of the public form;
  `orderId` must be an order of the caller (else 422 `orderId` `unknown_order`).
- Lists 6 and 8: `listQuery` with sorts `updatedAt` (default, desc), `createdAt`; filter `status` (the wire words); no search;
  at most 50 a page.
- Refusals: a foreign or unknown id or token → `404`; `upToMessageId` that is not a message of the ticket the caller may see
  → 422 `upToMessageId` `unknown_message`; file problems → 422 on `file` (`type`, `empty`) or `fileIds` (`unknown_file`,
  `not_yours`, `type`, `too_large`), `413` above 5 MiB; limits → `429 RATE_LIMITED` with `Retry-After`. Admin `reply` keeps
  `409 TICKET_RESOLVED`. No new error code.

### 3.3 Use cases

- **`TicketThreadService`** (new, `application/ticket-thread.service.ts`): the one place a requester's message is written:
  `write(ticketId, party, { body, fileIds })` (moves today's `StoreTicketService.write`: lock the ticket, insert, status and
  reply-target rules unchanged, `last_requester_message_id`, attachments check, `TicketEvents.message`). `StoreTicketService`
  and the new `ClientTicketService` call it. `TicketConversationService.reply/note` gain `fileIds`, set
  `last_staff_message_id` and `notify_channel` (reply), and call `TicketEvents`.
- **`TicketEvents`** (new): the doorbells of §3.4 through `RealtimePublisher.publishOnCommit`; called by every use case that
  changes a ticket (create, message, reply, note, PATCH, CSAT, read).
- **Read** (`TicketReadService.mark(ticketId, side, upToMessageId)`): the message must belong to the ticket and be one the
  other side wrote and the caller may see; one guarded statement `UPDATE … SET <side>_seen_message_id = $1, <side>_seen_at =
  $now WHERE id = $2 AND coalesce(<side>_seen_message_id, 0) < $1`; a row changed → doorbell `read`; a repeat is a 204 with no
  doorbell. A requester's read never touches `updated_at`.
- **Typing** (`TicketTypingService.ping(ticketId, by, mode)`): `SET gsm:{env}:support:typing:{ticketId}:{r|s<staffId>} 1 NX PX
  2500` on the cache Redis; set → publish the doorbell; not set, or Redis down → nothing. Always 204. No row, no audit.
- **Attachments** (`TicketAttachmentService`):
  - `upload(owner, input)`: type from `cleanMediaType` must be PDF, JPEG or PNG **and** `sniffAttachment(bytes)` (new pure
    function, `domain/attachment-rules.ts`: `%PDF-`, `FF D8 FF`, the PNG signature) must agree; 1 byte to 5 MiB;
    `StoredFiles.store(db, { ownerType, ownerId, area: 'tickets', … })` with the cleaned name. Owner: the ticket's customer
    (route 4), the staff member (route 17). Merchants upload with the existing `POST /client/files`.
  - `attach(tx, ticket, sender, fileIds)` inside the message's transaction: every id must exist and be owned by the sender
    (`StoredFiles.findOwned`: the ticket's customer; the merchant; the staff member), be PDF/JPEG/PNG and at most 5 MiB (a
    merchant's portal upload can be anything). The ids are written to `file_ids`.
  - `linkFor(ticketId, viewer, fileId)`: the file must be in `file_ids` of a message of **that** ticket, and for a requester
    that message must be public; then `StoredFiles.linkTo(db, fileId)` (new platform method: presigned GET, 5 minutes,
    attachment disposition) and `302` with `Cache-Control: no-store`. Anything else is 404.
  - `eraseForCustomer(tx, customerId)` (called by `SupportCustomerErasure` beside the token clear): collects the file ids of
    every message of the customer's tickets, empties those `file_ids`, calls `StoredFiles.remove(tx, ids)` (new: deletes the
    rows, deletes the objects `onCommit`, best effort) and rings `ticket` `revoked` for each ticket.
  - Retention job `ticket_attachment_retention` (queue `maintenance`, scheduler daily 03:30 UTC, batches of 200 tickets, at most
    25 a run, recorded in `job_runs` like `data_retention`): tickets resolved more than the setting ago with a non-empty
    `file_ids` → the same removal.
- **Email fallback.** `reply` on channel `email`: no outbox event; `reply_mail_due_at = coalesce(reply_mail_due_at, now +
  delay)` in the reply's transaction (delay `0`: the event is written at once, as today). Channel `telegram`: today's event,
  unchanged. Job **`support_reply_mail_sweep`** (queue `maintenance`, scheduler every minute, recorded the way
  `checkout_recovery_sweep` records its runs): tickets with `reply_mail_due_at <= now` in id order, `FOR UPDATE SKIP LOCKED`,
  100 a pass; per ticket in the same transaction: unseen = public staff messages with `notify_channel = 'email'` and `id >
  greatest(coalesce(requester_seen_message_id, 0), coalesce(reply_mailed_message_id, 0))`; none → clear `reply_mail_due_at`;
  else one outbox event `support.ticket_mail` `{ kind: 'reply', channel: 'email', messageId: <last>, fromMessageId: <first> }`,
  `reply_mailed_message_id = <last>`, `reply_mail_due_at = NULL`. `TicketMailJobs` (kind `reply` with `fromMessageId`): loads
  those messages again (same filter, so a message seen meanwhile drops out; none left → skipped), joins their bodies oldest
  first with a blank line (at most 10; before them `… and <n> earlier messages` when more), adds `(<n> files attached)` for
  attachments, and sends one mail (variable `reply`/`message`, dedupe key `outbox-<event id>:email`). An event without
  `fromMessageId` is one message, as today. The merchant's `link` is `<STORE_BASE_URL>/merchant/support/<id>`.
- **Settings** (`platform/settings/settings-registry.ts`): `support.replyEmailDelayMinutes` (integer 0 to 1440, default 5),
  `support.attachmentRetentionDays` (integer 0 to 3650, default 180).
- **Limits** (`infra/rate-limit/limiters.ts`): `ticket-chat` (120 a minute per address: routes 2 and 3, chosen in
  `publicLimiterFor` for a store `ticket-token` path ending in `/typing` or `/read`; fact 7); `ticket-message` (20 a minute per
  ticket, requester messages); `ticket-open` (5 an hour per account: routes 7 and 9). Routes 4 and 17 are multipart: add them to
  `MULTIPART_ROUTES` and, with 5 MiB + 64 KiB, to `MULTIPART_ROUTE_LIMITS`; they cost an `upload` point as large bodies do.
- **Audit** (entity `ticket`): `replied to ticket` and `added note to ticket` gain `after.fileIds`; `attached file to ticket`
  `{ fileId, filename, size }`. Routes 15 and 16 write none (table above). Requester routes write none (no staff actor).

### 3.4 Live events (source `TicketRealtimeSource`, topic `ticket`, cursor letter `t` = `ticket_messages.id`)

Audience keys: `support:staff` (`keysFor` of a staff viewer whose permissions grant `support:read`), `ticket:<id>` (a `ticket`
viewer), and the requester's account key `u:customer:<id>` / `u:client:<id>` (default keys of brief 27).

| Doorbell `op` | Fields (ids only) | Events |
|---|---|---|
| `message` | `ticketId`, `messageId` | `ticket.message.created` (id `t<message id>`), then `ticket.updated` |
| `updated` | `ticketId` | `ticket.updated` (status, assignee, priority, rating, a new ticket) |
| `read` | `ticketId`, `by: 'requester' \| 'staff'` | `ticket.read` |
| `typing` | `ticketId`, `by`, `staffId?`, `mode?` | `ticket.typing` |
| `revoked` | `ticketId` | a delivery with `close: 'session_ended'` for `ticket:<id>` (brief 27 §3.2): the hub ends those streams |

`resolve` reads the ticket (and the message with its author's name and attachments) once and renders **two views**:

| Event | Staff view (key `support:staff`) | Requester view (keys `ticket:<id>` and the account key) |
|---|---|---|
| `ticket.message.created` | `{ ticketId, message: TicketMessage, live }` (notes and system messages included) | `{ ticketId: Id \| null, number, message: StoreMessage, live }`; **never** for an internal or system message |
| `ticket.updated` | `{ ticket: TicketRow }` | `{ ticketId: Id \| null, number, status, updatedAt, resolvedAt, canRate, csatScore, hasUnread }` |
| `ticket.read` | `{ ticketId, by: 'requester' \| 'staff', upToMessageId, at }` | `{ ticketId: Id \| null, number, by: 'you' \| 'support', upToMessageId, at }` |
| `ticket.typing` | `{ ticketId, by: 'requester' \| 'staff', staffId: Id \| null, staffName: string \| null, mode: 'reply' \| 'note' \| null }` | `{ ticketId: Id \| null, number }`, only for staff typing a **reply** |

`ticketId` in a requester view is the id for a merchant and `null` for a customer (customers address tickets by token; a token is
never put in an event; the page matches by `number`). Only `ticket.message.created` carries an `id`. Replay (`after`, limit
100, else `resync`): staff → messages of all tickets; an account viewer → public messages of their own tickets; a `ticket` viewer
→ public messages of that ticket. `snapshot`: none. `head`: `max(id)` of `ticket_messages`.

**Route 1** (support module, `controllers/store-ticket-stream.controller.ts`): after the `ticket-token` guard, `hub.open` with
viewer `{ kind: 'ticket', id: <ticket id>, sessionId: null, … }` and caps `ticket:<id>` 3 and `ip:<ip>` 30; `query` and the
`last-event-id` header as in brief 27; no `originCheck` (no cookie is involved). **The token stays in the path**, like its three
sibling routes: an `EventSource` cannot send a header, and a short-lived stream ticket would need a mint route, a Redis key and
would break the browser's own reconnect, while the token already is the page URL. The API logs the route template (fact 8);
the hub logs `viewer: 'ticket:<id>'`. `deploy/Caddyfile`: the `log` of the shop host gets
`format filter { wrap json; request>uri regexp "/tickets/[^/?]+" "/tickets/[token]" }` (also hides the token of the existing
routes and of the page `/…/support/tickets/<token>`).

## 4. Clients

### 4.1 Console (slice C; `FA/src/features/support/` only, plus the two preference switches)

- **Live thread** (`hooks/useTicketLive.ts`, used by `TicketThread`): `ticket.message.created` for the open ticket appends
  to the `useOne` cache (dedupe by id, order by id); `ticket.updated` replaces the row in the detail and patches the list
  caches (or invalidates them), `SUPPORT_COUNTS_KEY` and `DASHBOARD_KEY` (at most once every 5 s); `resync` or a later
  `ready` refetches. `REFRESH_MS` stays 30 s while the stream is not open and becomes `LIVE_REFRESH_MS = 300_000` while it is.
- **Typing**: `Composer` calls `sendTyping(id, mode)` at most once every 3 s while the draft changes and is not empty (`mode`
  = the composer's Reply/Note tab). `TypingLine.tsx` under the thread: `<requester name> is typing…`; in `ThreadHeader`:
  `<name> is replying…` / `<name> is writing a note…` for other staff (never for oneself); each shown 6 s after its last event
  and cleared by that party's message. `TicketRow` shows a small pencil while the requester types.
- **Seen**: the thread calls `markTicketRead(id, upToMessageId)` when it is visible, the window has focus and the newest
  requester message is newer than `staffSeenMessageId`. Under the last public staff message: `Sent` or `Seen <time>` (from
  `requesterSeenMessageId` / `requesterSeenAt`, updated by `ticket.read`). `TicketRow` shows an unread dot for `hasUnread`.
- **Collision**: `CollisionNotice.tsx` above the composer, `aria-live="polite"`: `<name> just replied. Check the thread before
  you send.` for 30 s (rule 4).
- **Attachments**: `Composer` gets an `Attach` button (`paperclip` icon; PDF, JPEG, PNG; 5 MiB; 5 files) with a chip per file
  (name, size, remove, upload progress, the server's error); files upload on pick (`uploadTicketFile`), the reply or note sends
  `fileIds`. `MessageBubble` lists attachments as links to route 18 (`target="_blank"`, `rel="noopener"`), with `Files are not
  virus-scanned.` under a requester's.
- **Alerts** (`hooks/useSupportAlerts.ts`; it must run on every page: mounted through the feature manifest's shell slot as the
  notification bell is, else the lead adds one line to `AppShell.tsx`): rule 5.
  `src/app/layout/preferences.ts` and `DisplayMenu.tsx` gain `Support sound` and `Desktop alerts` (the two shared edits).
- **API** (`api/tickets.ts`, JSDoc with `@route`, "backend addition, B218"): `markTicketRead`, `sendTicketTyping`,
  `uploadTicketFile`, `ticketFileUrl`; `replyToTicket`/`addNote` take `fileIds`. **Types**: `Attachment`; the new keys of
  `SupportTicket` and `TicketMessage`.
- **Mocks** (`mocks/ticketHandlers.ts`, `store.ts`, `dto.ts`): the four routes; seen ids and `hasUnread`; attachments kept in
  memory; a reply pushes `ticket.message.created` and `ticket.updated` through `pushMockStreamEvent` (brief 27); a dev-only
  helper answers as the customer 4 s after a reply that contains `/echo` (so typing, seen and the alert can be seen).
- `FA/docs/MISMATCHES.md`: a line under M10 (B218, B219).
- **Tests**: `pages/SupportThread.test.tsx` (a pushed message appears without a request; an internal note of a colleague
  appears; typing lines show and expire with fake timers; `Seen` after `ticket.read`; the read call fires once and only when
  visible; the collision notice; attach, remove, a refused type, the reply body with `fileIds`; a files-only reply),
  `pages/SupportPage.test.tsx` (the unread dot; the list reorders on `ticket.updated`; counts refresh),
  `hooks/useSupportAlerts.test.ts` (sound and desktop rules with fakes; off switches), `api/support.test.ts` (the new
  functions).

### 4.2 Storefront (slice S; `SF/`)

- **Conversation** (`components/support/ticket-conversation.tsx`, client): takes the server-read ticket as its first state and
  an adapter (`lib/support/ticket-api.ts`: `tokenAdapter(token)` and `merchantAdapter(id)`: `send`, `read`, `typing`,
  `upload`, `fileHref`, `streamUrl` or the surface stream, `refetch`). It renders the messages (the markup of today's
  `ticket-messages.tsx`, which becomes a pure presentational part), appends `ticket.message.created`, applies
  `ticket.updated` (status badge, the rating form when `canRate`), shows `Support is typing…` (6 s) and `Sent` / `Seen` under
  the visitor's last message, marks read when the tab is visible and the last message is on screen, and sends typing at most
  once every 3 s. New messages are announced by the existing `role="log"`; the list scrolls to a new message only when the
  reader was at the bottom, else a `New message` button appears. The token page opens its own stream with
  `createStream({ url: '/store/v1/tickets/<token>/stream', lockName: 'gsm-ticket-<number>' })` (brief 27 §5.1); the merchant
  thread listens on the merchant stream. Without a stream: `refetch` every 30 s while visible.
- **Reply form** (`ticket-reply-form.tsx`): no `router.refresh()`; the answer of the `POST` is appended (the event with the
  same id is ignored); an `Attach` control (same limits; chips; errors by code `type`, `too_large`, `empty`); `Enter` sends,
  `Shift+Enter` breaks the line (hint text under the box).
- **Attachments** in a bubble: file name and size as a link to the download route (opens in a new tab; never an inline image).
- **My tickets**: `app/[lang]/account/tickets/page.tsx` (server list inside `<Suspense>`: number, subject, status badge,
  last activity, an unread dot; rows link to `/support/tickets/<token>`; empty state with `Open a ticket`), a `New ticket`
  button to `app/[lang]/account/tickets/new/page.tsx` (the public form's fields without email and Turnstile, an order picker
  from the customer's orders, then go to the token page). Account nav (`app/[lang]/account/layout.tsx`): `My tickets`
  (`/account/tickets`) replaces the `Support` item's target; the list refreshes on `ticket.*` events of the customer stream
  (`router.refresh()`, as brief 27's list).
- **Merchant portal**: `app/[lang]/(portal)/merchant/support/page.tsx` (list), `…/support/new/page.tsx`,
  `…/support/[id]/page.tsx` (thread with `merchantAdapter`); nav item `Support` (`/merchant/support`, icon `Headset`).
  `proxy.ts` already guards `/merchant…`.
- **Messages** (`lib/i18n/messages/support.ts`, `account.ts`, `portal.ts`; `en` / `ar`): `typing` `Support is typing…` / `فريق
  الدعم يكتب…`; `sent` `Sent` / `أُرسلت`; `seen` `Seen` / `شوهدت`; `newMessage` `New message` / `رسالة جديدة`; `attach` `Attach
  a file` / `إرفاق ملف`; `attachHint` `PDF, JPG or PNG, up to 5 MB, 5 files` / `PDF أو JPG أو PNG، حتى 5 ميغابايت، 5 ملفات`;
  `myTickets` `My tickets` / `تذاكري`; `newTicket` `New ticket` / `تذكرة جديدة`; `noTickets` `You have no tickets yet` / `لا
  توجد تذاكر بعد`; `merchantSupport` `Support` / `الدعم`; `live` `Connected` / `متصل`; `offline` `Reconnecting…` / `جارٍ إعادة
  الاتصال…`; the error texts of the new field codes.
- `npm run gen:api`; `lib/api/types.ts` aliases (`MyTicketRow`, `ClientTicket`, `Attachment`); ticket events in
  `lib/support/ticket-events.ts` (hand-written from §3.4).
- **Tests** (Vitest): the conversation reducer (append, dedupe, order, seen, typing expiry), the adapters (paths and bodies),
  the attach rules. **e2e** (`e2e/support-live.spec.ts`, written here, run by the lead): (a) a customer has the ticket page
  open; the seeded Support agent replies through the admin API; the reply shows **without a reload** and `Seen` reaches the
  agent's `GET`; (b) the customer types in the box and the staff stream (`GET /admin/stream` read by the test) gets
  `ticket.typing` for that ticket; (c) a PDF is attached and its download answers 302; (d) a signed-in customer sees the
  ticket under `/account/tickets`; (e) a merchant opens a ticket in the portal and gets the agent's reply live.
- a11y: the typing line and the connection state are `aria-live="polite"`; the file input has a real label; chips are buttons
  with names; focus stays in the box after sending; RTL through logical utilities; touch targets 44 px.

### 4.3 What stays the same

The public form and its Turnstile and limits; the token as the page's credential and the 404 after an erasure; the statuses and
their moves; reply targets and `late`; reply templates and macros; CSAT; the audit phrases; the Telegram reply; the console's
filters, tabs and counts (now also refreshed by events); every existing route's method, path and success status.

## 5. Contract and docs

- **`scripts/map-additions/28.mjs`** (rows 1-5 and 15-18, spec `B-TBD support-live-chat`, slice B1) and
  **`scripts/map-additions/28b.mjs`** (rows 6-14, spec `B-TBD support-accounts`, slice B2); stage 28, `module: 'support'`: store rows in group `support` (`a` = `رمز التذكرة` for 1-5, `جلسة الزبون` for 6-7),
  client rows in group `growth` (`a` = `جلسة`; no new group), admin rows in group `support` (`a` = the permission of §3.2).
  `successStatus` = the table's. Tables: `support_tickets`, `ticket_messages`, plus `files` (4, 5, 14, 17, 18), `orders` (7, 9)
  and `audit_logs` (17). Arabic sentences in the map's style (for example `بثّ مباشر لأحداث التذكرة`, `الزبون يكتب الآن`,
  `تعليم رسائل التذكرة كمقروءة`, `إرفاق ملف بالتذكرة`, `تنزيل مرفق`, `تذاكري`, `فتح تذكرة من الحساب`, `تذاكر التاجر`); `en` = the
  "What" column.
- `docs/queues.md`: `support_reply_mail_sweep` and `ticket_attachment_retention` under **maintenance** and in the schedulers
  table; the `support.ticket_mail` row gains `fromMessageId`. `docs/cache-keys.md`: `gsm:{env}:support:typing:{ticketId}:{party}`
  (owner support, TTL 2.5 s, never invalidated, a throttle, not a cache). `docs/contract/realtime-events.md`: the four ticket
  events with both views. `support/README.md` (routes 14 → 32, rules 2 to 10 of §2, events, jobs, cache key, audit, the stream
  route); `platform/README.md` (`StoredFiles.linkTo/remove`, the two settings).
- **B217 (proposal).** area `support`; routes 6-14; conflict: "The map gives a signed-in customer no list of their tickets and
  a merchant no ticket route at all."; decision: "Lead record (feature 28). A customer's tickets are those whose requester is
  that customer; the list returns each ticket's token and the page stays the token page; a signed-in customer opens a ticket
  without Turnstile (5 an hour). Merchants get list, open, thread, reply, read, typing and download under /client/tickets by
  id; a foreign id is 404; a pending merchant may use them."; status `decided`.
- **B218 (proposal).** area `support`; routes 1-5, 15-18; conflict: "Support was email plus a reload: no live messages, typing,
  seen marks or attachments."; decision: "Lead record (feature 28, decision 037). The ticket's events ride the real-time layer:
  staff with support:read on /admin/stream, the requester on their account stream and on GET /store/v1/tickets/:token/stream
  (the token in the path, 3 streams per ticket). Typing is a throttled POST that is never stored. Each side has one seen mark
  on the ticket. Attachments are PDF, JPEG or PNG, 5 MiB, 5 per message, checked by content, downloaded only through
  presigned links by the requester (public messages) or staff; deleted with the customer and 180 days after the ticket was
  resolved."; status `decided`.
- **B219 (proposal).** area `support`; routes `POST /admin/support-tickets/:id/reply`, `POST /admin/support-tickets/:id/note`,
  `GET /admin/support-tickets`, `GET /admin/support-tickets/:id`, `GET /store/v1/tickets/:token`, `POST
  /store/v1/tickets/:token/messages`; conflict: "The map mails every staff reply at once and its shapes have no attachment or
  seen field."; decision: "Lead record (feature 28). Messages gain attachments and accept fileIds (a body may be empty with a
  file); tickets gain the seen marks and hasUnread. An email reply is mailed only when the requester has not seen it after
  support.replyEmailDelayMinutes (default 5), one mail for all unseen replies; a Telegram reply is sent at once as before."; status
  `decided`.
- Lead after the merges: B217-B219 (indexes 112-114 of `extra`, after 27's B216); make the optional keys required; `bun run
  routes:build && contract:extract && contract:harvest && contract:docs && docs:openapi && coverage:build && check`; console
  `npm run mocks:live`; `db:migrate` on the owner's database; the storefront's `gen:api`.

## 6. Slices, order, files

Order: **B1 → B2** in `../backend-28` (`feat/backend-28`, `gsm_28_test`, Redis DB 7), started after backend 27 is on `main`.
**C** (`../frontend-admin-28`, `feat/console-28`) and **S** (`../storefront-28`, `feat/storefront-28`, own `npm ci`) start
after their feature-27 slice is on their `main` (they use its `realtime` library) and need not wait for B (mocks; §3 is the
contract). The lead merges B, then C, then S (tested against the isolated API on `:3100`).

**B1. Chat engine: HARD, an Opus implementer.** Create in `src/modules/support/`: `application/{ticket-thread.service.ts,
ticket-events.ts, ticket-read.service.ts, ticket-typing.service.ts, ticket-attachment.service.ts, reply-mail-sweep.ts}`,
`realtime/{ticket-realtime.source.ts, ticket-realtime.events.ts}`, `domain/{attachment-rules.ts, seen.ts, reply-mail.ts}`
(+ specs), `contracts/ticket-live.contracts.ts` (routes 1-5, 15-18), `controllers/{store-ticket-stream.controller.ts,
store-ticket-live.controller.ts, support-ticket-live.controller.ts}`, `jobs/{reply-mail-sweep.processor.ts,
attachment-retention.processor.ts}`, `support-jobs.module.ts`, `scripts/map-additions/28.mjs`; `test/integration/{support-live.test.ts,
support-attachments.test.ts, support-reply-mail.test.ts}`. Edit `db/schema.ts` (+ generated `drizzle/0031_*`, hand-written
`0032_*`), `infra/ticket.repository.ts`, `application/{store-ticket.service.ts, ticket-conversation.service.ts,
ticket-admin.service.ts, ticket-views.ts, ticket-mail-outbox.ts, ticket-mail.jobs.ts, support-events.ts,
support-templates.ts}`, `contracts/{shared.ts, store-tickets.contracts.ts, tickets.contracts.ts}`, `support-erasure.module.ts`,
the four support modules and `index.ts`, `src/worker.module.ts`; `platform/files/stored-files.ts`,
`platform/settings/settings-registry.ts`; `infra/rate-limit/{limiters.ts, public-ip-limit.ts}` (+ spec), `common/multipart.ts`
(+ spec), `infra/cache/cache-keys.ts`; `docs/cache-keys.md`, `docs/queues.md`, `docs/contract/realtime-events.md`;
`test/schema/structure.test.ts`; `deploy/Caddyfile`; the existing support tests that assert an immediate reply mail.
**B2. Account surfaces: a Sonnet implementer, after B1.** Create `application/{client-ticket.service.ts,
my-tickets.service.ts}`, `contracts/{client-tickets.contracts.ts, my-tickets.contracts.ts}`,
`controllers/{client-tickets.controller.ts, my-tickets.controller.ts}`, `support-client.module.ts`,
`scripts/map-additions/28b.mjs`, `test/integration/{support-client-tickets.test.ts, support-my-tickets.test.ts}`. Edit
`infra/support-foreign-reads.ts` (an order of a customer or a merchant by id), `support.module.ts` (the new module),
`scripts/seed/support.ts` (a merchant ticket with a thread, a customer ticket with an attachment and seen marks),
`support/README.md`, `platform/README.md`, and the generated
`docs/route-manifest.*`, `docs/slices/*`, `docs/contract/endpoints/support.md`, `docs/contract/openapi*.json`,
`docs/COVERAGE.md`. B2 calls B1's services and never edits B1's files (a needed change is reported, not made); B1 regenerates the generated
documents to get green and B2 regenerates them again at the end.
Acceptance (B): §2 and §3 as written; `bun run format`, then `bun run check` green.

**C. Console: Sonnet; `useTicketLive.ts` and the read/typing timing are reviewed by Opus.** Files of §4.1. Acceptance: `npm
run typecheck`, `npm run lint`, `VITE_API_MOCKS=false npm run build`, `npm test`.
**S. Storefront: Sonnet; `ticket-conversation.tsx` is reviewed by Opus.** Files of §4.2. Acceptance: `npm run typecheck`, `npm
run lint`, `npm run test` (the lead runs `next build` and Playwright).

HARD parts, all in B1: the stream route and its caps; the two-view rendering (no note, staff name or assignee may reach a
requester); read marks; the typing throttle; the email fallback sweep and the batched mail; the attachment ownership and
download checks; erasure. No file is in two slices; nothing under `infra/realtime`, `FA/src/lib/realtime` or `SF/lib/realtime`
is edited.

## 7. Tests and acceptance

| File | Covers |
|---|---|
| `support/domain/*.spec.ts` | `sniffAttachment` (each type, a renamed `.exe`, an empty file); the seen rule (monotonic, the other side's messages only); the mail text (1, 10 and 12 messages, attachments note) |
| `test/integration/support-live.test.ts` (listening test app, real Postgres and Redis, `TestClock`) | a staff reply reaches the token stream and the customer's account stream in **under 1 s** as the requester view; a customer message reaches a staff stream with `support:read` and **not** one without it; **an internal note and a system message never reach any requester stream** and the requester view has no staff name, assignee or priority; a merchant's stream gets only its own tickets; another ticket's token stream gets nothing; `ticket.updated` on PATCH and on a new ticket; typing: one event per 2.5 s however many pings, a note's typing only to staff, nothing stored; read: the mark moves forward only, a foreign or internal message id is 422, the event reaches the other side, a requester's read leaves `updated_at`; replay of 3 missed messages with `Last-Event-ID`, 101 → `resync`; the 4th stream of a ticket is 429; erasure ends the ticket's streams and the token answers 404; the `ticket-chat` limiter (typing does not use up `token`) |
| `test/integration/support-attachments.test.ts` | upload refusals (type by name, type by content, empty, 5 MiB + 1, a 6th file); attach: unknown id, **a file of another customer, of another merchant, of another staff member** → 422 `not_yours`; a merchant's 20 MiB portal upload → `too_large`; download: the requester gets a public message's file (302, 5-minute link, attachment disposition) and **404 for a note's file, another ticket's file and a file that is in no message**; staff get all; erasure removes rows and objects; the retention job by age, and nothing with the setting 0 |
| `test/integration/support-reply-mail.test.ts` | no mail when the requester read within the delay; one mail with two replies after 5 minutes (`TestClock`), then none for the same messages; a reply after a mail starts a new delay; delay 0 mails at once; a Telegram reply is sent at once and not mailed; the sweep twice in parallel sends once; an anonymized customer gets nothing; the merchant mail carries the portal link |
| `test/integration/support-client-tickets.test.ts`, `support-my-tickets.test.ts` | every route's success and refusals; a foreign id 404; a pending merchant allowed, a suspended one refused; the lists' filter, sort, range and `x-total-count`; `hasUnread`; `ticket-open` (6th in an hour 429); a foreign `orderId`; the token in route 6 and 7 opens the page route |
| `test/scenarios/b2c-ticket.e2e.ts` (extend) | the scenario still passes with the delayed mail (the clock advances 5 minutes before the mail is asserted) |
| Contract suite | parity of the 18 rows; examples validate; the optional keys carry their note; no allowlist entry |
| Console, storefront | §4.1, §4.2 |

**Load** (the lead, with brief 27's script and a `--chat` option): 200 open tickets with a customer stream each and 10 staff
streams; 20 messages a second for a minute; record delivery p95 (target under 1 s), drops (0), API CPU.

**Acceptance of the feature**: with the console and a customer ticket page open side by side, a message typed on either side
appears on the other within a second without a reload; typing and `Seen` show; a PDF goes both ways; the customer closes the
page, staff reply, and five minutes later one email arrives with the reply; a merchant does the same from the portal.

## 8. Handoff notes (the lead adds them after the merges)

- `STOREFRONT-BACKEND-HANDOFF.md`: a new **§16 "Support live chat (feature 28)"**: the 14 store and client routes with
  bodies, answers and refusals; the changed shapes (`attachments`, `seenByYou`, `seenBySupport`, `hasUnread`, `fileIds`, an
  empty body with a file); the four events with the requester view and "match a customer's ticket by `number`"; the token
  stream (path, caps, no cookie); the client rules (typing at most every 3 s, show 6 s; mark read only when visible; dedupe by
  message id; fall back to a 30 s refetch); attachments (types, sizes, download by link, never inline); the limits
  (`ticket-chat`, `ticket-message`, `ticket-open`, `token`); "a reply email now arrives only when the page was not open
  (5 minutes)"; My tickets and the merchant pages. The status table: feature 28. §11 (errors): the new field codes.
- `STOREFRONT-HANDOFF.md`: the banner's change list points to §16; the support section says the ticket page is live, that
  `router.refresh()` after a reply is gone, and lists the two new areas (`/account/tickets`, `/merchant/support`).

## 9. Decisions

Taken here: one seen mark per side on the ticket (no per-message table); typing through a throttled `POST` and a 2.5 s Redis
key; collision by typing lines and a notice, no lock and no viewing presence; the token stays in the stream's path with the
proxy log redacted; signed-in customers reuse the token page (the list hands out the token); merchants address tickets by id;
attachments through support's own upload routes for guests and staff and the portal's existing upload for merchants, with the
check at attach time; no new table; the fallback as a one-minute sweep that writes today's outbox event; Telegram unchanged.
Left out on purpose: a floating chat widget on every storefront page, staff-to-staff mentions, message edit or delete, emoji
reactions, inline image previews, voice notes, a bot or canned auto-reply, routing rules and working hours, live chat for
visitors without a ticket.

**For the owner (defaults applied; say so to change one):**

| # | Question | Default |
|---|---|---|
| 1 | Do customers see `Seen` when support opened their message? | **Yes**, both ways |
| 2 | How long before an unseen reply is emailed? | **5 minutes**, one mail for all unseen replies (setting; 0 = at once) |
| 3 | Attachment types and size | **PDF, JPEG, PNG; 5 MiB; 5 per message** |
| 4 | Virus scanning of attachments | **None** (no scanner in the stack; download-only links and a warning). A ClamAV container is a separate small feature |
| 5 | How long attachments are kept | **180 days** after the ticket is resolved (setting; 0 = keep) |
| 6 | Console sound and desktop alerts | **Sound on, desktop off** until the staff member turns it on; no message text in a desktop alert |
| 7 | May a merchant waiting for approval open tickets? | **Yes** |
| 8 | A chat bubble on every storefront page (not only the ticket page) | **Not now** |

## 10. Review against the code, and approval

Checked in the code: the support schema (requester columns, `token`, `file_ids`, the `chat` channel word), the three
storefront use cases and the two staff ones, the outbox event and its job, the token resolver and the capability guard, the
per-address limiter choice for token routes, the files table, `StoredFiles` and the three upload routes with their owners and
limits, the multipart route list, the erasure hook, the notification events of support (the merchant event has no `link`),
the settings registry pattern, `ADDITIONS` of the schema test, the optional-key precedent of feature 25, the map's groups
(`support` on store and admin, none on client: `growth`), `lead-decisions.json` (111 entries; 27 takes B216), migrations (0030
is the last; 27 adds none), the Caddyfile's log block and Caddy's `format filter` syntax (current docs), the console's support
components, hooks, mock handlers and preferences, the storefront's ticket page, reply form, messages component, account and
portal navigation and the support e2e file. Not verified: the exact names of the default merchant reply templates that
migration 0032 compares (B1 reads migration 0012 and `SUPPORT_DEFAULT_TEMPLATES`), how `checkout_recovery_sweep` records its
runs (B1 follows it), whether `cleanUploadName`/`cleanMediaType` are exported from the platform index (B1 exports them if not),
and the browser's autoplay rule for the alert sound (the console plays it only after a first click in the tab; the slice
tests it by hand).

**Approved by Fable 5.2 (2026-11-15)**
