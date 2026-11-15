# Real-time events (features 27 and 28, decision 037)

Hand-written. The data of the inbox events is parsed by the zod schemas of `inbox-realtime.events.ts`, and the data of the support
chat's ticket events (feature 28) by those of `src/modules/support/realtime/ticket-realtime.events.ts`, before the server writes
it; the hub's own events (`ready`, `hb`, `resync`, `bye`) are written by `src/infra/realtime/realtime-hub.ts` in the fixed
shapes below, so what is listed here is what a client receives.
The examples below are the exact text the server writes (generated with the server's own frame writer and schemas). The
OpenAPI description of the stream routes points here. Plans: `docs/briefs/27-realtime-notifications.md`,
`docs/briefs/28-support-live-chat.md` (the ticket events, § 3.4).

## The routes

| Route | Who | Refusals before the stream starts (problem+json) |
|---|---|---|
| `GET /store/v1/me/stream` | the signed-in customer | 401 `UNAUTHORIZED`, 403 `ACCOUNT_SUSPENDED`, 403 `IP_NOT_ALLOWED`, 403 `CSRF_FAILED`, 422 `VALIDATION_FAILED`, 429 `RATE_LIMITED`, 503 `UNAVAILABLE` |
| `GET /client/stream` | the signed-in merchant (also while pending approval) | 401 `UNAUTHORIZED`, 403 `ACCOUNT_SUSPENDED`, 403 `CSRF_FAILED`, 422 `VALIDATION_FAILED`, 429 `RATE_LIMITED`, 503 `UNAVAILABLE` |
| `GET /admin/stream` | the signed-in staff member | 401 `UNAUTHORIZED`, 403 `CSRF_FAILED`, 422 `VALIDATION_FAILED`, 429 `RATE_LIMITED`, 503 `UNAVAILABLE` |
| `GET /store/v1/tickets/:token/stream` | the holder of a ticket link (feature 28): no cookie, the token in the path is the credential | 404 `NOT_FOUND` (an unknown or erased token), 422 `VALIDATION_FAILED`, 429 `RATE_LIMITED`, 503 `UNAVAILABLE` |

- Plain `GET`, same origin, cookies as for any request. Success is `200`, `Content-Type: text/event-stream; charset=utf-8`,
  `Cache-Control: no-cache, no-transform` (the `no-transform` is load-bearing: a Next rewrite and a compressing proxy would
  otherwise buffer the stream), `X-Accel-Buffering: no`.
- Query: `locale` = `en` or `ar` (the page language: the text of every item comes in it; without it the person's saved language, else
  English) and `cursor` (the last event `id` the page saw, at most 64 characters). Header: `Last-Event-ID` (the browser's own
  reconnect; it wins over `cursor`). A cursor that is malformed or names an unknown source is ignored: the stream starts fresh.
- Same-site only (`originCheck`): a request whose `Sec-Fetch-Site` is not `same-origin` or `same-site` (for example `cross-site`) is
  `403 CSRF_FAILED`; without that header the `Origin` must be one of the CORS origins. An `EventSource` from the page's own origin
  sends `same-origin`.
- Limits: at most **3 open streams per session** and **30 per client address**; the newest one over a limit is refused with
  `429 RATE_LIMITED` (`Retry-After: 60`, detail `Too many open live connections.`), never an older one closed. 20 attempts a minute
  per session (`429` with its own `Retry-After`). `503 UNAVAILABLE` (`Retry-After: 30`) when live updates are switched off
  (`REALTIME_ENABLED=false`), the server is full or it is shutting down.
- The ticket stream (feature 28) has no session and no `originCheck` (no cookie is involved); it is capped at **3 open streams per
  ticket** (and the 30 per address), 20 opens a minute per ticket, and counts one point of the token limit (30 a minute per address)
  per open. It carries only the ticket events in the requester view and ends with `bye` `session_ended` when the link stops working
  (the customer was anonymized: the token then answers `404`).
- Lifetime: a stream ends by itself after 15 minutes (`bye` `max_age`, plus 0 to 120 s of jitter) so the guard runs again, and at
  once when its session ends (`bye` `session_ended`) or the account changes (`bye` `reauth`).

## Frame format

Standard server-sent events. Every frame is `[id: <cursor>]`, `event: <name>`, **one** `data:` line of JSON, and a blank line. Ids
in the data are JSON numbers; dates are ISO 8601 UTC with milliseconds. A client ignores an event name it does not know and a field
it does not know (`v` is `1`). The first thing on the wire is a `retry:` line (2 to 5 seconds, random per stream, so the browsers do
not all come back in the same second after a restart).

The `id:` is a **cursor**, present only on `notification.created` and `ticket.message.created`: the connection's position in every
replayable source, parts joined by `-`, each part a lower-case letter and an integer. The inbox's letter is `i` and its integer is
the item id (`i41`); the support chat's is `t` and its integer is the message id (`i41-t5521`; a ticket stream has `t` alone, in
practice `i0-t5521`). Every stream carries every part, so parse the part of your source rather than the whole id. The browser sends
the last one back on its own reconnect.

Order on a new stream: `retry`, `ready`, the replay (`notification.created` with `"live": false`, oldest first, or one
`resync`), then `unread.changed`, then live events. Live events that arrived during the replay are written right after it, so
one can come before `unread.changed`: do not treat `unread.changed` as the end of the replay, use `live`. `hb` arrives every 15
seconds.

Known limits (they heal on the next event or poll): a doorbell resolved before a new stream has primed its reader is rendered
in English for a viewer without `?locale=`, and with several doorbells in flight an older unread count can be written after a
newer one.

## Events

### `ready`

The first frame. No `id`. `resumed` is true when a cursor was accepted (the replay follows).

```
retry: 3412

event: ready
data: {"v":1,"heartbeatMs":15000,"resumed":false,"serverTime":"2026-11-15T09:30:00.000Z"}

```

### `hb`

Every `heartbeatMs` (15 s). No `id`. The data is the server's time in unix seconds, a plain number. It is an event (not a comment)
so that the client's watchdog sees it.

```
event: hb
data: 1794735015

```

### `notification.created`

An in-app item was made for the viewer, or (with `live: false`) is replayed after a reconnect. `item` is exactly the item of the
inbox lists (`zInboxItem`: `GET /store/v1/me/notifications`, `GET /client/notifications`, `GET /admin/inbox`), with `title` and
`body` in the viewer's language as plain text (render as text, never as HTML). `unread` is the viewer's fresh count, capped at 100
(show `99+` when it is 100). `live: false` marks a replayed item: no toast. The `id` is `i<item.id>`.

```
id: i41
event: notification.created
data: {"item":{"id":41,"category":"announcement","title":"Scheduled maintenance on Friday","body":"Hello Daniel,\nThe portal will be read-only on Friday from 02:00 to 03:00 UTC.","link":null,"locale":"en","readAt":null,"createdAt":"2026-11-10T09:06:00.000Z","campaignId":1,"event":null},"unread":3,"live":true}

```

A replayed item (the second example; an event item with a link):

```
id: i42
event: notification.created
data: {"item":{"id":42,"category":"order","title":"Order 1042 completed","body":"Your order for iPhone 15 unlock is complete.","link":"/account/orders","locale":"en","readAt":null,"createdAt":"2026-11-15T09:20:11.000Z","campaignId":null,"event":"order.completed"},"unread":4,"live":false}

```

### `notification.read`

The viewer marked one item (`ids: [id]`, `all: false`) or all items (`all: true`, `ids: []`) read, on any tab or device, **including
the one that did it** (handlers must be idempotent). With `all: true`, `upToId` is the newest id the screen showed (items with a
greater id stay unread) or `null` for every item. `unread` is the fresh count. No `id`.

```
event: notification.read
data: {"ids":[41],"all":false,"upToId":null,"unread":2}

```

```
event: notification.read
data: {"ids":[],"all":true,"upToId":42,"unread":0}

```

### `unread.changed`

The viewer's unread count (capped at 100). Sent after `ready` and the replay, and when the count changed for another reason (a
campaign was cancelled and its items are hidden). No `id`.

```
event: unread.changed
data: {"unread":3}

```

### `resync`

The server cannot say what the client missed (more than 50 items while it was away, the server's doorbell connection was lost, or a
burst overflowed a queue): refetch the open list and the count. `topics` names what to refetch (`inbox`). No `id`.

```
event: resync
data: {"topics":["inbox"]}

```

### `bye`

The server ends the stream; the browser reconnects (and the guard runs again). No `id`. `reason` is one of `max_age` (the 15-minute
limit), `shutdown` (the server is restarting), `session_ended` (sign-out, "end this device", "end all sessions", a session that was rotated, a suspension), `reauth`
(the account's role or details changed: reconnect and the guard decides, a suspended account then gets 403 and the stream stops).

```
event: bye
data: {"reason":"max_age"}

```

```
event: bye
data: {"reason":"session_ended"}

```

## Ticket events (feature 28, the support chat)

Four events, each rendered in one of **two views**. The **staff view** goes to every staff stream whose role grants `support:read`
(`GET /admin/stream`); a stream without it gets no ticket event. The **requester view** goes to the ticket link's streams
(`GET /store/v1/tickets/:token/stream`) and to the requester's own account stream (`GET /store/v1/me/stream` of the customer,
`GET /client/stream` of the merchant), and only for that requester's tickets. The requester view never carries an internal note, a
system message, a staff name, the assignee, the priority or a timer, and never the ticket token: `ticketId` is the ticket's id for a
merchant (the portal addresses tickets by id) and `null` for a customer (match the ticket by `number`). Only
`ticket.message.created` has an `id` (`t<message id>`, see the frame format) and is replayed after a reconnect: staff get the
messages of every ticket, an account stream the public messages of its own tickets, a ticket stream the public messages of that
ticket, at most 100, else `resync` with `topics: ["ticket"]` (refetch the open ticket or list). Typing is never replayed.

### `ticket.message.created`

A message was written. Staff view: `message` is exactly a message of `GET /admin/support-tickets/:id` (`TicketMessage`, with
`attachments`), notes and system messages included. Requester view: only a public message (a customer's, a merchant's or a staff
reply), as `GET /store/v1/tickets/:token` shows it (`StoreMessage`: `from` is `you` or `support`). `live: false` marks a replayed
message (no sound, no alert). Ignore an id you already have (the answer of your own `POST`, a second window). A `ticket.updated`
follows every message.

Staff view:

```
id: i41-t9002
event: ticket.message.created
data: {"ticketId":1042,"message":{"id":9002,"ticketId":1042,"authorType":"customer","authorId":28,"authorName":"Victor Hale","body":"Here is the photo.","isInternal":false,"fileIds":[7002],"attachments":[{"id":7002,"filename":"screen.jpg","mime":"image/jpeg","size":182044}],"createdAt":"2026-11-08T11:00:00.000Z"},"live":true}

```

Requester view (a customer's ticket stream):

```
id: i0-t9003
event: ticket.message.created
data: {"ticketId":null,"number":"T-1042","message":{"id":9003,"from":"support","body":"Thanks, the carrier confirmed it.","createdAt":"2026-11-08T11:02:00.000Z","attachments":[]},"live":true}

```

### `ticket.updated`

The ticket changed: a new ticket, a message, a status, assignee or priority change, a rating. No `id`. Staff view: `ticket` is exactly
a row of `GET /admin/support-tickets` (with `hasUnread` and the seen marks). Requester view: the fields of the ticket page and the
requester's own `hasUnread` (a support reply after their seen mark).

Staff view:

```
event: ticket.updated
data: {"ticket":{"id":1042,"number":"T-1042","subject":"Where is my unlock? (SF-20431)","channel":"web","requesterType":"customer","requesterId":28,"requester":{"name":"Victor Hale","email":"victor@mail.example"},"orderId":20431,"category":"delay","priority":"normal","status":"open","assigneeId":2,"assignee":{"id":2,"name":"Lina S."},"slaDueAt":"2026-11-08T19:00:00.000Z","firstResponseAt":"2026-11-08T10:12:00.000Z","resolvedAt":null,"csatScore":null,"createdAt":"2026-11-08T09:30:00.000Z","updatedAt":"2026-11-08T11:00:00.000Z","lastPublicAt":"2026-11-08T11:00:00.000Z","late":false,"hasUnread":true,"requesterSeenMessageId":9001,"requesterSeenAt":"2026-11-08T10:20:00.000Z","staffSeenMessageId":9000,"staffSeenAt":"2026-11-08T10:05:00.000Z"}}

```

Requester view (a merchant's account stream):

```
event: ticket.updated
data: {"ticketId":1043,"number":"T-1043","status":"pending","updatedAt":"2026-11-08T11:02:00.000Z","resolvedAt":null,"canRate":false,"csatScore":null,"hasUnread":true}

```

### `ticket.read`

A side's seen mark moved (it only moves forward), on any tab or device, including the one that marked. No `id`. Staff view: `by` is
`requester` or `staff`; `upToMessageId` is the newest message of the other side that this side has seen. Requester view: `by` is
`you` (the requester, on another tab) or `support` (any staff member: never who); show `Seen` under the requester's messages up to
`upToMessageId`.

```
event: ticket.read
data: {"ticketId":1042,"by":"requester","upToMessageId":9003,"at":"2026-11-08T11:03:00.000Z"}

```

```
event: ticket.read
data: {"ticketId":null,"number":"T-1042","by":"support","upToMessageId":9002,"at":"2026-11-08T11:01:00.000Z"}

```

### `ticket.typing`

Someone is typing: at most one event per person every 2.5 s while they type; show it for 6 s after the last one and clear it when that
person's message arrives. Never stored, never replayed. No `id`. Staff view: the requester (`by: "requester"`, the rest `null`; never for a resolved ticket, whose requester cannot write, B220) or a
colleague with their name and `mode` (`reply` or `note`; skip your own `staffId`). Requester view: only while a staff member types a
**reply** ("Support is typing…"); a note's typing never reaches the requester.

```
event: ticket.typing
data: {"ticketId":1042,"by":"staff","staffId":2,"staffName":"Lina S.","mode":"note"}

```

```
event: ticket.typing
data: {"ticketId":null,"number":"T-1042"}

```

### The routes beside the streams

`POST /store/v1/tickets/:token/typing` and `POST /admin/support-tickets/:id/typing` (`{ "mode": "reply" | "note" }`) send typing;
`POST /store/v1/tickets/:token/read` and `POST /admin/support-tickets/:id/read` (`{ "upToMessageId": <id> }`) move the seen mark (a
message the other side wrote on that ticket, else `422 unknown_message`); all four answer `204`. The two typing and read routes of the
ticket page count against `ticket-chat` (120 a minute per address), not the token limit. Attachments: `POST …/files` (multipart, one
part `file`: PDF, JPEG or PNG, 5 MiB) and `GET …/files/:fileId` (`302` to a 5-minute download link; never show a file inline).

## What the client does

Both clients (storefront and console; separate code, same rules):

- **One stream per browser and surface.** The tab that holds the Web Lock `gsm-stream-<surface>` opens the `EventSource` and repeats
  every event on `BroadcastChannel('gsm-stream-<surface>')`; the other tabs listen. Without Web Locks or `BroadcastChannel`: one stream
  per tab (the server's cap of 3 per session refuses the fourth, which polls). **Never open a stream on a public page.**
- **Reconnect.** An `EventSource` gives up after any answer that is not `200` (for example Caddy's 502 during a restart), so on `error`
  the client closes it and opens a new one after 5 s, doubling to 60 s, with +-20 % jitter; a `ready` resets the back-off. A watchdog
  reconnects when nothing, not even `hb`, arrived for 45 s. The reconnect sends the last `id` (`?cursor=`, the `EventSource` also sends
  `Last-Event-ID` itself).
- **Refusals.** An `EventSource` does not expose the status of a refusal. On an `error` before any `ready` the client asks the
  surface's `.../unread-count` and decides from that answer:

  | Answer | The client |
  |---|---|
  | 401 or 403 | stops the stream for this page load; the existing sign-out rules apply |
  | 429 | waits its `Retry-After`, at least 60 s |
  | 200 | the stream itself was refused (a cap, the kill switch, a restart): back-off as above, starting at 60 s after the third refusal in a row |

- **Events.** Ignore a `notification.created` whose `item.id` was already handled (a replay, a second window). After a `ready` with
  `resumed: true`, a `resync`, or a `ready` that is not the first of this page load, refetch the open list once.
- **Fallback.** While the stream is not open the old polling of `.../unread-count` runs as today (60 s); while it is open the poll
  slows to 5 minutes (a safety net, because a doorbell can be lost).
- **Through a Next rewrite** (storefront in development and production): the proxy cuts a stream that is silent for 30 s, so the
  server's 15 s heartbeat must reach the client, and the response must keep `no-transform`.
