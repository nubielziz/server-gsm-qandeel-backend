# Feature 27: Real-time layer (SSE + POST) and live notifications

Plan by Fable 5.2 (planner), 2026-11-15, against backend `main` @ `562fa52`, console `main` @ `4811a7a`, storefront `main` @
`2cb1a0a`. Owner request (2026-11-15): "a notification must appear to the user at once, not after a reload", and (for the chat,
feature 28) the owner chose **SSE + POST**. This feature builds the shared real-time layer and puts the notification inbox on it;
feature 28 (`28-support-live-chat.md`) adds the support chat on top. Read first: `backend/CLAUDE.md`, `docs/briefs/_common.md`,
`_feature.md`; console slices also `frontend-admin/CLAUDE.md`; storefront slices `storefront/CLAUDE.md` (and the Next docs in
`node_modules/next/dist/docs/`). Paths are backend-relative; `FA/` = the console worktree, `SF/` = the storefront worktree. No
agent commits, runs git that changes state, or spawns agents. Money, orders, suppliers and the ledger are not touched.

## 1. What exists (verified in the code, and by a scratch run where marked)

| # | Fact | Evidence |
|---|---|---|
| 1 | No SSE, no WebSocket. The storefront bell polls `…/unread-count` once a minute while visible; the console bell every 60 s; the notifications pages do not refresh | `SF/lib/notifications/unread-store.ts`, `FA/src/features/notifications/hooks/useUnreadCount.ts` |
| 2 | In-app items are `notification_inbox` rows. Three writers: `NotificationInbox.addForEvent(tx, …)` (called by `NotificationService.enqueue({ tx })`, `EventNotifier.notifyMerchant` and the campaign test send), and `insertCampaignItems` in the fan-out chunk (500 people per chunk transaction, in the worker) | `platform/notifications/inbox/notification-inbox.ts`, `notification.service.ts:116`, `event-notifier.ts:185`, `campaigns/campaign-send.service.ts:209`, `campaigns/campaign-fan-out.ts` |
| 3 | Many callers hold only `tx` (`enqueue({ tx })`, 21 call sites), not `afterCommit`; one caller runs inside a savepoint | `infra/db/transaction.ts`, `orders/application/api-orders.service.ts:154` |
| 4 | The item's text is made at read time in the reader's language (`inboxView(row, reader, texts)`); the unread count is an index probe capped at 100 | `inbox/inbox-views.ts`, `inbox/inbox.repository.ts` (`countUnread`, `visibleTo`) |
| 5 | Every session end goes through `SessionService`: `revoke`, `revokeAllOf`, `rotate` (rows with ids) and `invalidateSubject` (suspension, role or detail change) | `identity/security/session.service.ts` |
| 6 | A route may answer a non-JSON body: `success: { status: 200, contentType }`; the guard refuses a route without a contract; `originCheck: true` exists for session `GET`s | `common/contract/define-route.ts`, `response.interceptor.ts`, `identity/security/access.guard.ts` |
| 7 | The access log and the request histogram run in `onResponse`, which also fires when a hijacked reply ends: a 15-minute stream would log one "request" of 900 s and bend the latency percentiles | `infra/logging/access-log.ts`, `infra/metrics/http-metrics.ts` |
| 8 | Redis pub/sub ignores the database number: every worktree's tests (`…/7`, `…/1`) share one channel namespace per instance | Redis; `src/config/env.ts` (test URLs) |
| 9 | **Scratch run (Bun 1.4.4, Fastify 5.12, `reply.hijack()` + `reply.raw.write`)**: frames arrive unbuffered; the server sees the client's close; Bun does not cut a silent stream (70 s tested); 2 000 open streams cost about 14 MB RSS (about 7 KB each) before our registry | scratch script, 2026-11-15 |
| 10 | **Scratch run (Next 16.4.5 rewrites, `next dev` and `next start`)**: a stream with `Cache-Control: no-cache, no-transform` passes unbuffered and uncompressed (Next's `compress` skips `no-transform`); the rewrite proxy cuts a stream that is **silent for 30 s** (`proxyTimeout` default 30 000, `server/lib/router-utils/proxy-request.js`) | scratch app, 2026-11-15 |
| 11 | Production: Caddy sends `/client/*`, `/store/v1/*` and `/admin/*` straight to the one `api` container, with `encode zstd gzip` for all. Caddy flushes a `text/event-stream` answer at once and `encode` matches `text/*` (so it would compress the stream, one encoder per connection); an explicit `flush_interval -1` also stops Caddy from cancelling the upstream when the browser leaves | `deploy/Caddyfile`, `deploy/compose.prod.yaml`, Caddy docs (`reverse_proxy` Streaming, `encode`) |
| 12 | Bun's `fetch` opens at most 256 connections per host unless `BUN_CONFIG_MAX_HTTP_REQUESTS` is raised (the load test needs it) | scratch run |

## 2. Decision 037 (text for `docs/decisions/037-realtime-sse.md`; the lead writes the file)

**Decision.**
- **Transport.** Server to browser: Server-Sent Events (`GET`, `text/event-stream`, the browser's `EventSource`). Browser to
  server: ordinary `POST` routes. One stream per signed-in browser and surface, shared by its tabs.
- **Doorbell, not data.** A change is announced on Redis pub/sub with ids only. The API process that holds the connection
  re-reads Postgres with the viewer's rights and renders the event. Nothing is trusted from the message; a lost message loses
  no data.
- **Where.** The **cache Redis** (pub/sub stores no key, so `allkeys-lru` does not matter). One channel:
  `gsm:{env}:realtime:doorbell:{db}` (`{db}` = the database number of the cache URL, because pub/sub ignores `SELECT` and
  worktree test runs share the instance). Publishers use the process's existing cache client (API and worker; fail fast). Each
  API process has **one dedicated subscriber connection** (`gsm-realtime-sub`, reconnects for ever, resubscribes itself); the
  worker has none.
- **Message.** JSON, at most 8 KB: `{ v: 1, topic, op, at, … }` with ids only (never text, a token, an email address or a
  cookie). `at` is the publisher's clock in ms (for the delivery histogram).
- **Publish after commit.** `onCommit(callback)` (new, `infra/db/transaction.ts`): runs after the transaction of the current
  async context commits, or at once when there is none. Not the outbox: the relay is FIFO, shared with order dispatch, and a
  doorbell is worth nothing a second later. A crash between commit and publish loses only the doorbell; four things heal it: the
  truth is in Postgres, a reconnect replays, the hub sends `resync` after its subscriber reconnects, and clients keep a slow
  safety poll (5 minutes).
- **Events have ids.** The `id:` of a frame is a cursor (`i<inbox id>`, later `-t<message id>`); a reconnect sends it back
  (`Last-Event-ID`, or `?cursor=`) and the server replays the rows after it from Postgres, bounded, else tells the client to
  refetch (`resync`).
- **Rules of a connection.** Authenticated by the surface's guard like any request; re-authenticated at least every 15 minutes
  (the server ends the stream, the browser reconnects); closed at once when its session ends; capped per session, per IP and in
  total; a heartbeat every 15 s; a client that does not read is dropped, never buffered.

**Why not WebSocket.** Nest runs no guard, pipe or interceptor on a gateway's `handleConnection`: session auth, CSRF, IP rules,
rate limits, zod contracts, idempotency and audit would each need a second implementation for socket messages. Bun replaces the
`ws` package. Everything the browser sends here is small and rare (a message, "typing", "read"): a `POST` is enough. SSE is plain
HTTP: it passes Caddy, HTTP/2, Next rewrites and the Vite proxy as it is, and `EventSource` reconnects by itself.

**Rejected.** Postgres `LISTEN/NOTIFY` (transactional, but every notifying commit takes a database-wide lock, the payload limit
is 8 000 bytes, an ephemeral "typing" would cost a pool round trip, and decision 020 keeps NOTIFY as a wake-up only). The queue
Redis (BullMQ only, `noeviction`, AOF). A third Redis (nothing to isolate at this size; revisit if
`client-output-buffer-limit pubsub` ever drops the subscriber). A channel per user (subscribe churn and a subscribe/first-event
race; one process filters in memory with a map lookup). The outbox relay (above). A hosted service (personal data leaves, a
second secret, a monthly cost). Polling faster (cost grows with users, still not instant).

**Consequences.** `backend/CLAUDE.md` "Redis" gets one clause: the cache Redis also carries the real-time doorbell (pub/sub, no
keys). More API processes work unchanged (each subscribes and serves its own connections); the caps are then per process.

## 3. Backend design

### 3.1 Modules and wiring

| Piece | Where | Loaded by |
|---|---|---|
| `RealtimeModule` (`@Global`): `RealtimePublisher`, `RealtimeSources` (registry of sources) | `src/infra/realtime/` | API and worker (`app.module.ts`, `worker.module.ts`) |
| `RealtimeHubModule`: `RealtimeHub` (subscriber, connection registry, writer, replay, caps, metrics, shutdown) | `src/infra/realtime/` | API only |
| Stream routes and viewer mapping; session-end doorbells | `src/modules/identity/realtime/` (`StreamController`, `stream.contracts.ts`), `identity/security/session.service.ts` | API (`IdentityModule`) |
| Inbox source and doorbells: `InboxRealtimeSource`, `InboxDoorbell` | `src/modules/platform/notifications/inbox/` | source: the module of the inbox controllers (API); `InboxDoorbell`: beside `NotificationInbox` (API and worker) |

Owner of the layer: **infra** (no table). The three routes belong to module `identity` (it owns sessions, principals and the
guard). `RedisService` gains `createSubscriberConnection()` (cache URL, `connectionName: 'gsm-realtime-sub'`, `lazyConnect`,
`maxRetriesPerRequest: null`, no command timeout, watched and closed like the worker connections).

### 3.2 Types (exact; `src/infra/realtime/realtime.types.ts`)

```ts
type StreamViewerKind = 'staff' | 'client' | 'customer' | 'ticket';            // 'ticket' is used by feature 28
interface StreamViewer { kind: StreamViewerKind; id: number; sessionId: number | null; ip: string;
  locale: 'en' | 'ar' | null; name: string; permissions: readonly string[] }  // permissions: staff only, else []
interface Doorbell { v: 1; topic: string; op: string; at: number; [key: string]: unknown }
interface Frame { event: string; data: unknown | ((viewer: StreamViewer) => unknown); cursor?: number }
interface Delivery { keys: readonly string[]; frame?: Frame; close?: 'session_ended' | 'reauth' }  // keys: 'u:customer:42'
interface RealtimeSource {
  readonly topic: string;                 // 'inbox'
  readonly cursorKey: string;             // one lower-case letter: 'i'
  keysFor(viewer: StreamViewer): readonly string[];          // keys beyond the default; may be []
  head(viewer: StreamViewer): Promise<number>;               // the newest id now
  replay(viewer: StreamViewer, after: number, limit: number): Promise<Frame[] | 'resync'>;
  snapshot(viewer: StreamViewer): Promise<Frame[]>;          // sent after ready and replay
  resolve(doorbell: Doorbell, has: (key: string) => boolean): Promise<Delivery[]>;
}
interface CapKey { key: string; max: number }                // 'session:91' 3, 'ip:203.0.113.9' 30
```
Default audience key of a `staff`, `client` or `customer` viewer: `u:<kind>:<id>`. A `ticket` viewer has none by default. A
delivery with `close` makes the hub send `bye` with that reason to the connections of its keys and end them (feature 28 uses it).

### 3.3 `RealtimePublisher` (API and worker)

`publish(topic, op, fields)`: builds the doorbell (`v`, `at = clock.nowMs()`), refuses a message over 8 KB (throws a programming
error in tests, logs and counts in production), `redis.cache.publish(channel, json)`. It never throws to a use case: a failure is
logged through a `LogThrottle` and counted. `publishOnCommit(topic, op, fields)` = `onCommit(() => publish(…))`.

`onCommit` (in `infra/db/transaction.ts`, exported from `infra/db`): `runInTransaction` runs `fn` inside an `AsyncLocalStorage`
holding its callback list; `onCommit(cb)` pushes there, or calls `cb` at once when no transaction is open. A savepoint inside
the transaction shares the list (a rolled-back savepoint then rings for a row that does not exist: the hub finds nothing and
sends nothing). The existing `afterCommit` parameter stays and uses the same list.

### 3.4 `RealtimeHub` (API only)

- **Registry.** `Map<connId, Connection>`; indexes `byKey: Map<string, Set<Connection>>` (audience keys), `bySession`,
  `capCounts: Map<string, number>`. A connection holds: viewer, keys, cap keys, `raw` (the hijacked response), cursor parts,
  state (`replaying` | `live` | `closing`), counters, `openedAtMs`, `closeAtMs`. No per-connection timer, queue or Redis
  subscription.
- **`open({ viewer, caps, request, reply, cursor })`**, in this order:
  1. `REALTIME_ENABLED` off, the hub shutting down, or `REALTIME_MAX_CONNECTIONS` (default 5000) reached → `503 UNAVAILABLE`,
     `Retry-After: 30`.
  2. Limiter `stream-connect` (new, 20 a minute, key = the first cap key) → `429 RATE_LIMITED`.
  3. Any cap key at its `max` → `429 RATE_LIMITED`, `Retry-After: 60`, detail `Too many open live connections.` The **newest**
     is refused (never an older one closed: tabs must not fight).
  4. `reply.hijack()`; `raw.writeHead(200, …)` with the headers already on `reply` (CORS, security, `x-request-id`) plus
     `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform` (fact 10: load-bearing),
     `X-Accel-Buffering: no`, `Connection: keep-alive`; `flushHeaders()`.
  5. Write `retry: <2000-5000 random>` and `event: ready` `{ "v": 1, "heartbeatMs": 15000, "resumed": <a cursor was accepted>,
     "serverTime": "<iso>" }`.
  6. Register as `replaying`. For each source of the viewer: with a cursor part → `replay(viewer, after, limit)` (frames are
     written with `"live": false`; `'resync'` → one `event: resync` `{ "topics": [..] }` and the part jumps to `head`); without
     one → the part is `head(viewer)`. Live frames that arrive meanwhile wait in a list of at most 100 (overflow → `resync`
     for that topic) and are written after the replay unless their cursor is not newer than the part.
  7. `snapshot(viewer)` frames; state `live`.
- **Frames.** `id: <cursor>` only on a frame with a `cursor` (the connection's composite cursor after it: parts joined by `-`,
  each `<letter><integer>`, e.g. `i9001` and later `i9001-t5521`); `event:`; one `data:` line of JSON. Largest frame 32 KB (an
  over-long one is a programming error: log, count, skip). Parser of a cursor: unknown letters and malformed parts are ignored
  (that source starts at `head`); length cap 64 characters.
- **Subscriber.** On a message: parse, `sources.get(topic)`, `resolve(doorbell, has)` with at most 4 doorbells in flight (the
  pool is 10) and a waiting list of 1000 (overflow: drop it, count, and send `resync` for every topic to everyone). Each
  delivery is serialised once per key, or per connection when `data` is a function, and written to the connections of its keys.
  On `ready` after a reconnect of the subscriber: `resync` (all topics) to every connection. Topic `session` is handled by the
  hub itself (§3.6).
- **Heartbeat.** One hub interval of 1 s (injected `Timers`) over 15 buckets (`connId % 15`): each connection gets
  `event: hb` / `data: <unix seconds>` every 15 s (an event, not a comment, so the client's watchdog sees it; 15 s because the
  Next rewrite cuts at 30 s, fact 10). The same tick ends connections past `closeAtMs` (`REALTIME_MAX_AGE_SECONDS`, default 900,
  plus 0 to 120 s of jitter): `event: bye` `{ "reason": "max_age" }`, then `end()`; the browser reconnects and the guard runs
  again (idle or absolute session expiry, IP rules, a changed role).
- **Back-pressure.** After every write: `raw.writableLength > 262144` → destroy the socket, `realtime_drops_total{reason=
  "slow_consumer"}`. A write error does the same (`write_error`). The client reconnects and replays. Nothing is queued in the
  application.
- **Close.** `request.raw` `close` → unregister, free the cap counts, log.
- **Shutdown.** `onModuleDestroy`: refuse new streams, `bye` `{ "reason": "shutdown" }` + `end()` for all, wait at most 2 s,
  destroy the rest, unsubscribe. The subscriber connection itself closes in `RedisService.onApplicationShutdown`.
- **Logs.** `stream opened` (debug) and `stream closed` (log): `{ requestId, route, viewer: 'customer:42', sessionId,
  durationMs, frames, reason }`. Never a cookie, token, cursor query or body text. `access-log.ts` logs a reply whose content
  type is `text/event-stream` at `debug`; `http-metrics.ts` does not observe its duration (fact 7).
- **Metrics** (API registry): gauges `realtime_connections{surface}`, `realtime_subscriber_up`; counters
  `realtime_connections_opened_total{surface}`, `realtime_connections_closed_total{surface,reason}`,
  `realtime_connections_refused_total{surface,reason}` (`disabled|capacity|rate|session_cap|ip_cap|ticket_cap`),
  `realtime_events_sent_total{event}`, `realtime_drops_total{reason}`, `realtime_doorbells_received_total{topic}`,
  `realtime_replays_total{outcome}` (`fresh|replayed|resync`); histogram `realtime_delivery_seconds` (doorbell `at` to write;
  buckets 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2). Publisher side (API and worker registries):
  `realtime_doorbells_published_total{topic}`, `realtime_publish_failures_total{topic}`.
- **Config** (`src/config/env.ts`, `.env.example`, `docs/OPERATIONS.md`): `REALTIME_ENABLED` (true), `REALTIME_MAX_CONNECTIONS`
  (5000), `REALTIME_MAX_PER_SESSION` (3), `REALTIME_MAX_PER_IP` (30), `REALTIME_HEARTBEAT_SECONDS` (15, 5 to 25),
  `REALTIME_MAX_AGE_SECONDS` (900, 60 to 3600).

### 3.5 Routes and wire

Three routes, one controller (`identity/realtime/stream.controller.ts`), rows in `scripts/map-additions/27.mjs` (§6):

| Route | Access | Errors |
|---|---|---|
| `GET /store/v1/me/stream` | `customer-session` | `UNAUTHORIZED`, `ACCOUNT_SUSPENDED`, `IP_NOT_ALLOWED`, `CSRF_FAILED`, `VALIDATION_FAILED`, `RATE_LIMITED`, `UNAVAILABLE` |
| `GET /client/stream` | `merchant-session`, `pendingMerchant: 'allow'` | `UNAUTHORIZED`, `ACCOUNT_SUSPENDED`, `CSRF_FAILED`, `VALIDATION_FAILED`, `RATE_LIMITED`, `UNAVAILABLE` |
| `GET /admin/stream` | `staff-session` | `UNAUTHORIZED`, `CSRF_FAILED`, `VALIDATION_FAILED`, `RATE_LIMITED`, `UNAVAILABLE` |

Each: `defineRoute({ …, originCheck: true, query: z.object({ locale: z.enum(['en','ar']).optional(), cursor:
z.string().max(64).optional() }), headers: z.object({ 'last-event-id': z.string().max(64).optional() }), success: { status: 200,
contentType: 'text/event-stream' } })`. The header wins over `cursor`. Every refusal happens before the stream starts and is the
usual problem+json (an `EventSource` then stops; the client decides, §5). The handler takes the principal
(`@CurrentPrincipal()`), `@Req()` and `@Res()` and calls `hub.open` with caps `session:<id>` (`REALTIME_MAX_PER_SESSION`) and
`ip:<ip>` (`REALTIME_MAX_PER_IP`); viewer `locale` = the query's, `permissions` = the staff principal's. `originCheck` stops
another site from opening streams with the visitor's cookie and using up the session cap.

**Events of this feature** (JSON in `data`; names are final):

| Event | `id` | Data | When |
|---|---|---|---|
| `ready` | no | `{ v, heartbeatMs, resumed, serverTime }` | first frame |
| `hb` | no | unix seconds | every 15 s |
| `notification.created` | `i<item id>` | `{ item: <the list's item shape>, unread: number, live: boolean }` | an in-app item was made for the viewer |
| `notification.read` | no | `{ ids: Id[], all: boolean, upToId: Id \| null, unread: number }` | the viewer marked one (`ids: [id]`) or all (`all: true`) read, on any tab or device |
| `unread.changed` | no | `{ unread: number }` | after `ready`/replay/`resync`; and when the count changed for another reason (a cancelled campaign) |
| `resync` | no | `{ topics: string[] }` | the server cannot say what was missed: refetch |
| `bye` | no | `{ reason: 'max_age' \| 'shutdown' \| 'session_ended' \| 'reauth' }` | the server ends the stream |

`item` is exactly `zInboxItem` of `inbox.contracts.ts` (text in the viewer's `locale`, else the saved language, else `en`);
`unread` is capped at 100 as on `…/unread-count`. Zod schemas of the data: `inbox/inbox-realtime.events.ts`, parsed before every
write (a mismatch is logged and skipped, never sent). `docs/contract/realtime-events.md` (new, hand-written) lists every event
with one example; the OpenAPI description of the three routes points to it.

### 3.6 Publishers

| Change | Doorbell (`topic`, `op`, fields) | Where |
|---|---|---|
| An event item was inserted | `inbox`, `created`, `{ type, ids: [recipientId], itemId }` | `NotificationInbox.addForEvent`, after an insert that returned an id: `InboxDoorbell.created` → `publishOnCommit`. No signature changes (fact 3) |
| A campaign chunk committed | `inbox`, `created`, `{ type, ids: [..≤500], campaignId }` | `CampaignFanOut.run`, after the chunk's transaction and before `handOver`; `insertCampaignItems` returns the inserted recipient ids (`ChunkResult.inApp`); a repeated chunk publishes nothing |
| One item read (`updated` only) / all read (`updated > 0`) | `inbox`, `read`, `{ type, ids: [recipientId], itemIds: [id] }` / `{ …, all: true, upToId }` | `InboxService.markRead`, `markAll`, after the statement |
| A campaign cancelled | `inbox`, `recount`, `{ types: [..] }` (the audience's recipient types) | `CampaignSendService.cancel`, `onCommit` |
| Sessions ended | `session`, `ended`, `{ sessionIds: [..] }` | `SessionService.revoke`, `revokeAllOf`, `rotate` (the old row), beside the cache `forget`, after commit |
| A subject changed | `session`, `subject`, `{ subjectType, subjectId }` | `SessionService.invalidateSubject` |

`InboxRealtimeSource.resolve`: `created` with `itemId` → the row with its campaign, for `u:<type>:<id>` when connected;
`created` with `campaignId` → one query for the connected ids of the chunk (`recipient_id = any($1)`), one batched unread count
(`group by recipient_id`, capped at 100 in code); `read` → `notification.read` with the fresh count; `recount` → `unread.changed`
for every connected viewer of the types (at most 10 counts in flight). Every query carries `recipient_type` and `recipient_id`
(`visibleTo`), so nothing of another person can be rendered. `replay`: the viewer's visible rows with `id > after`, ascending,
limit 50; a 51st row → `'resync'`. `snapshot`: `unread.changed`. `head`: `max(id)` of the table. `keysFor`: `[]`.

Hub, topic `session`: `ended` → the connections of those session ids get `bye` `session_ended` and are ended; `subject` → the
connections of `u:<kind>:<id>` get `bye` `reauth` and are ended (they reconnect; the guard then answers 401 or 403 for a
suspended account, which stops the `EventSource`).

**Known limit.** Two transactions can commit inbox rows out of id order; a reconnect that falls exactly between them may not
replay the lower id. The count is never wrong (`snapshot`), and clients refetch their open list after a reconnect (§5).

## 4. Infra

- **Caddyfile** (`deploy/Caddyfile`, snippet `common`): replace `encode zstd gzip` by
  ```
  @compressible not path /store/v1/me/stream /client/stream /admin/stream /store/v1/tickets/*/stream
  encode @compressible zstd gzip
  ```
  (the fourth path is feature 28's). No `flush_interval` (fact 11). A comment says why.
- **`deploy/compose.prod.yaml`**: `ulimits: { nofile: { soft: 65536, hard: 65536 } }` on `caddy` and `api` (a stream is one
  descriptor in the API and two in Caddy). `docs/OPERATIONS.md`: a "Live connections" paragraph (the env keys, the metrics, the
  kill switch `REALTIME_ENABLED=false`: clients fall back to polling).
- **HTTP/2.** Caddy serves browsers over HTTP/2 and 3: no six-connections-per-host limit in production. Development is HTTP/1.1
  (Next, Vite): the one-stream-per-browser rule (§5) keeps it to one.
- **Next rewrites** (`SF/next.config.ts`): no change. Fact 10 holds only with `no-transform` and a heartbeat under 30 s; do not
  set `experimental.proxyTimeout`. **Vite proxy** (`FA/vite.config.ts`): no change (`/admin` is already proxied); the lead checks
  once with `curl -N` through `:5173`.

## 5. Clients

Both clients implement the same small state machine (separate code, same rules):

- **One stream per browser and surface.** `navigator.locks.request('gsm-stream-<surface>', …)`: the tab that holds the lock
  (the leader) opens the `EventSource` and repeats every event on `BroadcastChannel('gsm-stream-<surface>')`; the other tabs
  only listen. When the leader closes or is frozen (`pagehide`, `freeze`) the lock passes on and the next tab opens the stream
  with the last cursor it saw. Without `navigator.locks` or `BroadcastChannel`: one stream per tab (the server cap of 3 per
  session refuses the fourth, which polls).
- **URL.** Same origin, `withCredentials` not needed: `<stream path>?locale=<page language>[&cursor=<last id>]`. The client
  reconnects itself (an `EventSource` gives up after any non-200 answer, for example Caddy's 502 during a restart): on `error`
  close it and open a new one after 5 s, doubling to 60 s, ±20 %; reset after a `ready`. A watchdog reconnects when nothing
  (not even `hb`) arrived for 45 s.
- **Refusals.** An `EventSource` does not show the status of a refusal. So on an `error` before any `ready` the client asks
  the surface's `…/unread-count` (the route every client already polls) and decides from that answer: 401 or 403 → stop the
  stream for this page load (the session is gone; the existing sign-out rules apply); 429 → wait its `Retry-After` (at least
  60 s); a 200 means the stream itself was refused (a cap, the kill switch, a restart) → the back-off above, starting at 60 s
  after the third refusal in a row.
- **Events.** Ignore a `notification.created` whose `item.id` was already handled (replay, a second window). After a `ready`
  with `resumed: true`, a `resync`, or a `ready` that is not the first of this page load: refetch the open list once.
- **Fallback.** While the stream is not open the old polling runs as today (60 s); while it is open the poll slows to 5 minutes.

### 5.1 Storefront (slice S; `SF/`)

- New `lib/realtime/events.ts` (event names, data types, `STREAM_API = { customer: '/store/v1/me/stream', merchant:
  '/client/stream' }`, `parseFrame`), `lib/realtime/stream-client.ts` (`createStreamClient(env)`: pure, every browser API
  injected: `EventSource` factory, locks, channel, timers, visibility; `subscribe(event, listener)`, `status()`, `start()`,
  `stop()`), `lib/realtime/browser.ts` (`streamFor(surface)` singletons and the generic `createStream({ url, lockName })` that
  feature 28 uses), `lib/realtime/stream-client.test.ts`.
- `lib/notifications/unread-store.ts`: add `push(surface, count)` (a count from an event: same as `seed`) and
  `setLive(surface, live)` (the floor is `POLL_INTERVAL_MS` when false, `LIVE_POLL_INTERVAL_MS = 300_000` when true); tests.
- New `components/notifications/notification-stream.tsx` (client, renders nothing): starts `streamFor(surface)`, feeds the
  store (`unread.changed`, `notification.created`, `notification.read`), calls `setLive`, and toasts. `bell-slot.tsx` renders
  it beside `<Bell>` (so a stream exists only where a bell does: `/account` and `/merchant`; public pages open none).
- **Toast**: for `notification.created` with `live: true`, in a visible tab that is not on the notifications page:
  `toast({ title: item.title, description: <first 120 characters of item.body>, tone: 'info', duration: 6000, action })` with
  `lang`/`dir` of `item.locale`. `components/ui/toast.tsx` gains `action?: { label: string; href: string }` (a link). At most
  one toast every 3 s; more in that window become one: `{count} new notifications`. Plain text only (plan D11).
- New `components/notifications/live-refresh.tsx` (client), rendered by `notification-list.tsx`: on `notification.created`,
  `notification.read` from another tab, `resync` or a later `ready` → on page 1 `router.refresh()` (400 ms debounce, at most
  one every 2 s; the server list re-renders in place, scroll kept); on another page a pill `New notifications` linking to
  page 1 (`aria-live="polite"`).
- Messages (`lib/i18n/messages/notifications.ts`, `en` / `ar`): `live.view` `View` / `عرض`; `live.many` `{count} new
  notifications` / `{count} إشعارات جديدة`; `live.pill` `New notifications` / `إشعارات جديدة`; `live.pillAction` `Show` / `عرض`.
- `lib/api/types.ts` and `npm run gen:api` (the three routes appear in `schema.gen.ts`; the event types are hand-written in
  `lib/realtime/events.ts` from `docs/contract/realtime-events.md`).
- Tests (Vitest): the client (leader and follower with fake locks and channel; hand-over with the cursor; back-off; watchdog;
  401 stops; 429 waits; duplicate ids ignored), the store (`push`, `setLive`), the toast batching. New
  `e2e/realtime-notifications.spec.ts` (written here, run by the lead): a signed-in customer on `/account`; staff send an
  in-app campaign to that customer (`e2e/admin.ts`); the bell's number grows and a toast shows without a reload; on
  `/account/notifications` the item appears without a reload; a second tab shows the same number and the API has one stream
  for the session (`realtime_connections` through `/metrics`, or the 4th-stream refusal).
- Not touched: checkout, catalog, wallet, auth pages, `next.config.ts`, `proxy.ts`.

### 5.2 Console (slice C; `FA/`)

- New `src/lib/realtime/streamClient.ts` (+ test; same rules; `createStreamClient(env)`), `src/lib/realtime/events.ts`,
  `src/lib/realtime/StreamProvider.tsx` (starts the staff stream once `useMe()` has data; stops at sign-out),
  `src/lib/realtime/useStreamEvent.ts` (`useStreamEvent(name, handler)`, `useStreamStatus()`), `src/lib/realtime/index.ts`.
  The stream path constant has **no `@route` tag** (it is not a fetch function; the backend's contract harvest must never call
  a stream). `src/app/layout/AppShell.tsx`: mount `<StreamProvider>` (the one shared line of this slice).
- `src/features/notifications/hooks/useUnreadCount.ts`: `unread.changed`, `notification.created` and `notification.read` set
  `UNREAD_KEY` (`queryClient.setQueryData`) and invalidate `INBOX_KEY`; `refetchInterval` is `UNREAD_REFRESH_MS` while the
  stream is not open and `LIVE_UNREAD_REFRESH_MS = 300_000` (new, `hooks/keys.ts`) while it is. A live `notification.created`
  shows the existing toast (`item.title`). The campaign page's 5 s poll while sending stays.
- Mocks: `src/mocks/stream.ts` (`MockEventSource` and `pushMockStreamEvent(name, data)`; used when `VITE_API_MOCKS` is on and
  in tests); `src/features/notifications/mocks/inboxRoutes.ts` pushes `notification.read` after the two read routes and
  `campaignRoutes.ts` pushes `notification.created` for a test send to the signed-in staff member.
- `FA/docs/MISMATCHES.md`: one line (`GET /admin/stream` is a backend addition, B216).
- Tests: `streamClient.test.ts`; `NotificationBell.test.tsx` (an event changes the badge without a request; with the stream
  closed the 60 s poll still runs; a `resync` refetches).

## 6. Contract and docs

- **`scripts/map-additions/27.mjs`** (stage 27, `module: 'identity'`, spec `B-TBD realtime-streams`, `successStatus: 200`):

  | Row | group | `a` | `t` | `f` / `en` |
  |---|---|---|---|---|
  | `GET /admin/stream` | `ops` | `جلسة` | `sessions`, `notification_inbox`, `notification_campaigns` | `قناة الأحداث الحية للموظف (SSE)` / `The staff member's live event stream (server-sent events).` |
  | `GET /client/stream` | `growth` | `جلسة` | same | `قناة الأحداث الحية للتاجر (SSE)` / `The merchant's live event stream (server-sent events).` |
  | `GET /store/v1/me/stream` | `account` | `جلسة الزبون` | same | `قناة الأحداث الحية للزبون (SSE)` / `The customer's live event stream (server-sent events).` |

  No new group, access word or table; no migration; no error code (the catalog has `RATE_LIMITED`, `UNAVAILABLE`,
  `CSRF_FAILED`). `test/contract/pending.ts` gets no entry. The routes have no console `@route` function, so the harvest and
  the fixtures skip them; if a generator still asks for one the lead adds a `known-gaps.json` entry.
- `docs/cache-keys.md`: a short "Not keys" note: the channel `gsm:{env}:realtime:doorbell:{db}` (owner infra/realtime, no TTL,
  ids only). `infra/rate-limit/limiters.ts`: `stream-connect` (20 a minute per session). `docs/queues.md`: no change (no job).
- READMEs: new `src/infra/realtime/README.md` (the layer, how to add a source, the events doc, the load-test table);
  `infra/redis/README.md` (the subscriber connection); `infra/db/README.md` (`onCommit`); `identity/README.md` (routes,
  session doorbells); `platform/README.md` (inbox source and doorbells); `docs/ARCHITECTURE.md` §7 gets one paragraph (lead).
- **B216 (proposal).** area `platform`; route `GET /admin/stream, GET /client/stream, GET /store/v1/me/stream`; conflict: "The
  map has no live channel: every screen polls. The owner asked on 2026-11-15 for notifications that appear at once."; decision:
  "Lead record (feature 27, decisions 035 and 037). Three routes beyond the map answer text/event-stream to the signed-in staff
  member, merchant or customer (same-site requests only). Events: ready, hb, notification.created (the item and the unread
  count), notification.read, unread.changed, resync, bye. A change rings a Redis doorbell with ids after its commit; the API
  re-reads Postgres for the viewer. A reconnect sends the last event id and gets what it missed (at most 50 items, else resync).
  At most 3 streams per session and 30 per address (429), re-authenticated every 15 minutes, closed when the session ends.
  The polling routes stay and remain the fallback."; status `decided`.
- Lead after the merges: replace `B-TBD realtime-streams` by `B216`; append B216 to `extra` of `lead-decisions.json` (index
  111); write decision 037 (§2) and the CLAUDE.md clause; `bun run routes:build && contract:docs && docs:openapi &&
  coverage:build && check`; console `npm run mocks:live`; the storefront's `gen:api`.

## 7. Slices, order, files

Order: **B1 → B2** in `../backend-27` (`feat/backend-27`, `.env.test`: `gsm_27_test`, Redis DB 7); **C** (`../frontend-admin-27`,
`feat/console-27`) and **S** (`../storefront-27`, `feat/storefront-27`, own `npm ci`) start with B1, against §3.5 and their
mocks. The lead merges B, then C, then S (after testing S against the isolated API on `:3100`).

**B1. Backend core: HARD, an Opus implementer.** Create `src/infra/realtime/{realtime.module.ts, realtime-hub.module.ts,
realtime.types.ts, realtime-publisher.ts, realtime-sources.ts, realtime-hub.ts, stream-writer.ts, stream-cursor.ts,
connection-registry.ts, realtime-metrics.ts, index.ts}` with `.spec.ts` for the pure parts (cursor, registry, caps, heartbeat
buckets, frame format); `src/modules/identity/realtime/{stream.controller.ts, stream.contracts.ts, stream-viewer.ts}`;
`src/modules/platform/notifications/inbox/{inbox-realtime.source.ts, inbox-realtime.events.ts, inbox-doorbell.ts}`;
`test/integration/realtime-stream.test.ts`, `test/integration/realtime-inbox.test.ts`, `test/support/stream.ts` (a client that
reads frames from a listening test app), `test/load/realtime-connections.ts`, `scripts/map-additions/27.mjs` (the routes
need their rows to pass the parity tests). Edit `src/infra/db/transaction.ts` (+ spec, `index.ts`),
`src/infra/logging/access-log.ts`, `src/infra/metrics/http-metrics.ts` (+ specs), `src/infra/redis/{redis-clients.ts, redis.service.ts}` (+ spec), `src/infra/rate-limit/limiters.ts`,
`src/config/env.ts` (+ spec), `src/app.module.ts`, `src/worker.module.ts`, `identity/identity.module.ts`, `identity/index.ts`,
`identity/security/session.service.ts`, `platform/notifications/inbox/{notification-inbox.ts, inbox.repository.ts,
inbox.service.ts}`, `platform/notifications/campaigns/{campaign-fan-out.ts, campaign-send.service.ts}`, the platform module
files that provide the two new classes, `platform/index.ts`.
**B2. Backend standard: a Sonnet implementer, after B1.** Create `docs/contract/realtime-events.md`,
`src/infra/realtime/README.md`. Edit `deploy/Caddyfile`, `deploy/compose.prod.yaml`, `.env.example`,
`docs/OPERATIONS.md`, `docs/cache-keys.md`, the READMEs of §6, `package.json` (script `test:load:realtime`), and the generated
`docs/route-manifest.*`, `docs/slices/*`, `docs/contract/endpoints/*.md`, `docs/contract/openapi*.json`, `docs/COVERAGE.md`.
Acceptance (B): §3 as written; every existing test passes unchanged; `bun run format`, then `bun run check` green.

**C. Console: Sonnet; the stream client is HARD (Opus writes or reviews line by line `streamClient.ts`).** Files of §5.2.
Acceptance: `npm run typecheck`, `npm run lint`, `VITE_API_MOCKS=false npm run build`, `npm test`.
**S. Storefront: Sonnet; `lib/realtime/stream-client.ts` is HARD (same rule).** Files of §5.1. Acceptance: `npm run
typecheck`, `npm run lint`, `npm run test` (the lead runs `next build` and Playwright).

No hand-written file is in two slices (the generated documents are regenerated by B1 to get green and again by B2 at the
end, never hand-merged). Feature 28 must not edit `src/infra/realtime/**`, `FA/src/lib/realtime/**` or `SF/lib/realtime/**`.

## 8. Tests and acceptance

| File | Covers |
|---|---|
| `infra/realtime/*.spec.ts`, `infra/db/transaction.spec.ts` | cursor parse/format (unknown letters, malformed, 64-character cap); caps and their release; heartbeat buckets with fake timers; frame text; `onCommit` (runs after commit, not after rollback, at once without a transaction, inside a savepoint, nested transactions keep their own lists) |
| `test/integration/realtime-stream.test.ts` (a listening test app, real Postgres and Redis, `TestClock`, fake `Timers`) | headers of §3.4; `ready` first; 401 without a session on each surface; `403 CSRF_FAILED` for a cross-site `Sec-Fetch-Site`; the 4th stream of a session is `429` and a closed one frees its place; the per-IP cap; `REALTIME_ENABLED=false` → `503`; `hb` after 15 s; `bye max_age` at the limit; **sign-out, `revokeAllOf` and a customer block close the stream with `bye session_ended`**; a role change closes with `reauth`; shutdown sends `bye shutdown` and `app.close()` returns within 3 s with streams open; a client that does not read is dropped at the buffer limit; the access log and the histogram skip the stream |
| `test/integration/realtime-inbox.test.ts` | an event item (through `NotificationService.enqueue`) reaches the owner's stream in **under 1 s** with the right text, language and count; nothing is sent for a rolled-back transaction; **no leak**: a second customer, a merchant and a staff member with the same numeric id get nothing; mark read and read-all reach the owner's other stream; a campaign fanned out by `CampaignFanOut.run` (the worker's code path, publishing through Redis) reaches every connected recipient once, a repeated chunk sends nothing; cancel → `unread.changed`; **replay**: close, insert 3 items, reconnect with `Last-Event-ID` (and with `?cursor=`) → exactly those 3 with `live: false`, then `unread.changed`; 51 missed items → `resync`; a garbage cursor is a fresh connect; a Redis outage of the subscriber → `resync` after it returns |
| Contract suite | route, access and permission parity for the three rows; OpenAPI lists `text/event-stream`; no allowlist entry |
| Console, storefront | §5 |

**Load test** (`bun run test:load:realtime`, not part of `check`; the lead runs it once before the merge and records the
table in `src/infra/realtime/README.md`): a listening test app with `REALTIME_MAX_PER_IP=5000`; 2 000 customers with one session
each; a child process (`BUN_CONFIG_MAX_HTTP_REQUESTS=4096`, fact 12) opens 2 000 streams; then 60 s idle, then one in-app
campaign to all, then a restart. Record: API RSS before and after (target: at most 50 KB per connection, 100 MB in all), CPU of
the idle minute (target: under 5 % of one core), campaign delivery p50, p95, p99 and maximum (target: p95 under 1 s),
`realtime_drops_total` (target 0), open descriptors, and the time until all 2 000 are back after the restart (target: under
90 s). Caddy's share is measured once on the production stack (`docker stats caddy`) and added to the table by the lead.

**Acceptance of the feature**: the owner sends a campaign from the console and sees it on an open storefront tab (bell, toast,
list) and in the console bell within a second, without a reload; closing the API for a minute and starting it again brings
every tab back by itself; with `REALTIME_ENABLED=false` everything behaves as today.

## 9. Handoff notes (the lead adds them after the merges)

- `STOREFRONT-BACKEND-HANDOFF.md`: a new **§15 "Live events (feature 27)"**: the two stream routes, the query and
  `Last-Event-ID`, the events table of §3.5 with one example each, the refusals and what the client does for each, the rules
  of §5 (one stream per browser, back-off, watchdog, fallback, dedupe by `item.id`), the limits (3 per session, 30 per
  address, 15 minutes), `no-transform` and the 30 s rule of Next rewrites, and "never open a stream on public pages". §4.1
  (notification routes): one line, "poll every 5 minutes while the stream is open". The status table: feature 27.
- `STOREFRONT-HANDOFF.md`: the banner's change list gets the same pointer; its notifications section (§10) says the bell is
  fed by the stream and keeps the poll as the fallback.

## 10. Decisions

Taken here: SSE + POST; the cache Redis with one channel and one subscriber per API process; `onCommit` instead of the outbox;
the hub in `infra/realtime`, the routes in identity; a composite cursor with bounded replay and `resync`; heartbeat 15 s
(because of the Next rewrite); re-authentication by a 15-minute maximum age plus session doorbells; newest-refused caps (3 per
session, 30 per address, 5000 in all); drop a slow client; one stream per browser through Web Locks; streams only where a bell
is; the page list refreshes through `router.refresh()`; a kill switch. Left out on purpose: push notifications to a closed
browser (Web Push), a presence list, a stream for API-key clients, live order status on the tracking page (a natural next
source: say so to the owner).

**For the owner (not blocking, defaults applied):** (1) a toast for every new notification while the site is open: default
**yes**, at most one every 3 seconds; (2) no sound for notifications on the storefront: default **no sound**.

## 11. Review against the code, and approval

Checked in the code: the three inbox writers and their callers (`tx` only, one savepoint); the fan-out chunk and its return
value; `InboxService` and the repository's owner filter and count; `SessionService` (every end and `invalidateSubject`);
`defineRoute` (`contentType`, `originCheck`, session stages, `pendingMerchant`), the response interceptor and the guard order;
the access log and the request histogram hooks; `RedisService` and the client factories; the limiter table; the map-additions
rules and the groups of the inbox rows (`ops`, `growth`, `account`); `lead-decisions.json` (`extra` has 111 entries, the last
is B215); migrations end at 0030 (this feature adds none); the Caddyfile and the production compose file (one `api`
container); the console's bell hooks and mock layer (MSW); the storefront's unread store, bell slot, list and toast. Run in a
scratch folder, not in the repositories: facts 9, 10 and 12. Read in current docs: Caddy `reverse_proxy` streaming and
`encode`, Next 16.4 rewrites (`proxy-request.js`) and `compress`. Not verified: Nest's handling of a hijacked reply behind the
contract interceptor (B1's first test proves it, or the handler bypasses the interceptor result), the Vite proxy with a stream
(the lead's `curl -N`), Caddy's memory per stream (the load test's last line), and Web Locks behaviour in a frozen mobile tab
(the watchdog and the fallback cover it).

**Approved by Fable 5.2 (2026-11-15)**
