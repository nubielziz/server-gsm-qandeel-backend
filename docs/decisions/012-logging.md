# 012: Logging and request ids

Status: accepted, 2026-10-31.

**Decision.**
- pino as Fastify's logger, bridged to Nest with `nestjs-pino` (Nest 12 supported); JSON in production, pino-pretty
  only in development.
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
