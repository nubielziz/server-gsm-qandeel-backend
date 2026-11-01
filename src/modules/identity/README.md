# Identity & access module (`identity`)

Map domain A. Who can sign in and what they may do: staff accounts and roles, merchants (clients), sessions, one-time tokens, API keys, KYC submissions and IP rules. It owns the authentication and authorization building blocks every surface uses: sessions, CSRF, API keys and the permission check (decision 018).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 007 password hashing, 010 ids and tokens, 018 authentication, sessions and CSRF, 019 encryption and token hashing, 021 rate limiting. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (P2.5a and P2.5c, code in `security/`): the session service, cookies and CSRF token, the guard dispatcher with the staff, merchant and customer session guards, the CSRF guard, the permission guard with the permissions catalog and the Owner helpers, the staff gate of the internal API reference, and the machine guards (`security/machine/`): capability tokens, URL secrets, merchant API keys (REST v1 Bearer and Dhru credentials) and gateway webhook signatures. The sign-in routes (P2.6), the staff, role and IP-rule routes (feature 2a) and the IP rules, maintenance and rate-limit hooks (P2.5b) come with their own features.

## Public API (`index.ts`)

Exports `IdentityModule` and the security stack (`SecurityModule`, global). Other modules import only `src/modules/identity/index.ts` (lint rule `gsm/module-boundaries`):

| Export | Use |
|---|---|
| `SessionService` | `create`, `rotate`, `lookup`, `touch`, `revoke`, `revokeAllOf`, `invalidateSubject` (see below) |
| `SessionCookies` | `set` (session cookie + CSRF cookie + `X-CSRF-Token` header), `clear`, `readToken`, cookie names |
| `CsrfService`, `csrfTokenFor`, `CSRF_HEADER` | derive and check the CSRF token |
| `SessionAuthenticator` | `authenticate` / `authenticateOptional(subject, request, { stages })`: for routes that serve two kinds of callers on one path (the password set by token or by forced-change session) |
| `CurrentPrincipal`, `CurrentStaff`, `principalOf`, `Principal` types | the caller inside a handler |
| `grants`, `isValidPermission`, `isOwner`, `assertOwnerTargetAllowed` | the permission grammar and the Owner rules |
| `RolePermissions` | the permissions of a role, cached per role; `invalidate(roleId, work)` after a role change |
| `PermissionsCatalog` | `list()`: every concrete permission the registered contracts require, without `area:*` wildcards such as the literal `risk:*` (for `GET /admin/permissions`) |
| `SessionSubjects` | register the session resolver of a subject type (the customers module does, feature 14b) |
| `AccessHandlers` | `replace(kind, handler)`: P2.5c gave the machine kinds their real guards; a test installs a stand-in with it |
| `ApiKeyDirectory` | `invalidate(keyHashes, work)` after a key is revoked or edited, `invalidateClient(clientId, work)` after a merchant's status changes; `findByKey` |
| `CapabilityTokenResolvers` | `register({ kind, resolve })`: the owning module's lookup of a checkout, tracking, ticket or sign-in link token |
| `UrlSecretVerifiers` | `register({ routeKey, load })`: where a URL-secret webhook (Telegram) finds its stored secret |
| `WebhookVerifiers` | `register({ gateway, verify })`: one signature adapter per payment gateway (billing) |
| `ApiKeyPrincipal`, `CapabilityPrincipal`, `WebhookPrincipal` | the caller of a machine route: merchant id, key id and scopes / the id a token opens / gateway, event id and `duplicate` |
| `SessionPolicy`, `SESSION_SETTING_KEYS` | the lifetimes and their settings keys |

## The security stack (decision 018)

One global guard, `AccessGuard`, reads each route's contract (`getContract`) and runs, in this order: **authentication by access
kind**, the **CSRF guard**, the **permission guard**. Validation, the handler and the audit follow in the route's own pipes and
interceptors. A route without a contract is refused (`500`), except `DOCUMENTATION_ROUTES`, which keep their own guard.

| Access kind | Who authenticates |
|---|---|
| `public` | nobody; a mutation on `/admin` or `/client` still needs an `Origin` from `CORS_ORIGINS` (`403 CSRF_FAILED` otherwise) |
| `staff-session`, `staff-permission` | the staff session cookie; `staff-permission` adds the contract's `permission` (`403 FORBIDDEN`, the detail names it) |
| `merchant-session`, `customer-session` | the same mechanics with their own cookie, table and statuses |
| `internal-or-token` | the network-or-token rule of `/metrics` (`MetricsAccessGuard`) |
| `api-key` | `Authorization: Bearer <key>` (REST v1): see "Machine guards" below |
| `dhru-credentials` | `username` + `apiaccesskey` in the JSON or form body of `POST /api/index.php`; every refusal is the Dhru envelope with HTTP 200 |
| `gateway-signature` | the adapter of the `:gateway` in the URL, the 5 minute window, the replay filter |
| `url-secret` | a secret in the URL path, compared in constant time with the stored hash or decrypted value |
| `checkout-token`, `tracking-token`, `ticket-token`, `link-token` | the token in the path (`:token`) or the body (`token`), looked up by the resolver the owning module registered |

**Session checks**, in this order: cookie present, the session is known and belongs to the subject (`401`); absolute expiry and idle
expiry (`401`); the account is not suspended (`403 ACCOUNT_SUSPENDED`, and every session of the account is revoked); the stage is one
the contract accepts (`sessionStages`, default `['active']`; `401`); `last_seen_at` is written at most once a minute. A pending
sign-in session has a principal without permissions. `403 FORBIDDEN` and `403 CSRF_FAILED` never sign the caller out.

**Cookies.** `gsm_admin_session`, `gsm_client_session`, `gsm_store_session` (httpOnly, `Secure` from `COOKIE_SECURE`, `SameSite=Lax`,
`Path=/`, `__Host-` prefix when secure) and the readable CSRF cookies `csrf_token` (staff), `csrf_token_client`, `csrf_token_store`
(`Domain` from `CSRF_COOKIE_DOMAIN`). The CSRF token is `HMAC(CSRF_SECRET, session token hash)`, so it changes when the session is
rotated. A same-origin deployment must list its own origin in `CORS_ORIGINS` too, or the Origin check refuses its sign-in.

**Lifetimes** are settings in minutes, with the defaults of decision 018: `sessions.staff_absolute_minutes` 480,
`sessions.staff_idle_minutes` 30, `sessions.client_absolute_minutes` / `sessions.customer_absolute_minutes` 43200,
`sessions.client_idle_minutes` / `sessions.customer_idle_minutes` 10080, `sessions.pending_minutes` 10. An invalid value is ignored
(the default applies, with a warning in the log).

**What a feature does when an account changes** (always pass the transaction so the cache is cleaned after the commit):

```ts
await this.db.runInTransaction(async (work) => {
  // suspend, password change, "end all sessions", 2FA reset: sign the account out everywhere
  await this.sessions.revokeAllOf('staff', id, { exceptSessionId: caller.session.id }, work);
  // role of a staff member changed, or the account state changed but sessions stay: drop the cached views
  await this.sessions.invalidateSubject('staff', id, work);
  // permissions of a role changed
  await this.roles.invalidate(roleId, work);
});
```

**Sign-in steps** (P2.6): `create` a pending session at login (10 minutes), `rotate(principal.session, { stage: 'active' })` when the
last step completes (new token, old one revoked), then `cookies.set(reply, 'staff', issued.token, issued.session.expiresAt)`.

**Customers.** Storefront customers belong to the customers module. Until it registers a resolver
(`SessionSubjects.register({ subjectType: 'customer', resolve })`, mapping `customers.status` to `ok`, `suspended` or `gone`), every
customer session is refused with `401`.

Built: the **IP rules stage of the request pipeline** (P2.5b, `security/ip-rules/`). The module has no controllers yet; the
routes arrive with their features.

### Machine guards (P2.5c, `security/machine/`)

`MachineAccessInstaller` replaces the fail-closed placeholders of the machine kinds with their guards through `AccessHandlers.replace`.
It does so in its constructor, before any `onModuleInit`, so a test module that installs its own stand-in handler in
`onModuleInit` (`test/support/pipeline-routes.ts`) wins and is never overwritten.

**API keys** (`api-keys/`). `Authorization: Bearer <key>` (REST v1) or `username` + `apiaccesskey` (Dhru, scope `dhru`, the username
is `clients.username` compared case-insensitively) resolve an `api_keys` row by `HMAC-SHA256(TOKEN_PEPPER, key)` (decision 019: only
the hash and the 8 character display `prefix` are stored; the key is shown once when the merchant creates it). The checks, in this
order, with the answer of each:

| Check | REST v1 (problem+json) | Dhru (HTTP 200, envelope) |
|---|---|---|
| no key, unknown key, malformed, wrong Dhru username | `401 UNAUTHORIZED` | `Authentication Failed` |
| revoked or expired (`revoked_at`, `expires_at <= now`) | `401 UNAUTHORIZED` ("revoked or has expired") | `Authentication Failed` |
| merchant `suspended` | `403 ACCOUNT_SUSPENDED` | the message |
| merchant `pending` (not approved) | `403 FORBIDDEN` | the message |
| `allowed_ips` non-empty and the client address (`request.ip`, `TRUST_PROXY`) is outside every CIDR, IPv4 or IPv6 (empty = any) | `403 IP_NOT_ALLOWED` | the message |
| the key's `scopes` do not cover the contract's `permission` by the permission grammar (decision 018): the permission itself, its `area:*`, or `*`; Dhru needs `dhru` listed exactly (`*` does not open it) | `403 FORBIDDEN` naming it | the message |
| more than `rate_limit_per_min` accepted calls in a minute (limiter `api-key`, key = key id) | `429 RATE_LIMITED` + `Retry-After` | the message |

Only accepted calls count against the key's limit. Unknown keys and wrong usernames are counted per client address (the `ip` limiter,
300 a minute, under the key `api-key-failures:<ip>`; IPv6 by /64): REST v1 and Dhru have no per-IP stage in the pipeline and an unknown
key has no limit of its own. A request without any key is refused without a lookup and without counting. A stored `rate_limit_per_min`
below 1 is a data error: the limiter's default (60) applies. `last_used_at` / `last_used_ip` are written at most once a minute (best
effort). The principal is `{ kind: 'api-key', clientId, keyId, scopes, ip }`; the request context actor is the merchant (`client`).

The lookup is cached 60 s (a key that matches nothing 10 s). **The features that revoke a key, change its scopes or allowed IPs, or
change a merchant's status call, after their commit:** `afterCommit(() => directory.invalidate([keyHash]))` /
`directory.invalidateClient(clientId, work)`; until then the old view is served for up to a minute.

**Capability tokens** (`capability-tokens.ts`). The guard takes the `token` path parameter or, for the sign-in link routes, the `token`
field of the body; a token that is not 16 to 128 base64url characters never reaches a resolver. The owning module registers a
`CapabilityTokenResolver` per kind in `onModuleInit` (orders: `tracking-token`; customers: `checkout-token`, `link-token`; support:
`ticket-token`): `resolve(token)` returns `{ id }` or `null` (unknown, expired, used) and **must not consume** the token; a single-use link is
marked used by the use case, in its own transaction. A kind without a resolver refuses every request. The answer to a token that opens
nothing is always the same: `404 NOT_FOUND`, or `410 TOKEN_INVALID` for a sign-in link; never `401`, which would sign out a customer who
follows an old link. Brute force is limited per client address by the pipeline's `token` limiter before the guard runs. The principal is
`{ kind: 'capability', access, resourceId, ip }`.

**URL secrets** (`url-secrets.ts`). `UrlSecretVerifiers.register({ routeKey: 'POST /webhooks/telegram/:secret', load })`; `load` returns
`{ form: 'hash', value: TokenService.hash(secret) }` or `{ form: 'secret', value }` (decrypted by the owning module for the comparison only).
The comparison is constant time and always runs, so a missing configuration takes as long to refuse as a wrong secret. A route without a
source, or without a stored secret, refuses every request with `401`.

**Gateway signatures** (`webhooks/`). The `:gateway` of the URL (lower case; `^[a-z0-9][a-z0-9_-]{0,39}$`) picks the `WebhookVerifier` billing
registers (feature 8): `verify({ gateway, headers, rawBody, nowSeconds })` checks the gateway's own scheme over the **exact bytes** of the
body (kept by the raw-body tap of the `/webhooks` surface, `src/common/raw-body.ts`) and returns the `eventId` and the `timestamp` it read
from the signed material. The guard then applies what every gateway shares, in this order: the adapter's signature (a bad one is `400
WEBHOOK_SIGNATURE_INVALID`), the window (signed time within 300 s of now, either way, same code), and the replay filter. The filter is a
`SET NX PX` mark per `(gateway, SHA-256 of the event id)` in the cache Redis for 15 minutes. **A repeat is not refused:** gateways retry, and
refusing would make them retry for hours. The principal says `duplicate: true` and the handler answers `200`. `duplicate` is a hint, not
truth: the first delivery may still be running (and may yet fail), so the handler skips the work only when its own record (the payment row,
unique on the gateway event id) shows the event done, and otherwise processes it idempotently. The mark is released when the reply ends
with a `5xx`, so the gateway's retry is processed; with the cache Redis down the delivery is treated as new (logged). The principal is `{ kind: 'webhook', gateway, eventId, timestamp, duplicate, ip }`.

### IP rules exports (P2.5b)

Exports `IdentityModule` and, for the IP rules: `IpRuleCache` (`get()`, `invalidate()`), `ADMIN_ALLOWLIST_KEY`, the pure
`decideIpAccess` / `compileIpRules` / `ipAudienceOf` / `clientAddressOf` and their types (`IpDecision`, `IpAudience`,
`CompiledIpRules`, `ActiveIpRule`, `IpRuleSnapshot`), `IpRuleHits` (`record`, `idle`: the API counts), `IpRuleHitsFlush` (`flush`: the worker writes) and
`IpRuleHitsFlushModule` with `IP_RULE_HITS_FLUSH_JOB` and `IP_RULE_HITS_FLUSH_SCHEDULER` for the worker. Add the services other modules may call here, and
nothing else: other modules import only `src/modules/identity/index.ts` (lint rule `gsm/module-boundaries`).

## Owned tables

Only this module reads and writes these 8 tables (`scripts/module-map.mjs`); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `staff_users` | Admin console staff. Two-factor authentication is mandatory. Status is invited until the first sign-in, then active, or suspended (a reversible stop that ends the sessions and keeps the record). The last owner and the staff member themselves cannot be suspended. Allowed addresses live in ip_rules, not in a column. |
| `roles` | Roles and their permissions (RBAC). |
| `clients` | B2B merchants; username is the Dhru username. |
| `sessions` | Sign-in sessions for staff, merchants and customers (magic link). |
| `auth_tokens` | One-time tokens for invite and password-reset links for merchants, customers and staff, and for link sign-in and email verification: hash only, valid for one hour and one use. |
| `api_keys` | Merchant API keys, stored as a hash. |
| `kyc_submissions` | Merchant identity-verification (KYC) requests. |
| `ip_rules` | Network rules checked before any other logic: allow addresses for the admin console, and block an address or range for one audience (storefront, API or admin) or for all. A block beats an allow. Restricting the console to the allowlist is a switch in settings. Active rules are loaded into Redis, so no query runs per request. |

## Routes

59 endpoints (admin 38, client 21). Source: `docs/slices/identity.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (38)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/api-keys/:id` | staff-permission · `api_keys:revoke` | Revoke a merchant API key. | 7 |
| `DELETE /admin/ip-rules/:id` | staff-permission · `access:*` | Allowed and blocked addresses: range, audience, reason and duration. | 2 |
| `DELETE /admin/roles/:id` | staff-permission · `roles:*` | Roles and their permissions. | 2 |
| `DELETE /admin/sessions/:id` | staff-permission · `sessions:revoke` | End a session. | 2 |
| `GET /admin/auth/me` | staff-session | The signed-in staff member and their permissions, for Refine. | 2 |
| `GET /admin/clients` | staff-permission · `clients:*` | Merchants: creation, group, status and blocking. | 2 |
| `GET /admin/clients/:id` | staff-permission · `clients:*` | Merchants: creation, group, status and blocking. | 2 |
| `GET /admin/clients/:id/api-keys` | staff-permission · `api_keys:read` | API keys of a merchant. | 7 |
| `GET /admin/ip-rules` | staff-permission · `access:*` | Allowed and blocked addresses: range, audience, reason and duration. | 2 |
| `GET /admin/ip-rules/:id` | staff-permission · `access:*` | Allowed and blocked addresses: range, audience, reason and duration. | 2 |
| `GET /admin/kyc-submissions` | staff-permission · `kyc:read` | Verification (KYC) requests. | 8 |
| `GET /admin/kyc-submissions/:id` | staff-permission · `kyc:read` | Verification (KYC) requests. | 8 |
| `GET /admin/permissions` | staff-permission · `roles:read` | All available permissions. | 2 |
| `GET /admin/roles` | staff-permission · `roles:*` | Roles and their permissions. | 2 |
| `GET /admin/roles/:id` | staff-permission · `roles:*` | Roles and their permissions. | 2 |
| `GET /admin/sessions` | staff-permission · `sessions:read` | Active sessions of staff members and merchants. | 2 |
| `GET /admin/staff` | staff-permission · `staff:*` | Staff members: add by invitation or temporary password, set the role, and edit details. | 2 |
| `GET /admin/staff/:id` | staff-permission · `staff:*` | Staff members: add by invitation or temporary password, set the role, and edit details. | 2 |
| `PATCH /admin/clients/:id` | staff-permission · `clients:*` | Merchants: creation, group, status and blocking. | 2 |
| `PATCH /admin/roles/:id` | staff-permission · `roles:*` | Roles and their permissions. | 2 |
| `PATCH /admin/staff/:id` | staff-permission · `staff:*` | Staff members: add by invitation or temporary password, set the role, and edit details. | 2 |
| `POST /admin/auth/2fa` | public | Complete the sign-in with a TOTP code. | 2 |
| `POST /admin/auth/2fa/setup` | public | First sign-in: the TOTP secret with a QR code. | 2 |
| `POST /admin/auth/login` | public | Sign in with email and password; a TOTP step follows. | 2 |
| `POST /admin/auth/logout` | staff-session | Sign out. | 2 |
| `POST /admin/auth/password/set` | public | An invited or recovering staff member chooses their own password with a one-time token. | 2 |
| `POST /admin/clients` | staff-permission · `clients:*` | Merchants: creation, group, status and blocking. | 2 |
| `POST /admin/ip-rules` | staff-permission · `access:*` | Allowed and blocked addresses: range, audience, reason and duration. | 2 |
| `POST /admin/ip-rules/check` | staff-permission · `access:read` | Test an address before the change; it returns the decision and the matching rule. | 2 |
| `POST /admin/kyc-submissions/:id/decide` | staff-permission · `kyc:decide` | Approve or reject the verification. | 8 |
| `POST /admin/roles` | staff-permission · `roles:*` | Roles and their permissions. | 2 |
| `POST /admin/staff` | staff-permission · `staff:*` | Staff members: add by invitation or temporary password, set the role, and edit details. | 2 |
| `POST /admin/staff/:id/password` | staff-permission · `staff:update` | Send a link to set a new password, or set a temporary one; the current password is never readable and never enters the log. | 2 |
| `POST /admin/staff/:id/reactivate` | staff-permission · `staff:suspend` | Reactivate a suspended staff member. | 2 |
| `POST /admin/staff/:id/reset-2fa` | staff-permission · `staff:update` | Reset 2FA for a staff member. | 2 |
| `POST /admin/staff/:id/sessions/revoke` | staff-permission · `staff:update` | End all sessions of a staff member. | 2 |
| `POST /admin/staff/:id/suspend` | staff-permission · `staff:suspend` | Suspend a staff member with a reason, which ends their sessions; suspending yourself or the last Owner is rejected. | 2 |
| `PUT /admin/access/restriction` | staff-permission · `access:update` | Turn the allow-list restriction on the admin panel on or off; turning it on is rejected if the address of the requester is outside the list. | 2 |

### Merchant portal (21)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /client/api-keys/:id` | merchant-session | Revoke a key. | 7 |
| `DELETE /client/sessions/:id` | merchant-session | End a session. | 2 |
| `GET /client/api-keys` | merchant-session | My API keys (prefix only). | 7 |
| `GET /client/auth/me` | merchant-session | The merchant's details and client group. | 2 |
| `GET /client/kyc` | merchant-session | Verification (KYC) status. | 8 |
| `GET /client/sessions` | merchant-session | Active devices and sessions. | 2 |
| `PATCH /client/api-keys/:id` | merchant-session | Rename a key or change its allowed IPs. | 7 |
| `PATCH /client/profile` | merchant-session | Update name, company, phone and country. | 2 |
| `POST /client/api-keys` | merchant-session | New API key, shown once, with allowed IPs. | 7 |
| `POST /client/auth/2fa` | public | Complete the sign-in with a TOTP code. | 2 |
| `POST /client/auth/login` | public | Sign in; asks for a 2FA code when 2FA is enabled. | 2 |
| `POST /client/auth/logout` | merchant-session | Sign out and end the session. | 2 |
| `POST /client/auth/password/forgot` | public | Send a password reset link. | 2 |
| `POST /client/auth/password/reset` | public | Set a new password with the reset token. | 2 |
| `POST /client/auth/register` | public | Register a new merchant and send the verification email. | 2 |
| `POST /client/auth/verify-email` | public | Verify the email with the token. | 2 |
| `POST /client/kyc` | merchant-session | Upload verification documents. | 8 |
| `POST /client/security/2fa/disable` | merchant-session | Disable 2FA with a code. | 2 |
| `POST /client/security/2fa/enable` | merchant-session | Enable 2FA after confirming a code. | 2 |
| `POST /client/security/2fa/setup` | merchant-session | A new TOTP secret with a QR code. | 2 |
| `POST /client/security/password` | merchant-session | Change the password. | 2 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/scenarios/`).

- `success`: Order completed by the supplier (tables: `api_keys`)
- `reject`: Supplier rejects the order (tables: `api_keys`)
- `manual`: Manual fulfilment by staff (tables: `api_keys`)
- `timeout`: Supplier timeout (the order needs attention) (tables: `api_keys`)
- `b2c-account`: Managing a storefront customer account (tables: `auth_tokens`, `sessions`)
- `admin-team`: Adding and suspending a staff member (tables: `auth_tokens`, `ip_rules`, `roles`, `sessions`, `staff_users`)
- `ip-rules`: IP block list and allowlist (tables: `ip_rules`, `sessions`)

## Permissions

Staff permissions the map requires on this module's admin routes: `access:*`, `access:read`, `access:update`, `api_keys:read`, `api_keys:revoke`, `clients:*`, `kyc:decide`, `kyc:read`, `roles:*`, `roles:read`, `sessions:read`, `sessions:revoke`, `staff:*`, `staff:suspend`, `staff:update`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## IP rules in the request pipeline (`security/ip-rules/`)

Scenario `ip-rules`. The stage runs first after CORS and the request id (`src/common/pipeline/README.md`), on every request
except `/health` and `/metrics`, and refuses with **`403 IP_NOT_ALLOWED`** (problem+json, CORS headers, before any guard).

- **Client address:** `request.ip` (the socket, or the address a trusted proxy reported when `TRUST_PROXY` is set), parsed once;
  an IPv4-mapped IPv6 address (`::ffff:203.0.113.9`) counts as its IPv4 address. IPv4, IPv6 and CIDR ranges are matched on bytes
  (`ip_rules.cidr` is the Postgres `cidr` type; a single address reads back as `/32` or `/128`).
- **Audience of a request** (`ip-audience.ts`): `/admin` is `admin`, `/store/v1` is `store`, `/v1` and `/api/index.php` are `api`
  (the console's "Merchants using the API"), everything else (merchant portal `/client`, `/webhooks`, the documentation pages) is
  `other`. The path is the route template of a matched route and the decoded path of an unknown one, so an escaped spelling
  such as `/%61dmin` cannot dodge a rule.
- **Verdict** (`decideIpAccess`, the same words as `POST /admin/ip-rules/check`): (1) a live **block** rule with the audience's
  scope, or with scope `all`, that covers the address refuses it (the most specific rule is reported, then the lowest id);
  (2) for `admin`, when the setting `adminAllowlistOnly` is on, the address needs a live **allow** rule (scope `admin`), else it
  is refused as "not listed"; (3) otherwise it passes. A rule past its `expires_at` drops out by itself, without a reload.
  `all` therefore reaches the merchant portal, webhooks and the docs too; `/health` and `/metrics` are never judged.
- **Cache:** the live rules and `adminAllowlistOnly` form one snapshot in the cache Redis (`gsm:{env}:identity:ip-rules:active`,
  60 s, stale value served for up to 5 more minutes while one refresh runs), parsed once per snapshot and kept in memory for one
  second per process, so most requests ask neither Redis nor Postgres. **The routes that change a rule or the restriction call
  `IpRuleCache.invalidate()` after their commit** (feature 2a): `afterCommit(() => ipRules.invalidate())`; other API instances
  see the change within a second. With Redis down the loader reads Postgres (once a second per process); with Postgres down too
  the last snapshot keeps being used; with no snapshot at all (cold start) the request is refused with
  `503 DATABASE_UNAVAILABLE`: a rule that cannot be checked is not skipped.
- **Hit counters:** every request a rule decided (a block that refused it, an allow rule that let it into the restricted console)
  adds to the Redis hash `gsm:{env}:identity:ip-rule-hits:pending` (`IpRuleHits.record`, fire and forget; a failure only counts
  `ip_rule_hit_record_failures_total{reason}`). The worker's per-minute job `ip_rule_hits_flush` (`IpRuleHitsFlush`, queue
  `maintenance`, `docs/queues.md`) adds the totals to `ip_rules.hit_count` and moves `last_hit_at` forward in one statement.
  Statistics, not truth: Redis evicting the hash loses counts. `POST /admin/ip-rules/check` must not count hits: it calls
  `decideIpAccess` directly.
- **Operational note:** with the restriction on, the last allow rule expiring locks everyone out of the console (the creation and
  deletion guards of feature 2a judge only the moment of the change). The demo seed turns the restriction on and lists
  `203.0.113.24`, `203.0.113.31` and `198.51.100.77`, so local requests from `127.0.0.1` are refused after `bun run db:seed`
  until an allow rule for the developer's address exists.

## Events

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

- `ip_rule_hits_flush` on the `maintenance` queue, scheduler `ip-rule-hits-flush`, every minute (`IpRuleHitsFlushModule`, imported
  by `src/worker.module.ts` only; processor `IpRuleHitsFlushProcessor`). Not recorded in `job_runs` (decision 020); metrics
  `ip_rule_hits_flush_last_success_timestamp_seconds`, `ip_rule_hits_flush_failures_total`, `ip_rule_hits_flushed_total`.
  Listed in `docs/queues.md`.

Add the next job here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

- `gsm:{env}:identity:session:{tokenHash}` (`CacheKeys.session`): the cached view of a session and the state of its account, 60 s (an unknown token 10 s). `SessionService` deletes it after the commit of a revoke or rotation; `invalidateSubject` does after a suspension, password change or role change.
- `gsm:{env}:identity:role:{roleId}` (`CacheKeys.rolePermissions`): the permissions of a role, 300 s. `RolePermissions.invalidate(roleId)` after the commit of a role change.

Both are listed in `docs/cache-keys.md`. Register every other key family there too (see `CONTRIBUTING.md` → "Add a cache key").

| Key | What | TTL | Invalidation |
|---|---|---|---|
| `gsm:{env}:identity:ip-rules:active` | live IP rules + `adminAllowlistOnly` | 60 s, then stale for 5 min while one refresh runs | `IpRuleCache.invalidate()` after the commit of any rule or restriction change |
| `gsm:{env}:identity:ip-rule-hits:pending` | hash of hit counters (`<rule id>`, `<rule id>:at`) | 24 h, renewed by every hit | emptied by the flush job every minute |
| `gsm:{env}:identity:api-key:{keyHash}` | cached view of an API key and its merchant's status | 60 s (a key that matches nothing: 10 s) | `ApiKeyDirectory.invalidate(keyHashes)` / `invalidateClient(clientId)` after the commit of a revoke, an edit or a merchant status change |
| `gsm:{env}:identity:webhook-event:{gateway}:{eventHash}` | mark that a gateway event was accepted (replay filter) | 15 min | released after a `5xx` reply; otherwise expires |

All four are registered in `docs/cache-keys.md`.
