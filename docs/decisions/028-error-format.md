# 028: Error format (problem+json) and the error catalog

Status: accepted, 2026-10-31.

**Context.** The frontend parses `application/problem+json` (`type, title, status, code, detail, errors[]`), reads
`X-Request-Id` and `Retry-After`, and reacts to these codes (frontend decision 007): `UNAUTHORIZED` 401,
`FORBIDDEN` 403, `ACCOUNT_SUSPENDED` 403, `IP_NOT_ALLOWED` 403, `VALIDATION_FAILED` 422, `WEAK_PASSWORD` 422,
`EMAIL_TAKEN` 409, `TOKEN_INVALID` 410, `NOT_FOUND` 404, `RATE_LIMITED` 429, plus business 409s.

**Decision.**
- Every error on the admin, client, v1, store, hooks and system surfaces is
  `{ type, title, status, code, detail, errors?, requestId }` with `Content-Type: application/problem+json`;
  `type` = `<ERRORS_BASE_URL>/<code in kebab-case>`; `title` is the catalog's fixed English title; `detail` is a
  human sentence for this occurrence; `errors[]` items are `{ field, code, message }` with dotted field paths
  (`items.0.imei`); `requestId` repeats the `X-Request-Id` header. The Dhru surface keeps its own envelope
  (decision 026).
- Validation failures are `422 VALIDATION_FAILED` with one `errors[]` item per zod issue (never 400). Malformed JSON
  is `400 BAD_REQUEST`.
- One catalog, `src/common/errors/catalog.ts` (`code → status, title`), mirrored by `docs/contract/error-codes.md`
  (contract test, decision 009). Code throws `new AppError('EMAIL_TAKEN', { detail, errors })`; the global exception
  filter maps `AppError`, contract validation failures (422, built by `validationFailed()`), Fastify errors (404
  route, 413 body, 415) and unknown errors (500 `INTERNAL_ERROR`, no stack or internals in production; full error
  logged with the request id). A raw `ZodError` thrown from code counts as a server bug (500): a handler that
  validates more client input itself throws `validationFailed(location, error)` instead.
- 429 always carries `Retry-After`; 401 on a staff route clears no cookie by itself (the frontend signs out);
  `IP_NOT_ALLOWED` is decided before authentication.

- A problem may carry extra members next to the standard ones when a code needs them (RFC 9457 extensions), for example
  `expectedEndAt` on `503 MAINTENANCE`; clients ignore members they do not know.

**Consequences.** One error type everywhere; the frontend's forms map `errors[]` onto fields without changes; the
error catalog is reviewed like an API.

**Amendment (2026-11-08, feature 11's merge).** A Postgres deadlock (`40P01`) or serialization failure (`40001`) is not a
server bug: Postgres rolled the losing transaction back, so nothing was written. `normalizeException` answers it with
`409 CONFLICT` and the detail 'This was changed by another request at the same moment. Try again.', and the filter logs it at
warn level with the request id. Lock order still comes first (feature 11 locks a reversal's accruals before any wallet); the
409 covers the rare paths lock order cannot remove.
