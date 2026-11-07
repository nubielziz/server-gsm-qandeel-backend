# 7b merchant-api-webhooks

> **Lead, before launching the implementer (resolution identity-platform-16):** write the per-route specs of
> `/client/api-keys` and `/client/webhooks` (request, response with status, errors, list query) as B-entries in
> `docs/contract/lead-decisions.json` and regenerate the contract docs (`bun scripts/build-contract-docs.mjs`), as
> B121-B136 did for 2b; 7a needs the `/v1/files` specs the same way.

Phase 3, map stage 7 (admin, client and outgoing-event surfaces). Read `_common.md` and `_feature.md` first: this brief only
names the scope. Modules: identity (API keys) and platform (webhook endpoints, deliveries, outgoing events). Wave 3, in
parallel with 6 (it needs 5's order transitions to emit `order.status_changed`). Decisions 019 (key hashing, HMAC), 020
(outbox and queues), 023 (outbound HTTP and SSRF guard), 017 (public API docs), 031 (clock).

## Routes and events (17; remove the routes from `test/contract/pending.ts`)
- Admin: `GET /admin/clients/:id/api-keys`, `DELETE /admin/api-keys/:id`, `GET /admin/webhook-deliveries`,
  `GET /admin/webhook-deliveries/:id`, `POST /admin/webhook-deliveries/:id/retry`.
- Merchant portal: `GET|POST /client/api-keys`, `PATCH|DELETE /client/api-keys/:id`, `GET|POST /client/webhooks`,
  `PATCH|DELETE /client/webhooks/:id`, `POST /client/webhooks/:id/test`, `GET /client/webhooks/:id/deliveries`.
- Outgoing events (OpenAPI `webhooks` with `defineEvent`): `order.status_changed`, `wallet.low_balance`, `invoice.paid`
  (emitted by feature 8 through your service), and `service.price_changed` (user rule 9, MISMATCHES B117: a backend addition
  the route-parity test must allow under that B-entry).

Per-route semantics: `docs/contract/endpoints/identity.md` and `platform.md`; shapes: `docs/contract/frontend-endpoints.json`;
console callers (read-only): `FRONTEND_DIR/src/features/merchants/api` (API access tab) and
`src/features/settings/api` (webhook deliveries tab) with their `types/` and `mocks/`. The portal routes follow ALIGNMENT § 7
and B153 (a pending merchant is refused, the default of `pendingMerchant`).

## Rules that matter (beyond the endpoint docs)
- **API keys (P2.5c machine auth is already built: reuse it).** A key is shown once at creation; only its keyed hash, a
  prefix for display and the scopes are stored; scopes follow the permission grammar and Dhru needs the exact `dhru` scope;
  `allowedIps` accepts a bare IP and stores `/32` or `/128`, and reads back without the host prefix (identity-platform-5);
  `lastUsedIp` is `''` for a never-used key. Revocation (admin `DELETE`, portal `DELETE`, a merchant suspension) calls
  `ApiKeyDirectory.invalidate` / `invalidateClient` after the commit (P2.5c notes: otherwise up to 60 s). Audit the admin
  revocation with the demo's verb phrase (`revoked API key of`, ANSWERS audit Q3).
- **Webhook endpoints.** HTTPS URLs only (SSRF guard of decision 023 at save time and at send time); a per-endpoint signing
  secret, AES-GCM at rest, shown once; the event list a subset of the four events; `test` sends a signed `ping` delivery.
- **Deliveries (decision 020).** Each event is an outbox row turned into one delivery per subscribed endpoint, sent by a
  worker queue with `X-GSM-Signature` (HMAC-SHA256 over timestamp and body, the format P2.5c verifies for incoming hooks),
  a delivery id header for the receiver's de-duplication, backoff with jitter, a fixed number of attempts, then `failed`.
  `responseCode` 0 when there was no answer (identity-platform-12); `response_body` and `error` truncated and stored
  (B116). Manual retry re-sends the same payload as a new attempt. Idempotent jobs (deterministic job ids per delivery
  attempt); documented in `docs/queues.md`.
- **Emitters.** `order.status_changed` from 5's transitions (one outbox row per status change, in the transition's
  transaction), `wallet.low_balance` when a posting takes a wallet under the merchant's threshold (once per crossing, not per
  posting), `service.price_changed` from 4b's price changes for merchants who ordered the service in the last 30 days (12a
  adds the digest mail; you emit the webhook event). Payloads carry ids and the public fields the endpoint doc names, never
  secrets.
- Public API docs: the four events appear in `/openapi.json` and `/docs` (decision 017; the internal document stays a
  superset).

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
identity-platform-5, -7 (API key and Dhru actors in the audit log), -12, -16 (portal specs). Migration 0003 ships their
schema changes; add a migration only for what it lacks.

## Out of scope
Dhru and REST v1 routes (7a), notification templates and mail delivery (12a), payments and invoices (8).
