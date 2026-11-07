# Identity & access module (`identity`)

Map domain A. Who can sign in and what they may do: staff accounts and roles, merchants (clients), sessions, one-time tokens, API keys, KYC submissions and IP rules. It owns the authentication and authorization building blocks every surface uses: sessions, CSRF, API keys and the permission check (decision 018).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 007 password hashing, 010 ids and tokens, 018 authentication, sessions and CSRF, 019 encryption and token hashing, 021 rate limiting. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: the staff, role, permission, session, IP-rule and merchant routes of feature 2a (27 of its 31 routes; the other 4 are the platform's audit log and settings), the daily purge of ended sessions and the demo merchants of the seed (see "Staff access, merchants and sessions (feature 2a)" below); the 15 merchant portal routes of feature 2b (`/client/auth/*`, `/client/profile`, `/client/security/*`, `/client/sessions`, see "Merchant portal sign-in (2b)" below) and the pending-merchant rule of B153. Built earlier (P2.5a, P2.5c and the P2.6 sign-in routes, code in `security/`): the session service, cookies and CSRF token, the guard dispatcher with the staff, merchant and customer session guards, the CSRF guard, the permission guard with the permissions catalog and the Owner helpers, the staff gate of the internal API reference, and the machine guards (`security/machine/`): capability tokens, URL secrets, merchant API keys (REST v1 Bearer and Dhru credentials) and gateway webhook signatures. The sign-in routes (P2.6) and the IP rules, maintenance and rate-limit hooks (P2.5b) are built too.

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
| `StaffAuthTokens` | `issue(work, { staffId, purpose: 'invite' \| 'reset', createdBy?, ip? })`: the one-hour, single-use link token of `POST /admin/auth/password/set` (feature 2a calls it when it adds a member by invitation or sends a reset; it voids the account's older links) |
| `checkPasswordPolicy`, `MIN_PASSWORD_LENGTH` | the staff password policy (also for a temporary password the server generates) |
| `STAFF_TOTP_AAD`, `CLIENT_TOTP_AAD`, `TOTP_ISSUER` | the encryption contexts of `staff_users.totp_secret_enc` and `clients.totp_secret_enc`, and the name authenticator apps show |
| `MerchantAuthTokens` | `issue(work, { clientId, purpose: 'verify_email' \| 'reset' \| 'invite', createdBy?, ip? })`: the one-hour, single-use link token of a merchant (feature 2a calls it with `invite` for `POST /admin/clients`); it voids the merchant's older unused links of the same family and returns `{ token, id, expiresAt }` |
| `MerchantMailOutbox`, `MERCHANT_MAIL_EVENTS` | `enqueue(work, { kind: 'email_verification' \| 'password_reset' \| 'invited', clientId, tokenId, token })`: writes the outbox event of a merchant mail (ids only) in the caller's transaction; feature 2a writes `invited` with it |
| `MAIL_SENDER`, `MailSender`, `MerchantMail` | the seam between the mail jobs and a mail transport; feature 12a provides the real sender under the `MAIL_SENDER` token |
| `CurrentMerchant` | parameter decorator: the signed-in merchant (`MerchantPrincipal`) of a `merchant-session` route |
| `MerchantGroupMembers` | `countByGroup(db, groupIds)` (the `merchantCount` of the catalog's group routes and their delete guard) and `countInGroup(db, groupId, clientIds)` (the overdraft rule); read-only, no dependencies, exported in the leaf block of `index.ts` (decision 032) |
| `GroupPromotionModule`, `GroupPromotion`, `decidePromotion`, `breaksCreditRule` | the nightly promotion job of feature 4a (worker only) and its pure decision |

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
rotated. A same-origin deployment must list its own origin in `CORS_ORIGINS` too, or the Origin check refuses its sign-in.

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
| `POST /admin/auth/login` | public (Origin check) | email + password → `{ next }` and a pending session (10 min). Order: IP rules and the per-IP limit (pipeline) → sign-in limit (email + address) → credentials → suspended → session |
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
  address; **codes per account** (not per session, or every new login would give a thief five more guesses); setups per account. The keys are
  `HMAC(TOKEN_PEPPER, ...)` hashes, so Redis keys hold no email address. Trying links from one address uses the `token` limiter (30 a minute).
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

## Staff access, merchants and sessions (feature 2a)

Scenarios `admin-team` and `ip-rules` (tests: `test/scenarios/admin-team.e2e.test.ts` and `ip-rules.e2e.test.ts`). 27 routes, each a
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
| `GET /admin/sessions`, `DELETE /admin/sessions/:id` | `sessions:read`, `sessions:revoke` | `SessionAdminService` |
| `GET /admin/ip-rules`, `GET /admin/ip-rules/:id`, `POST /admin/ip-rules/check` | `access:read` | `IpRuleAdminService` |
| `POST /admin/ip-rules`, `DELETE /admin/ip-rules/:id`, `PUT /admin/access/restriction` | `access:create`, `access:delete`, `access:update` | |
| `GET /admin/clients`, `GET /admin/clients/:id` | `clients:read` (`wallet` and `stats` only with `wallet:read`) | `ClientAdminService` |
| `POST /admin/clients`, `PATCH /admin/clients/:id` | `clients:create`, `clients:update` | |

**Rules worth knowing**

- **Owner rules** (`assertOwnerTargetAllowed`, `owner.repository.ts`): an action on an account whose role grants `*`, or handing out such a role,
  needs `*`; nobody changes their own role (`409 CANNOT_CHANGE_OWN_ROLE` on `roleId`) or suspends themselves (`409 CANNOT_SUSPEND_SELF`); the
  last active Owner is never demoted, suspended or stripped of `*` (`409 LAST_OWNER`). The count of Owners runs under one advisory lock
  (`lockOwnerChanges`), so two Owners demoting or suspending each other at the same moment cannot both win. Every staff write re-reads the
  caller's account from `staff_users` (`ACCOUNT_SUSPENDED` at once), not the 60-second cached session view.
- **What a change does to sessions and caches:** a suspension, "end all sessions", a password reset with `revokeSessions` and a 2FA reset
  call `SessionService.revokeAllOf` (the caller keeps their own session when they reset their own 2FA); a rename or role change, and a
  reactivation, call `invalidateSubject`; a role change calls `RolePermissions.invalidate`; a merchant status change calls
  `ApiKeyDirectory.invalidateClient`. All after the commit.
- **Staff links** (`StaffAuthTokens`): `POST /admin/staff` (invite) and `reset_link` issue an `auth_tokens` row (purpose `invite` while the member
  is `invited`, `reset` otherwise; hash only, one hour, only the newest link works). The link itself is built and mailed by the
  notifications feature (12a): until then the raw token is not delivered anywhere. A temporary password stores only its argon2id hash,
  forces a change, voids unused links and is shown once (never in the audit log).
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
- **Merchants:** `POST /admin/clients` inserts the merchant as `pending` with a generated Dhru username and referral code, opens the wallet and
  hold accounts through `MerchantAccounts.open` (`overdraft_limit` = credit limit; user rule 2: credit above zero on a group without
  `overdraft_allowed` is `422` on `creditLimit`), issues the one-hour invite token (`auth_tokens`, purpose `invite`, subject type `client`, hash only)
  and writes the outbox event `merchant.invited` (`{ tokenId }`, through `MerchantMailOutbox`, see "Merchant mail"), all in one
  transaction. `PATCH` does one action per call: approve
  (`pending → active`), suspend (`active → suspended`, a reason of 3 to 140 characters, sessions ended), reactivate (`suspended → active`), or a
  group move (`422` on `groupId` for an unknown group, the storefront retail group, the same group, or a group without credit while the
  wallet's limit is above zero). Any other status change is `409 INVALID_TRANSITION`.
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
| `POST /client/auth/register` | public (Origin check) | the form → `204`, the same for a new and a known email. A new email creates a `pending` merchant in the `is_default` group, opens its wallet and hold (`MerchantAccounts.open`, credit limit 0), a `verify_email` link and the event `merchant.email_verification`, in one transaction |
| `POST /client/auth/verify-email` | public | `{ token }` → `204`; sets `email_verified_at`, uses the link; the status stays `pending`; signs nobody in |
| `POST /client/auth/login` | public | email + password → `{ next: 'totp' \| 'done' }`; a `pending_totp` session (10 min) when 2FA is on, an `active` one otherwise; a pending merchant signs in |
| `POST /client/auth/2fa` | session, `pending_totp` | six digits → `204`; rotates the session to `active` |
| `POST /client/auth/logout` | session, `pending_totp` or `active` | revokes the session, clears both cookies, `204` |
| `POST /client/auth/password/forgot` | public | `{ email }` → `204` for any email; a merchant that is not suspended (also one waiting for approval without a password) gets a `reset` link and the event `merchant.password_reset` |
| `POST /client/auth/password/reset` | public | `{ token, password }` with a `reset` or `invite` link → `204`; sets the password, uses the link, ends every session, signs nobody in; an invitation also sets `email_verified_at` and voids the merchant's verification link |
| `GET /client/auth/me` | session, `active` | `Me`: id, username, email, name, company, phone, country, status, kycStatus, emailVerifiedAt, twofaEnabled, referralCode, group, createdAt; `no-store`; repeats `X-CSRF-Token` |
| `PATCH /client/profile` | session | name, company, phone, country (partial) → `Me` |
| `POST /client/security/password` | session | `{ currentPassword, newPassword }` → `204`; ends the other sessions |
| `POST /client/security/2fa/setup` | session | a pending secret (encrypted, `twofa_enabled` stays false) → `{ secret, otpauthUrl, qrSvg }`; `409 TWOFA_ALREADY_ENABLED` once on |
| `POST /client/security/2fa/enable` | session | `{ code }` confirms the pending secret → `204`; ends the other sessions |
| `POST /client/security/2fa/disable` | session | `{ code }` → `204`; forgets the secret, ends the other sessions; `409 TWOFA_NOT_ENABLED` |
| `GET /client/sessions` | session | the caller's live `active` sessions, newest first, `current` marked, simple-rest range and `x-total-count` |
| `DELETE /client/sessions/:id` | session | `204`; `404 NOT_FOUND` for a session that is not the caller's, unknown or no longer live; ending the current one clears the cookies |

**Rules worth knowing**

- **No enumeration.** `register` and `password/forgot` answer `204` whatever the email; `register` always hashes the password
  (the same work for a known email), and both are counted per address (`register`) or email + address (`forgot`) by the `sign-in`
  limiter, known email or not. `login` is one `401` for an unknown email, a wrong password and a merchant with no password yet
  (each verifies one argon2 hash); `403 ACCOUNT_SUSPENDED` only follows a correct password.
- **A wrong current password or code is `422` on its field (`currentPassword`, `code`), never `401`**, which would sign the caller
  out (B121). `WEAK_PASSWORD` names `password` (register, reset) or `newPassword` (change).
- **Rate limits** (`MerchantSignInLimiter`, keys are `HMAC(TOKEN_PEPPER, ...)` hashes under the prefix `merchant-sign-in`, so
  counters do not mix with the staff ones): login per email + address; registration per address; forgot per email + address;
  codes (sign-in, enable, disable), 2FA setups and password changes **per account**; emailed links (`verify-email`, `password/reset`)
  by the `token` limiter per address. The per-IP limit of the pipeline covers the public routes first.
- **Links** (`auth_tokens`, purposes `verify_email`, `reset`, `invite`; `MerchantAuthTokens`): 256 random bits, only the keyed hash
  stored, one hour, one use. A newer `reset` or `invite` voids the older ones; a newer `verify_email` voids the older one. Unknown,
  used, expired, superseded and suspended-merchant links are all `410 TOKEN_INVALID`. A weak password does not use the link up.
  Changing the password voids open `reset` and `invite` links.
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

### Merchant mail

An email is outbox work (decision 020): the use case writes `merchant.email_verification`, `merchant.password_reset` (and feature 2a
`merchant.invited`) in its transaction with `MerchantMailOutbox.enqueue`; the payload is `{ tokenId }` and the aggregate the
merchant, never the token or the address. The events map to the `notifications` queue; `MerchantMailModule` (loaded by the API
and by the worker) registers them and provides one named processor per type (`jobs/merchant-mail.processors.ts`) that re-reads the
merchant and the link, skips what is no longer worth sending and hands the rest to the `MailSender` bound to `MAIL_SENDER`. The
development sender (`LogMailSender`) writes one redacted log line per mail; **feature 12a replaces it with templates and real
delivery.** Open point for 12a: the token exists in clear text only in the request that created it and the outbox carries ids only,
so the worker cannot build the link `<PORTAL_BASE_URL>/set-password?token=<token>` or `/verify-email?token=<token>` yet. Outside
production `MerchantMailOutbox.enqueue` writes the link to the log after the commit (`DEVELOPMENT ONLY: ...`), which is how a
developer finishes a flow. 12a must decide how the token reaches the mailer (for example a sealed copy that the job wipes).

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

59 endpoints (admin 38, client 21). Source: `docs/slices/identity.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built; the staff sign-in (6) and the 15 merchant portal routes of stage 2 (2b) are built.

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

End-to-end tests: `test/scenarios/admin-team.e2e.test.ts` (steps 1 to 9) and `test/scenarios/ip-rules.e2e.test.ts` (steps 1 to 9; step 7, the risk engine's automatic block, is a row written the way feature 18 will write it). Route tests: `test/integration/{staff-admin,roles-admin,sessions-admin,ip-rules-admin,clients-admin}.test.ts`.

## Permissions

Staff permissions the map requires on this module's admin routes: `access:*`, `access:read`, `access:update`, `api_keys:read`, `api_keys:revoke`, `clients:*`, `kyc:decide`, `kyc:read`, `roles:*`, `roles:read`, `sessions:read`, `sessions:revoke`, `staff:*`, `staff:suspend`, `staff:update`.

The contracts of feature 2a name the concrete permissions: `access:read|create|update|delete`, `clients:read|create|update`, `roles:read|create|update|delete`, `sessions:read|revoke`, `staff:read|create|update|suspend` (a role may hold `area:*` for each area).

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

Outbox events produced (types, payload ids; all on the `notifications` queue, registered by `MerchantMailOutbox`):
`merchant.email_verification` (`POST /client/auth/register`, token purpose `verify_email`) and `merchant.password_reset`
(`POST /client/auth/password/forgot`, purpose `reset`), both built by feature 2b; `merchant.invited` (`POST /admin/clients`, purpose
`invite`), written by feature 2a with `MerchantMailOutbox`. The payload is `{ tokenId }` (the `auth_tokens` row), the aggregate is
the merchant: ids only, never a token. Until feature 12a adds the templates, the `MailSender` development implementation logs a
redacted line. The links are built from the config key `PORTAL_BASE_URL`
(`<PORTAL_BASE_URL>/set-password?token=<token>`). `auth_tokens.purpose` is closed to `invite | reset | verify_email |
magic_link` (exported `AUTH_TOKEN_PURPOSES`); `POST /client/auth/password/reset` accepts `reset` and `invite`. Consumed: the three types above, by `jobs/merchant-mail.processors.ts` (worker). Record each outbox type and the queue it maps to here and in `docs/queues.md`.

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

Both are listed in `docs/cache-keys.md`. Feature 2a added no key family: its routes clear the existing ones after their commit (`RolePermissions.invalidate`, `SessionService.invalidateSubject` / `revokeAllOf`, `IpRuleCache.invalidate`, `ApiKeyDirectory.invalidateClient`). The sign-in rate limits use the existing `gsm:{env}:ratelimit:sign-in:{hash}` and `...:token:{address}` families. Register every other key family there too (see `CONTRIBUTING.md` → "Add a cache key").

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
