# 7a dhru-and-rest-v1

> Portal spec prerequisite (resolution identity-platform-16): done. `POST /v1/files` and `GET /v1/files/:id` are
> `docs/contract/MISMATCHES.md` **B157** (lead, 2026-11-07).

Phase 3, map stage 7 (the merchants' machine surfaces). Read `_common.md` and `_feature.md` first: this brief only names the
scope. Modules: orders, catalog, money and platform own the actions; one Dhru envelope adapter and the REST v1 conventions
are shared. Wave 3, after 6 and 7b (the API keys and their directory). Scenarios: add the merchant-side Dhru steps
(`placeimeiorder`, `getimeiorder`) to `test/scenarios/{success,reject,timeout,manual}.e2e.test.ts`. Decisions 026 (Dhru
compatibility, the authority for the wire), 021 (rate limits), 008 (contracts), 017 (public API docs), 031 (clock).

## Routes (20; remove them from `test/contract/pending.ts`)
- Dhru (`POST /api/index.php`, 8 actions): `accountinfo` (money), `imeiservicelist` (catalog), `placeimeiorder`,
  `placeimeiorderbulk`, `getimeiorder`, `getimeiorderbulk`, `placefileorder`, `getfileorder` (orders).
- REST v1 (12): `GET /v1/services`, `GET /v1/services/:id` (catalog), `GET /v1/account`, `GET /v1/transactions` (money),
  `POST /v1/orders`, `POST /v1/orders/bulk`, `GET /v1/orders`, `GET /v1/orders/:id`, `POST /v1/orders/:id/cancel`,
  `POST /v1/orders/:id/verify` (orders), `POST /v1/files`, `GET /v1/files/:id` (platform, B157).

No console screen calls these routes. Semantics: the map rows (`docs/slices/<module>.json`), decision 026, ALIGNMENT § 7
(REST v1) and the endpoint docs of each module.

## Rules that matter
- **Dhru envelope (decision 026).** Form-encoded (multipart accepted) `username`, `apiaccesskey`, `action`, base64 JSON
  `parameters` (bulk: keyed by the caller's request id); always HTTP 200 JSON with `X-Powered-By: DHRU-FUSION`,
  `dhru-fusion-api-version: 6.1`, `SUCCESS` or `ERROR` arrays and `apiversion`; the exact keys and spellings of the decision
  (`AccoutInfo`, `LIST`, `REFERENCEID`, `STATUS` + `CODE`). Never problem+json on this surface; each refusal maps to a catalog
  code for logs and metrics. One fixture per action in `test/dhru/`, checked byte for byte on keys and types. Route parity
  needs an allowance for the transport `POST /api/index.php` (P2.7 notes). A multipart placement during maintenance calls
  `maintenanceRefusal` itself (decision 026 note).
- **Machine auth (P2.5c, built).** Dhru: `username` = `clients.username` and an API key with the exact `dhru` scope; REST v1:
  `Authorization: Bearer`, the route's scope; allowed IPs; per-key rate limits with `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset` on v1 (the P2.5c notes left the headers and multipart Dhru credentials to you). A pending merchant is
  refused with `ACCOUNT_PENDING_APPROVAL` (Dhru: inside its envelope, B153). The audit and log actor is `{type: 'client',
  id, name}` (identity-platform-7).
- **One placement path.** Both surfaces place orders through feature 5's placement use case (price from 4b's
  `PriceResolver`, user rule 9 guard, duplicate rule, `orders.imei` helper of orders-suppliers-2, hold, outbox): no second
  implementation. `PRICE_CHANGED`: REST v1 answers `409` problem+json with `listedPrice` and `currentPrice`; Dhru answers
  `ERROR` with "Price changed. Please refresh the service list and order again.". The list actions (`imeiservicelist`,
  `GET /v1/services[/:id]`) record the listed prices through 4b's `ListedPrices.record`. Archived or disabled services are
  never listed or orderable (catalog-3).
- **REST v1 conventions (ALIGNMENT § 7).** Cursor lists `?limit=` (1-100, default 50) and `?cursor=` → `{ data, nextCursor }`;
  `Idempotency-Key` on `POST /v1/orders` and `/v1/orders/bulk`: the first result is stored with the key (Postgres, inside the
  placement transaction) and replayed; a different body with the same key is `409 IDEMPOTENCY_KEY_REUSED`, one still running
  `409 IDEMPOTENCY_IN_PROGRESS`. Bulk placement answers per item. Cancel and verify use feature 5's transitions
  (`cancel`, `requestVerification` with the service's window). The public OpenAPI (`/openapi.json`, `/docs`) lists every v1
  route with examples (decision 017).
- **Statuses on the wire.** Dhru `STATUS` 0 new, 1 in process, 3 rejected (refunded), 4 completed (decision 025's status
  numbers); `CODE` is the result text. REST v1 sends the console's status words.
- Tests: every action and route with its refusals, concurrency (parallel placements on one wallet never overspend; a duplicate
  Dhru placement within the duplicate rule is refused; an idempotency replay posts once), the Dhru fixtures, and the scenario
  steps above against the fake supplier of feature 6.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
identity-platform-7, -16, catalog-3, orders-suppliers-2. Migration 0003 ships their schema changes; add a migration only for
what it lacks (for example the idempotency store, if feature 5 did not add it).

## Out of scope
API keys and webhooks (7b), supplier calls (6), the portal routes (5, 2b), storefront orders (14a).
