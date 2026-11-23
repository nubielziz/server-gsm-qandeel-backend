# Identity & access module (`identity`)

Map domain A. Who can sign in and what they may do: staff accounts and roles, merchants (clients), sessions, one-time tokens, API keys, KYC submissions and IP rules. It owns the authentication and authorization building blocks every surface uses: sessions, CSRF, API keys and the permission check (decision 018).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 007 password hashing, 010 ids and tokens, 018 authentication, sessions and CSRF, 019 encryption and token hashing, 021 rate limiting. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: the staff, role, permission, session, IP-rule and merchant routes of feature 2a (27 of its 31 routes; the other 4 are the platform's audit log and settings), the daily purge of ended sessions and the demo merchants of the seed (see "Staff access, merchants and sessions (feature 2a)" below); the 6 API key routes of feature 7b (see "API keys (feature 7b)" below); the 4 notification routes of feature 12a (the merchant's preferences, the Telegram link and Telegram's update webhook, see "Notification settings and Telegram (feature 12a)" below); the 15 merchant portal routes of feature 2b (`/client/auth/*`, `/client/profile`, `/client/security/*`, `/client/sessions`, see "Merchant portal sign-in (2b)" below) and the pending-merchant rule of B153. Built earlier (P2.5a, P2.5c and the P2.6 sign-in routes, code in `security/`): the session service, cookies and CSRF token, the guard dispatcher with the staff, merchant and customer session guards, the CSRF guard, the permission guard with the permissions catalog and the Owner helpers, the staff gate of the internal API reference, and the machine guards (`security/machine/`): capability tokens, URL secrets, merchant API keys (REST v1 Bearer and Dhru credentials) and gateway webhook signatures. The sign-in routes (P2.6) and the IP rules, maintenance and rate-limit hooks (P2.5b) are built too.

## Public API (`index.ts`)

Exports `IdentityModule` and the security stack (`SecurityModule`, global). Other modules import only `src/modules/identity/index.ts` (lint rule `gsm/module-boundaries`):

| Export | Use |
|---|---|
| `SessionService` | `create`, `rotate`, `lookup`, `touch`, `revoke`, `revokeAllOf`, `invalidateSubject` (see below) |
| `SessionCookies` | `set` (session cookie + CSRF cookie + `X-CSRF-Token` header), `clear`, `readToken`, cookie names; `setLinkBrowser` and `readLinkBrowser` (the HttpOnly cookie that marks the browser which asked for a storefront sign-in link) |
| `CsrfService`, `csrfTokenFor`, `CSRF_HEADER` | derive and check the CSRF token |
| `SessionAuthenticator` | `authenticate` / `authenticateOptional(subject, request, { stages })`: for routes that serve two kinds of callers on one path (the password set by token or by forced-change session) |
| `CurrentPrincipal`, `CurrentStaff`, `principalOf`, `Principal` types | the caller inside a handler |
| `grants`, `isValidPermission`, `isOwner`, `assertOwnerTargetAllowed`, `customerContactOf` | the permission grammar and the Owner rules; `customerContactOf(caller)` is `'full'` for a role that grants `customers:read`, else `'masked'` (decision 047: the form of a customer's address in staff answers outside the Customers pages) |
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
| `StaffAuthTokens` | `issue(work, { staffId, purpose: 'invite' \| 'reset', createdBy?, ip? })`: the one-hour, single-use link token of `POST /admin/auth/password/set` (feature 2a calls it when it adds a member by invitation or sends a reset; it voids the account's older links) |
| `checkPasswordPolicy`, `MIN_PASSWORD_LENGTH` | the staff password policy (also for a temporary password the server generates) |
| `OWNER_ROLE_NAME`, `OWNER_ROLE_PERMISSIONS`, `EmailField`, `NameField`, `temporaryPasswordFor` | what `bun run setup` (P4b) shares with the seed and the staff routes: the Owner role definition, the email and name rules, the temporary password |
| `TEMPORARY_PASSWORD_TTL_MS`, `temporaryPasswordExpired` | a temporary password works 72 hours from `password_changed_at` (decision 052); the customers module checks its customers' passwords with it |
| `SignInLockModule`, `SignInLock`, `SignInAccount`, `SignInScope` | the failed-sign-in lock of an email (decision 052, section "Sign-in lock" below); the customers module's store sign-in, smart sign-in and password use cases use it |
| `takePublicMailPoint`, `NO_ACCOUNT_ID`, `MAX_LIVE_PUBLIC_LINKS` | the per-recipient budget of the mails a visitor can ask for, the id of "no account" of a run that is rolled back, and the three live links a visitor's requests may hold (decision 052) |
| `STAFF_TOTP_AAD`, `CLIENT_TOTP_AAD`, `TOTP_ISSUER` | the encryption contexts of `staff_users.totp_secret_enc` and `clients.totp_secret_enc`, and the name authenticator apps show |
| `MerchantAuthTokens` | `issue(work, { clientId, purpose: 'verify_email' \| 'reset' \| 'invite', createdBy?, ip?, keepEarlier? })`: the one-hour, single-use link token of a merchant (feature 2a calls it with `invite` for `POST /admin/clients`); it voids the merchant's older unused links of the same family (with `keepEarlier`, only the visitor's own forgot request, all but the two newest: decision 052) and returns `{ token, id, expiresAt }` |
| `MerchantMailOutbox`, `MERCHANT_MAIL_EVENTS` | `enqueue(work, { kind: 'email_verification' \| 'password_reset' \| 'invited', clientId, tokenId })`: writes the outbox event of a merchant mail (ids only, never the token) in the caller's transaction; feature 2a writes `invited` with it |
| `StaffMailModule`, `StaffMailOutbox`, `STAFF_MAIL_EVENTS` | feature 20: `enqueue(work, { kind: 'invited' \| 'password_reset', staffId, tokenId })` writes the outbox event of a staff mail (ids only); the module is loaded by the API (through `AccessAdminModule`) and by the worker |
| `MerchantNotificationsModule` | the merchant's notification preferences, the Telegram link and the Telegram webhook (feature 12a) |
| `CustomerAuthTokens`, `CUSTOMER_TOKEN_TTL_MS`, `isUsableLink`, `CustomerTokenRecord` | the one-time links of storefront customers (feature 14b; `auth_tokens` rows of subject type `customer`): `issue(work, { customerId, purpose: 'magic_link' \| 'invite' \| 'reset' \| 'verify_email', createdBy?, ip?, keepEarlier?, browserKey? })` returns `{ token, id, expiresAt }` (256 random bits, only the keyed hash stored, valid one hour, one use; it voids the customer's older unused links of the same family: `invite` and `reset` are one family; with `keepEarlier`, for the links a visitor asks for, all but the two newest, decision 052), `find(token)`, `findById(id)`, `rotate(id)` (the customer mail job: a new token's hash on the same unused, unexpired row, the clear value returned), `consume(work, id)` (false when a parallel request used it first), `voidOpen(work, customerId, purposes, exceptId?)`, `passwordLinkSentAt(customerId)` and `askedFrom(record, browserKey)` (whether the link stored the keyed hash of that asking-browser cookie value; `browserKey` on `issue` stores it); `isUsableLink(record, nowMs)` is the unused-and-not-expired test the link resolver and the use cases share |
| `CustomerTokensModule` | provides and exports `CustomerAuthTokens` on its own (database, token hasher, clock), so the worker loads the customer mail job without the security stack; the customers module's `CustomersAccountsModule` and `CustomerMailModule` import it |
| `CUSTOMER_TOKEN_PURPOSES`, `CUSTOMER_PASSWORD_LINK_PURPOSES`, `CustomerTokenPurpose` | the link purposes of a customer, and the two (`invite`, `reset`) that choose a password |
| `CurrentMerchant` | parameter decorator: the signed-in merchant (`MerchantPrincipal`) of a `merchant-session` route |
| `MerchantGroupMembers` | `countByGroup(db, groupIds)` (the `merchantCount` of the catalog's group routes and their delete guard) and `countInGroup(db, groupId, clientIds)` (the overdraft rule); read-only, no dependencies, exported in the leaf block of `index.ts` (decision 032) |
| `GroupPromotionModule`, `GroupPromotion`, `decidePromotion`, `breaksCreditRule` | the nightly promotion job of feature 4a (worker only) and its pure decision |
| `StreamRoutesModule` | the three live event stream routes (feature 27, decision 037), loaded by the API only; the hub it uses is `RealtimeHubModule` of `src/infra/realtime` |

## The security stack (decision 018)

One global guard, `AccessGuard`, reads each route's contract (`getContract`) and runs, in this order: **authentication by access
kind**, the **CSRF guard**, the **permission guard**, then, for a `turnstile: true` storefront route only, the **anti-bot check**
(`TurnstileGuard`, `src/infra/turnstile`, decision 034: `403 TURNSTILE_FAILED`; also public `/client` routes since feature 24A). Validation, the handler and the audit follow in the
route's own pipes and interceptors. A route without a contract is refused (`500`), except `DOCUMENTATION_ROUTES`, which keep their own guard.

| Access kind | Who authenticates |
|---|---|
| `public` | nobody; a mutation on `/admin` or `/client` still needs an `Origin` of the route's audience (`CONSOLE_ORIGINS`, `SHOP_ORIGINS`; `403 CSRF_FAILED` otherwise); on `/store/v1` only the routes with `originCheck` (the sign-in routes, the link exchange included) |
| `staff-session`, `staff-permission` | the staff session cookie; `staff-permission` adds the contract's `permission` (`403 FORBIDDEN`, the detail names it) |
| `merchant-session`, `customer-session` | the same mechanics with their own cookie, table and statuses |
| `internal-or-token` | the network-or-token rule of `/metrics` (`MetricsAccessGuard`) |
| `api-key` | `Authorization: Bearer <key>` (REST v1): see "Machine guards" below |
| `dhru-credentials` | `username` + `apiaccesskey` in the JSON or form body of `POST /api/index.php`; every refusal is the Dhru envelope with HTTP 200 |
| `gateway-signature` | the adapter of the `:gateway` in the URL, the 5 minute window, the replay filter |
| `url-secret` | a secret in the URL path, compared in constant time with the stored hash or decrypted value |
| `checkout-token`, `tracking-token`, `ticket-token`, `link-token` | the token in the path (`:token`) or the body (`token`), looked up by the resolver the owning module registered |

**Failed session lookups (decision 053).** In required mode (the guard, the queues board, the `upload-session` stage) a cookie that names no live session of the audience costs
one point of the budget `session-failures:<subject>:<address key>` on the `ip` limiter (300 a minute per client address and audience, the budget of unknown API keys; `sessionFailureKey`);
the budget is read first (`RateLimitService.peek`) and an address that used it up is answered `429 RATE_LIMITED` with `Retry-After` without a lookup (the queues board gate sends the header
too). A request without the cookie and a live session cost nothing; `authenticateOptional` (public routes that accept an optional session) charges nothing.
**`upload-session` stage** (`security/upload-session.hook.ts`, `UploadSessionModule`, API only, the fourth stage of `PIPELINE_STAGES`): for a `multipart/form-data` request on a route of
`MULTIPART_ROUTES` whose contract signs in with a session cookie (`POST /client/files`, `POST /store/v1/files`, the three console uploads), `SessionAuthenticator.precheck(subject, request)` refuses
with `401 UNAUTHORIZED` unless the cookie of the route's audience names a live session, before the body is read; suspension, stage, approval, CSRF and permission stay in the guard.
API keys and ticket links are not judged here (the `upload` limiter and the 5 MiB bound of the ticket route bound them).

**Session checks**, in this order: cookie present, the session is known and belongs to the subject (`401`); absolute expiry and idle
expiry (`401`); the account is not suspended (`403 ACCOUNT_SUSPENDED`, and every session of the account is revoked); the stage is one
the contract accepts (`sessionStages`, default `['active']`; `401`); `last_seen_at` is written at most once a minute. A pending
sign-in session has a principal without permissions. `403 FORBIDDEN`, `403 CSRF_FAILED` and `403 ACCOUNT_PENDING_APPROVAL` never sign the caller out.

**Merchants waiting for approval (user decision B153).** A merchant with `clients.status = 'pending'` may sign in, but a
`merchant-session` route answers it `403 ACCOUNT_PENDING_APPROVAL` unless its contract says `pendingMerchant: 'allow'` (default
`deny`, like `sessionStages`; the OpenAPI operation carries `x-gsm-pending-merchant`). The routes of feature 2b all allow it (a
pending merchant reads its approval status with `GET /client/auth/me` and manages its own profile, password, 2FA and sessions);
the KYC routes (feature 8) will too. The check runs in the session access handler, after the suspension and stage checks, from the
`approved` flag of the cached session view (`SubjectSnapshot.approved`, true when the status is `active`; a view cached without
the flag counts as not approved). **A route that changes a merchant's status calls `SessionService.invalidateSubject('client', id,
work)` and `ApiKeyDirectory.invalidateClient(id, work)` after its commit**, or the old view is served for up to a minute. API-key
and Dhru calls of a pending merchant answer `403 ACCOUNT_PENDING_APPROVAL` as well (Dhru: its message in the envelope).

**Cookies.** `gsm_admin_session`, `gsm_client_session`, `gsm_store_session` (httpOnly, `Secure` from `COOKIE_SECURE`, `SameSite=Lax`,
`Path=/`, `__Host-` prefix when secure) and the readable CSRF cookies `csrf_token` (staff), `csrf_token_client`, `csrf_token_store`
(`Domain` from `CSRF_COOKIE_DOMAIN`). The CSRF token is `HMAC(CSRF_SECRET, session token hash)`, so it changes when the session is
rotated. The Origin checks use the origins of the route's audience (decision 045): `CONSOLE_ORIGINS` and `SHOP_ORIGINS`, which production derives from `CONSOLE_BASE_URL`,
`STORE_BASE_URL` and `PORTAL_BASE_URL`; a deployment that serves a page from another host lists that origin too. The readable CSRF
cookies keep their names and are not host-locked (the console and the storefront read them by name).

**Lifetimes** are settings in minutes, with the defaults of decision 018: `sessions.staff_absolute_minutes` 480,
`sessions.staff_idle_minutes` 30, `sessions.client_absolute_minutes` / `sessions.customer_absolute_minutes` 43200,
`sessions.client_idle_minutes` / `sessions.customer_idle_minutes` 10080, `sessions.pending_minutes` 10. An invalid value is ignored
(the default applies, with a warning in the log).

**One "live session" predicate** (lead resolution identity-platform-6, built by feature 2a in the sessions repository):
`revoked_at IS NULL AND expires_at > $now AND (stage <> 'active' OR last_seen_at > $now - the idle limit of the subject
type)`, where `$now` is the injected clock's time passed in (decision 031), never the database's `now()`. `GET /admin/sessions` (still limited to fully signed-in staff and merchant sessions, B9), `StaffMember.activeSessions`
(which enables "Sign out all devices"), the `DELETE /admin/sessions/:id` 404 (an idle-dead session reads as already ended) and
the merchant `GET /client/sessions` all use it; `SessionService.revokeAllOf` keeps revoking every non-revoked row, idle-dead ones
included.

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

**Sign-in steps** (P2.6, built): `create` a pending session at login (10 minutes), `rotate(principal.session, { stage: 'active' })` when the
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
| merchant `pending` (not approved, B153) | `403 ACCOUNT_PENDING_APPROVAL` | the message |
| `allowed_ips` non-empty and the client address (`request.ip`, `TRUST_PROXY`) is outside every CIDR, IPv4 or IPv6 (empty = any) | `403 IP_NOT_ALLOWED` | the message |
| the key's `scopes` do not cover the contract's `permission` by the permission grammar (decision 018): the permission itself, its `area:*`, or `*`; Dhru needs `dhru` listed exactly (`*` does not open it) | `403 FORBIDDEN` naming it | the message |
| more than `rate_limit_per_min` accepted calls in a minute (limiter `api-key`, key = key id) | `429 RATE_LIMITED` + `Retry-After` | the message |

Only accepted calls count against the key's limit. Unknown keys and wrong usernames are counted per client address (the `ip` limiter,
300 a minute, under the key `api-key-failures:<ip>`; IPv6 by /64): REST v1 and Dhru have no per-IP stage in the pipeline and an unknown
key has no limit of its own; that budget is peeked before the lookup (decision 053), so an address that used it up gets `429` without a lookup.
A bulk placement costs more than one point: `ApiKeyCredentials.points` (default 1; `requestPoints` in `api-keys/request-points.ts`: the length of `orders` of `POST /v1/orders/bulk`,
the item ids of a Dhru `placeimeiorderbulk`, clamped to 1 to 100; `getimeiorderbulk` stays one) is charged in the one `consume`, at most the key's own limit, so the `RateLimit-*` headers stay true. A request without any key is refused without a lookup and without counting. A stored `rate_limit_per_min`
below 1 is a data error: the limiter's default (60) applies. `last_used_at` / `last_used_ip` are written at most once a minute (best
effort). The principal is `{ kind: 'api-key', clientId, keyId, scopes, ip }`; the request context actor is the merchant (`client`).

The lookup is cached 60 s (a key that matches nothing 10 s). **The features that revoke a key, change its scopes or allowed IPs, or
change a merchant's status call, after their commit:** `afterCommit(() => directory.invalidate([keyHash]))` /
`directory.invalidateClient(clientId, work)`; until then the old view is served for up to a minute.

**Cached views are bound to their credential (decision 055).** A cached session view is used only when its `tokenHash` equals the hash of
the presented cookie, and a cached API key view only when its `keyHash` equals the hash of the presented key (constant-time compare); a
view of another credential answers 401, is deleted and logs one warning a minute. The deletes that follow a security change (sessions,
API keys, role permissions, IP rules) go through `CacheService.invalidate`: retried, reported, never thrown.

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
source, or without a stored secret, refuses every request with `401`. A source may also name a request `header` that must carry the same
secret (both are compared, both always, so the time does not say which failed) and a `refusal` of `not_found` (404, so a scanner cannot tell
the route exists); a stored `secret` may name a separate `header` value, which the header is then compared with instead of the path's
(decision 054). Feature 12a's Telegram webhook uses all three: the path and `X-Telegram-Bot-Api-Secret-Token` carry two values derived from
`TELEGRAM_WEBHOOK_SECRET` with two labels (`telegramWebhookPath`, `telegramWebhookHeader`), registered with Telegram by
`scripts/telegram-webhook.ts`.

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

Built: the **IP rules stage of the request pipeline** (P2.5b, `security/ip-rules/`) and the **staff sign-in routes** (P2.6, below). The
other routes arrive with their features.

### IP rules exports (P2.5b)

Exports `IdentityModule` and, for the IP rules: `IpRuleCache` (`get()`, `invalidate()`), `ADMIN_ALLOWLIST_KEY`, the pure
`decideIpAccess` / `compileIpRules` / `ipAudienceOf` / `clientAddressOf` and their types (`IpDecision`, `IpAudience`,
`CompiledIpRules`, `ActiveIpRule`, `IpRuleSnapshot`), `IpRuleHits` (`record`, `idle`: the API counts), `IpRuleHitsFlush` (`flush`: the worker writes) and
`IpRuleHitsFlushModule` with `IP_RULE_HITS_FLUSH_JOB` and `IP_RULE_HITS_FLUSH_SCHEDULER` for the worker. Add the services other modules may call here, and
nothing else: other modules import only `src/modules/identity/index.ts` (lint rule `gsm/module-boundaries`).

## Staff sign-in (P2.6): `/admin/auth/*`

Six routes (`contracts/auth.contracts.ts`, `controllers/staff-auth.controller.ts`; use cases in `application/`, queries in `infra/`,
pure rules in `domain/`), wired by `StaffAuthModule`. Contract: `docs/contract/ALIGNMENT.md` § 3 and `endpoints/identity.md`.

| Route | Access | What it does |
|---|---|---|
| `POST /admin/auth/login` | public (Origin check) | email + password → `{ next }` and a pending session (10 min). Order: IP rules and the per-IP limit (pipeline) → sign-in limit (email + network) → account lookup → the email's lock (`SignInLock`, scope `staff`) → credentials (a temporary password older than 72 hours is a wrong one) → suspended → session |
| `POST /admin/auth/2fa` | session, `pending_totp` / `pending_totp_setup` | six digits → `204`; rotates the session to `active`, stamps `last_login_at` / `last_login_ip`, turns `invited` into `active`, turns 2FA on when the code confirmed a pending secret |
| `POST /admin/auth/2fa/setup` | session, `pending_totp_setup` | a fresh pending secret (encrypted) → `{ secret, otpauthUrl, qrSvg }`; `409 TWOFA_ALREADY_ENABLED` once 2FA is on |
| `POST /admin/auth/password/set` | public (Origin check) | `{ token, password }` (link) or `{ password }` on a `pending_password` session (then `X-CSRF-Token` is checked in the handler) → `204`; signs nobody in; ends every session of the account |
| `POST /admin/auth/logout` | session, every stage | revokes the session, clears both cookies, `204` |
| `GET /admin/auth/me` | session, `active` | the member, their role and the role's permissions; `Cache-Control: no-store`; repeats `X-CSRF-Token` |

**Rules worth knowing**

- **One answer for every bad credential.** An unknown email, a wrong password and an account with no password yet are the same `401`
  (same body), and each verifies one argon2 hash (a dummy one when there is no account to check), so timing does not tell them apart.
  `403 ACCOUNT_SUSPENDED` only follows a correct password.
- **Rate limits** (`SignInLimiter`, limiter `sign-in`, 5 per 15 minutes then locked for 15; a success clears the count): login per email +
  network (`RequestMeta.limitKey`: the IPv4 address or the IPv6 /64, decision 052); **codes per account** (not per session, or every new login
  would give a thief five more guesses) on the limiter `sign-in-code`, which is never counted in process memory (while the cache Redis cannot
  be reached the code step answers `429`); setups per account. The keys are `HMAC(TOKEN_PEPPER, ...)` hashes, so Redis keys hold no email
  address. Trying links from one address uses the `token` limiter (30 a minute).
- **The email's lock** (decision 052): every attempt is counted for its email before the password is checked; after ten failures, from
  any networks, the next attempt is refused and the email is locked for 15 minutes for every network the account has not signed in from
  (`SignInLock`, scope `staff`); a correct password takes back only its own count and keeps a running lock; a new password (link, forced
  change, a temporary password set by another member) ends it. The attempts a familiar network is still allowed while the lock runs share
  one budget per email and network (limiter `sign-in-familiar`, 5 in 15 minutes).
- **The code step closes after twenty wrong codes within 24 hours** (`CodeStepLock`, columns `staff_users.totp_failures`,
  `totp_failures_since` and `totp_locked_at`): every code attempt is counted on the account's row before the code is checked, in one
  `UPDATE`, and a correct code takes back only its own count, so neither parallel attempts nor the member's own sign-in reset it. The
  count runs 24 hours from the first counted wrong code, and every wrong code writes a warning naming the account and the address. The
  twentieth closes the step: the closing is recorded once (`totp_locked_at`, a guarded `UPDATE`, so requests at the cap write one audit
  row `locked the authenticator step of`, entity `staff`), and from then on every code, the right one included, is `429 RATE_LIMITED`
  with a `Retry-After` of the seconds until the 24 hours end. Then the step opens by itself with a count of zero; sooner, a new password
  (from a link, or a temporary password set by another member) or a 2FA reset by another member opens it. The count is in
  Postgres, not in the cache Redis, so no eviction, restart or in-process fallback can end it early.
- **Temporary passwords work 72 hours** from when they were set (`password_changed_at`); after that `login` refuses them like a wrong
  password (and counts the failure). An open `pending_password` step may finish.
- **TOTP.** otplib, SHA-1, 6 digits, 30 s, ±1 step. `staff_users.totp_last_step` (schema addition of P2.6, migration `0002`) holds the last accepted
  time step; one guarded `UPDATE` (`completeSignIn`) accepts a step only if it is newer, the account is not suspended and the secret is
  still the one that was checked, so a code works once even with parallel requests. A new setup clears the step.
- **The database decides.** The code, setup, password-set and logout steps and `me` read the account from `staff_users`, not from the 60-second
  cached session view: a suspension applies at once (`403`, every session of the account revoked).
- **Passwords.** At least 10 characters, at most 128, not trivially weak, not the email name or the person's name, not the current password
  (`422 WEAK_PASSWORD` on `password`). argon2id; a correct login re-hashes a hash made with a lower cost (decision 007).
- **Links** (`auth_tokens`, purposes `invite` and `reset`): 256 random bits, only the keyed hash stored, one hour, one use. A newer link voids
  the older ones; using one voids the rest. Unknown, used, expired, superseded or suspended-account links are `410 TOKEN_INVALID`. A weak
  password does not use the link up.
- **Audit** (`audit_logs`): `logged in` (entity `session`, written by the code step), `turned on two-factor sign-in` (entity `staff`, the first
  time), `logged out` (full sessions only), `set a new password` (entity `staff`; in link mode the account owner is the actor). Failed attempts are
  logged without the email and rate-limited, never audited. No password, token or secret reaches a log or an audit row.
- **Development credentials** (`bun run db:seed`, development only): see the root `README.md`, "Local sign-in".
- **First owner on a fresh server** (P4b, `bun run setup`, production included): the account is a `staff_users` row with status `invited`, no
  creator (it is set up outside the console) and the Owner role (`OWNER_ROLE_NAME`, `OWNER_ROLE_PERMISSIONS = ['*']`, exported for the seed and
  the setup) or any role that already grants `*`. It is created only while no staff member of any status holds a role that grants every
  permission (checked again inside the transaction, under an advisory lock). Two ways: a password the person **chose** (typed at the prompt, or
  read by `--password-stdin`): `mustChangePassword` false, so `POST /admin/auth/login` answers `next: totp_setup` at once; or a generated
  **temporary** password (`--email` and `--name`, as `POST /admin/staff` in its `temporary_password` mode): `mustChangePassword`, so the first
  sign-in answers `next: password`, then `totp_setup`. Either way two factors are mandatory (decision 018), only the argon2id hash is stored,
  and the audit row (`added admin`) says `onboarding: chosen_password` or `temporary_password` and holds no password or hash. See the root
  `README.md`, "First run on a server".

## Staff access, merchants and sessions (feature 2a)

Scenarios `admin-team` and `ip-rules` (tests: `test/e2e/admin-team.e2e.test.ts` and `ip-rules.e2e.test.ts`). 27 routes, each a
contract under `contracts/`, a thin controller under `controllers/`, a use case under `application/` (one transaction, an audit row
for every write), queries under `infra/`, pure rules under `domain/`. Wired by `AccessAdminModule` (staff, roles, sessions, IP rules)
and `MerchantAdminModule` (merchants), both imported by `IdentityModule`. The detail of each route is `docs/contract/endpoints/identity.md`;
the lead's resolutions (`identity-platform-1` to `-7`, `-14`, `-15`) win over it.

| Routes | Permission | Use case |
|---|---|---|
| `GET /admin/staff`, `GET /admin/staff/:id` | `staff:read` | `StaffAdminService` |
| `POST /admin/staff` | `staff:create` | invite (link token) or temporary password; `201` |
| `PATCH /admin/staff/:id` | `staff:update` | name, email, role |
| `POST /admin/staff/:id/password` | `staff:update` | `{mode: reset_link \| temporary_password, revokeSessions}`; always `200`, `Cache-Control: no-store`, `{}` or `{temporaryPassword}` |
| `POST /admin/staff/:id/sessions/revoke`, `POST /admin/staff/:id/reset-2fa` | `staff:update` | `204` |
| `POST /admin/staff/:id/suspend`, `POST /admin/staff/:id/reactivate` | `staff:suspend` | `204` |
| `GET /admin/roles`, `GET /admin/roles/:id`, `GET /admin/permissions` | `roles:read` | `RoleAdminService`, `PermissionsCatalog` |
| `POST /admin/roles`, `PATCH /admin/roles/:id`, `DELETE /admin/roles/:id` | `roles:create`, `roles:update`, `roles:delete` | `409 ROLE_IN_USE` while any member holds the role |
| `GET /admin/sessions`, `DELETE /admin/sessions/:id` | `sessions:read`, `sessions:revoke` (and `clients:security` for a merchant's session) | `SessionAdminService` |
| `GET /admin/ip-rules`, `GET /admin/ip-rules/:id`, `POST /admin/ip-rules/check` | `access:read` | `IpRuleAdminService` |
| `POST /admin/ip-rules`, `DELETE /admin/ip-rules/:id`, `PUT /admin/access/restriction` | `access:create`, `access:delete`, `access:update` | |
| `GET /admin/clients`, `GET /admin/clients/:id` | `clients:read` (`wallet` and `stats` only with `wallet:read`) | `ClientAdminService` |
| `POST /admin/clients`, `PATCH /admin/clients/:id` | `clients:create` (and `wallet:credit_limit` for a credit limit above zero, `groups:update` for a group other than the default one), `clients:update` (and `clients:security` to suspend, decline or reactivate or to change the email, `groups:update` for a group move) | decisions 046 and 047 |

**Rules worth knowing**

- **Owner rules** (`assertOwnerTargetAllowed`, `owner.repository.ts`): an action on an account whose role grants `*`, or handing out such a role,
  needs `*`; nobody changes their own role (`409 CANNOT_CHANGE_OWN_ROLE` on `roleId`) or suspends themselves (`409 CANNOT_SUSPEND_SELF`); the
  last active Owner is never demoted, suspended or stripped of `*` (`409 LAST_OWNER`). The count of Owners runs under one advisory lock
  (`lockOwnerChanges`), so two Owners demoting or suspending each other at the same moment cannot both win. Every staff write re-reads the
  caller's account from `staff_users` (`ACCOUNT_SUSPENDED` at once), not the 60-second cached session view.
  **Privilege ceiling** (decision 046, `assertWithinCeiling`): role create, edit (current and new list) and delete, the role given to a new member
  or by a role change, and every action on another member's account (also `DELETE /admin/sessions/:id`) need the caller to hold each permission
  concerned (`403 FORBIDDEN`); only an Owner edits the role they hold (`409 CANNOT_CHANGE_OWN_ROLE` for everyone else).
  `GET /admin/sessions` masks the address and device (`•••`) of another member's session whose role the caller does not cover (an Owner's, for
  everyone but an Owner), and a merchant's email unless the caller holds `clients:read`; `DELETE /admin/sessions/:id` on a merchant's session also
  needs `clients:security` (decisions 046 and 047).
  **Money rules per person** (decision 049, `grantsPerPersonMoney`): the limits and the second-person rule of `wallet:adjust`,
  `wallet:credit_limit`, `payments:approve` and `invoices:create` count per staff account (`PER_PERSON_MONEY_PERMISSIONS`), so only an
  Owner adds a member whose role grants one of them, gives such a role to another member, sets a temporary password for another member
  whose role does, or changes that member's email (`403 FORBIDDEN`). Only an Owner adds one of them to a role that a member of any
  status holds (`RoleAdminService.update`, under the role's row lock that adding a member and a role change also take); a role nobody
  holds stays editable.
- **What a change does to sessions and caches:** a suspension, "end all sessions", a password reset with `revokeSessions` and a 2FA reset
  call `SessionService.revokeAllOf` (the caller keeps their own session when they reset their own 2FA); a rename or role change, and a
  reactivation, call `invalidateSubject`; a role change calls `RolePermissions.invalidate`, and a change of a role's permissions also calls
  `invalidateSubject` for each member, so their open streams end with `bye reauth` (a rename does not); a merchant status change calls
  `ApiKeyDirectory.invalidateClient`. All after the commit.
- **Staff links** (`StaffAuthTokens`): `POST /admin/staff` (invite) and `reset_link` issue an `auth_tokens` row (purpose `invite` while the member
  is `invited`, `reset` otherwise; hash only, one hour, only the newest link works). The link itself is built and mailed by the
  notifications feature (12a): until then the raw token is not delivered anywhere. A temporary password stores only its argon2id hash,
  forces a change, voids unused links and is shown once (never in the audit log). A change of the member's email voids their unused links
  in the same transaction (they were mailed to the old address); a queued mail of such a link is then skipped and staff send a new one.
- **One live-session rule** (`liveSessionCondition`, `security/session.repository.ts`, resolution `identity-platform-6`): not revoked, not past
  `expires_at`, and (for a full session) used within the idle limit of its subject type. `GET /admin/sessions` (staff and merchant sessions at
  stage `active` only), `StaffMember.activeSessions` and the `404` of `DELETE /admin/sessions/:id` all use it, with the clock's time as a
  parameter (decision 031).
- **IP rules:** `cidr` is normalised on write (a single address is stored as `/32` or `/128`, a range with bits after the prefix is `422`, a
  range wider than /16 or /48 is `422`) and read back without `/32` and `/128`. An allow rule is always for the `admin` scope. A block needs a
  `reason`. A live rule with the same network and kind (and scope, for blocks) is refused. `409 SELF_LOCKOUT` when a block of `admin` or `all`
  covers the caller's request address, or when a removal would take away the only live allow rule that lets the caller in while the restriction
  is on; `409 IP_NOT_IN_ALLOWLIST` when turning the restriction on without a live allow rule for the caller. Every change runs under one advisory
  lock and calls `IpRuleCache.invalidate()` after the commit. `POST /admin/ip-rules/check` calls `decideIpAccess`, counts no hit and writes no audit row.
  A staff member who is not an Owner cannot make a change that would turn an address an active Owner uses (live Owner sessions, active Owners'
  last sign-in address) from allowed to refused for the console (`403 FORBIDDEN`, decision 046). `shutOutNowOrLater` judges the change as things are and at
  each later moment a rule of either state runs out: an Owner's address may not be refused at any moment at which it would have been allowed
  without the change.
- **Merchants:** `POST /admin/clients` inserts the merchant as `pending` with a generated Dhru username and referral code, opens the wallet and
  hold accounts through `MerchantAccounts.open` (`overdraft_limit` = credit limit; user rule 2: credit above zero on a group without
  `overdraft_allowed` is `422` on `creditLimit`), issues the one-hour invite token (`auth_tokens`, purpose `invite`, subject type `client`, hash only)
  and writes the outbox event `merchant.invited` (`{ tokenId }`, through `MerchantMailOutbox`, see "Merchant mail"), all in one
  transaction. `PATCH` does one action per call: approve
  (`pending → active`), suspend (`active → suspended`, a reason of 3 to 140 characters, sessions ended), reactivate (`suspended → active`), or a
  group move (`422` on `groupId` for an unknown group, the storefront retail group, the same group, or a group without credit while the
  wallet's limit is above zero). Any other status change is `409 INVALID_TRANSITION`. A credit limit above zero at invitation also needs
  `wallet:credit_limit`, and a `groupId` other than the default group's `groups:update` (no `groupId`, or the default group's id, needs only
  `clients:create`; checked after the group is found and before anything is written); suspending, declining and reactivating also need
  `clients:security`, a group move `groups:update` (decision 046).
- **Times the API returns or decides on come from the clock** (decision 031): `createdAt` of staff, IP rules, merchants, sessions and
  invite/reset tokens is written by the service, not by the column default.

**Seed** (`scripts/seed/identity.ts`): the 6 roles, 6 staff, the IP rules, the 4 demo client groups (ids 1 to 4 as the frontend mock; the
catalog feature's seeder takes them over) and the 20 demo merchants (`m3` is id 3, referral code `GSM0003`, username the name's slug,
group, status and referrer as the mock, no password). Their wallets are feature 3's seed. Open point for that seed: the frontend mock gives
the Standard group `overdraft_allowed = false` but its merchants a credit limit above zero, which user rule 2 forbids.

## Merchant portal sign-in (2b): `/client/*`

Fifteen routes (`contracts/merchant-auth.contracts.ts`, `contracts/merchant-account.contracts.ts`, controllers `merchant-auth.controller.ts`
and `merchant-account.controller.ts`; use cases in `application/merchant-*.ts`, queries in `infra/merchant-*.repository.ts`, pure rules in
`domain/merchant-*.ts`), wired by `MerchantAuthModule`. No console screen calls them (the portal is another frontend): the specs are
MISMATCHES B121 to B136 and ALIGNMENT § 7. Session cookie `gsm_client_session`, CSRF cookie `csrf_token_client` and the
`X-CSRF-Token` header, like the staff routes.

| Route | Access | What it does |
|---|---|---|
| `POST /client/auth/register` | public (Origin check; Turnstile while `TURNSTILE_MERCHANT_AUTH` is on, the default in production) | the form → `204`, the same for a new and a known email. A new email creates a `pending` merchant in the `is_default` group, opens its wallet and hold (`MerchantAccounts.open`, credit limit 0), a `verify_email` link and the event `merchant.email_verification`, in one transaction |
| `POST /client/auth/verify-email` | public | `{ token }` → `204`; sets `email_verified_at`, uses the link; the status stays `pending`; signs nobody in |
| `POST /client/auth/login` | public (Turnstile while `TURNSTILE_MERCHANT_AUTH` is on, the default in production) | email + password → `{ next: 'totp' \| 'done' }`; a `pending_totp` session (10 min) when 2FA is on, an `active` one otherwise; a pending merchant signs in; the session opens in a transaction that reads the merchant again under its row lock (`lockClientForSignIn`) and requires the account as it was when the password was checked (the same password, by its `password_changed_at`, which a hash upgrade keeps; the same 2FA and forced-change state; not suspended; `signInStillHolds`), else the same `401` as a wrong password |
| `POST /client/auth/2fa` | session, `pending_totp` | six digits → `204`; rotates the session to `active` |
| `POST /client/auth/logout` | session, `pending_totp` or `active` | revokes the session, clears both cookies, `204` |
| `POST /client/auth/password/forgot` | public (Turnstile while `TURNSTILE_MERCHANT_AUTH` is on, the default in production) | `{ email }` → `204` for any email; a merchant that is not suspended (also one waiting for approval without a password) gets a `reset` link and the event `merchant.password_reset`, at most five an hour; the earlier links keep working (at most three) |
| `POST /client/auth/password/reset` | public | `{ token, password }` with a `reset` or `invite` link → `204`; sets the password, uses the link, ends every session, signs nobody in; an invitation also sets `email_verified_at` and voids the merchant's verification link; on a merchant whose email was not verified before, it also turns two-factor sign-in off (decision 052); clears `password_set_by_staff` (not `email_set_by_staff`) |
| `GET /client/auth/me` | session, `active` | `Me`: id, username, email, name, company, phone, country, status, kycStatus, emailVerifiedAt, twofaEnabled, referralCode, group, createdAt; `no-store`; repeats `X-CSRF-Token` |
| `PATCH /client/profile` | session | name, company, phone, country (partial) → `Me` |
| `POST /client/security/password` | session | `{ currentPassword, newPassword }` → `204`; ends the other sessions |
| `POST /client/security/2fa/setup` | session | a pending secret (encrypted, `twofa_enabled` stays false) → `{ secret, otpauthUrl, qrSvg }`; `409 TWOFA_ALREADY_ENABLED` once on; `409 CONFLICT` while the email is not confirmed |
| `POST /client/security/2fa/enable` | session | `{ code }` confirms the pending secret → `204`; ends the other sessions; `409 CONFLICT` while the email is not confirmed |
| `POST /client/security/2fa/disable` | session | `{ code }` → `204`; forgets the secret, ends the other sessions; `409 TWOFA_NOT_ENABLED` |
| `GET /client/sessions` | session | the caller's live `active` sessions, newest first, `current` marked, simple-rest range and `x-total-count` |
| `DELETE /client/sessions/:id` | session | `204`; `404 NOT_FOUND` for a session that is not the caller's, unknown or no longer live; ending the current one clears the cookies |

**Rules worth knowing**

- **No enumeration.** `register` and `password/forgot` answer `204` whatever the email; `register` always hashes the password, and
  both run the same statements for every email (decision 052: `DbService.runOrDiscard`; `forgot` writes for `NO_ACCOUNT_ID` and a known
  email's `register` runs on a placeholder address, and the transaction is rolled back at its end when nothing may be kept). Both are
  counted per network (`register`) or email + network (`forgot`) by the `sign-in` limiter, known email or not; `forgot` also spends one
  point of the merchant's `account-mail` budget (kind `forgot_password`, five an hour; beyond it nothing is sent). `login` is one `401` for an unknown email, a wrong password and a merchant with no password yet
  (each verifies one argon2 hash); `403 ACCOUNT_SUSPENDED` only follows a correct password.
- **A wrong current password or code is `422` on its field (`currentPassword`, `code`), never `401`**, which would sign the caller
  out (B121). `WEAK_PASSWORD` names `password` (register, reset) or `newPassword` (change).
- **Rate limits** (`MerchantSignInLimiter`, keys are `HMAC(TOKEN_PEPPER, ...)` hashes under the prefix `merchant-sign-in`, so
  counters do not mix with the staff ones): login per email + network; registration per network; forgot per email + network;
  codes (sign-in, enable, disable; limiter `sign-in-code`, never counted in process memory), 2FA setups and password changes **per account**; emailed links (`verify-email`, `password/reset`)
  by the `token` limiter per address. The per-IP limit of the pipeline covers the public routes first.
- **The sign-in code step closes after twenty wrong codes within 24 hours**, the staff rule (`CodeStepLock`, columns
  `clients.totp_failures`, `totp_failures_since` and `totp_locked_at`, audit row `locked the authenticator step of` with entity
  `merchant`): from then on `POST /client/auth/2fa` answers `429 RATE_LIMITED` to every code until the 24 hours from the first counted
  wrong code end (`Retry-After`), or sooner until a new password is set by a reset or invitation link or by a temporary password from
  staff, or staff reset two-factor sign-in (`POST /admin/clients/:id/reset-2fa`); the merchant's own or forced change leaves it closed. The enable and disable codes of a signed-in
  merchant are not counted.
- **Links** (`auth_tokens`, purposes `verify_email`, `reset`, `invite`; `MerchantAuthTokens`): 256 random bits, only the keyed hash
  stored, one hour, one use. A newer `reset` or `invite` voids the older ones, except a `reset` the visitor asked for on `forgot`, which
  keeps the two newest unused ones (at most three work at once, decision 052); a newer `verify_email` voids the older one. Unknown,
  used, expired, superseded and suspended-merchant links are all `410 TOKEN_INVALID`. A weak password does not use the link up.
  Changing the password voids open `reset` and `invite` links.
- **Two-step sign-in needs a confirmed email address** (decision 052; `MerchantTwoFactorService`): `2fa/setup` and `2fa/enable` answer
  `409 CONFLICT` ("Confirm your email address first; two-step sign-in can be switched on after that.") while `clients.email_verified_at`
  is empty; nothing is stored and no secret is made. The row is read under its lock (`lockClientById`) in the transaction that writes, so
  a change landing at the same time cannot slip in between. Switching it off and using it at sign-in do not depend on the address; a
  reset or invitation link keeps turning it off on an unconfirmed merchant (rows from before the rule). An address that nobody confirmed
  therefore never carries a second step.
- **TOTP.** The same `TotpService` as staff (SHA-1, 6 digits, 30 s, ±1 step) with the encryption context `CLIENT_TOTP_AAD`. A code
  is accepted only if its time step is newer than `clients.totp_last_step`, written by a guarded `UPDATE` (so a code works once
  even in parallel). Migration `0004` adds `clients.twofa_enabled`, `totp_last_step` and `password_changed_at` (MISMATCHES B116).
  Enabling or disabling 2FA, changing the password and resetting it end the merchant's other sessions; `ApiKeyDirectory` is not
  affected.
- **The database decides.** The code, password, 2FA, `me` and profile steps read the merchant from `clients`, not from the cached
  session view: a suspension applies at once (`403`, every session of the merchant revoked).
- **Live sessions.** `GET /client/sessions` and `DELETE /client/sessions/:id` use the live rule of identity-platform-6 (not revoked,
  not past `expires_at`, used within `sessions.client_idle_minutes`), implemented in `infra/merchant-sessions.repository.ts`
  (the same rule as 2a's `liveSessionCondition` in `security/session.repository.ts`).
- **Audit.** Merchant routes write no `audit_logs` rows (the audit log records staff writes, and `AUDIT_ENTITY_TYPES` has no
  merchant security type yet); failed attempts are logged without the email.

### Smart sign-in, the merchant side (feature 24A)

`POST /client/auth/sign-in` (one form for merchants and customers) is hosted by the customers module, which may import identity (not
the reverse, decision 032). Identity gives it one narrow class, `MerchantPasswordSignIn` (`application/merchant-password-sign-in.ts`,
provided and exported by `MerchantAuthModule`, exported from `index.ts`): `charge` / `reset` spend and clear the same `sign-in`
counter as `POST /client/auth/login` (one budget per email and network for both routes); `find(email)` returns a `MerchantCandidate`
whose `shadowsCustomer` says whether it takes precedence over a customer with the same email (only when its email is verified,
decision 052), whose `verify(password)` runs one argon2 verify against the stored hash (a temporary password older than 72 hours
answers false) and whose `open(meta, staleToken?)` (only after a verified
password) calls `MerchantSignInService.startSession` (suspension, stale merchant session, feature 20's step `password | totp | done`)
with the hash upgrade of the proven password (`upgradedClientPasswordHash`, `application/merchant-password-hash.ts`, shared
with `login`: hashed before the session's transaction, written in it only over the hash that was verified). The hash never leaves identity. `POST /client/auth/login` shares the shop lock of the email with this route and the
store login (`SignInLock`, scope `shop`).

### Sign-in lock (decision 052)

`SignInLockModule` (`sign-in-lock.module.ts`, imported by `StaffAuthModule`, `MerchantAuthModule`, `AccessAdminModule`,
`MerchantAdminModule` and the customers module) provides `SignInLock` (`application/sign-in-lock.ts`) on top of `SignInFailures`
(`infra/sign-in-failures.ts`). Failed password sign-ins are counted per email in two scopes, `staff` (the console) and `shop` (merchant
login, store login and the one sign-in form share one count), whether or not an account has the email. `assertMayTry(scope, email,
account, meta)` counts the attempt before the password is checked (`SignInFailures.charge`: one `MULTI` that raises the count, renews
the TTL and reads the lock, so parallel attempts each see their own count) and refuses it (`429 RATE_LIMITED`, `Retry-After` = the time
left) while the email is locked, or when it is the first attempt beyond ten failures, which starts the 15-minute lock and the count again
(`domain/sign-in-lock.ts`), unless the request's network (an IPv4 /24 or an IPv6 /64, `signInNetworkKey`) is one of the networks of the
50 newest full (`active`) sessions of the account being signed into (`fullSignInAddresses`); it reads the sessions whenever the email is
locked, with an id no account has when there is no account, so a locked email answers alike for every email. The attempts a familiar network is still allowed while the lock runs share one budget per scope, email and network:
`takeFamiliarPoint` takes one point of the limiter `sign-in-familiar` (5 in 15 minutes; the key is a keyed hash of scope, email and network
key, `gsm:{env}:ratelimit:sign-in-familiar:{hash}`), and the sixth attempt is refused like any other one on a locked email, before its password
is checked; nothing of this runs while no lock runs. A refused attempt's count goes back while a lock runs. Every `401` stays counted; `giveBack` (a Lua script, never below 0) takes back the attempt of a correct
password, before a `403` too, and never the failures of other attempts: the two shop accounts of one email may belong to two people (a
merchant registration proves no mailbox). `clear` (after the commit of a new password from a link, a staff member's own or forced
change, a customer's own change, a temporary password set by staff, a staff-created customer account, an anonymisation) deletes count and
lock; a merchant's own or forced change does not. The state is the hash `gsm:{env}:identity:sign-in-failures:{hash}` (fields `n`, `until`; the hash is keyed on the scope and
the email) on the cache Redis; while it cannot be reached each process counts in memory.

### Merchant mail

An email is outbox work (decision 020): the use case writes `merchant.email_verification`, `merchant.password_reset` (and feature 2a
`merchant.invited`) in its transaction with `MerchantMailOutbox.enqueue`; the payload is `{ tokenId }` and the aggregate the
merchant, never the token or the address. The events map to the `notifications` queue; `MerchantMailModule` (loaded by the API
and by the worker) registers them and provides one named processor per type (`jobs/merchant-mail.processors.ts`) that runs
`MerchantMailJobs.handle` (feature 12a made the mail real, decision 033): it re-reads the merchant and the link and skips what is no
longer worth sending (a suspended or deleted merchant, a link that was used, replaced or has expired, a mail that already went out); a missing
or switched-off template does not stop the mail, the shipped text is sent (decision 047). The request makes a placeholder token that nobody receives (the clear value is not kept
anywhere); **the job rotates it**: it puts a new random token's hash on the same `auth_tokens` row (same id, same expiry, only while the
row is unused and unexpired) and sends the link `<PORTAL_BASE_URL>/set-password?token=<token>` (or `/verify-email`) through the platform's
`NotificationService.sendNow`, with the clear link as a *secret* placeholder that is never stored or logged. The `notifications` row
(`outbox-<event id>:email`) logs the mail without the link; a retry of the job rotates again and resends (the earlier value never
arrived), and a repeat after a delivered mail is skipped before it can spoil the link that arrived. In development the mail lands in
Mailpit (`http://localhost:8025`); the old "link in the log" convenience is gone, because a link is a credential.

### Notification settings and Telegram (feature 12a)

Four routes (contracts `contracts/merchant-notifications.contracts.ts`; controller `controllers/merchant-notifications.controller.ts`; use cases
`application/merchant-notification-settings.service.ts` and `application/telegram-linking.service.ts`; queries `infra/merchant-notification.repository.ts`;
the webhook secret `application/telegram-webhook-secret.ts`; module `merchant-notifications.module.ts`). They live here because they need
`CurrentMerchant` and the merchant's own columns (`notification_prefs`, `telegram_chat_id`); the delivery path itself is the platform's. Spec:
MISMATCHES B165.

| Route | Access | What it does |
|---|---|---|
| `GET /client/notification-preferences` | merchant session | `{ email: { address }, telegram: { linked }, lowBalanceThreshold (money or null), events: [{ event, label, email, telegram }] }`: the non-transactional merchant events of the platform's registry; never saved reads as email on, Telegram off (the order results stay off until chosen) |
| `PUT /client/notification-preferences` | merchant session | `{ lowBalanceThreshold?, events }` replaces the listed events, keeps the others and the keys it does not know; `422` on `events.N.event` (unknown, always-sent or repeated), on `events.N.telegram` ("Link Telegram first."; sending back the value the GET showed is accepted, so the announcements' default Telegram on saves without a chat) and on `lowBalanceThreshold` (negative or malformed); answers the GET body; the row is locked, so it takes turns with a Telegram link |
| `POST /client/telegram/link` | merchant session | `201 { url: 'https://t.me/<bot>?start=<token>', expiresAt }`, `Cache-Control: no-store`: a single-use `telegram_link` token (hash only, 15 minutes); a new call voids the previous link; `503 UNAVAILABLE` without `TELEGRAM_BOT_USERNAME` |
| `POST /webhooks/telegram/:secret` | url-secret | the path segment and `X-Telegram-Bot-Api-Secret-Token` carry two different values derived from `TELEGRAM_WEBHOOK_SECRET` (decision 054; `scripts/telegram-webhook.ts` registers both), compared in constant time, else `404`; always `200 {}`; a private-chat `/start <token>` with a live token links the chat (a chat of another merchant moves, that merchant's Telegram switches go off) and the bot answers "Linked to <merchant name>."; `/stop` unlinks the chat, turns the merchant's Telegram events off and the bot says so; anything else is ignored; a repeated `update_id` is processed once (the answer's dedupe key is `telegram-update-<id>`) |

The merchant portal writes no audit rows (B121). The link token is the platform's delivery of one more purpose of `auth_tokens` (`telegram_link`, migration
0009); `clients.telegram_chat_id` is unique (one chat, one merchant). The webhook is exempt from the refusal of U+0000 and unpaired surrogates by the validation guard (a `422` would make Telegram
re-send the update and hold back the later ones, decision 053); it stores no text of the update (the token and the chat id must match fixed patterns, the update id a safe integer),
so a character the pattern does not accept is just an update to ignore.

### Merchant management (feature 20; plan `docs/briefs/20-merchant-management.md`)

Staff tools, merchant sign-in changes, the staff link mails and staff-made API keys, all inside this module.

- **Row.** `ClientViews` (`application/client-views.ts`) builds the console's merchant row for the list, `GET /admin/clients/:id` and every
  change. New keys are optional in the schema and always sent: `address`, `taxId`, `internalNotes`, `telegramLinked`, `security`
  (`hasPassword`, `mustChangePassword`, `passwordChangedAt`, `twofaEnabled`, `lastLoginAt`, `lastLoginIp`, `activeSessions`, `linkSentAt`,
  `verificationSentAt`) and `suspension` (`at`, `reason`, `by`). A merchant has no language (decision 039): every merchant mail
  is English.
- **Edit details** (`PATCH /admin/clients/:id`, a third kind of change next to status and group; `domain/client-details.ts`,
  `ClientDetailsEditor`). An email change also needs `clients:security` (decision 047; checked before the limiter and again on the locked row), clears
  `email_verified_at`, uses every open link up, ends every session of the merchant, sends a security notice (`merchant.security_notice`, kind `email_changed`)
  to the address before the change, sends a verification (or the invitation while there is no password) to the new address, drops the session and API key cache
  keys, sets `email_set_by_staff` (the hold of machine credentials below), and counts on the `account-mail` limiter. A name change keeps the sessions.
- **Security tools** (`ClientSecurityAdminService`, permission `clients:security`): `POST /admin/clients/:id/password` (`reset_link` mails
  an invitation or reset link, `temporary_password` shows a 14-character password once and sets `must_change_password` and
  `password_set_by_staff`),
  `POST /admin/clients/:id/reset-2fa`, `POST /admin/clients/:id/sessions/revoke`, `POST /admin/clients/:id/verify-email/resend`. Each locks the
  `clients` row first, writes one audit row under the merchant (`credential`, never `password`) and returns no link: the outbox carries ids, the mail job rotates the token.
- **Forced password change.** `nextMerchantStep` (`domain/merchant-sign-in-step.ts`) decides password, then code, then done;
  `MerchantSignInService.startSession` opens the session of that step after any proven password (the portal's login, and the smart sign-in
  of feature 24A later). A merchant with `must_change_password` gets `next: 'password'` and a `pending_password` session that only
  `POST /client/auth/password/change` and logout accept; the change rotates the session (no fixation), ends the other sessions and voids password links.
  Every chosen password (reset link, invitation, security page) clears the flag.
- **Machine credentials after a staff-set password** (`MachineCredentialHold`, decision 046). `password_set_by_staff` is set with a temporary
  password and cleared only by a password from a link mailed to the merchant's address (reset or invitation; the forced change and the
  security page do not clear it). While it is set, `POST /client/api-keys`, `POST /client/webhooks` and `PATCH /client/webhooks/:id` answer
  `403 FORBIDDEN` with a sentence that sends the merchant to "Forgot password"; signing in and the rest of the portal work. The check reads
  the account and then the caller's session row (the link that clears the flag ends every session in the same commit). A staff change
  of the email address sets `email_set_by_staff`, with the same hold and its own sentence (contact support); a password from a link does
  not clear it, because the link goes to the address staff chose.
- **Verification resend.** `POST /client/auth/verify-email/resend` (merchant session) and the staff action share the `account-mail` counter
  (5 an hour per merchant and kind); there is no public route. `verify-email` answers `410` for a suspended merchant.
- **Suspension.** Voids every open link, accepts `pending -> suspended` (this is how an application is declined), and mails the merchant
  (without the staff reason). API keys are refused while suspended and work again after reactivation.
- **Lifecycle mails** (`MerchantLifecycleMails`): `merchant.approved`, `merchant.suspended`, `merchant.reactivated`, `merchant.kyc_approved`,
  `merchant.kyc_rejected`, `merchant.security_notice` are transactional, registered at boot by `IdentityMailEventsModule`, with English
  default templates (`application/mail/identity-templates.ts` keeps the text; `drizzle/0025_merchant_management_templates.sql` shipped it, and a spec finds
  every default row of the code in the applied file). The module also registers those shipped texts with the event registry
  (`registerBuiltInTemplates`), the fallback of the security emails (decision 047). The security notice has five kinds, each one fixed sentence
  (`SECURITY_NOTICE_PHRASES`): `temporary_password`, `twofa_reset`, `api_key_created`, `api_key_changed` and `email_changed`; the `email_changed` notice names the address
  it goes to (`to`: the address before the change), because the merchant's current address is the new one. The event is flagged `security` and `namedAddress`
  in the registry, and `staff.invited` and `staff.password_reset` are flagged `security` and `secretLink`.
  KYC decisions and the end of one merchant session are audited under `merchant`.
- **Staff link mails** (`StaffMailModule`, loaded by the API through `AccessAdminModule` and by the worker): `POST /admin/staff` (onboarding `invite`) and
  `POST /admin/staff/:id/password` (`reset_link`) write `staff.invited` (while the member is `invited`) or `staff.password_reset` with `StaffMailOutbox.enqueue`
  (payload `{ tokenId }`, aggregate `staff_users`). `StaffMailJobs` does what `MerchantMailJobs` does for merchants: re-reads the member and the link,
  skips a suspended or deleted member and a used, replaced or expired link (a missing or switched-off template does not stop the mail: the shipped text is sent,
  decision 047), rotates the token on the same row and sends
  `<CONSOLE_BASE_URL>/set-password?token=<token>` as a secret that is never stored or logged. The link request counts on the `account-mail` limiter
  (five an hour per member, `429`); the temporary-password mode sends no mail.
- **API keys by staff** (`ApiKeyAdminService`, `ApiKeyIssuer`): `POST /admin/clients/:id/api-keys` (`api_keys:create`; active merchants only, `409 NOT_ACTIVE`
  otherwise; the key shown once with `no-store`, `api_keys.created_by` = the staff member, a `merchant.security_notice` mail, an audit row without the key) and
  `PATCH /admin/api-keys/:id` (`api_keys:update`; per-minute limit 1-6000 and allowed addresses; drops the cached view of the key; a change that gives the key
  more reach, meaning an empty address list, an address that is not stored or a higher limit, is kept for Owners (`classifyKeyChange`, judged on the locked row,
  decision 046); a change of a value mails the merchant the `api_key_changed` notice). `createdByStaff` is on every key row.
  Lock order: the merchant's `api-keys:<id>` advisory lock, then the `clients` row (the merchant's own creation takes the advisory lock and then a shared lock on the
  merchant row for the foreign key of the insert, so the reverse order would deadlock). Creating a key from the console is kept for Owners (decision 046).

### What happens when an account changes

| Change | Sessions | Open links | Caches | Mail |
|---|---|---|---|---|
| Staff set a temporary password (`revokeSessions` on by default in the console) | ended when asked | all password links voided | session views dropped | `merchant.security_notice` |
| Staff send a reset or invitation link | kept (or ended when asked) | the newer link voids the older | none | the link mail (rotated in the job) |
| Staff reset 2FA | all ended | none | session views dropped | `merchant.security_notice` |
| Staff change the email (needs `clients:security`) | all ended | every open link voided | session and API key views dropped | `merchant.security_notice` to the address before the change; verification (or invitation) to the new address |
| Suspension | all ended | every open link voided | session and API key views dropped | `merchant.suspended` (no reason) |
| Reactivation | none (already ended) | none | API key views dropped | `merchant.reactivated` |
| Approval | none | none | none | `merchant.approved` |
| KYC decision | none | none | none | `merchant.kyc_approved` / `merchant.kyc_rejected` |
| Staff create a key | none | none | none | `merchant.security_notice` |
| The merchant creates a key in the portal | none | none | none | `merchant.security_notice` (the same notice) |
| Staff edit a key's limits or revoke it | none | none | that key's view dropped | none |
| The merchant chooses a password (change, reset, invitation) | the others ended, this one rotated | password links voided | session views dropped | none |

### Notification center audiences (feature 23)

`notifications/` holds the staff and merchant audience providers of the platform's notification center (`StaffAudience`,
`MerchantAudience`), registered with `NotificationAudiences` by `IdentityAudienceModule` at boot (imported by `IdentityModule` and the
worker). Staff: active members, optionally of some roles. Merchants: by status (default active; a listed merchant may be pending),
group and country, never suspended; their email and Telegram flags are the SQL twin of `choiceFor` for `broadcast.announcement`
(a Telegram message also needs a linked chat). Merchants and staff read English. The providers only read `staff_users` and `clients`.

### Live event streams and session doorbells (feature 27)

Three routes beyond the map (`scripts/map-additions/27.mjs`; decisions 035 and 037; plan `docs/briefs/27-realtime-notifications.md`)
answer `text/event-stream` to the signed-in person, so a notification appears at once. The routes live here because identity owns
sessions, principals and the guard; the layer itself (hub, publisher, registry, wire format) is `src/infra/realtime` (see its
README) and the inbox is its first source (platform). Code: `realtime/` (`stream.contracts.ts`, `stream.controller.ts`,
`stream-viewer.ts`, `stream.module.ts` = `StreamRoutesModule`).

- **Thin controller.** The session guard authenticates the request like any other (stage, account state, IP rules, and `originCheck`:
  `Sec-Fetch-Site: same-origin` or an `Origin` of the surface's audience, else `403 CSRF_FAILED`); the handler maps the principal to a `StreamViewer`
  (`streamViewerOf`: staff, merchant as `client`, customer; an API-key, capability or webhook principal is `401`) and the caps
  `session:<id>` (`REALTIME_MAX_PER_SESSION`) and `ip:<address>` (`REALTIME_MAX_PER_IP`) (`streamCapsOf`), then calls `RealtimeHub.open`.
  The hub refuses (problem+json, before the stream starts) or hijacks the reply and streams. `GET /client/stream` uses
  `pendingMerchant: 'allow'`: a merchant waiting for approval has an inbox too; a suspended one is `ACCOUNT_SUSPENDED`.
- **Events and refusals:** `docs/contract/realtime-events.md`.
- **Session doorbells.** `SessionService` rings the hub after the commit, ids only (topic `session`, never a source): `revoke`,
  `revokeAllOf` and `rotate` (the old row) ring `ended` with the session ids (500 per message), so the streams of those sessions get
  `bye session_ended` and close at once; `invalidateSubject` (suspension, password or role change, a change of the permissions of a role for each of its members, a staff edit of a merchant) rings
  `subject` with the subject type and id when the account has live sessions, so its streams get `bye reauth`, reconnect, and the guard
  answers 401 or 403 for a suspended account (which stops the browser's `EventSource`). Beside the cache `forget`, after the commit
  (`afterCommit` and `onCommit`), through `RealtimePublisher.publishOnCommit`; a failed publish never fails the use case. A stream
  also ends by itself every 15 minutes (`bye max_age`), so the idle and absolute expiry of a session, IP rules and a changed role
  apply to an open stream.
- **No new table, migration, permission or error code** (`RATE_LIMITED`, `UNAVAILABLE` and `CSRF_FAILED` are in the catalog); the
  limiter `stream-connect` (20 a minute per session) is in `src/infra/rate-limit/limiters.ts`.

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

70 endpoints (admin 45, client 24, store 1; the map has 59: feature 20 adds 8 routes beyond it and feature 27 adds the 3 live event streams). Source: `docs/slices/identity.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built; the staff sign-in (6) and the 15 merchant portal routes of stage 2 (2b) are built.

### Admin console (44)

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
| `PATCH /admin/api-keys/:id` | staff-permission · `api_keys:update` | Change a merchant key's per-minute limit and allowed addresses (feature 20). | 7 |
| `PATCH /admin/roles/:id` | staff-permission · `roles:*` | Roles and their permissions. | 2 |
| `PATCH /admin/staff/:id` | staff-permission · `staff:*` | Staff members: add by invitation or temporary password, set the role, and edit details. | 2 |
| `POST /admin/auth/2fa` | public | Complete the sign-in with a TOTP code. | 2 |
| `POST /admin/auth/2fa/setup` | public | First sign-in: the TOTP secret with a QR code. | 2 |
| `POST /admin/auth/login` | public | Sign in with email and password; a TOTP step follows. | 2 |
| `POST /admin/auth/logout` | staff-session | Sign out. | 2 |
| `POST /admin/auth/password/set` | public | An invited or recovering staff member chooses their own password with a one-time token. | 2 |
| `POST /admin/clients` | staff-permission · `clients:*` | Merchants: creation, group, status and blocking. | 2 |
| `POST /admin/clients/:id/password` | staff-permission · `clients:security` | Send a merchant a set-password or invitation link, or set a temporary password that must be changed at the next sign-in (feature 20). | 20 |
| `POST /admin/clients/:id/reset-2fa` | staff-permission · `clients:security` | Turn off a merchant's two-factor sign-in and end their sessions (feature 20). | 20 |
| `POST /admin/clients/:id/sessions/revoke` | staff-permission · `clients:security` | Sign a merchant out of every device (feature 20). | 20 |
| `POST /admin/clients/:id/verify-email/resend` | staff-permission · `clients:security` | Send the merchant a new email verification link (feature 20). | 20 |
| `POST /admin/clients/:id/api-keys` | staff-permission · `api_keys:create` | Create an API key for a merchant; the key is shown once (feature 20). | 7 |
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
| `PATCH /client/profile` | merchant-session | Update name, company, phone, country, address and tax id. | 2 |
| `POST /client/api-keys` | merchant-session | New API key, shown once, with allowed IPs. | 7 |
| `POST /client/auth/2fa` | public | Complete the sign-in with a TOTP code. | 2 |
| `POST /client/auth/login` | public | Sign in; asks for a 2FA code when 2FA is enabled. | 2 |
| `POST /client/auth/logout` | merchant-session | Sign out and end the session. | 2 |
| `POST /client/auth/password/change` | merchant-session (`pending_password`) | Replace a temporary password during sign-in (feature 20). | 20 |
| `POST /client/auth/password/forgot` | public | Send a password reset link. | 2 |
| `POST /client/auth/password/reset` | public | Set a new password with the reset token. | 2 |
| `POST /client/auth/register` | public | Register a new merchant and send the verification email. | 2 |
| `POST /client/auth/verify-email` | public | Verify the email with the token. | 2 |
| `POST /client/auth/verify-email/resend` | merchant-session | Send the signed-in merchant a new verification link (feature 20). | 20 |
| `POST /client/kyc` | merchant-session | Upload verification documents. | 8 |
| `POST /client/security/2fa/disable` | merchant-session | Disable 2FA with a code. | 2 |
| `POST /client/security/2fa/enable` | merchant-session | Enable 2FA after confirming a code. | 2 |
| `POST /client/security/2fa/setup` | merchant-session | A new TOTP secret with a QR code. | 2 |
| `POST /client/security/password` | merchant-session | Change the password. | 2 |

### Live event streams (3, beyond the map: feature 27)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /admin/stream` | staff-session | The staff member's live event stream (server-sent events). | 27 |
| `GET /client/stream` | merchant-session (`pendingMerchant: 'allow'`) | The merchant's live event stream (server-sent events). | 27 |
| `GET /store/v1/me/stream` | customer-session | The customer's live event stream (server-sent events). | 27 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/e2e/`).

- `success`: Order completed by the supplier (tables: `api_keys`)
- `reject`: Supplier rejects the order (tables: `api_keys`)
- `manual`: Manual fulfilment by staff (tables: `api_keys`)
- `timeout`: Supplier timeout (the order needs attention) (tables: `api_keys`)
- `b2c-account`: Managing a storefront customer account (tables: `auth_tokens`, `sessions`)
- `admin-team`: Adding and suspending a staff member (tables: `auth_tokens`, `ip_rules`, `roles`, `sessions`, `staff_users`)
- `ip-rules`: IP block list and allowlist (tables: `ip_rules`, `sessions`)

End-to-end tests: `test/e2e/admin-team.e2e.test.ts` (steps 1 to 9) and `test/e2e/ip-rules.e2e.test.ts` (steps 1 to 9; step 7, the risk engine's automatic block, is a row written the way feature 18 will write it). Route tests: `test/integration/{staff-admin,roles-admin,sessions-admin,ip-rules-admin,clients-admin}.test.ts`.

## Permissions

Feature 20 adds `clients:security` (password links, temporary password, 2FA reset, end all sessions, verification resend) and, in slice D, `api_keys:create` and `api_keys:update`; a role that holds `clients:*` or `api_keys:*` receives them through the grammar.

Staff permissions the map requires on this module's admin routes: `access:*`, `access:read`, `access:update`, `api_keys:read`, `api_keys:revoke`, `clients:*`, `kyc:decide`, `kyc:read`, `roles:*`, `roles:read`, `sessions:read`, `sessions:revoke`, `staff:*`, `staff:suspend`, `staff:update`.

The contracts of feature 2a name the concrete permissions: `access:read|create|update|delete`, `clients:read|create|update`, `roles:read|create|update|delete`, `sessions:read|revoke`, `staff:read|create|update|suspend` (a role may hold `area:*` for each area).

Keep this list in step with the contracts (`permission` of each `defineRoute`).

### Permissions that reach owner-level power (decision 046)

The server keeps every staff member inside their own permissions (the privilege ceiling) and keeps a few actions for Owners: a payment
method's secrets and automatic methods, API keys made for a merchant from the console, and IP rule changes that would shut out an
Owner. Some permissions still let one person move money or act for other accounts on their own. Give them only to people you trust as
you trust an Owner, and remember that an area wildcard (`wallet:*`, `clients:*`, `payments:*`, ...) includes every permission of its
area:

- money: `wallet:adjust`, `wallet:credit_limit`, `payments:approve`, `invoices:create`, `refunds:approve`, `commissions:approve`, `orders:reopen`;
- other people's accounts: `clients:security`, `clients:update`, `customers:password`, `customers:update`, `staff:create`, `staff:update`,
  `roles:create`, `roles:update` (the last four only up to the holder's own permissions); `clients:security` and `customers:password` also guard the change of
  an account's email address (and `customers:password` the creation of an account with a temporary password), because the address is where the account's
  sign-in and password links go (decision 047);
- who reaches the console: `access:create`, `access:update`, `access:delete`, `sessions:revoke`;
- personal data: `kyc:read` (identity documents), `payments:read` (payment receipts), `customers:read` (customers' addresses in every staff page),
  `customers:privacy` (exports), `risk:decide` (IMEI digits), `reports:read` (the order export); `files:read` alone opens only files nothing uses yet and
  public pictures (decision 047);
- configuration that steers money or messages: `payments:gateways`, `suppliers:update`, `settings:update`, `currencies:update`,
  `notifications:update`, `system:manage`.

Decision 049 adds limits on top: a staff member's credits beyond the daily approval limit, a single debit above it, a credit limit above it
and the approval of a payment for an invoice one issued oneself need an Owner. Because these count per staff account, only an Owner adds a
member with `wallet:adjust`, `wallet:credit_limit`, `payments:approve` or `invoices:create`, gives such a role to another member,
adds one of them to a role somebody holds, sets a temporary password for another member who holds one, or changes that member's email.

The development seed's roles follow the console's demo and hold several of these through area wildcards: they are for development only.

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

Feature 20's merchant lifecycle mails are not outbox types of this module: they are `notifications` rows with a `notification.send` event written by `MerchantLifecycleMails` in the transaction of the staff action (events `merchant.approved`, `merchant.suspended`, `merchant.reactivated`, `merchant.kyc_approved`, `merchant.kyc_rejected`, `merchant.security_notice`).

Outbox events produced (types, payload ids; all on the `notifications` queue, registered by `MerchantMailOutbox`):
`merchant.email_verification` (`POST /client/auth/register`, token purpose `verify_email`) and `merchant.password_reset`
(`POST /client/auth/password/forgot`, purpose `reset`), both built by feature 2b; `merchant.invited` (`POST /admin/clients`, purpose
`invite`), written by feature 2a with `MerchantMailOutbox`. The payload is `{ tokenId }` (the `auth_tokens` row), the aggregate is
the merchant: ids only, never a token. Feature 12a made the mail real: the job rotates the link's token and sends the mail through the platform's
notification delivery (see "Merchant mail"). The links are built from the config key `PORTAL_BASE_URL`
(`<PORTAL_BASE_URL>/set-password?token=<token>`). `auth_tokens.purpose` is closed to `invite | reset | verify_email |
magic_link | telegram_link` (exported `AUTH_TOKEN_PURPOSES`; `telegram_link` is the Telegram link of feature 12a); `POST /client/auth/password/reset` accepts `reset` and `invite`. Consumed: the three types above, by `jobs/merchant-mail.processors.ts` (worker). Feature 20 adds `staff.invited` and `staff.password_reset` (`StaffMailOutbox`, payload `{ tokenId }`, aggregate `staff_users`; written by `POST /admin/staff` and `POST /admin/staff/:id/password`, consumed by `jobs/staff-mail.processors.ts`; links `<CONSOLE_BASE_URL>/set-password?token=`). Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

- `ip_rule_hits_flush` on the `maintenance` queue, scheduler `ip-rule-hits-flush`, every minute (`IpRuleHitsFlushModule`, imported
  by `src/worker.module.ts` only; processor `IpRuleHitsFlushProcessor`). Not recorded in `job_runs` (decision 020); metrics
  `ip_rule_hits_flush_last_success_timestamp_seconds`, `ip_rule_hits_flush_failures_total`, `ip_rule_hits_flushed_total`.
  Listed in `docs/queues.md`.
- `session_purge` on the `maintenance` queue, scheduler `session-purge`, daily at 03:15 UTC (`SessionPurgeModule`, imported by
  `src/worker.module.ts` only; processor `SessionPurgeProcessor`, use case `SessionPurge`). Deletes `sessions` rows that ended (revoked, or
  past `expires_at`) more than 30 days ago, in batches of 1000; safe to repeat or run in parallel; every run writes a `job_runs` row
  (`JobRunsService.run`). Listed in `docs/queues.md`.

- `merchant.email_verification`, `merchant.password_reset`, `merchant.invited` on the `notifications` queue (processors `EmailVerificationMailProcessor`,
  `PasswordResetMailProcessor`, `MerchantInvitedMailProcessor` in `MerchantMailModule`, imported by the API and by `src/worker.module.ts`). Event-driven, no
  schedule, no `job_runs`; safe to run twice (the job re-reads the merchant and the link and skips what is no longer worth
  sending). Retry: the queue's 5 attempts with backoff from 30 s for a failing sender, `UnrecoverableError` for a job without a
  token id. Listed in `docs/queues.md`.

- `staff.invited`, `staff.password_reset` on the `notifications` queue (processors `StaffInvitedMailProcessor`, `StaffPasswordResetMailProcessor` in `StaffMailModule`,
  imported by the API and by `src/worker.module.ts`; feature 20). Same design and retry policy as the merchant mails (`StaffMailJobs`); a suspended or deleted member, a used or
  expired link send nothing and leave no `queued` row; a missing or switched-off template does not stop the mail, the shipped text is sent (decision 047). Listed in `docs/queues.md`.

- `client_group_promotion` on the `maintenance` queue, scheduler `client-group-promotion`, nightly at 03:30 UTC (`GroupPromotionModule`,
  imported by `src/worker.module.ts` only; processor `GroupPromotionProcessor`, use case `GroupPromotion`, pure decision
  `domain/group-promotion.ts`; feature 4a, user rule 1). Promotes `active` merchants, never demotes, to the merchant group with the
  highest `earn_threshold` above zero that their completed-order spend (money's `MerchantSpend`) reaches and that is above their
  group's threshold; a group at 0 and the storefront group are never targets; a target without overdraft is skipped while the merchant
  has credit (ip-3). One transaction per merchant (lock, re-read, update `clients.group_id`, audit row with actor `system`,
  `SessionService.invalidateSubject`); safe to repeat or run in parallel; every run writes a `job_runs` row. Listed in `docs/queues.md`.

Add the next job here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

- `gsm:{env}:identity:session:{tokenHash}` (`CacheKeys.session`): the cached view of a session and the state of its account, 60 s (an unknown token 10 s). `SessionService` deletes it after the commit of a revoke or rotation; `invalidateSubject` does after a suspension, password change or role change.
- `gsm:{env}:identity:role:{roleId}` (`CacheKeys.rolePermissions`): the permissions of a role, 300 s. `RolePermissions.invalidate(roleId)` after the commit of a role change.

Both are listed in `docs/cache-keys.md`, and so is the sign-in lock `gsm:{env}:identity:sign-in-failures:{emailHash}` (`CacheKeys.signInFailures`,
decision 052: 16 minutes after the last attempt; a correct password takes back only its own count and keeps a running lock, a new
password from a link or staff deletes it).
Feature 2a added no key family: its routes clear the existing ones after their commit (`RolePermissions.invalidate`, `SessionService.invalidateSubject` / `revokeAllOf`, `IpRuleCache.invalidate`, `ApiKeyDirectory.invalidateClient`). The sign-in rate limits use the existing `gsm:{env}:ratelimit:sign-in:{hash}` and `...:token:{address}` families, and `...:sign-in-familiar:{hash}` (decision 052, listed in `docs/cache-keys.md`). Register every other key family there too (see `CONTRIBUTING.md` → "Add a cache key").

| Key | What | TTL | Invalidation |
|---|---|---|---|
| `gsm:{env}:identity:ip-rules:active` | live IP rules + `adminAllowlistOnly` | 60 s, then stale for 5 min while one refresh runs | `IpRuleCache.invalidate()` after the commit of any rule or restriction change |
| `gsm:{env}:identity:ip-rule-hits:pending` | hash of hit counters (`<rule id>`, `<rule id>:at`) | 24 h, renewed by every hit | emptied by the flush job every minute |
| `gsm:{env}:identity:api-key:{keyHash}` | cached view of an API key and its merchant's status | 60 s (a key that matches nothing: 10 s) | `ApiKeyDirectory.invalidate(keyHashes)` / `invalidateClient(clientId)` after the commit of a revoke, an edit or a merchant status change |
| `gsm:{env}:identity:webhook-event:{gateway}:{eventHash}` | mark that a gateway event was accepted (replay filter) | 15 min | released after a `5xx` reply; otherwise expires |

All four are registered in `docs/cache-keys.md`.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `identity-platform-1` · POST /admin/clients
- `identity-platform-2` · POST /admin/clients
- `identity-platform-3` · POST /admin/clients
- `identity-platform-4` · PATCH /admin/roles/:id
- `identity-platform-5` · GET /admin/clients/:id/api-keys
- `identity-platform-6` · GET /admin/sessions
- `identity-platform-7` · GET /admin/audit-logs
- `identity-platform-14` · POST /admin/staff/:id/password
- `identity-platform-16` · POST /client/* , /v1/files, /webhooks/telegram/:secret (the 15 sign-in routes are specified by B121 to B136 and built by feature 2b)

## API keys (feature 7b)

Eight routes (contracts `contracts/api-keys.contracts.ts`, controllers `controllers/api-keys.controller.ts`, use cases `application/merchant-api-key.service.ts` and
`application/api-key-admin.service.ts`, shared checks and insert `application/api-key-issuer.ts`, queries `infra/api-key-manage.repository.ts`, pure rules `domain/api-key-input.ts`), wired by `ApiKeysModule`. Spec: MISMATCHES B155
(portal) and identity.md (staff).

| Route | Access | What it does |
|---|---|---|
| `GET /client/api-keys` | merchant | the merchant's keys, live first then revoked, newest first, `x-total-count`; the console's `ApiKey` (never the hash) |
| `POST /client/api-keys` | merchant | `{ name 1-60, scopes, allowedIps?, expiresAt? }` → `201 { key, secret }`, `no-store`; `secret` is `gsm_` + 32 random bytes in base64url, shown once; stored: keyed hash (decision 019) and the first 8 characters; limit `60` a minute; at most 10 live keys (`422` on `name`, advisory lock against races); a `merchant.security_notice` mail (`api_key_created`); `403 FORBIDDEN` while `password_set_by_staff` or `email_set_by_staff` is set |
| `PATCH /client/api-keys/:id` | merchant | `{ name?, allowedIps? }`; a revoked key is `409 INVALID_TRANSITION`; drops the cached view after the commit |
| `DELETE /client/api-keys/:id` | merchant | `204`, a second delete too; drops the cached view after the commit |
| `GET /admin/clients/:id/api-keys` | `api_keys:read` | every key of the merchant, plain array, newest first |
| `POST /admin/clients/:id/api-keys` | `api_keys:create` | feature 20: the merchant's body plus `rateLimitPerMin` (1-6000, default 60) → `201 { key, secret }`, `no-store`; active merchants only (`409 NOT_ACTIVE`); `created_by` = the staff member (`createdByStaff: true`); a `merchant.security_notice` mail; audited `created API key for <merchant>` (never the key) |
| `PATCH /admin/api-keys/:id` | `api_keys:update` | feature 20: `{ rateLimitPerMin?, allowedIps? }` (at least one); `403 FORBIDDEN` for a non-Owner when the change widens the key (an empty list, an address not stored, a higher limit); `409 ALREADY_REVOKED`; drops the cached view; a changed value mails the merchant a security notice; audited `changed limits of API key of <merchant>` with before and after |
| `DELETE /admin/api-keys/:id` | `api_keys:revoke` | `204`; `409 ALREADY_REVOKED`; drops the cached view; audited `revoked API key of <merchant>` (entity `merchant`, as the demo logs it) |

Scopes a merchant may give: `dhru`, `account:read`, `orders:read`, `orders:write`, `services:read` and the area wildcards `account:*`, `orders:*`, `services:*`
(`*` is never offered). B155 lists the first four; `services:read` is added because `GET /v1/services` needs it. `allowedIps` entries are an address or a CIDR range checked like the
IP rules (`normaliseCidr`: host bits and ranges wider than /16 are refused, a bare address is stored as `/32` or `/128`); the wire drops the host prefix (`cidrToWire`);
`lastUsedIp` is `''` for a key never used.

## Verification, KYC (feature 8)

Five routes (contracts `contracts/kyc.contracts.ts`, controllers `controllers/kyc.controller.ts`, use cases `application/kyc.service.ts`, queries
`infra/kyc.repository.ts`, pure rules `domain/kyc-rules.ts`), wired by `KycModule`. Spec: MISMATCHES B161 (portal) and identity.md (staff).

| Route | Access | What it does |
|---|---|---|
| `GET /client/kyc` | merchant, a pending merchant too (B153) | `{ status, submission }`: `clients.kyc_status` and the latest request (`documents`, `note` only for a rejection, `submittedAt`, `reviewedAt`) or `null` |
| `POST /client/kyc` | merchant, a pending merchant too | `{ fileIds 1-5, note? ≤ 500 }` → `201` the same view; the files must be the merchant's own uploads of type PDF, JPEG or PNG (`422 fileIds.<n>`); one request under review at a time (`409 CONFLICT`, a partial unique index backs it), `409 ALREADY_DECIDED` once approved; a rejected merchant may submit again; sets `kyc_status` to `pending`; no audit row (B121) |
| `GET /admin/kyc-submissions`, `GET /admin/kyc-submissions/:id` | `kyc:read` | the console's `KycSubmission` with the merchant, the reviewer and the documents joined from `files`; filters `status`, `clientId`; sort `createdAt` |
| `POST /admin/kyc-submissions/:id/decide` | `kyc:decide` | `{ decision: approve \| reject, note? ≤ 300 }`, a note required for a rejection; locks the request, sets it and `clients.kyc_status` to the same word (never `clients.status`); `409 ALREADY_DECIDED`; audited `approved verification of` / `rejected verification of` (entity `kyc_submission`) |

Schema addition (migration `0009`): `kyc_submissions.submitted_note` (what the merchant wrote; B161 has a `note` the console column does not hold) and the unique index
`kyc_submissions_one_pending_uq` on `client_id` where `status = 'pending'`. The files are read through the platform's `StoredFiles` (`findOwned`, `metaOf`).
The merchant is not notified of a decision yet (the mail event of the decision arrives with feature 12a); the rejection note reaches it through `GET /client/kyc`.

## Gateway webhook adapters (feature 8)

`WebhookVerifiers` (P2.5c) keeps adapters by gateway slug and now also takes one **resolver** (`setResolver`, `resolve`): a registered adapter wins, then the resolver is asked
for a valid slug nobody registered. Payment gateways are rows staff add at run time, so money's `PaymentWebhookVerifier` registers a resolver that reads the gateway row by
`code`, decrypts its signing key and hands the delivery to the driver. The guard (`GatewaySignatureAccessHandler`) calls `await verifiers.resolve(gateway)`; an unknown slug,
a manual gateway and a gateway without a key all answer `400 WEBHOOK_SIGNATURE_INVALID`.

