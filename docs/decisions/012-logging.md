# 012: Logging and request ids

Status: accepted, 2026-10-31.

**Decision.**
- pino through `nestjs-pino` (Nest 12 supported) for Nest's own messages and application code; JSON in production,
  pino-pretty only in development. Fastify's built-in logger stays off: the access log is our `onResponse` hook
  (`request completed` with method, route template, status, code, duration), and nestjs-pino's per-request middleware
  is off because its route pattern does not match under Nest 12 + Fastify; the request id reaches every line through a
  pino mixin reading the async context. Accepted gap: Fastify-internal warnings (a reply sent twice, client socket
  errors) are not logged.
- Request id: the incoming `X-Request-Id` is kept when it is ≤ 64 safe characters, otherwise a new UUIDv7 is made;
  it is echoed in the `X-Request-Id` response header (the frontend shows it on errors), bound to every log line, put
  into outbox payload metadata, BullMQ job data and outgoing supplier/webhook calls.
- Redaction (paths, censor `[redacted]`): `authorization`, `cookie`, `set-cookie`, `x-csrf-token`,
  `idempotency-key`, and body fields `password`, `currentPassword`, `newPassword`, `token`, `code`, `secret`,
  `apiaccesskey`, `apiKey`, `totpSecret`, `otpauthUrl`. Personal data is masked by serializers: email
  (`r***@domain`), phone (last 3 digits), IMEI (last 4 digits). Request/response bodies are not logged by default.
- Levels: `info` in production, `debug` in development, `warn` in tests.

**Consequences.** Logs are safe to ship to a log store; investigations join by request id across API, worker and
supplier logs.
