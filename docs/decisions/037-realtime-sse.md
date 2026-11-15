# 037: Real-time events over SSE with a Redis doorbell

Status: accepted, 2026-11-15 (feature 27, planned by Fable 5.2, approved by the lead). Builds on decisions 006 (two Redis
roles), 020 (outbox and NOTIFY as a wake-up only), 035 (routes beyond the map) and 036 (production deploy).

**Context.** Every screen polled: the storefront bell once a minute, the console every 30 to 60 seconds, so a notification
reached its reader up to a minute late and the support chat (feature 28) could not be a conversation. The owner asked on
2026-11-15 for notifications that appear at once and chose SSE + POST after the options were compared.

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
