# Contract alignment (backend ↔ frontend ↔ map)

What the backend must send and accept so the finished admin console (`../frontend-admin`) works unchanged, and the
conventions for the surfaces that have no frontend yet. Read this before any route work. Sources: the frontend's
`src/lib/api`, `src/lib/auth`, `src/app/providers`, feature `api/types/mocks`, its `docs/ASSUMED_CONTRACTS.md`
and `docs/MISMATCHES.md`, analysed in Phase 1 (`extraction/*.json`, all 269 console endpoints covered).

| Document | Holds |
|---|---|
| `frontend-endpoints.json` | exact request/response shapes of the 269 console endpoints, from the frontend's TypeScript |
| `endpoints/<module>.md` | per endpoint: map rule, frontend function, query/request/response semantics, errors, B-ids, mocks |
| `error-codes.md` | every code the backend may emit (119) |
| `MISMATCHES.md` | B1–B116: frontend versus map, map silences, schema additions, with decisions |
| `ANSWERS.md` | the backend's answer to each of the frontend's 201 questions |
| `RULES.md` | 216 business rules the console relies on, per feature, and the frontend mismatches with backend impact |
| `OPEN-QUESTIONS.md` | 8 business rules waiting for the user (lead defaults apply meanwhile) |
| `TESTS.md` | how CI keeps all of this true (decision 009) |

**Precedence.** What exists and every business rule: the map. Exact wire format: what the frontend sends and parses.
Disagreements are B-entries; nothing is picked silently.

## 1. Transport

- **Base and prefixes.** One API host: `/admin` (console), `/client` (merchant portal), `/v1` (REST v1), `/store/v1`
  (storefront), `/api/index.php` (Dhru), `/webhooks` (incoming), `/health`, `/metrics`, `/openapi.json`, `/docs`,
  `/reference`. The console calls `${VITE_API_BASE_URL}/admin/…` and `/health`; same-origin deployments use a reverse
  proxy (the dev proxy forwards `/admin` and `/health`).
- **JSON** both ways, `camelCase` keys, `Content-Type: application/json` request bodies (the console sends no
  multipart; uploads on `/client` and `/v1` are multipart). 2xx bodies are JSON or empty: never text or HTML.
- **Ids** are JSON numbers (decision 010). Path params are decimal ids or tokens.
- **Money** is a string with exactly 4 decimals (`"12.4900"`), USD unless the field says otherwise. Other decimals
  follow the frontend type per field: strings for pricing/tax/FX rates, numbers for health and dashboard measures and
  for fractions inside snapshots (decision 011).
- **Times** are ISO 8601 UTC with milliseconds and `Z` (`"2026-03-01T09:30:00.000Z"`); a missing time is `null`,
  never `""`. Date-only parameters (`YYYY-MM-DD`, e.g. audit `from`/`to`, report ranges) are UTC calendar days, both
  ends inclusive. Chart buckets are UTC days (`YYYY-MM-DD`) and months (`YYYY-MM`).
- **Enums** are the frontend's words (lower case, `snake_case`); the backend never sends a value the frontend type
  does not list (contract test). Internal values with no wire word are mapped (B-entries: ticket `pending`, refund
  `completed` until the console adds `processing`).
- **Nullability and optionality** follow the frontend type: a nullable field is sent as `null`, an optional field may
  be omitted. Empty lists are `[]` with `x-total-count: 0`.
- **Success statuses**: creates answer `201` with the created record; deletes `204`; actions answer `204` when the
  console expects no body, otherwise `200` with the documented body (`successStatus` per endpoint). The console accepts
  any 2xx, the contract fixes one.
- **GETs never change state.** The one exception, `GET /admin/customers/:id/export` (closes the export request), also
  requires a same-site `Sec-Fetch-Site` or a matching `Origin`.

## 2. Lists (simple-rest dialect)

- Request: `_start` (0-based, inclusive) and `_end` (exclusive); `_sort=f1,f2` with `_order=asc,desc` (same order,
  camelCase field names); `q` = case-insensitive substring over the endpoint's search fields; field filters
  `field=value` on the camelCase response field (dotted paths such as `role.id` allowed where documented), a repeated
  key = IN, suffixes `_ne` (repeated = NOT IN), `_gte`, `_lte`, `_gt`, `_lt`, `_like` (case-insensitive contains).
  Booleans are `true`/`false`; times are ISO strings; `+` is a space. Accept a string or a repeated list for every
  filter.
- Response: `200` JSON array of rows + `x-total-count` = rows matching the filters before the range (exact; the
  console builds pagers, tab counts and "Show more" on it). Count-only calls (`_start=0&_end=1`, sent in bursts for tab
  counts) must be cheap: one `COUNT` plus one row.
- Server rules: each list contract whitelists its sort fields, filters and search fields (unknown → `422
  VALIDATION_FAILED` naming the parameter); a documented default order when `_sort` is absent; page size up to 1000
  (the console asks for 500 on IP rules); stable order (the id breaks ties).
- Deviations (plain arrays, objects, extra parameters, path-scoped lists, whole-list screens) are listed per endpoint in
  `endpoints/<module>.md`; examples: `GET /admin/permissions` and `GET /admin/orders/:id/events` are plain arrays without
  `x-total-count`; `GET /admin/settings` is one object; audit takes `from`/`to` days; incidents take `open=true`.

## 3. Staff authentication (decision 018)

1. `POST /admin/auth/login {email, password}`: no CSRF (no session yet). Order: IP rules (`403 IP_NOT_ALLOWED`) → rate
   limit (`429` + `Retry-After`) → credentials (`401 UNAUTHORIZED`, identical for unknown email, wrong password or no
   password yet) → suspended (`403 ACCOUNT_SUSPENDED`) → pending session. `200 {next}`: `password` (must change; checked
   first) | `totp` | `totp_setup`. Sets the session cookie (pending, 10 min), the readable `csrf_token` cookie, and
   `X-CSRF-Token`.
2. `POST /admin/auth/2fa {code}` (pending session + CSRF): 6 digits; `204`; rotates the session to active; sets
   `last_login_at`/`last_login_ip`; `invited` → `active` on the first full sign-in; sends `X-CSRF-Token`. Errors: `422`
   on `code`, `401` (pending session gone), `403 CSRF_FAILED`, `429`.
3. `POST /admin/auth/2fa/setup` (pending `totp_setup` session + CSRF, no body): `200 {secret, otpauthUrl, qrSvg}`; a new
   call replaces the pending secret; `409 TWOFA_ALREADY_ENABLED` once 2FA is on. The first code goes to step 2.
4. `POST /admin/auth/password/set`: `{token, password}` (invite/reset link, public, `410 TOKEN_INVALID`) or `{password}`
   on a `pending_password` session (forced change); `204`; signs nobody in; revokes the subject's sessions; `422
   WEAK_PASSWORD` or field errors on `password` (the console hints ≥ 10 characters).
5. `GET /admin/auth/me`: `200` Me `{id, email, name, status, role {id,name}, permissions[], twofaEnabled,
   mustChangePassword, lastLoginAt, lastLoginIp}`; `401` until the session is active; sends `X-CSRF-Token` (first call
   after every reload). `Cache-Control: no-store`.
6. `POST /admin/auth/logout` (CSRF): `204`, revokes the session, clears both cookies (`Max-Age=0`); a `401` there counts
   as success for the console.

- **Session-ending codes**: any `401`, and `403` with `ACCOUNT_SUSPENDED` or `IP_NOT_ALLOWED`, sign the caller out
  wherever they appear: they describe the caller only. `403 FORBIDDEN` (detail names the permission) and `403
  CSRF_FAILED` never sign out; nor do 5xx, 429 or network failures.
- **Expiry** is server-side (staff: 8 h absolute, 30 min idle, settings); the next request answers `401`. Permission
  and role changes apply on the next request (the console caches `me` for 60 s).
- **Cookies**: session httpOnly, Secure, SameSite=Lax, Path=/, a name per subject (`gsm_admin_session`,
  `gsm_client_session`, `gsm_store_session`; `__Host-` in production). CSRF cookie `csrf_token`: readable, Secure,
  SameSite=Lax, `Domain` from config so the console origin can read it; value = HMAC of the session (the merchant portal
  and the storefront use `csrf_token_client` and `csrf_token_store`, so apps on one domain do not overwrite each other's
  token). A mutation without a session on `/admin` or `/client` (sign-in, password set by token, register) sends no token and
  is accepted only with an `Origin` header that is one of `CORS_ORIGINS` (a same-origin deployment lists its own origin too).
  Cross-site deployments (different registrable domains): session cookie `SameSite=None; Secure` (not configurable yet:
  the cookies are `SameSite=Lax`), and the console relies on the `X-CSRF-Token` response header.
- **Other surfaces** (decision 018): merchant portal `/client/auth/*` (optional TOTP, email verification, reset links),
  storefront customers `/store/v1/auth/*` (password or magic link, lockout after repeated failures as `429`), REST v1
  `Authorization: Bearer <key>` with scopes, Dhru `username` + `apiaccesskey` (decision 026), webhooks by signature.

## 4. Permissions

- Grammar `area:action` (lower snake_case); granted `area:*` covers every `area:` action; `*` (and `*:*`) covers all; a
  required `area:*` needs `area:*` or `*`. CRUD rows (`x:*` in the map) need `x:read` (list, show), `x:create`,
  `x:update`, `x:delete`; action rows need their exact permission (`PUT /admin/risk/rules` keeps the literal `risk:*`;
  `POST /admin/content-pages/generate` needs `storefront:create`, B57). `/admin/auth/*` need none; `GET /health` is
  public.
- `GET /admin/permissions` (roles:read) answers the whole catalog as `string[]` of every concrete permission the
  server checks (generated from the contract registry, so it never drifts); roles are `{id, name, permissions[],
  staffCount}` stored as given; `me.permissions` = the role's list; `409 ROLE_IN_USE` when deleting a held role.
- Owner = a staff member whose role contains `*`. `409 LAST_OWNER` for any change leaving no active Owner; actions on an
  Owner account need `*`; no self-suspension (`409 CANNOT_SUSPEND_SELF`), no own role change (`409
  CANNOT_CHANGE_OWN_ROLE`); IP-rule lockout guards (`409 IP_NOT_IN_ALLOWLIST`, `SELF_LOCKOUT`) judge the real request IP.
- Seed roles mirror the frontend mocks: 1 Owner `["*"]`, 2 Admin, 3 Finance, 4 Support, 5 Risk reviewer, 6 Read only
  (exact lists in `RULES.md` § access and `extraction/auth-access.json` → `permissions`).

## 5. Errors (decision 028)

- `application/problem+json` `{type, title, status, code, detail, errors?, requestId}`; `title` and `detail` are shown to
  staff verbatim (plain English, never HTML); always send `code`; `errors[]` items `{field, code, message}` with dotted
  camelCase paths equal to the request keys (`items.0.imei`).
- Validation `422 VALIDATION_FAILED` (one item per issue); malformed JSON `400 BAD_REQUEST`; show routes answer `404
  NOT_FOUND` (the console renders a not-found view); `429 RATE_LIMITED` always with `Retry-After`; business refusals are
  the 409/422 codes of `error-codes.md`, each mapped to the field the console highlights where it has one.
- `X-Request-Id` on every response (errors and successes); the body repeats it as `requestId`.

## 6. Headers, cookies and CORS

- The console sends `Accept: application/json` (`*/*` for downloads), `Content-Type: application/json`, `X-CSRF-Token`
  on non-GET requests, cookies (`credentials: include`); no `Authorization`, no `Idempotency-Key` on admin calls.
- It reads `x-total-count`, `X-Request-Id`, `Retry-After` (seconds or HTTP date), `X-CSRF-Token` (any response),
  `Content-Disposition` (`filename*=UTF-8''…` preferred).
- CORS (when the console is another origin): exact configured origins, `Access-Control-Allow-Credentials: true`,
  `Vary: Origin` on **every** response including errors (otherwise a 401 looks like a network error and never signs
  out); preflight allows `GET, POST, PUT, PATCH, DELETE` and headers `Content-Type, X-CSRF-Token, Idempotency-Key,
  Accept`, `Max-Age: 600`, answered before IP rules, rate limits, auth and CSRF; `Access-Control-Expose-Headers:
  x-total-count, x-request-id, x-csrf-token, retry-after, content-disposition`.
- `Cache-Control: no-store` on `/admin/auth/*` and on any response carrying a secret (temporary passwords, TOTP
  secrets, new API keys).

## 7. Surfaces without a frontend yet

Same JSON, id, money, time, error and header conventions; the map defines the routes and rules.
- **Merchant portal** (`/client`): cookie session + CSRF like the console; simple-rest lists; CSV exports with
  `Content-Disposition`.
- **Storefront** (`/store/v1`): public routes protected by Turnstile (`403 TURNSTILE_FAILED`) and per-IP limits;
  capability tokens in paths (checkout, tracking, tickets); customer session cookie + CSRF for account routes;
  `Idempotency-Key` required on `…/pay`.
- **REST v1** (`/v1`): `Authorization: Bearer <key>`, scopes per route (map), allowed IPs, per-key limits with
  `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` headers. Lists are cursor-paged (map): `?limit=` (1–100,
  default 50) and `?cursor=` (opaque) → `{ data: [...], nextCursor: string | null }`. `Idempotency-Key` on
  `POST /v1/orders` and `/v1/orders/bulk`: the first result is stored with the key and replayed; a different body with
  the same key is `409 IDEMPOTENCY_KEY_REUSED`. Public OpenAPI at `/openapi.json` (decision 017).
- **Dhru** (`/api/index.php`): decision 026 (form fields, base64 JSON parameters, SUCCESS/ERROR envelope, always 200).
- **Incoming webhooks** (`/webhooks/*`): verified signature + 5-minute window + de-duplication by the gateway event id;
  answer `200` fast after the DB write; the processing is idempotent.
- **Outgoing events** (`order.status_changed`, `wallet.low_balance`, `invoice.paid`): `POST` JSON
  `{ id, type, createdAt, data }` to the merchant's endpoint with `X-GSM-Signature: t=<unix>,v1=<hex HMAC-SHA256 of
  "<t>.<body>">` and `X-GSM-Event-Id`; retried with exponential backoff (8 attempts over about 24 h); every attempt in
  `webhook_deliveries`; documented as OpenAPI 3.1 `webhooks` (decision 017).

## 8. Mock layer and fixture harvest

The console's mock layer (MSW handlers, seed `src/mocks/seed/demo-state.json`, `problem()` helper, `crud.ts` list
engine) is the reference behaviour for shapes, status codes and the refusals it implements (it skips most server
rules). Harvest recipe, verified on 2026-10-31 without writing into the frontend repo:
- Config outside the frontend (`test/contract/harvest/vitest.config.mjs`): `root` and `cacheDir` in this repo, alias
  `@` → `<frontend>/src`, `globals: true`, `environment: 'node'`, `execArgv: ['--no-experimental-webstorage']` (Node ≥
  25), `env: { VITE_API_BASE_URL: 'http://api.test' }`, `server.deps.inline: ['@refinedev/react-router']`.
- The test imports `mockServer` from `@/mocks/node`, `resetMockState` from `@/mocks/handlers`, the demo credentials from
  `@/mocks/session`; signs in (`rami@gsm-supply.example`, demo password, code), then calls every route with the
  `X-CSRF-Token` it received and writes `{status, headers, body}` per route under `test/contract/fixtures/frontend/`.
- Run with the frontend's own Vitest under Node (the mocks need Vite transforms):
  `<frontend>/node_modules/.bin/vitest run --config test/contract/harvest/vitest.config.mjs`.
- Compare shapes, types and status codes, not values (times are rebased, tokens random). Seed ids: staff 1 Rami (Owner),
  2 Lina, 3 Omar, 4 Dana, 5 Nadia (invited), 6 Yusuf (suspended); roles 1–6; demo ids become numbers (`m3` → 3).
- The backend seed maps the same demo state with the same id rule, so a switch from mocks to the API looks the same.

## 9. Health and dashboards (System health, dashboard, sidebar counts)

All 30 System health bodies and the dashboard are assumed contracts implemented exactly as the frontend types them:
server-computed states with warn/crit thresholds (settings `health.thresholds`), JSON numbers for measures, money as
4-decimal strings. `GET /admin/system/health` is polled every 15 s and answers from the worker's per-minute snapshot
even during a Postgres outage; `GET /admin/dashboard` is polled every 60 s by every page and is cached per
`(scope, days)`; metrics and errors history come from Prometheus (`503 MONITORING_UNAVAILABLE` when it is missing).
Component keys follow the console's mocks (`postgres`, `redis` = the cache Redis, `storage`, `workers`, `mail`,
`supplier:<id>`, `gateway:<id>`), plus `redis_queue` for the queue Redis (decision 006).
