# Real-time layer (`src/infra/realtime`)

Live updates for signed-in people: a notification appears on an open page at once, not after a reload (owner request,
2026-11-15). Transport: Server-Sent Events, one `GET` stream per signed-in browser and surface; everything the browser sends back
is an ordinary `POST`. Decision 037 (`docs/decisions/037-realtime-sse.md`); plan `docs/briefs/27-realtime-notifications.md`; the
events a client receives: `docs/contract/realtime-events.md`. The layer is infrastructure and owns no table; the three stream
routes belong to the `identity` module (it owns sessions, principals and the guard). A viewer is `staff`, `account` or `ticket`
(`StreamViewerKind`, decision 064): every account, whatever its rank, has **one key per account**, `u:account:<id>`, whichever family's stream route it
connects through (`GET /client/stream` for a merchant rank, `GET /store/v1/me/stream` for the retail rank); the inbox source, the session doorbell and
the viewer registry build the same key, and one test proves the three agree.

| What | Where |
| --- | --- |
| Types: `StreamViewer`, `Doorbell`, `Frame`, `Delivery`, `RealtimeSource`, `CapKey` | `realtime.types.ts` |
| `RealtimeModule` (global; API **and** worker): the publisher and the registry of sources | `realtime.module.ts` |
| `RealtimePublisher`: `publish`, `publishOnCommit`, the channel name | `realtime-publisher.ts` |
| `RealtimeSources`: sources register here (`onModuleInit`) | `realtime-sources.ts` |
| `RealtimeHubModule` (API only): `RealtimeHub` | `realtime-hub.module.ts`, `realtime-hub.ts` |
| Connection registry: indexes by audience key and session, cap counts, heartbeat buckets | `connection-registry.ts` |
| Frame text, headers, the writer with the back-pressure rule | `stream-writer.ts` |
| Composite cursor: parse and format | `stream-cursor.ts` |
| Metrics | `realtime-metrics.ts` |
| The three routes, the principal-to-viewer mapping, the caps | `src/modules/identity/realtime/` |
| The inbox source and its doorbells | `src/modules/platform/notifications/inbox/` (`inbox-realtime.source.ts`, `inbox-doorbell.ts`, `inbox-realtime.events.ts`) |
| Session-end doorbells | `src/modules/identity/security/session.service.ts` |

## How a change reaches a screen

1. A use case changes data and commits. Next to the change it calls `publisher.publishOnCommit(topic, op, fields)`, which is
   `onCommit(() => publish(...))` (`src/infra/db`): it runs after the commit of the transaction of the current async context, or at
   once when there is none, and never for a rollback. Callers that hold only `tx` need no signature change.
2. `publish` sends one JSON message on one Redis pub/sub channel of the **cache** Redis: `gsm:{env}:realtime:doorbell:{db}` (`{db}`
   is the database number of the cache URL, because pub/sub ignores `SELECT` and the test runs of several worktrees share one
   instance). It carries `{ v: 1, topic, op, at, ...ids }`, at most 8 KB, **ids only**: never a text, a token, an email address or a
   cookie. It never throws to the use case: a failure is logged (throttled) and counted. Not the outbox: the relay is FIFO and shared
   with order dispatch, and a doorbell is worth nothing a second later.
3. Every API process has one dedicated subscriber connection (`gsm-realtime-sub`, `RedisService.createSubscriberConnection()`,
   reconnects for ever and resubscribes itself). On a message the hub finds the source of the `topic` and asks it to `resolve` the
   doorbell into deliveries, with at most 4 doorbells in flight (the pool has 10 connections) and a waiting list of 1000.
4. The source **re-reads Postgres with the viewer's own keys** (`recipient_type` and `recipient_id`), renders the frame for the viewer
   and returns it with the audience keys it is for (`u:account:42`). Nothing is trusted from the message, so a lost or
   forged doorbell loses or leaks nothing.
5. The hub serialises each delivery once per key (once per connection when `data` is a function of the viewer) and writes it to the
   connections of those keys. A connection that does not read is dropped, never buffered.

Four things heal a lost doorbell (a crash between the commit and the publish, Redis down): the truth is in Postgres, a reconnect
replays what it missed, the hub sends `resync` to every stream after its subscriber reconnects, and clients keep a slow safety
poll (5 minutes while a stream is open).

## Rules of a connection

- **Authentication** is the surface's guard, like any request; the stream is refused before it starts with a problem+json answer.
  It is re-authenticated at least every 15 minutes (`REALTIME_MAX_AGE_SECONDS`: `bye max_age`, the browser reconnects, the guard runs
  again) and closed at once when its session ends (topic `session`, handled by the hub itself: `ended` closes the connections of
  those session ids with `bye session_ended`; `subject` closes the connections of `u:<kind>:<id>` with `bye reauth`).
- **Caps.** At most `REALTIME_MAX_PER_SESSION` (3) per session, `REALTIME_MAX_PER_IP` (30) per address and `REALTIME_MAX_CONNECTIONS`
  (5000) per process. The **newest** stream over a cap is refused (`429`, or `503` for the process cap): an older one is never closed,
  so tabs do not fight. The limiter `stream-connect` (20 a minute, key = the first cap key) stops a reconnect loop.
- **Frames.** `id: <cursor>` only on a replayable frame, `event:`, one `data:` line of JSON; at most 32 KB (a longer one is a
  programming error: logged, counted, skipped). A `hb` event every `REALTIME_HEARTBEAT_SECONDS` (15; an event, not a comment, so the
  client's watchdog sees it, and under the 30 s at which a Next rewrite cuts a silent stream).
- **Cursor and replay.** The cursor is composite, one part per source (`i9001`, later `i9001-t5521`; `-` joins, each part is a letter
  and an integer, 64 characters at most). A reconnect sends it back (`Last-Event-ID`, or `?cursor=`, the header wins); the hub asks
  each source to `replay(viewer, after, limit)`: the rows after the cursor, oldest first, at most 50 for the inbox, else `resync`.
  Live frames that arrive meanwhile wait in a list of 100 (overflow: `resync` for that topic) and are written after the replay unless
  the replay already had them. Unknown letters and malformed parts are ignored (that source starts at `head`).
- **Back-pressure.** After every write `raw.writableLength` above 256 KB (beyond the bytes of the current burst) or a write error
  destroys the socket (`realtime_drops_total{reason="slow_consumer"|"write_error"}`); the client reconnects and replays.
- **Shutdown.** `onModuleDestroy`: refuse new streams, `bye shutdown` and `end()` for all, wait at most 2 s, destroy the rest,
  unsubscribe. The subscriber connection closes in `RedisService.onApplicationShutdown`. The worker has no hub and no subscriber.
- **Not in the access log or the request histogram.** A stream is one "request" of up to 15 minutes: `access-log.ts` logs a
  `text/event-stream` reply at `debug` and `http-metrics.ts` does not observe it. The hub logs `stream opened` (debug) and
  `stream closed` (log) with the viewer (`account:42`), session id, duration, frames and reason; never a cookie, token, cursor or text.
- **Kill switch.** `REALTIME_ENABLED=false`: every stream route answers `503 UNAVAILABLE` with `Retry-After: 30`; clients fall back to
  polling. Publishing continues (harmless).

## Configuration

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `REALTIME_ENABLED` | `true` | | the kill switch |
| `REALTIME_MAX_CONNECTIONS` | `5000` | 1 to 100000 | open streams per API process |
| `REALTIME_MAX_PER_SESSION` | `3` | 1 to 50 | open streams per session |
| `REALTIME_MAX_PER_IP` | `30` | 1 to 100000 | open streams per client address |
| `REALTIME_HEARTBEAT_SECONDS` | `15` | 5 to 25 | the `hb` interval |
| `REALTIME_MAX_AGE_SECONDS` | `900` | 60 to 3600 | lifetime of a stream, plus 0 to 120 s of jitter |

Production notes (descriptor limits, Caddy, the kill switch, what to watch): `docs/OPERATIONS.md` section 6, "Live connections".

## Metrics

API registry: gauges `realtime_connections{surface}` and `realtime_subscriber_up`; counters `realtime_connections_opened_total{surface}`,
`realtime_connections_closed_total{surface,reason}`, `realtime_connections_refused_total{surface,reason}`
(`disabled`, `capacity`, `rate`, `session_cap`, `ip_cap`, `ticket_cap`), `realtime_events_sent_total{event}`, `realtime_drops_total{reason}`,
`realtime_doorbells_received_total{topic}`, `realtime_replays_total{outcome}` (`fresh`, `replayed`, `resync`); histogram
`realtime_delivery_seconds` (the doorbell's `at` to the write; buckets 0.005 to 2 s). API and worker registries:
`realtime_doorbells_published_total{topic}` and `realtime_publish_failures_total{topic}`.

## Adding a source (feature 28 adds the support chat this way)

1. Implement `RealtimeSource` (`realtime.types.ts`) in your module, with a `topic` (`^[a-z][a-z0-9-]{0,31}$`, not `session`) and a
   `cursorKey` (one lower-case letter, not taken: the inbox has `i`) and register it in `onModuleInit` with
   `RealtimeSources.register(this)`, so it is known before the API listens. A taken topic or letter stops the boot.
2. `head(viewer)`: the newest id now. `replay(viewer, after, limit)`: the viewer's frames after `after`, oldest first, or `'resync'`
   when more than `limit` were missed. `snapshot(viewer)`: frames sent after `ready` and the replay (the inbox sends the unread
   count). `keysFor(viewer)`: audience keys beyond the default `u:<kind>:<id>` (a `ticket` viewer has none by default).
3. `resolve(doorbell, has)`: parse the doorbell defensively (it is a message from Redis: check every field), skip what nobody
   watches with `has(key)`, re-read the row **with the viewer's keys in the query**, and return `Delivery` objects: the audience
   `keys`, a `frame` (`data` may be a function of the viewer; give `cursor` for a replayable frame) or a `close` reason. Validate the
   frame's data with a zod schema before returning it (a mismatch is logged and the frame skipped).
4. Ring the doorbell after the commit with `RealtimePublisher.publishOnCommit(topic, op, ids)` from the API and the worker alike:
   ids only, at most 8 KB (split a long list, as `InboxDoorbell.campaignChunk` does at 500).
5. Document every event in `docs/contract/realtime-events.md` with one example, and add the source to the integration tests (leak
   test: another person with the same numeric id gets nothing).
6. Never edit this folder for a feature: a missing capability is a change to the layer, planned by the lead.

## Tests

Unit specs in `test/unit/infra/realtime/` (`stream-cursor`, `stream-writer`, `connection-registry`, `realtime-sources`,
`realtime-publisher`; `test/unit/infra/db/transaction.spec.ts` for `onCommit`). Integration (`bun run test:integration`, real Postgres and Redis, a listening test app, fake
timers): `test/integration/infra/realtime-stream.test.ts` (headers, `ready` first, refusals, caps, kill switch, heartbeat, max age,
session end, shutdown, slow client) and `test/integration/platform/realtime-inbox.test.ts` (delivery under 1 s, no leak, mark read, campaign
fan-out, cancel, replay, `resync`, a Redis outage of the subscriber). The test client is `test/support/stream.ts`.

## Load test

`bash scripts/with-slot.sh bun run test:load:realtime [--count 2000] [--idle 60]` (script `test/load/realtime-connections.ts`;
`NODE_ENV=test`, so the test database and Redis of `.env.test`; not part of `bun run check`). A listening test app with
`REALTIME_MAX_PER_IP=5000`; 2000 accounts with one session each; a child process
(`BUN_CONFIG_MAX_HTTP_REQUESTS=4096`, because Bun's `fetch` opens at most 256 connections per host otherwise) opens one stream each;
then an idle minute, then one in-app campaign to all, then a restart of the API. It prints the table below. Run it once before a
merge of the layer and record the numbers here (a small `--count` proves the script works, but its memory figure is noise);
Caddy's share is measured once on the production stack (`docker stats caddy`).

| Measure | Value | Target |
| --- | --- | --- |
| Streams | 2000 | 2000 |
| API RSS before / with the streams | 357.3 MB / 541.8 MB | |
| Memory per stream | **94.5 KB** (missed; see the note below) | at most 50 KB (100 MB in all) |
| CPU of the idle 60 s | 2.65 % of one core | under 5 % of one core |
| Campaign delivery p50 / p95 / p99 / max | 234 / 393 / 395 / 396 ms | p95 under 1 s |
| `realtime_drops_total` | 0 | 0 |
| Open descriptors before / with the streams | 17 / 2024 | |
| All streams back after a restart | 5.6 s | under 90 s |
| Caddy memory and CPU with the streams (production stack) | | |

Recorded by the lead on 2026-11-15 (Bun 1.4.4, the dev machine, 2000 streams opened in 1.5 s). Memory per stream is about
twice the target: the RSS difference also holds the 2000 sessions, the Fastify request and reply objects of each hijacked
stream and the heap the sign-ins grew. 2000 streams cost about 185 MB, which the production server can carry; profiling the
per-connection retention is a follow-up before the target is claimed.

## Known limits

- Two transactions can commit inbox rows out of id order; a reconnect that falls exactly between them may not replay the lower id.
  The count is never wrong (`snapshot`), and clients refetch their open list after a reconnect.
- A rolled-back **savepoint** inside a committed transaction still rings (they share one callback list): the hub then finds no row
  and sends nothing.
- Caps and the waiting list are per API process. More API processes work unchanged (each subscribes and serves its own streams).
- Not built: push to a closed browser (Web Push), a presence list, a stream for API-key clients.
