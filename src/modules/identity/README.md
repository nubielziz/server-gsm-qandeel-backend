# Identity & access module (`identity`)

Map domain A. Who can sign in and what they may do: staff accounts and roles, merchants (clients), sessions, one-time tokens, API keys, KYC submissions and IP rules. It owns the authentication and authorization building blocks every surface uses: sessions, CSRF, API keys and the permission check (decision 018).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 007 password hashing, 010 ids and tokens, 018 authentication, sessions and CSRF, 019 encryption and token hashing, 021 rate limiting. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Not built yet: the module is an empty shell (`identity.module.ts`, `index.ts`). Its feature adds controllers, services, repositories and the owned tables.

## Public API (`index.ts`)

Exports `IdentityModule` only. Add the services other modules may call here, and nothing else: other modules import only `src/modules/identity/index.ts` (lint rule `gsm/module-boundaries`).

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

None yet. Register each key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").
