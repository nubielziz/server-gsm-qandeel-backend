# Real-time events (feature 27, decision 037)

Hand-written. The data of the inbox events is parsed by the zod schemas of `inbox-realtime.events.ts` before the server writes
it; the hub's own events (`ready`, `hb`, `resync`, `bye`) are written by `src/infra/realtime/realtime-hub.ts` in the fixed
shapes below, so what is listed here is what a client receives.
The examples below are the exact text the server writes (generated with the server's own frame writer and schemas). The
OpenAPI description of the three routes points here. Plan: `docs/briefs/27-realtime-notifications.md`.

## The routes

| Route | Who | Refusals before the stream starts (problem+json) |
|---|---|---|
| `GET /store/v1/me/stream` | the signed-in customer | 401 `UNAUTHORIZED`, 403 `ACCOUNT_SUSPENDED`, 403 `IP_NOT_ALLOWED`, 403 `CSRF_FAILED`, 422 `VALIDATION_FAILED`, 429 `RATE_LIMITED`, 503 `UNAVAILABLE` |
| `GET /client/stream` | the signed-in merchant (also while pending approval) | 401 `UNAUTHORIZED`, 403 `ACCOUNT_SUSPENDED`, 403 `CSRF_FAILED`, 422 `VALIDATION_FAILED`, 429 `RATE_LIMITED`, 503 `UNAVAILABLE` |
| `GET /admin/stream` | the signed-in staff member | 401 `UNAUTHORIZED`, 403 `CSRF_FAILED`, 422 `VALIDATION_FAILED`, 429 `RATE_LIMITED`, 503 `UNAVAILABLE` |

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
- Lifetime: a stream ends by itself after 15 minutes (`bye` `max_age`, plus 0 to 120 s of jitter) so the guard runs again, and at
  once when its session ends (`bye` `session_ended`) or the account changes (`bye` `reauth`).

## Frame format

Standard server-sent events. Every frame is `[id: <cursor>]`, `event: <name>`, **one** `data:` line of JSON, and a blank line. Ids
in the data are JSON numbers; dates are ISO 8601 UTC with milliseconds. A client ignores an event name it does not know and a field
it does not know (`v` is `1`). The first thing on the wire is a `retry:` line (2 to 5 seconds, random per stream, so the browsers do
not all come back in the same second after a restart).

The `id:` is a **cursor**, present only on `notification.created`: the connection's position in every replayable source, parts
joined by `-`, each part a lower-case letter and an integer. The inbox's letter is `i` and its integer is the item id (`i41`);
feature 28 adds `t` for the support chat (`i41-t5521`). The browser sends the last one back on its own reconnect.

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
