# Identity & access module (`identity`)

Map domain A. Who can sign in and what they may do: staff accounts and roles, merchants (clients), sessions, one-time tokens, API keys, KYC submissions and IP rules. It owns the authentication and authorization building blocks every surface uses: sessions, CSRF, API keys and the permission check (decision 018).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 007 password hashing, 010 ids and tokens, 018 authentication, sessions and CSRF, 019 encryption and token hashing, 021 rate limiting. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built (P2.5a, code in `security/`): the session service, cookies and CSRF token, the guard dispatcher with the staff, merchant and customer session guards, the CSRF guard, the permission guard with the permissions catalog and the Owner helpers, and the staff gate of the internal API reference. The kinds that P2.5c builds (API keys, Dhru credentials, gateway signatures, URL secrets, capability tokens) are fail-closed placeholders. The sign-in routes (P2.6), the staff, role and IP-rule routes (feature 2a) and the IP rules, maintenance and rate-limit hooks (P2.5b) come with their own features.

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
| `AccessHandlers` | `replace(kind, handler)`: P2.5c gives the machine kinds their real guards |
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
| `api-key`, `dhru-credentials`, `gateway-signature`, `url-secret`, `checkout-token`, `tracking-token`, `link-token`, `ticket-token` | placeholders until P2.5c: every request is refused with `401 UNAUTHORIZED` (the Dhru envelope `Authentication Failed` on `/api/index.php`) |

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

## Events

Outbox events produced (types, payload ids): none yet. Consumed: none yet. Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

None yet. List each queue, job, schedule, idempotency key and retry policy here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

- `gsm:{env}:identity:session:{tokenHash}` (`CacheKeys.session`): the cached view of a session and the state of its account, 60 s (an unknown token 10 s). `SessionService` deletes it after the commit of a revoke or rotation; `invalidateSubject` does after a suspension, password change or role change.
- `gsm:{env}:identity:role:{roleId}` (`CacheKeys.rolePermissions`): the permissions of a role, 300 s. `RolePermissions.invalidate(roleId)` after the commit of a role change.

Both are listed in `docs/cache-keys.md`. Register every other key family there too (see `CONTRIBUTING.md` → "Add a cache key").
