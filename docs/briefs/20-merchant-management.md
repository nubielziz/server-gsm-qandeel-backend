# Brief 20 · Merchant management (backend + admin console)

Plan by the feature architect (Fable 5.2), 2026-11-10, against `main` @ `bd32229`. Status: **approved** (see § 15).
Nobody writes code for this feature before the lead has read § 12 (decisions) and § 15 (dependencies).

Scope: ROADMAP phase 0 (items 0.1-0.6), the owner's list B "Merchant Management" (2026-11-10), the merchant gaps of
`STOREFRONT-HANDOFF.md` § 6.4 (verification resend; a notification on approval and on a KYC decision) and the binding
defaults of `.lead/w1/LEAD-DECISIONS.md` § 6 "Merchant management".

Worktrees (the lead creates them after W0 is merged): backend `../backend-20` on `feat/backend-20` (test database
`gsm_20_test`, Redis DB 12), console `../frontend-admin-20` on `feat/console-20`. The storefront is read only: its needs are in
§ 13.

Paths below are relative to `backend/` unless they start with `FA/` (= `/home/saifi/gsm-project/frontend-admin`) or `SF/`
(= `/home/saifi/gsm-project/storefront`). Line numbers are 1-based, on `main` @ `bd32229`.

## 0. Rules the implementer follows

- Read `CLAUDE.md`, `docs/briefs/_common.md` (ignore its lines about the frontend cwd and the Serena binding: they are stale),
  `docs/briefs/_feature.md`, `CONTRIBUTING.md`; for the console `FA/CLAUDE.md` and `FA/docs/ARCHITECTURE.md` § 5.
- Work only inside your worktree. Never run `docker compose`, `db:migrate`, `db:seed`, `src/main.ts` or `scripts/ci.sh` there
  (they would hit the owner's dev database). Never touch ports 3000 and 3100, the databases `gsm` and `gsm_storefront`, or
  anything under `reference/`. No git command that changes state. No agents.
- Memory is tight: run targeted files while developing (`bun test --timeout 15000 <files>`), heavy runs through the slot lock
  (`bash scripts/with-slot.sh bun run typecheck`, `bun run lint`, `bun run test`), and `bun run check` once at the end, in the
  foreground. Console: `npm ci`, then `npm run typecheck && npm run lint && npm run build && npm test`.
- No float for money (this feature moves no money). Time only through the injected `Clock`. SQL that decides takes the clock's
  time as a parameter. TSDoc on every exported symbol; controllers add `@route METHOD /path`.
- Error codes: this feature adds **none**. Use only the codes named per route in § 4.
- Never write a token, a link, a password or an API key secret to a log, an audit row, an outbox payload or a
  `notifications` row. Audit keys that end in `password`, `secret` or `token` are redacted
  (`src/modules/platform/audit/audit-redaction.ts:47`): name such facts `credential`.
- Before starting, look for partial work of an interrupted attempt (`git status` in your worktree) and continue it.

## 1. What was inspected, and where the code corrects the discovery reports

Verified in the code (not only in `.lead/w1/D1`, `D2`, `D5`, `D6`):

| Fact | Evidence |
|---|---|
| The merchant row staff read, and the only edit route | `src/modules/identity/contracts/clients.contracts.ts:21-39` (`ClientRow`), `:143-167` (`PATCH /admin/clients/:id`: `status`, `reason`, `groupId` only) |
| One change per call; the row is locked first | `src/modules/identity/application/client-admin.service.ts:174-185`; `lockClient` in `src/modules/identity/infra/client-admin.repository.ts:91-94` |
| Status machine `pending→active`, `active→suspended`, `suspended→active` | `src/modules/identity/domain/client-rules.ts:6-10`; `changeStatus` at `client-admin.service.ts:254-295` |
| A suspension ends sessions and clears caches but does **not** void open links | `client-admin.service.ts:280-282`; staff do void (`src/modules/identity/application/staff-admin.service.ts:371`) |
| `clients` has no `must_change_password`, `last_login_*`, `locale`, address, tax id or notes | `src/modules/identity/db/schema.ts:216-276`; staff have them at `:158,166-167` |
| Merchant sign-in steps are `totp | done` only | `src/modules/identity/domain/merchant-sign-in-step.ts:5,15-17,28-30`; `MerchantNext` at `src/modules/identity/contracts/merchant-auth.contracts.ts:8`; login at `src/modules/identity/application/merchant-sign-in.service.ts:77-108` |
| A merchant-session route may accept a pending stage | `src/common/contract/define-route.ts:82,494-504` (only `staff-permission` is restricted to `active`) |
| `SessionService.rotate` moves a session to any stage with a new token | `src/modules/identity/security/session.service.ts:111-130` |
| Merchant links: issue voids the family, the mail job rotates the token | `src/modules/identity/application/merchant-auth-tokens.ts:63-80`; `src/modules/identity/application/mail/merchant-mail-jobs.ts:99-184` (suspended skipped at `:117`, rotation at `:153-154`) |
| Outbox rows of merchant mails carry ids only | `src/modules/identity/application/mail/merchant-mail-outbox.ts:49-59` |
| Staff links are issued and the clear token is dropped; no staff mail exists | `staff-admin.service.ts:179-186`, `:291-298`; `StaffAuthTokens.issue` returns it (`src/modules/identity/application/staff-auth-tokens.ts:60-78`) |
| No `CONSOLE_BASE_URL` | `src/config/env.ts:66-68,205-206,230-231,547-553` |
| Merchants and staff always get English mail | `src/modules/platform/notifications/notification-foreign-reads.ts:77,97` |
| A transactional event reaches a suspended recipient | `src/modules/platform/notifications/notification.service.ts:332`; `notification-delivery.ts:146-149` |
| Module-owned events and templates (the pattern to copy) | `src/modules/support/support-events.module.ts:16-28`; `src/modules/support/application/support-templates.ts:11-73` and its spec `:86-93` |
| `verify-email` does not check suspension | `src/modules/identity/application/merchant-registration.service.ts:118-130` |
| KYC decision: audited as `kyc_submission`, no notification | `src/modules/identity/application/kyc.service.ts:114-143` |
| API keys: merchant creates (max 10 live), staff only list and revoke; no `created_by` | `src/modules/identity/application/merchant-api-key.service.ts:99-129`; `api-key-admin.service.ts:41-70`; `schema.ts:371-392` |
| A key works only for an `active` merchant | `src/modules/identity/security/machine/api-keys/api-key.rules.ts` (`checkApiKey`: `suspended`, then `not_active`) |
| Admin session list filters `subjectType` only | `src/modules/identity/contracts/sessions.contracts.ts:31-35`; `src/modules/identity/infra/session-admin.repository.ts:19-24` |
| The audit list already filters `entityType` + `entityId` (indexed) | `src/modules/platform/contracts/audit-logs.contracts.ts:55-60`; `src/modules/platform/db/schema.ts:356` |
| Invoices, top-up payments and KYC lists filter by `clientId` | `src/modules/money/contracts/invoices.contracts.ts` (`listInvoices`), `payments.contracts.ts` (`listPayments`), `src/modules/identity/contracts/kyc.contracts.ts:60` |

Corrections to the reports (the code wins):

1. **New response fields on `ClientRow` cannot be required.** The contract tests validate the harvested console fixtures
   (`test/contract/fixtures/frontend/GET_admin_clients.json`, `GET_admin_clients_id.json`, `PATCH_admin_clients_id.json`,
   `POST_admin_clients.json`, `GET_admin_clients_id_api_keys.json`) against the response schema
   (`test/contract/lib/fixture-check.ts:41-66`). A required new field fails shape parity unless an allowlist entry cites an
   existing B-id (`test/contract/allowlist.ts:86-151`, precedent B171), and B-ids are now assigned only at merge. So every new
   field on a console-read row is **optional in the schema and always sent** (§ 4.1). D2 § 12 called these additions simply
   "additive".
2. `MerchantAuthTokens.issue` writes `auth_tokens.created_at` from the column default, not from the clock; staff tokens use
   the clock (`staff-auth-tokens.ts:71-73`). The new "link sent at" field needs the clock: fix it in slice A.
3. The list of limiter names is pinned by a spec (`src/infra/rate-limit/rate-limit.service.spec.ts:25-37`); a new limiter
   must be added there too. The reports did not say so.
4. `CONSOLE_BASE_URL` being required in production touches five fixtures of a production environment:
   `src/config/env.spec.ts` (`production()` and the list at `:198-205`), `test/support/app.ts:53-57` (`PRODUCTION_ENV`),
   `test/integration/process.test.ts:113-114`, `test/integration/db-reset.test.ts:588-589`,
   `test/unit/db-reset-plan.test.ts:22-23`.
5. Integration tests truncate `notification_templates` (`resetDb`); templates of a migration are gone in a test. Tests insert
   them with a helper (`test/support/support.ts:23-28` is the pattern). A new helper is needed for this feature's templates.
6. Identity imports nothing from the customers module, and customers import identity (decision 032). So "refuse a merchant
   email that a customer uses" cannot be checked from identity without a cycle. It is **not built**; the smart sign-in rule
   "the merchant wins" already covers the case (§ 12, O-3).
7. Route parity compares method, path, surface and the Turnstile flag only (`test/contract/route-parity.test.ts`). The map
   even calls `POST /client/auth/2fa` public while its contract is a merchant session. The addition rows of § 4.4 still state
   the access honestly.

## 2. Requirement → status today → evidence

| # | Requirement | Backend today | Console today | This plan |
|---|---|---|---|---|
| 0.1 | Staff send a password reset link | missing (building blocks: `merchant-auth-tokens.ts:63-80`, `merchant-mail-outbox.ts:49-59`) | missing | slice A, `POST /admin/clients/:id/password` mode `reset_link`; K2 |
| 0.2 | Resend an invitation | missing; `MerchantInvites.issue` does not void (`src/modules/identity/application/merchant-invites.ts:46-64`) | missing; no "has a password" field | same route: purpose `invite` while `password_hash` is null (the staff rule, `staff-admin.service.ts:294`) |
| 0.3 | Edit name, company, phone, country, email | missing (`clients.contracts.ts:157-163`) | missing | slice A, `PATCH /admin/clients/:id` grows; K1 |
| 0.4 | Reset 2FA; end all sessions | missing (staff parity: `staff-admin.service.ts:318-335,418-436`) | one session at a time in Access › Sessions | slice A, two routes; K2 |
| 0.5 | Staff invitations and resets by email | missing (`staff-admin.service.ts:179-186,291-298`) | toasts claim a mail (`FA/src/features/access/hooks/useStaffMutations.ts:38-39,71`) | slice C; K5 |
| 0.6 | Staff create an API key (shown once) | missing by design (`api-key-admin.service.ts:16-17`) | missing | slice D; K4 |
| B-1 | Merchant profiles, business information | partial: name, company, phone, country, email (`schema.ts:226-229`); no address, tax id, locale, notes | header only (`FA/src/features/merchants/components/MerchantHeader.tsx:45-64`) | A0 columns; slice A edit; slice B self-edit; K1 Profile tab |
| B-2 | Account settings | merchant-only preferences and Telegram | missing | read-only `locale` and `telegramLinked` on the row; staff set `locale`; editing preferences or unlinking Telegram for a merchant is not built (§ 12, O-13) |
| B-3 | Secure password resets | self-service is secure (`merchant-password.service.ts:61-118`); staff-initiated missing | missing | slice A (ids-only outbox, rotate-in-job, cooldown, audit) |
| B-4 | Forced password change, temporary password | missing for merchants | missing | A0 column; slice A (temporary password); slice B (`next: 'password'`, `POST /client/auth/password/change`) |
| B-5 | Activation | exists (`client-admin.service.ts:283-294`); no mail | exists | slice B: `merchant.approved` mail |
| B-6 | Suspension | exists; links survive; `suspended_*` stored but not returned (`schema.ts:252-256`); no mail; a pending applicant cannot be stopped | dialog exists; wrong banner text (`FA/src/features/merchants/components/MerchantNote.tsx:42-47`) | slice B: void links, refuse verify, `pending→suspended`, mail; `suspension` on the row; K1 |
| B-7 | Restoration | exists (`client-admin.service.ts:273-278`) | exists | slice B: `merchant.reactivated` mail |
| B-8 | Sessions | global list + end one (`sessions.contracts.ts:20-69`) | Access › Sessions | slice A: `subjectId` filter, end all; K2 list on the merchant page |
| B-9 | Permissions | route permissions exist; no separate security permission | hints via `useMerchantGrants` | new `clients:security`, `api_keys:create`, `api_keys:update` |
| B-10 | API keys | list + revoke | list + revoke | slice D; K4 |
| B-11 | Access controls | global IP rules; per key `allowed_ips` editable only by the merchant | view only | slice D: staff edit `allowedIps` and `rateLimitPerMin` |
| B-12 | Wallet, orders | exist (`src/modules/money/contracts/wallet.contracts.ts`; `GET /admin/orders?clientId=`) | Wallet and Orders tabs exist | unchanged |
| B-13 | Transactions | statement and journal exist; invoices and payments filter by `clientId` | statement only on the page | K3 Billing tab (no backend change) |
| B-14 | Audit history | `GET /admin/audit-logs?entityType=merchant&entityId=` works; KYC decisions and single session ends are filed elsewhere | no tab | slice A and B file them under the merchant; K3 Audit tab |
| H-1 | Resend the verification email | missing (`merchant-password.service.ts:112-113`) | missing | slice B: merchant route + staff route; K2 |
| H-2 | Notify on approval and KYC decision | missing (`client-admin.service.ts:254-295`, `kyc.service.ts:114-143`) | n/a | slice B |

## 3. Design

### 3.1 Boundaries and ownership

- Everything lives in the **identity** module (`src/modules/identity`), in the existing sub-modules. No new module. One new
  sub-module, `StaffMailModule`, is imported by `AccessAdminModule` (API) and by `src/worker.module.ts` (worker).
- Identity touches only its own tables (`clients`, `auth_tokens`, `sessions`, `api_keys`, `staff_users`, `kyc_submissions`).
  Notifications go through the platform's public services (`NotificationService`, `OutboxService`,
  `NotificationEventRegistry`). The only edit outside identity is one line in
  `src/modules/platform/notifications/notification-foreign-reads.ts` (read `clients.locale`), allowed by LEAD-DECISIONS § 5.
- Layering as everywhere: contract → thin controller → application use case (one `runInTransaction`) → pure domain function →
  Drizzle repository.
- Console: `FA/src/features/merchants` (the page), `FA/src/features/access` (staff mail texts), `FA/src/features/audit` (a record
  filter). The merchant page reuses other features only through their `index.ts`: `listSessions`, `revokeSession`,
  `RevealPasswordDialog` from `@/features/access`; `listInvoices`, `listPayments`, `financeInvoicePath`, `financePaymentPath`,
  `PaymentStatusBadge` from `@/features/finance`; `listAuditLogs` from `@/features/audit`.

### 3.2 Data (two migrations, both generated in slice A0)

**`drizzle/0020_merchant_management.sql`** (generated: `bun run db:generate --name merchant_management`; it reads no
database):

| Table | Column | Type | Rule |
|---|---|---|---|
| `clients` | `must_change_password` | boolean, not null, default false | true after staff set a temporary password; false after the merchant chooses a password by any route |
| `clients` | `last_login_at` | timestamptz(3), null | written when a session of the merchant becomes `active` |
| `clients` | `last_login_ip` | text, null | same moment |
| `clients` | `locale` | text, not null, default `'en'` | CHECK `clients_locale_check`: `in ('en','ar')`, from the new `CLIENT_LOCALES = ['en','ar'] as const` |
| `clients` | `address` | text, not null, default `''` | postal address, free text, at most 300 characters (the contract enforces the length) |
| `clients` | `tax_id` | text, not null, default `''` | tax or VAT registration number, at most 40 characters |
| `clients` | `internal_notes` | text, not null, default `''` | staff only, at most 2000 characters; never on a `/client` route |
| `api_keys` | `created_by` | bigint, null, FK → `staff_users(id)` (restrict) | the staff member who created the key; null for a key the merchant made. Index `api_keys_created_by_idx` (every FK has one) |

No existing column changes. No data backfill: the defaults are the right values for every existing row.

**`drizzle/0021_merchant_management_templates.sql`** (custom:
`bunx --bun drizzle-kit generate --custom --name merchant_management_templates`): one
`INSERT INTO "notification_templates" … ON CONFLICT ("event","channel","audience","locale") DO NOTHING;` with the 14 rows of § 6.
Its text is exactly what `identityTemplatesSql()` writes (a spec keeps them equal).

The lead renumbers at merge. The spec reads the file name from **one** constant,
`IDENTITY_TEMPLATES_MIGRATION = '0021_merchant_management_templates.sql'` in
`src/modules/identity/application/mail/identity-templates.ts`.

`test/schema/structure.test.ts` `ADDITIONS` (`:73-126`): append `'must_change_password', 'last_login_at', 'last_login_ip',
'locale', 'address', 'tax_id', 'internal_notes'` to `clients` and add `api_keys: ['created_by']`.

### 3.3 Vocabulary this feature adds (LEAD-DECISIONS § 3)

| Kind | New | Where |
|---|---|---|
| Permissions | `clients:security`, `api_keys:create`, `api_keys:update` | they exist once a contract declares them (`src/modules/identity/security/permissions-catalog.ts`); roles holding `clients:*` or `api_keys:*` get them through the grammar |
| Error codes | none | reuse `NOT_ACTIVE`, `TWOFA_NOT_ENABLED`, `EMAIL_TAKEN`, `ALREADY_REVOKED`, `CONFLICT`, `RATE_LIMITED`, `WEAK_PASSWORD`, `INVALID_TRANSITION` |
| Audit entity words | none | every row uses `merchant` or `staff` |
| Settings keys | none | |
| Cache key families | none | reuse `identity:session`, `identity:api-key`, `ratelimit` |
| Rate limiter | `account-mail`: 5 points per 3600 s, no block | `src/infra/rate-limit/limiters.ts`, the names list in `rate-limit.service.spec.ts:25-37`, one line in `docs/decisions/021-rate-limiting.md` |
| Config | `CONSOLE_BASE_URL` → `config.http.consoleBaseUrl` (dev default `http://localhost:5173`, required in production, trailing slashes removed) | `src/config/env.ts`, `.env.example`, the five fixtures of § 1 item 4 |
| Outbox event types | `staff.invited`, `staff.password_reset` (queue `notifications`, payload `{ tokenId }`, aggregate `staff_users`) | `docs/queues.md` |
| Notification events | merchant: `merchant.approved`, `merchant.suspended`, `merchant.reactivated`, `merchant.kyc_approved`, `merchant.kyc_rejected`, `merchant.security_notice`; staff: `staff.invited`, `staff.password_reset` | registered by identity at boot (§ 6) |
| Queues, jobs | no new queue; two processors on `notifications` | § 5.4 |
| Map additions | 8 rows in `scripts/map-additions/20.mjs` | § 4.4 |

### 3.4 The merchant sign-in step, in one reusable place

`src/modules/identity/domain/merchant-sign-in-step.ts` becomes the single source of the step logic:

```ts
export type MerchantSignInStep = 'password' | 'totp' | 'done';
export interface MerchantSignInFacts { readonly mustChangePassword: boolean; readonly twofaEnabled: boolean }
/** Password first (a temporary password must go before anything else), then the code, then done. */
export function nextMerchantStep(facts: MerchantSignInFacts): MerchantSignInStep;
/** 'password' → 'pending_password', 'totp' → 'pending_totp', 'done' → 'active'. */
export function merchantStageOfStep(step: MerchantSignInStep): SessionStage;
```

`MerchantSignInService` gets one public method that every password-verified sign-in ends in:

```ts
/** After the credentials are proven: refuse a suspended merchant, end the stale session, open the session of the next step. */
startSession(client: Client, meta: RequestMeta, staleToken?: string): Promise<MerchantLoginResult>  // { next, session }
```

`login()` keeps its order (limiter → lookup → one argon2 verify → `401`) and then calls `startSession`. § 14 says what feature
24A reuses.

## 4. API

Conventions: camelCase JSON, ids are numbers, times ISO UTC with milliseconds, `null` not `""` for "no value" (the text
fields `company`, `phone`, `address`, `taxId`, `internalNotes` are `""` when empty, as `company` and `phone` are today).
Admin mutations need the staff session cookie and `X-CSRF-Token` (`403 CSRF_FAILED`). Every admin route also answers
`401 UNAUTHORIZED` and `403 FORBIDDEN` (naming the permission). No route here takes `Idempotency-Key` (no money moves; a
repeat is harmless, see § 7.3). No route here uses Turnstile. Every `/client` session route also answers
`403 ACCOUNT_SUSPENDED` and `403 IP_NOT_ALLOWED`.

### 4.1 Existing routes, changed additively

**`GET /admin/clients`, `GET /admin/clients/:id`, `POST /admin/clients`, `PATCH /admin/clients/:id`: the row grows.**
All new keys are `.optional()` in `ClientRow` and **always sent** by the server (§ 1 item 1). Update the comment at
`clients.contracts.ts:20` and `CLIENT_EXAMPLE` (the example must carry every new key).

```ts
locale: z.enum(CLIENT_LOCALES).optional(),          // 'en' | 'ar'
address: z.string().optional(),
taxId: z.string().optional(),
internalNotes: z.string().optional(),
telegramLinked: z.boolean().optional(),             // clients.telegram_chat_id is not null; never the chat id
security: z.object({
  hasPassword: z.boolean(),                         // password_hash is not null
  mustChangePassword: z.boolean(),
  passwordChangedAt: zIsoDateTime.nullable(),
  twofaEnabled: z.boolean(),
  lastLoginAt: zIsoDateTime.nullable(),
  lastLoginIp: z.string().nullable(),
  activeSessions: z.number().int().min(0),          // live, fully signed-in sessions (the rule of GET /admin/sessions)
  linkSentAt: zIsoDateTime.nullable(),              // created_at of the newest open (unused, unexpired) invite or reset link
  verificationSentAt: zIsoDateTime.nullable(),      // same for the newest open verify_email link
}).optional(),
suspension: z.object({
  at: zIsoDateTime.nullable(),
  reason: z.string().nullable(),
  by: PersonRef.nullable(),
}).nullable().optional(),                            // null unless status is 'suspended'
```

No new filter or sort on the list. `wallet` and `stats` keep their `wallet:read` rule.

**`PATCH /admin/clients/:id` (`clients:update`): the body grows.** New optional keys, the "details":

| Key | Rule |
|---|---|
| `name` | trimmed, 1-120 characters (inner whitespace collapsed by the use case; empty after that is `422` on `name`) |
| `company` | trimmed, ≤ 160 |
| `phone` | trimmed, ≤ 40 |
| `country` | two letters, upper-cased (`MerchantCountry` of `merchant-auth.contracts.ts:17-21`) |
| `email` | `EmailField` (`src/modules/identity/contracts/shared.ts`) |
| `locale` | `'en' | 'ar'` |
| `address` | trimmed, ≤ 300 |
| `taxId` | trimmed, ≤ 40 |
| `internalNotes` | trimmed, ≤ 2000 |

Rules: a call is **one** of three kinds: a status change (`status`, with `reason` when suspending), a group move (`groupId`), or
details (any of the nine keys above, several at once). Mixing kinds is `422` on the first key of the second kind ("Send one
change at a time: a status, a group or details."). The body refine becomes "Send a status, a group or details.". `reason`
without `status: 'suspended'` is ignored as today. New error codes on the contract: `EMAIL_TAKEN` (409), `RATE_LIMITED`
(429). `status: 'suspended'` is now also accepted from `pending` (§ 5.2). Answer: the updated row. Audit: `edited details of`
(entity `merchant`, before and after hold only the keys that changed; a call that changes nothing still writes the row with
empty before and after, because the audit enforcement interceptor demands a row for every staff write).

**`GET /admin/sessions` (`sessions:read`): one more filter.** `subjectId: { type: 'id', ops: ['eq'] }`. It needs
`subjectType` in the same request, else `422` on `subjectId` ("Send subjectType together with subjectId."), because ids of
staff and merchants overlap. No other change.

**`DELETE /admin/sessions/:id`: the audit row of a merchant's session moves under the merchant** (§ 5.1.6). Wire unchanged.

**`POST /admin/kyc-submissions/:id/decide`: the audit row moves under the merchant and the merchant is mailed** (§ 5.2.5).
Wire unchanged.

**`POST /admin/staff`, `POST /admin/staff/:id/password`: the mail is now really sent** (§ 5.3). The password route gains the
error `RATE_LIMITED` (429) for the link mode. Wire otherwise unchanged; update both descriptions.

**`GET /admin/clients/:id/api-keys`, `GET /client/api-keys`, `POST /client/api-keys`, `PATCH /client/api-keys/:id`: the key row
grows.** `createdByStaff: z.boolean().optional()` (always sent; true when `api_keys.created_by` is not null).

**`POST /client/auth/login`: `next` may be `'password'`.** `MerchantNext = z.enum(['password', 'totp', 'done'])`.
`'password'` opens a `pending_password` session (10 minutes) that can call only `POST /client/auth/password/change` and
`POST /client/auth/logout`. Update the description.

**`POST /client/auth/logout`:** `sessionStages: ['pending_password', 'pending_totp', 'active']`.

**`GET /client/auth/me`, `PATCH /client/profile`: `Me` grows** (required keys; no console fixture exists for `/client`
routes): `locale: 'en' | 'ar'`, `address: string`, `taxId: string`, `mustChangePassword: boolean`. Update
`MERCHANT_ME_EXAMPLE`. **`PATCH /client/profile` body** gains optional `locale`, `address` (≤ 300), `taxId` (≤ 40).

### 4.2 New admin routes

All: surface `admin`, access `staff-permission`, tags `['clients']`, params `{ id: zIdParam }`.

**R1 `POST /admin/clients/:id/password`** · permission `clients:security` · `Cache-Control: no-store`
- Body `{ mode: 'reset_link' | 'temporary_password', revokeSessions: boolean (default false) }`.
- `200` `{ temporaryPassword?: string, link?: 'invite' | 'reset' }`: `link` for the link mode (which mail was sent),
  `temporaryPassword` (14 characters, shown once) for the temporary mode.
- Errors: `NOT_FOUND` (404), `VALIDATION_FAILED` (422), `NOT_ACTIVE` (409: the merchant is suspended; detail "This merchant is
  suspended. Reactivate the account first."), `RATE_LIMITED` (429, link mode only: `account-mail`, key
  `client:<id>:password_link`).
- Audit (entity `merchant`): `sent a password reset link to` / `resent the invitation of` / `set a temporary password for`,
  `after: { credential: 'reset link emailed' | 'invitation emailed' | 'temporary password set', revokeSessions, sessionsEnded }`.

**R2 `POST /admin/clients/:id/reset-2fa`** · `clients:security` · no body · `204`
- Errors: `NOT_FOUND`, `TWOFA_NOT_ENABLED` (409).
- Audit: `reset 2FA of`, `before: { twofaEnabled: true }`, `after: { twofaEnabled: false, sessionsEnded }`.

**R3 `POST /admin/clients/:id/sessions/revoke`** · `clients:security` · no body · `204`
- Errors: `NOT_FOUND`. Ends every session, a sign-in step in progress included; zero sessions is still `204`.
- Audit: `signed out all devices of`, `before: { sessions: n }`, `after: { sessions: 0 }`.

**R4 `POST /admin/clients/:id/verify-email/resend`** · `clients:security` · no body · `204`
- Errors: `NOT_FOUND`, `CONFLICT` (409: "This email address is already verified."), `NOT_ACTIVE` (409: suspended),
  `RATE_LIMITED` (429: `account-mail`, key `client:<id>:verification`, shared with the merchant's own resend).
- Audit: `sent a verification email to`, `after: { email }`.

**R5 `POST /admin/clients/:id/api-keys`** · permission `api_keys:create` · `Cache-Control: no-store` · tags `['clients']`
- Body `{ name (1-60), scopes (1-20 strings, the rule of `checkScopes`), allowedIps? (≤ 20), expiresAt? (ISO, future),
  rateLimitPerMin? (integer 1-6000, default 60) }`.
- `201` `{ key: ApiKeyRow, secret: string }` (the full key, shown once).
- Errors: `NOT_FOUND`, `NOT_ACTIVE` (409: the merchant is not `active`; a key of a pending or suspended merchant cannot be
  used anyway), `VALIDATION_FAILED` (422 on `scopes.N`, `allowedIps.N`, `expiresAt`, `rateLimitPerMin`, or `name` when the
  merchant already holds 10 live keys).
- Audit: `created API key for`, `after: { keyId, name, prefix, scopes, allowedIps, rateLimitPerMin, expiresAt }` (never the
  key).

**R6 `PATCH /admin/api-keys/:id`** · permission `api_keys:update` · params `{ id }` = the key id
- Body `{ rateLimitPerMin?: integer 1-6000, allowedIps?: string[] (≤ 20; [] removes the restriction) }`, at least one.
- `200` `ApiKeyRow`.
- Errors: `NOT_FOUND`, `ALREADY_REVOKED` (409), `VALIDATION_FAILED` (422 on `allowedIps.N`, `rateLimitPerMin`).
- Audit: `changed limits of API key of`, `before` and `after`: `{ keyId, name, prefix, rateLimitPerMin, allowedIps }`.

### 4.3 New merchant routes

**R7 `POST /client/auth/password/change`** · surface `client`, access `merchant-session`,
`sessionStages: ['pending_password']`, `pendingMerchant: 'allow'`, tags `['auth']` · `Cache-Control: no-store`
- Needs the `X-CSRF-Token` of the pending session (the login answer carries it).
- Body `{ password: string (1-1024) }` (the new password; the temporary one was proven when the session was opened).
- `200` `{ next: 'totp' | 'done' }` with **new** session cookies and `X-CSRF-Token`: the pending session is rotated to
  `pending_totp` (the merchant has 2FA on) or to a full session.
- Errors: `WEAK_PASSWORD` (422 on `password`: policy, or the password in use), `VALIDATION_FAILED` (422), `UNAUTHORIZED`
  (401: no such pending session, or the account no longer needs the change), `ACCOUNT_SUSPENDED` (403), `CSRF_FAILED` (403),
  `IP_NOT_ALLOWED` (403), `RATE_LIMITED` (429: limiter `sign-in`, the per-account `password` counter of
  `merchant-sign-in-limiter.ts:101-103`).
- No audit row (merchant routes write none, B121).

**R8 `POST /client/auth/verify-email/resend`** · access `merchant-session` (full session), `pendingMerchant: 'allow'`, tags
`['auth']` · no body · `204`
- Errors: `CONFLICT` (409: already verified), `UNAUTHORIZED`, `ACCOUNT_SUSPENDED`, `CSRF_FAILED`, `IP_NOT_ALLOWED`,
  `RATE_LIMITED` (429: `account-mail`, key `client:<id>:verification`).
- A session route, so it reveals nothing about other accounts. There is no public resend route.

### 4.4 Map additions (`scripts/map-additions/20.mjs`, LEAD-DECISIONS § 2)

Eight rows in the map's `R(surface, group, method, path, text, auth, stage, tables)` shape, plus per row the English
description, `module: 'identity'`, the decision tag and, for console-called routes, `successStatus`. **Use the exact export
shape W0's loader documents** (W0 was not built when this plan was written); the data is:

| Surface, group | Method, path | Arabic text (map vocabulary) | Auth text | Stage | Tables | English description | Tag | successStatus |
|---|---|---|---|---|---|---|---|---|
| admin, clients | `POST /admin/clients/:id/password` | رابط تعيين كلمة مرور أو دعوة جديدة للتاجر، أو كلمة مؤقتة تُفرض تغييرها بأول دخول | `clients:security` | 2 | clients, auth_tokens, sessions, notifications, audit_logs | Send a merchant a set-password or invitation link, or set a temporary password that must be changed at the next sign-in. | `B-TBD merchant-admin-security` | 200 |
| admin, clients | `POST /admin/clients/:id/reset-2fa` | إعادة ضبط 2FA لتاجر وإنهاء جلساته | `clients:security` | 2 | clients, sessions, audit_logs | Turn off a merchant's two-factor sign-in and end their sessions. | same | 204 |
| admin, clients | `POST /admin/clients/:id/sessions/revoke` | إنهاء كل جلسات تاجر | `clients:security` | 2 | sessions, audit_logs | Sign a merchant out of every device. | same | 204 |
| admin, clients | `POST /admin/clients/:id/verify-email/resend` | إعادة إرسال إيميل تفعيل البريد للتاجر | `clients:security` | 2 | clients, auth_tokens, notifications, audit_logs | Send the merchant a new email verification link. | `B-TBD merchant-verification-resend` | 204 |
| admin, clients | `POST /admin/clients/:id/api-keys` | إنشاء مفتاح API لتاجر من اللوحة، يُعرض مرة واحدة | `api_keys:create` | 7 | api_keys, audit_logs | Create an API key for a merchant; the key is shown once. | `B-TBD staff-api-keys` | 201 |
| admin, clients | `PATCH /admin/api-keys/:id` | تعديل حدود مفتاح تاجر: المعدّل بالدقيقة والعناوين المسموحة | `api_keys:update` | 7 | api_keys, audit_logs | Change a merchant key's per-minute limit and allowed addresses. | same | 200 |
| client, auth | `POST /client/auth/password/change` | تغيير كلمة السر المؤقتة قبل إكمال الدخول | `جلسة` | 2 | clients, sessions | Replace a temporary password during sign-in. | `B-TBD merchant-forced-password` | (not a console route) |
| client, auth | `POST /client/auth/verify-email/resend` | إعادة إرسال إيميل تفعيل البريد | `جلسة` | 2 | clients, auth_tokens, notifications | Send the signed-in merchant a new email verification link. | `B-TBD merchant-verification-resend` | (not a console route) |

If W0's tooling wants new keys in `test/contract/pending.ts` until they are built, add them in slice A0 and delete each when
its route is built; the branch ends with none of them pending.

## 5. Use cases (one transaction each)

Shared helpers used below:

- `accountMailKey(subject: 'client' | 'staff', id: number, kind: string)`: a pure function in the new
  `src/modules/identity/domain/account-mail.ts` that returns `RateLimitService.compositeKey(subject, String(id), kind)`. Callers
  run `RateLimitService.enforce('account-mail', key)` **before** opening the transaction, after the cheap refusals (404,
  wrong state), so a refused call spends no point.
- `MerchantLifecycleMails` (new, `src/modules/identity/application/mail/merchant-lifecycle-mails.ts`, provided and exported by
  `MerchantMailModule`): wraps `NotificationService.enqueue({ tx }, …)` (`notification.service.ts:108-136`) for the six
  merchant events of § 6. It writes the `notifications` row and the `notification.send` outbox event in the caller's
  transaction, with no `dedupeKey` (the guarded change it rides on happens once). It injects `APP_CONFIG` for
  `portalBaseUrl`. A skipped result (`no_template`, `template_off`) is not an error.
- Lock order for every staff action on a merchant: **`clients` row `FOR UPDATE` first** (`lockClient`), then anything else
  (the `api-keys:<clientId>` advisory lock, an `api_keys` row, `auth_tokens` writes, `sessions` writes). No use case locks two
  merchants.

### 5.1 Slice A: staff security tools

**5.1.1 The row (`ClientViews`).** Move `ClientView`, `viewOf`, `viewsOf` and `toView` out of `client-admin.service.ts`
(`:41-59`, `:330-386`) into the new `src/modules/identity/application/client-views.ts` (an injectable `ClientViews` with `one(db,
caller, id)` and `many(db, caller, rows)`), and extend it:
- `src/modules/identity/infra/client-admin.repository.ts`: `selectRows` (`:29-34`) also selects the suspender (left join of an
  alias of `staff_users` on `clients.suspended_by`) and two correlated subqueries that take the clock's `now` as a parameter:
  `linkSentAt` = `max(created_at)` of the merchant's `auth_tokens` with `subject_type = 'client'`, `purpose in ('invite','reset')`,
  `used_at is null`, `expires_at > now`; `verificationSentAt` the same for `purpose = 'verify_email'`. Both use the index
  `auth_tokens_subject_idx` (`schema.ts:355`). `findClientRow(db, id, now)` and `listClientRows(db, query, now)` take `now`.
- `src/modules/identity/infra/session-admin.repository.ts`: add `countLiveSessionsOf(db, subjectType, ids, now, idle)` (the
  body of `countLiveStaffSessions`, `:101-121`, with the subject type as a parameter) and make the staff function call it.
  `ClientViews.many` calls it once per page with `await idleLimitsOf(this.policy)`
  (`src/modules/identity/application/idle-limits.ts`, as `staff-admin.service.ts:485-492` does).
- `MerchantAuthTokens.issue` (`merchant-auth-tokens.ts:70-78`): pass `createdAt: now` (the clock), like the staff tokens.

**5.1.2 Edit details** (`PATCH /admin/clients/:id`, details kind). New pure file
`src/modules/identity/domain/client-details.ts`:
- `kindOfClientChange(input)` → `'status' | 'group' | 'details'`, or the field error of § 4.1 for a mixed or empty body.
- `detailChanges(client, input)` → `{ columns, before, after, emailChanged, nameChanged }`: compares with the **locked** row
  (name with collapsed whitespace; email lower-case against `client.email.toLowerCase()`); a key equal to the stored value is
  not a change.

`ClientAdminService.update` (`:174-185`) dispatches on the kind. For details it calls the new
`ClientDetailsEditor.apply(work, caller, client, input)` (`src/modules/identity/application/client-details-editor.ts`):
1. Before the transaction (in `update`): when `input.email` differs from the stored email (plain read), enforce
   `account-mail` with `accountMailKey('client', id, 'email_change')`.
2. In the transaction, after `lockClient`: compute `detailChanges`. When `columns` is not empty, `updateClientRow`; an email
   change also writes `emailVerifiedAt: null`. Map a unique violation of `clients_email_uq` to `409 EMAIL_TAKEN`
   (`isUniqueViolation`, as `client-admin.service.ts:217-220`).
3. On an email change: `voidOpenClientTokens(tx, id, CLIENT_TOKEN_PURPOSES, now)` (every open link dies: a verification link
   carries no email snapshot, so an old one would mark the new address as proven). Then, unless the merchant is suspended,
   send one mail to the new address: when `password_hash` is null, `MerchantAuthTokens.issue({ purpose: 'invite', createdBy,
   ip })` + `MerchantMailOutbox.enqueue({ kind: 'invited' })`; otherwise `issue({ purpose: 'verify_email', … })` +
   `enqueue({ kind: 'email_verification' })`. Sessions stay.
4. When the name or the email changed: `sessions.invalidateSubject('client', id, work)` and
   `apiKeys.invalidateClient(id, work)` (both cached views hold the name: `subject-resolvers.ts:55-66`, `api-key.rules.ts`).
5. `audit.record`: `edited details of`, entity `merchant`, `before`/`after` of the changed keys (an email change adds
   `emailVerified: false` to `after`).

**5.1.3 Password** (R1). New `src/modules/identity/application/client-security-admin.service.ts`
(`ClientSecurityAdminService.setPassword(caller, id, input)`):
1. Read the merchant (`findClientById`): none → `NOT_FOUND`; suspended → `NOT_ACTIVE`.
2. Link mode: enforce `account-mail` (`client:<id>:password_link`). Temporary mode: `temporaryPasswordFor(randomInt, { email,
   name })` (`src/modules/identity/domain/temporary-password.ts:48-57`) and hash it with `PasswordHasher` **before** the
   transaction (argon2 takes tens of milliseconds).
3. Transaction: `lockClient`; check `NOT_FOUND` and `NOT_ACTIVE` again under the lock.
   - Link: `purpose = client.passwordHash === null ? 'invite' : 'reset'`; `MerchantAuthTokens.issue(work, { clientId, purpose,
     createdBy: caller.staffId, ip: caller.ip })` (it voids the older invite and reset links); `MerchantMailOutbox.enqueue(work,
     { kind: purpose === 'invite' ? 'invited' : 'password_reset', clientId, tokenId })`. The clear token returned by `issue` is
     never used: the mail job makes the real one (`merchant-mail-jobs.ts:153-154`).
   - Temporary: `updateClientRow(tx, id, { passwordHash, mustChangePassword: true, passwordChangedAt: now })`;
     `voidOpenClientTokens(tx, id, PASSWORD_LINK_PURPOSES, now)` (an older link must not undo it);
     `lifecycleMails.securityNotice(work, client, 'temporary_password')`.
   - `sessionsEnded = input.revokeSessions ? await sessions.revokeAllOf('client', id, {}, work) : 0`.
   - `audit.record` as § 4.2 R1.
4. Answer `{ link: purpose }` or `{ temporaryPassword }`. The controller sets `@Header('Cache-Control', 'no-store')`.

**5.1.4 Reset 2FA** (R2). Transaction: `lockClient` → `NOT_FOUND`; `!twofaEnabled` → `TWOFA_NOT_ENABLED`;
`updateClientRow(tx, id, { twofaEnabled: false, totpSecretEnc: null, totpLastStep: null })` (the three columns
`disableClientTwoFactor` clears, `merchant-auth.repository.ts:253-260`); `revokeAllOf('client', id, {}, work)`;
`lifecycleMails.securityNotice(work, client, 'twofa_reset')`; audit.

**5.1.5 End all sessions** (R3). Transaction: `lockClient` → `NOT_FOUND`; `n = await sessions.revokeAllOf('client', id, {},
work)`; audit with `n`.

**5.1.6 Resend verification by staff** (R4). Read: `NOT_FOUND`; `emailVerifiedAt !== null` → `CONFLICT`; suspended →
`NOT_ACTIVE`. Enforce `account-mail` (`client:<id>:verification`). Transaction: `lockClient`, same checks again, `issue({
purpose: 'verify_email', createdBy, ip })`, `enqueue({ kind: 'email_verification' })`, audit.

**5.1.7 Sessions.** `sessions.contracts.ts:34`: add the `subjectId` filter; `session-admin.repository.ts:19-24`: add
`subjectId: sessions.subjectId` to `COLUMNS`. `SessionAdminService.list` answers `422` on `subjectId` when the parsed filters
hold `subjectId` without `subjectType`. `SessionAdminService.remove` (`session-admin.service.ts:71-87`): when the session
belongs to a merchant, the audit row is `{ action: 'ended a session of', entityType: 'merchant', entityId:
found.session.subjectId, entityLabel: merchant name, before: { sessionId, ip }, after: { ended: true } }`; a staff session
keeps today's row.

### 5.2 Slice B: forced change, verification resend, suspension hardening, lifecycle mails

**5.2.1 Sign-in.** `MerchantSignInService.startSession` (§ 3.4) holds lines `:91-106` of today's `login`: suspended →
`403 ACCOUNT_SUSPENDED`; end the stale session; `next = nextMerchantStep({ mustChangePassword: client.mustChangePassword,
twofaEnabled: client.twofaEnabled })`; `sessions.create({ stage: merchantStageOfStep(next) })`; when `next === 'done'`,
`recordClientSignIn(db, id, now, meta.ip)` (new repository function: writes `last_login_at`, `last_login_ip`).
`login` keeps the limiter reset and the hash upgrade before it. `verifyTwoFactor` (`:120-145`) calls `recordClientSignIn`
inside its transaction after `acceptClientSignInStep`.

**5.2.2 Forced change** (R7). `MerchantPasswordService.changeForced(principal, password, meta)`:
1. `limiter.enforcePasswordChange(principal.clientId)` (5 tries per 15 minutes per account).
2. `client = await reader.current(clientId)` (`401` when gone; `403` and all sessions revoked when suspended).
3. `principal.stage !== 'pending_password' || !client.mustChangePassword` → `UNAUTHORIZED` (the account moved on).
4. `checkPasswordPolicy(password, { email, name })` → `WEAK_PASSWORD` on `password`; the password in use
   (`hasher.verify(client.passwordHash, password)`) → `WEAK_PASSWORD` "Choose a password you are not using now.". Hash the new
   one (before the transaction).
5. Transaction:
   - `saveForcedClientPassword(tx, { id, passwordHash, now })` (new): `UPDATE clients SET password_hash, password_changed_at =
     now, must_change_password = false WHERE id = $1 AND status <> 'suspended' AND must_change_password = true RETURNING
     twofa_enabled`. No row → `UNAUTHORIZED` (a parallel request won, or a suspension landed).
   - `voidOpenClientTokens(tx, id, PASSWORD_LINK_PURPOSES, now)`.
   - `sessions.revokeAllOf('client', id, { exceptSessionId: principal.session.id }, work)`.
   - `next = nextMerchantStep({ mustChangePassword: false, twofaEnabled })` (`'totp'` or `'done'`);
     `issued = await sessions.rotate(principal.session, { stage: merchantStageOfStep(next), ip, userAgent }, work)` (the old
     token dies: no fixation; `rotate` throws `UNAUTHORIZED` when the session was ended meanwhile).
   - `next === 'done'` → `recordClientSignIn(tx, …)`.
6. `limiter.resetPasswordChange(clientId)`; return `{ next, session: issued }`. The controller sets the cookies
   (`SessionCookies.set(reply, 'client', …)`, as `merchant-auth.controller.ts:112`) and answers `{ next }`.

**5.2.3 Every chosen password clears the flag.** `saveClientPassword` (`merchant-auth.repository.ts:104-115`) also sets
`mustChangePassword: false`. So a reset link, an invitation link and `POST /client/security/password` all end a forced change.

**5.2.4 Verification.** `MerchantRegistrationService.resendVerification(principal)` (R8): `reader.current`; verified →
`CONFLICT`; enforce `account-mail` (`client:<id>:verification`); transaction: `MerchantAuthTokens.issue({ purpose:
'verify_email', ip })` (voids the older verification link) + `MerchantMailOutbox.enqueue({ kind: 'email_verification' })`.
`verifyEmail` (`merchant-registration.service.ts:118-130`): after the link is found usable, read the merchant; gone or
suspended → `410 TOKEN_INVALID`.

**5.2.5 Status changes and KYC.**
- `src/modules/identity/domain/client-rules.ts:6-10`: `pending: ['active', 'suspended']`. Suspending a pending applicant is
  how staff decline an application (§ 12, O-4). The reason rule is the same (3-140 characters).
- `changeStatus` (`client-admin.service.ts:254-295`), all inside the existing transaction:
  - suspending: after `revokeAllOf`, `voidOpenClientTokens(tx, id, CLIENT_TOKEN_PURPOSES, now)`; then
    `lifecycleMails.suspended(work, client)`.
  - approving (`pending → active`): `lifecycleMails.approved(work, client)`.
  - reactivating (`suspended → active`): `lifecycleMails.reactivated(work, client)`.
  - audit phrases unchanged (`suspended merchant`, `approved merchant`, `reactivated merchant`); the `before.status` tells a
    declined application (`pending`) from a suspension (`active`).
- `KycService.decide` (`kyc.service.ts:114-143`): in its transaction, after `setClientKycStatus`, call
  `lifecycleMails.kycDecided({ tx }, { clientId, decision, note })`; and file the audit row under the merchant:
  `{ action: 'approved verification of' | 'rejected verification of', entityType: 'merchant', entityId: current.clientId,
  entityLabel: name, before: { kycStatus: 'pending' }, after: { kycStatus: status, note, submissionId: id } }`.

**5.2.6 The merchant's own profile.** `ClientProfilePatch` and `saveClientProfile` (`merchant-auth.repository.ts:134-165`)
take `locale`, `address`, `taxId`; `MerchantMe` and `describe` (`merchant-account.service.ts:13-28,74-94`) add `locale`,
`address`, `taxId`, `mustChangePassword`. Fix the known nit: when `name` changed, `MerchantAccountService.updateProfile` calls
`sessions.invalidateSubject('client', id)` and `apiKeys.invalidateClient(id)`.

**5.2.7 Mail language.** `notification-foreign-reads.ts:58-82`: select `s.clients.locale` and return it instead of `'en'`.
`findTemplateFor` already falls back to English when a language has no active template.

### 5.3 Slice C: staff invitation and reset mails

Copy the merchant mail design (`merchant-mail-outbox.ts`, `merchant-mail-jobs.ts`, `merchant-mail.processors.ts`) for staff:

- `src/modules/identity/application/mail/staff-mail-outbox.ts`: `STAFF_MAIL_EVENTS = { invited: 'staff.invited',
  password_reset: 'staff.password_reset' }`; `StaffMailOutbox` registers both types with the `notifications` queue in
  `onModuleInit` and `enqueue(work, { kind, staffId, tokenId })` writes `outbox_events` (`aggregateType: 'staff_users'`,
  `aggregateId: staffId`, `payload: { tokenId }`).
- `src/modules/identity/infra/auth-token.repository.ts`: add `findStaffTokenById(db, id)` and `rotateStaffToken(db, id,
  tokenHash, now)` (the guarded update of `rotateClientToken`, `merchant-token.repository.ts:108-122`, with
  `subject_type = 'staff'`).
- `src/modules/identity/application/mail/staff-mail-jobs.ts`: `StaffMailJobs.handle(kind, job)`, the same steps as
  `MerchantMailJobs.decide` (`merchant-mail-jobs.ts:114-184`): re-read the staff member (gone → `staff_gone`; suspended →
  `staff_suspended`: a suspended member's link is dead anyway, `staff-password.service.ts:87`); re-read the token (subject,
  purpose `invite` for `invited` and `reset` for `password_reset`, unused, not expired) → `link_not_usable`;
  `notifications.statusOf('outbox-<eventId>:email')` (`sent`/`failed` → skip, never rotate a delivered link);
  `notifications.check` (no template → skip without rotating); rotate; `notifications.sendNow({ event, recipient: { type:
  'staff', id }, channel: 'email', variables: { staffName, expiresAt }, dedupeKey: 'outbox-<eventId>:email' }, { link:
  staffMailLink(config.http.consoleBaseUrl, token) }, attempts)`. `staffMailLink` = `<consoleBaseUrl>/set-password?token=<encoded>`
  (the console page exists: `FA/src/features/auth/paths.ts:7`). A skipped retry abandons the queued row
  (`notifications.abandon`), as the merchant job does.
- `src/modules/identity/jobs/staff-mail.processors.ts`: two `@QueueProcessor('notifications', …)` classes.
- `src/modules/identity/staff-mail.module.ts`: `StaffMailModule` (`imports: [NotificationDeliveryModule]`, providers: outbox,
  jobs, both processors; exports the outbox). `AccessAdminModule` imports it; `src/modules/identity/index.ts` exports it;
  `src/worker.module.ts` imports it (one name in the identity import list at `:21-26`, one line in `imports` after
  `MerchantMailModule` at `:68`). Without the worker import the events would stay `unmapped_type`: a wiring test guards it.
- `StaffAdminService.create` (`:179-186`): keep the issued token's `id` and call `staffMail.enqueue(work, { kind: 'invited',
  staffId: created.id, tokenId })`. `setPassword` (`:291-298`): the same with `kind: purpose === 'invite' ? 'invited' :
  'password_reset'`; before its transaction, for the link mode, enforce `account-mail` with
  `accountMailKey('staff', id, 'password_link')`.
- Update the two contract descriptions in `src/modules/identity/contracts/staff.contracts.ts` (the mail is sent to the member's
  address; add `RATE_LIMITED` to the password route).

### 5.4 Slice D: API keys by staff

- New `src/modules/identity/application/api-key-issuer.ts` (`ApiKeyIssuer.issue(tx, input)`): the body of
  `MerchantApiKeyService.create` from the checks to the insert (`merchant-api-key.service.ts:100-127`): `checkScopes`,
  `checkAllowedIps`, the expiry in the future, `composeApiKey(tokens.random(32))`, `lockKeysOfClient`, the 10-live-keys rule,
  `insertKey` with `rateLimitPerMin` and `createdBy`. Input: `{ clientId, name, scopes, allowedIps, expiresAt, rateLimitPerMin,
  createdBy }`. It returns `{ row, secret }`. `MerchantApiKeyService.create` calls it with `DEFAULT_RATE_LIMIT_PER_MIN` and
  `createdBy: null`; its behaviour and messages do not change.
- `src/modules/identity/domain/api-key-input.ts`: `RATE_LIMIT_PER_MIN_RANGE = { min: 1, max: 6000 } as const`; `ApiKeyColumns`
  and `ApiKeyWire` gain `createdBy` / `createdByStaff`; `apiKeyToWire` sets `createdByStaff: row.createdBy !== null`.
- `ApiKeyAdminService.create(caller, clientId, input)` (R5): one transaction: `lockClient(tx, clientId)` → `NOT_FOUND`;
  `status !== 'active'` → `NOT_ACTIVE`; `issuer.issue(tx, { …, createdBy: caller.staffId })` (a full merchant gets `422` on
  `name`: "This merchant already has 10 active keys; revoke one first."); `lifecycleMails.securityNotice(work, client,
  'api_key_created')`; audit. The controller sets `no-store`.
- `ApiKeyAdminService.update(id, input)` (R6): validate `allowedIps` with `checkAllowedIps` first; transaction: `lockKey` →
  `NOT_FOUND`; `revokedAt !== null` → `ALREADY_REVOKED`; `updateKey` (extend it with `rateLimitPerMin`,
  `api-key-manage.repository.ts:130-145`); `directory.invalidate([row.keyHash], work)` (the cached view holds both values);
  audit with before and after.
- `ApiKeysModule` imports `MerchantMailModule` (for `MerchantLifecycleMails`) and provides `ApiKeyIssuer`.

## 6. Mail events and templates

New file `src/modules/identity/application/mail/identity-mail-events.ts`: `IDENTITY_MAIL_EVENTS:
NotificationEventDefinition[]` (the type is exported by the platform, `notification-events.ts:13-38`). A provider
`IdentityMailEventRegistration` in `MerchantMailModule` registers them in `onModuleInit`
(`NotificationEventRegistry.register`, the support pattern). `MerchantMailModule` is loaded by the API and the worker, so
both processes know the events.

| Key | Audience | Channels | Transactional | Variables (sample) |
|---|---|---|---|---|
| `merchant.approved` | merchant | email | yes | `merchantName` (Zain Mobile Hub), `portalUrl` (https://shop.example.com/merchant) |
| `merchant.suspended` | merchant | email | yes | `merchantName` |
| `merchant.reactivated` | merchant | email | yes | `merchantName`, `portalUrl` |
| `merchant.kyc_approved` | merchant | email | yes | `merchantName` |
| `merchant.kyc_rejected` | merchant | email | yes | `merchantName`, `reason` (The photo of the document is not readable.) |
| `merchant.security_notice` | merchant | email | yes | `merchantName`, `change` (a temporary password was set for your account) |
| `staff.invited` | staff | email | yes | `staffName` (Nadia Hamdan), `link` (https://admin.example.com/set-password?token=example), `expiresAt` (2026-11-01 11:00 UTC) |
| `staff.password_reset` | staff | email | yes | `staffName`, `link`, `expiresAt` |

All have `defaultEmail: true`, `defaultTelegram: false`. Transactional means: always sent, never in the merchant's
preferences (so the site's preference list does not change), and delivered to a suspended recipient (needed for
`merchant.suspended`). `portalUrl` is `config.http.portalBaseUrl` (not a secret). The suspension mail does **not** carry the
staff reason (it is an internal note; § 12, O-4). The KYC rejection mail carries the staff note, which the merchant already
reads in `GET /client/kyc`.

`merchant.security_notice` is sent after three staff actions; `change` is a fixed phrase chosen by the merchant's `locale`
(a constant map in `merchant-lifecycle-mails.ts`):

| Kind | `en` | `ar` |
|---|---|---|
| `temporary_password` | a temporary password was set for your account; you will choose a new one when you sign in | تم تعيين كلمة مرور مؤقتة لحسابك، وستختار كلمة جديدة عند تسجيل الدخول |
| `twofa_reset` | two-factor sign-in was turned off for your account | تم إيقاف التحقق بخطوتين لحسابك |
| `api_key_created` | a new API key was created for your account | تم إنشاء مفتاح API جديد لحسابك |

New file `src/modules/identity/application/mail/identity-templates.ts`: `IDENTITY_DEFAULT_TEMPLATES: readonly DefaultTemplate[]`
(14 rows: `en` and `ar` for the six merchant events, `en` for the two staff events), `identityTemplatesSql()` (the generator of
`support-templates.ts:62-73`) and `IDENTITY_TEMPLATES_MIGRATION`. Channel `email` everywhere. Bodies are plain text.

| Event, locale | Subject | Body |
|---|---|---|
| `merchant.approved`, en | Your merchant account is approved | `Hi {{merchantName}},\n\nGood news: our team approved your merchant account. You can now add funds, place orders and create API keys.\n\nSign in here: {{portalUrl}}\n\nIf you have not chosen a password yet, use "Forgot password" on the sign-in page.` |
| `merchant.approved`, ar | تمت الموافقة على حساب التاجر الخاص بك | `مرحباً {{merchantName}}،\n\nوافق فريقنا على حساب التاجر الخاص بك. يمكنك الآن شحن الرصيد وتقديم الطلبات وإنشاء مفاتيح API.\n\nسجّل الدخول من هنا: {{portalUrl}}\n\nإذا لم تختر كلمة مرور بعد، استخدم «نسيت كلمة المرور» في صفحة تسجيل الدخول.` |
| `merchant.suspended`, en | Your merchant account is suspended | `Hi {{merchantName}},\n\nYour merchant account has been suspended. You cannot sign in, and API calls are refused, until it is reactivated. Orders that are already in progress will still be completed.\n\nIf you think this is a mistake, reply to this email or contact our support team.` |
| `merchant.suspended`, ar | تم إيقاف حساب التاجر الخاص بك | `مرحباً {{merchantName}}،\n\nتم إيقاف حساب التاجر الخاص بك. لا يمكنك تسجيل الدخول، وتُرفض طلبات الـ API، إلى أن يُعاد تفعيله. الطلبات الجارية ستُستكمل.\n\nإذا كنت تعتقد أن هذا خطأ، ردّ على هذا البريد أو تواصل مع فريق الدعم.` |
| `merchant.reactivated`, en | Your merchant account is active again | `Hi {{merchantName}},\n\nYour merchant account is active again. You can sign in and place orders: {{portalUrl}}\n\nYour earlier sessions were ended, so please sign in again.` |
| `merchant.reactivated`, ar | تمت إعادة تفعيل حساب التاجر الخاص بك | `مرحباً {{merchantName}}،\n\nأُعيد تفعيل حساب التاجر الخاص بك. يمكنك تسجيل الدخول وتقديم الطلبات: {{portalUrl}}\n\nانتهت جلساتك السابقة، لذا يُرجى تسجيل الدخول من جديد.` |
| `merchant.kyc_approved`, en | Your identity verification is approved | `Hi {{merchantName}},\n\nWe reviewed your documents and your identity verification is approved. Thank you.` |
| `merchant.kyc_approved`, ar | تمت الموافقة على توثيق هويتك | `مرحباً {{merchantName}}،\n\nراجعنا مستنداتك وتمت الموافقة على توثيق هويتك. شكراً لك.` |
| `merchant.kyc_rejected`, en | Your identity verification needs attention | `Hi {{merchantName}},\n\nWe could not approve your identity verification.\n\nReason: {{reason}}\n\nYou can upload new documents from the Verification page of your account.` |
| `merchant.kyc_rejected`, ar | توثيق هويتك يحتاج إلى مراجعة | `مرحباً {{merchantName}}،\n\nلم نتمكن من الموافقة على توثيق هويتك.\n\nالسبب: {{reason}}\n\nيمكنك رفع مستندات جديدة من صفحة التوثيق في حسابك.` |
| `merchant.security_notice`, en | A security change on your merchant account | `Hi {{merchantName}},\n\nOur support team made this change to your account: {{change}}.\n\nIf you did not ask for it, reply to this email or contact our support team at once.` |
| `merchant.security_notice`, ar | تغيير أمني في حساب التاجر الخاص بك | `مرحباً {{merchantName}}،\n\nأجرى فريق الدعم هذا التغيير على حسابك: {{change}}.\n\nإذا لم تطلب ذلك، ردّ على هذا البريد أو تواصل مع فريق الدعم فوراً.` |
| `staff.invited`, en | You were invited to the GSM admin console | `Hi {{staffName}},\n\nYou were added to the GSM admin console. Choose your password here:\n\n{{link}}\n\nThe link works once, until {{expiresAt}}. After that, ask an owner to send a new one.` |
| `staff.password_reset`, en | Choose a new password for the GSM admin console | `Hi {{staffName}},\n\nAn owner sent you a link to choose a new password:\n\n{{link}}\n\nThe link works once, until {{expiresAt}}. Your current password keeps working until you use it. If you did not expect this email, tell an owner.` |

(`\n` above is a real line break in the string.) The three existing merchant link mails keep their English templates; their
Arabic rows are feature 23's.

## 7. Risks and how the design closes each

### 7.1 Security

| Risk | Closure |
|---|---|
| A clear token or link leaks through the API, a log, the outbox or the audit log | Staff routes never return a link. The request stores a placeholder token whose clear value is dropped; the outbox carries ids; the mail job rotates the token and passes the link as a `sendNow` secret that is never stored (`merchant-mail-jobs.ts:153-166`). Staff mails copy this exactly. |
| A temporary password or key secret is cached or logged | Generated server-side, hashed before the transaction, returned once with `Cache-Control: no-store`, never in audit (`credential`, not `password`). Console: mutation `gcTime: 0`, shown in a show-once dialog, never stored. |
| `clients:security` lets staff take over a merchant (temporary password, 2FA reset), `api_keys:create` lets staff spend the wallet through the API | Three dedicated permissions, separate from `clients:update`; one audit row per action under the merchant; a `merchant.security_notice` mail to the merchant for a temporary password, a 2FA reset and a staff-made key; the temporary password forces a change at the first sign-in; a staff-made key is marked (`createdByStaff`) and listed for the merchant. Roles holding `clients:*` or `api_keys:*` receive the new permissions through the grammar: the final report tells the owner (§ 12, O-1). |
| An old link proves a new email address | An email change voids every open link of the merchant and clears `email_verified_at` (§ 5.1.2). |
| A link sent before a suspension works after a reactivation; `verify-email` works while suspended | A suspension voids every open link; `verifyEmail` refuses a suspended merchant with `410` (§ 5.2.4, § 5.2.5). |
| Mail bombing through staff or merchant resends; provider quota | Limiter `account-mail`: 5 per hour per account and kind (password link, verification, email change), for merchants and staff. Link consumption stays on the `token` limiter. |
| Enumeration | No new public route. The two new merchant routes need a session. Staff routes are authenticated (`EMAIL_TAKEN` to staff is fine). |
| Session fixation in the forced change | The pending session is rotated: new token, old one revoked in the same transaction (`session.service.ts:111-130`). |
| Forced change bypasses 2FA | The step order is password, then code: after the change the session becomes `pending_totp` when 2FA is on; `GET /client/auth/me` answers `401` until the session is `active`. |
| A pending-password session reaches other routes | Every other merchant route keeps the default `sessionStages: ['active']` (`define-route.ts:93`); only R7 and logout accept the stage. A contract test asserts it. |
| CSRF | All new mutations are session routes: the guard demands `X-CSRF-Token` (decision 018). |
| Session-ending codes about another record | Refusals about a merchant use `NOT_ACTIVE`, `CONFLICT`, `TWOFA_NOT_ENABLED`, never `ACCOUNT_SUSPENDED` (which would sign the staff member out of the console). |
| Staff see data beyond their role | The new row fields need `clients:read` (the same as today's row); `wallet`/`stats` keep `wallet:read`; the per-merchant session list needs `sessions:read`; invoices and payments on the Billing tab need their own permissions. The server checks every route. |

### 7.2 Financial integrity

No ledger write, no wallet change, no order change. Two indirect paths to money exist and are closed above: a staff-made
API key and a staff-set password both let a person act as the merchant. Controls: separate permissions, audit under the
merchant, the merchant is mailed, keys only for `active` merchants, the secret shown once. Suspension keeps its meaning: new
orders refused on every surface, open orders continue, the wallet untouched (`clients.contracts.ts:148-149`).

### 7.3 Concurrency and idempotency

| Case | Guard |
|---|---|
| Two staff act on one merchant | `lockClient` (`FOR UPDATE`) first in every use case; state is re-checked under the lock. |
| Two edits race on an email | The unique index `clients_email_uq` decides; the loser gets `409 EMAIL_TAKEN`. |
| Two forced-change requests on one pending session | The guarded `UPDATE … WHERE must_change_password = true` and `rotate`'s guarded revoke: one wins, the other gets `401`. |
| Suspension lands during a password write | `saveClientPassword` and `saveForcedClientPassword` refuse a suspended row in the `UPDATE` itself. |
| Staff create a key while the merchant creates one | Both take the `api-keys:<clientId>` advisory lock before counting (`api-key-manage.repository.ts:92-94`); the staff path takes the `clients` row lock first, the merchant path never takes it: no cycle. |
| A mail job runs twice or retries | Unchanged design: dedupe key `outbox-<eventId>:email`, `statusOf` before rotating, a retry rotates again only when nothing was delivered. Lifecycle mails are a `notifications` row written with the change: at-least-once delivery by the existing `notification.send` job. |
| A repeated staff click | Link: the newer link voids the older (the limiter caps it). Temporary password: the second replaces the first; the console shows the last answer. Key: a second key appears; the console disables the button while the request runs. No `Idempotency-Key` is needed because no money moves and every repeat is visible and reversible. |
| A sign-in overlaps a temporary password | A login verified against the old hash may open a session a few milliseconds after the change. Accepted (the same window exists for staff and customers); "sign them out" in the dialog is on by default. |

### 7.4 Performance

- List of merchants: one more grouped query per page (`countLiveSessionsOf`, served by `sessions_active_idx`), two indexed
  correlated subqueries and one left join per row. No N+1. The exact `COUNT` is unchanged.
- `GET /admin/sessions?subjectType=client&subjectId=` uses `sessions_active_idx (subject_type, subject_id)`.
- The Audit tab uses `audit_logs_entity_idx (entity_type, entity_id)`.
- Sign-in: one extra `UPDATE` (last login) per completed sign-in. No new cache; nothing about passwords, sessions or
  decisions is cached beyond today's 60-second views, which every change here invalidates after the commit.
- No new index is needed besides `api_keys_created_by_idx`.

### 7.5 Backward compatibility

| Change | Who reads it | Why nothing breaks |
|---|---|---|
| New optional keys on the merchant row and the key row | console (main checkout), fixtures | optional in the schema; shape parity reports extra backend fields without failing; old fixtures stay valid |
| `PATCH /admin/clients/:id` accepts more keys; `pending → suspended` allowed | console | the console sends only `status`/`reason`/`groupId` today; a transition that was refused is now accepted and the console never sent it |
| `next: 'password'` on merchant login | storefront | the site treats any `next` other than `totp` as done (`SF/components/auth/sign-in-flow.tsx:232-235`); with a pending session `me` answers `401` and the site returns to sign-in. Only a merchant with a temporary password meets this, and "Forgot password" still works for them. § 13 tells the site what to build; the console's dialog recommends the link until then |
| `Me` gains four keys, profile body three | storefront | additive; the site regenerates its types from `openapi.json` |
| KYC decision and merchant-session audit rows change entity | console audit page | `merchant` is one of the console's 19 words and links to the merchant; old rows stay as they are |
| `CONSOLE_BASE_URL` required in production | deploy | dev and test have a default; the final report and `.env.example` say it (24D's env template must include it) |
| Operation ids | storefront type generation | no existing route key is renamed; two new keys are added |

## 8. Backend slices (in this order, one worktree, one implementer at a time)

The slices share files (`db/schema.ts`, `client-admin.service.ts`, `merchant-mail.module.ts`), so they are never built in
parallel. If the lead uses two backend implementer calls, split them as (A0, A, D) then (B, C). Each slice ends with its own
targeted tests green; `bun run check` runs once after slice D.

### Slice A0 · Foundation: schema, migrations, vocabulary, events, config (size S-M)

Creates:
- `scripts/map-additions/20.mjs` (§ 4.4).
- `drizzle/0020_merchant_management.sql`, `drizzle/meta/0020_snapshot.json`, the `_journal.json` entry (generated).
- `drizzle/0021_merchant_management_templates.sql` (custom; the text of `identityTemplatesSql()`), its snapshot and journal entry.
- `src/modules/identity/application/mail/identity-mail-events.ts`, `identity-templates.ts`, `identity-templates.spec.ts` (§ 6).
- `src/modules/identity/identity-mail-events.module.ts`: `IdentityMailEventsModule` with the provider
  `IdentityMailEventRegistration` (registers `IDENTITY_MAIL_EVENTS` in `onModuleInit`). It is imported by `MerchantMailModule`
  now and by `StaffMailModule` in slice C; Nest builds a module once, so the events are registered once.
- `src/modules/identity/domain/account-mail.ts` + `account-mail.spec.ts`.
- `test/support/identity-mail.ts`: `seedIdentityTemplates(db)` (inserts `IDENTITY_DEFAULT_TEMPLATES`, the pattern of
  `test/support/support.ts:23-28`).

Edits:
- `src/modules/identity/db/schema.ts`: `CLIENT_LOCALES`, `ClientLocale`, the seven `clients` columns, `clients_locale_check`,
  `api_keys.created_by` and `api_keys_created_by_idx` (§ 3.2).
- `test/schema/structure.test.ts` (`ADDITIONS`).
- `src/infra/rate-limit/limiters.ts` (`'account-mail'`, with a description), `src/infra/rate-limit/rate-limit.service.spec.ts`
  (the names list and one `toMatchObject` line), `docs/decisions/021-rate-limiting.md` (one line).
- `src/config/env.ts` (`AppConfig.http.consoleBaseUrl`, `DEV_DEFAULTS.consoleBaseUrl = 'http://localhost:5173'`,
  `CONSOLE_BASE_URL: httpUrl.optional()`, `withDefault(...)` with trailing slashes removed, `summarizeConfig`), `.env.example`
  (a line after `PORTAL_BASE_URL`), and the five fixtures of § 1 item 4.
- `src/modules/identity/merchant-mail.module.ts` (import `IdentityMailEventsModule`).

Acceptance:
- `bun run db:check` passes; `bun test --timeout 15000 test/schema test/integration/db-schema.test.ts
  test/integration/first-run.test.ts test/integration/seed.test.ts test/integration/notification-seed.test.ts` passes.
- `identity-templates.spec.ts`: every template belongs to a registered event and channel, uses only that event's variables,
  has a subject; every merchant event has `en` and `ar`, every staff event `en`; the migration file named by
  `IDENTITY_TEMPLATES_MIGRATION` holds exactly `identityTemplatesSql()`.
- `src/config/env.spec.ts`: production without `CONSOLE_BASE_URL` fails naming the variable; a value with trailing slashes is
  normalised; a non-http value is refused.
- The route tooling (`bun run routes:check`, or what W0 names it) accepts the eight additions.

### Slice A · Staff security tools (size L)

Creates:
- `src/modules/identity/contracts/client-security.contracts.ts` (R1-R4).
- `src/modules/identity/controllers/client-security.controller.ts` (`@route` tags; `no-store` on R1).
- `src/modules/identity/application/client-views.ts`, `client-details-editor.ts`, `client-security-admin.service.ts`.
- `src/modules/identity/domain/client-details.ts` + `client-details.spec.ts`.
- `test/integration/client-security-admin.test.ts`.

Edits:
- `src/modules/identity/contracts/clients.contracts.ts` (row, example, PATCH body, description, errors),
  `sessions.contracts.ts` (filter).
- `src/modules/identity/infra/client-admin.repository.ts`, `session-admin.repository.ts`.
- `src/modules/identity/application/client-admin.service.ts` (uses `ClientViews`; dispatches the three kinds),
  `session-admin.service.ts`, `merchant-auth-tokens.ts` (`createdAt: now`), `staff-admin.service.ts` (only the import of the
  renamed session counter, if you rename it).
- `src/modules/identity/merchant-admin.module.ts`: `imports: [MerchantMailModule, MerchantAuthModule]` (for
  `MerchantAuthTokens`), the new controller and providers.
- `test/integration/clients-admin.test.ts`, `test/integration/sessions-admin.test.ts`.

Note: `lifecycleMails.securityNotice` (used by 5.1.3 and 5.1.4) is built in slice B. In slice A leave one clearly marked
call site comment at each of the two places, and slice B adds the calls and their tests. Do not ship slice A alone.

Acceptance (each is an integration assertion):
- The row carries every new key with the right value for: a merchant with no password and an open invitation; a merchant
  with 2FA and two live sessions; a suspended merchant (who, when, why); an expired link (`linkSentAt: null`).
- Details edit: several keys in one call; unchanged keys are not in the audit row; mixed kinds `422`; `403` without
  `clients:update`; `404`.
- Email change: `emailVerifiedAt` becomes null; every open link of the merchant is used up; exactly one outbox row
  (`merchant.email_verification`, or `merchant.invited` when there is no password) with `payload` = `{ tokenId }` only; live
  sessions still work; the session and API key cache keys of the merchant are gone after the commit; a taken address is `409
  EMAIL_TAKEN` on a second merchant, case-insensitively; two parallel edits to one address → one `200`, one `409`.
- R1 link: purpose `invite` without a password, `reset` with one; the older link answers `410` on
  `POST /client/auth/password/reset`; the response body has no token; the sixth link within an hour is `429` and writes
  nothing; a suspended merchant `409 NOT_ACTIVE`.
- R1 temporary: 14 characters, passes the policy, signs in on `/client/auth/login`; `must_change_password` true; open links
  voided; `Cache-Control: no-store`; the audit row and the logs do not contain the password; `revokeSessions: true` ends
  every session and the audit row says how many.
- R2: clears the three TOTP columns; `409 TWOFA_NOT_ENABLED` when off; a `pending_totp` session is ended too.
- R3: ends full and pending sessions; `204` with none.
- R4: `409 CONFLICT` when verified; the limiter is shared with R8.
- `403 FORBIDDEN` for a role with `clients:update` but without `clients:security` on R1-R4; `403 CSRF_FAILED` without the
  header.
- `GET /admin/sessions?subjectType=client&subjectId=7` lists only that merchant with the exact `x-total-count`; `subjectId`
  alone is `422`.

### Slice B · Forced change, verification resend, suspension hardening, lifecycle mails (size L)

Creates:
- `src/modules/identity/application/mail/merchant-lifecycle-mails.ts`.
- `test/integration/merchant-lifecycle-mails.test.ts`, `test/integration/merchant-management-flow.test.ts`.

Edits:
- `src/modules/identity/domain/merchant-sign-in-step.ts` + spec; `client-rules.ts` + spec.
- `src/modules/identity/contracts/merchant-auth.contracts.ts` (`MerchantNext`, logout stages, R7, R8, `Me`, the example),
  `merchant-account.contracts.ts` (profile body).
- `src/modules/identity/infra/merchant-auth.repository.ts` (`saveClientPassword`, `saveForcedClientPassword`,
  `recordClientSignIn`, profile patch).
- `src/modules/identity/application/merchant-sign-in.service.ts`, `merchant-password.service.ts`,
  `merchant-registration.service.ts`, `merchant-account.service.ts`, `client-admin.service.ts` (`changeStatus`),
  `client-security-admin.service.ts` (the two notice calls), `kyc.service.ts`.
- `src/modules/identity/controllers/merchant-auth.controller.ts` (R7 sets the cookies; R8; both `no-store`; the class TSDoc
  lists the two new `@route`s).
- `src/modules/identity/merchant-mail.module.ts` (provide and export `MerchantLifecycleMails`), `kyc.module.ts` (import
  `MerchantMailModule`).
- `src/modules/platform/notifications/notification-foreign-reads.ts` (the merchant's `locale`; nothing else in this file).
- `test/integration/merchant-sign-in.test.ts`, `merchant-security.test.ts`, `merchant-registration.test.ts`,
  `clients-admin.test.ts`, `kyc.test.ts`, `client-security-admin.test.ts`; `test/support/merchant-portal.ts` only if a helper
  is missing (for example a `mustChangePassword` override in `makeMerchant`).

Acceptance:
- `nextMerchantStep`: the four fact combinations; `merchantStageOfStep`: the three steps.
- Login with a temporary password answers `{ next: 'password' }` and a `pending_password` session; with it `GET
  /client/auth/me` is `401`, `GET /client/wallet` is `401`, logout is `204`.
- R7 without 2FA: `200 { next: 'done' }`, a new cookie, the old token is dead, `me` works, `must_change_password` false,
  `last_login_at` set, other sessions of the merchant ended, open password links voided.
- R7 with 2FA: `{ next: 'totp' }`, then `POST /client/auth/2fa` with the rotated session's CSRF token → full session.
- R7 refusals: weak password and the temporary password itself (`422 WEAK_PASSWORD` on `password`, the flag stays); no CSRF
  header `403`; a full session `401`; a `pending_totp` session `401`; flag cleared meanwhile `401`; suspended `403`; the
  sixth try in 15 minutes `429`; two parallel calls → one `200`, one `401`.
- A reset link, an invitation link and `POST /client/security/password` each clear `must_change_password`.
- R8: `204`, the older verification link is `410`, the new one verifies; `409 CONFLICT` when verified; a pending merchant
  may call it; `429` on the sixth in an hour.
- A suspended merchant's verification link is `410`.
- Suspension: every open link of the merchant is used up; one `notifications` row `merchant.suspended` that is delivered
  although the merchant is suspended; a pending merchant can be suspended and then cannot sign in (`403` after a correct
  password); `pending → pending` and `active → pending` stay `409 INVALID_TRANSITION`.
- Approval and reactivation each write one `notifications` row; a merchant with `locale: 'ar'` gets the Arabic template, one
  with `en` the English; with the template switched off nothing is sent and the request still succeeds.
- KYC: approve and reject each mail the merchant (the rejection carries the note); the audit row is under `merchant` with
  `submissionId`.
- `PATCH /client/profile` saves `locale`, `address`, `taxId`; `Me` shows them; a name change drops the merchant's session
  and API key cache keys.
- The flow test of § 10 passes end to end.

### Slice C · Staff invitation and reset mails (size M)

Creates:
- `src/modules/identity/application/mail/staff-mail-outbox.ts`, `staff-mail-jobs.ts`.
- `src/modules/identity/jobs/staff-mail.processors.ts`, `src/modules/identity/staff-mail.module.ts`.
- `test/integration/staff-mails.test.ts`, `test/unit/staff-mail-wiring.test.ts`.

Edits:
- `src/modules/identity/infra/auth-token.repository.ts` (`findStaffTokenById`, `rotateStaffToken`).
- `src/modules/identity/application/staff-admin.service.ts` (`create`, `setPassword`).
- `src/modules/identity/contracts/staff.contracts.ts` (descriptions; `RATE_LIMITED` on the password route).
- `src/modules/identity/access-admin.module.ts`, `src/modules/identity/index.ts` (export `StaffMailModule`),
  `src/worker.module.ts` (two lines).
- `docs/queues.md` (the `notifications` section and the "Outbox event types" table).
- `test/integration/staff-admin.test.ts`, `test/scenarios/admin-team.e2e.test.ts` (step 3: the invitation now writes
  `staff.invited`; after the job runs there is one `notifications` row and one mail).

Acceptance:
- `POST /admin/staff` with `onboarding: 'invite'` writes one outbox row `staff.invited` with `payload` = `{ tokenId }`.
- The job sends one mail to the member with `<CONSOLE_BASE_URL>/set-password?token=…`; that token sets a password on
  `POST /admin/auth/password/set`; the placeholder token of the request never works.
- The job run twice sends one mail and the delivered link still works; a transient mail failure retries and the retry's
  link works; a suspended or deleted member, a used or expired link and a switched-off template send nothing and leave no
  `queued` row behind.
- `POST /admin/staff/:id/password` `reset_link`: purpose `invite` while the member is `invited`, else `reset`; the sixth
  within an hour is `429`; the temporary mode writes no outbox row.
- No log line, audit row, outbox row or `notifications` row contains the token or the link.
- The wiring test proves the worker module imports `StaffMailModule`.

### Slice D · API keys created and edited by staff (size M)

Creates:
- `src/modules/identity/application/api-key-issuer.ts`.
- `test/integration/api-keys-admin.test.ts`.

Edits:
- `src/modules/identity/contracts/api-keys.contracts.ts` (row, example, R5, R6).
- `src/modules/identity/domain/api-key-input.ts` + `api-key-input.spec.ts`.
- `src/modules/identity/infra/api-key-manage.repository.ts` (`updateKey`).
- `src/modules/identity/application/merchant-api-key.service.ts` (uses the issuer), `api-key-admin.service.ts`.
- `src/modules/identity/controllers/api-keys.controller.ts` (two admin methods, `no-store` on R5, class TSDoc).
- `src/modules/identity/api-keys.module.ts`.
- `test/integration/api-keys.test.ts` (only if an assertion pins the exact row keys).

Acceptance:
- R5: `201` with the secret once; the key authenticates a REST v1 call; `Cache-Control: no-store`; `createdByStaff: true` in
  `GET /admin/clients/:id/api-keys` and in the merchant's `GET /client/api-keys`; a merchant-made key says `false`; the audit
  row has no secret; one `merchant.security_notice` row.
- R5 refusals: pending and suspended merchant `409 NOT_ACTIVE`; unknown merchant `404`; `403` with `api_keys:read` only;
  bad scope, bad address, past expiry, `rateLimitPerMin` 0 or 6001 → `422` on the field; the eleventh live key `422` on
  `name`; a staff creation and a merchant creation in parallel at nine live keys → exactly one more key.
- R6: the new limit and addresses apply on the next call with the key (the cached view is dropped); `409 ALREADY_REVOKED`;
  `404`; `403` without `api_keys:update`; `422` on `allowedIps.N`.
- The merchant's own `POST /client/api-keys` behaves exactly as before (its existing tests pass unchanged).

### After slice D (the same implementer)

- `src/modules/identity/README.md`: routes, permissions, events, jobs, the table "what happens when an account changes"
  (the table of § 9 of D2, as built), the forced-change flow, the new exports.
- `docs/cache-keys.md`: the invalidation text of the `identity:session` and `identity:api-key` rows (a details edit; a key
  limits edit).
- Regenerate, in this order: the route manifest and slices (W0's command; `bun run routes:build` today), `bun run
  contract:docs`, `bun run docs:openapi`, `bun run coverage:build`, `bun run format`. Then `bun run check` in the foreground.
- Do **not** edit `PROGRESS.md`, `docs/ROADMAP.md`, `docs/contract/lead-decisions.json`, `docs/contract/MISMATCHES.md` or
  `test/contract/allowlist.ts`: the lead writes the B-entries at merge. Report the spec decisions of § 12 in your reply.
- No seed change is required (the new columns have defaults). Keep every seed total as it is.

## 9. Console slices (after the backend contracts are final; one implementer, worktree `../frontend-admin-20`)

Rules: `FA/CLAUDE.md`. All HTTP through `src/lib/api`. One exported API function per endpoint with `@route METHOD /path`; never
declare a second function for a route another feature already exports (import it from that feature's `index.ts`).
Components ≤ about 200 lines; pages compose; components never call the API. Client guards are hints: always show the
server's refusal. New `@route` tags will show as "unknown tag" in the console's non-strict coverage report: accepted
(LEAD-DECISIONS § 2). Write `FA/src/features/merchants/HANDOFF.md` with the mismatch rows (`MERCHANTS-1…`), the assumed
contracts and the SHARED-NEEDS below.

Shared files this feature may edit, and only these lines:
- `FA/src/mocks/roles.ts:51,54` (the mock permission catalog: `clients: 'read create update security'`,
  `api_keys: 'read create update revoke'`).
- `FA/src/mocks/handlers/accessSessions.ts` (honour a `subjectId` filter).

Permission hints use `useMerchantGrants()` (`FA/src/features/merchants/hooks/useMerchantGrants.ts`): `grants.needs(p)` gives
`{ disabled, title }`.

### K1 · Types, mocks, tabs, Profile tab, header and banner (size M)

- `types/client.ts`: `ClientLocale`, `ClientSecurity`, `ClientSuspension`; `Client` gains the optional keys of § 4.1;
  `UpdateClientBody` gains the nine detail keys.
- `lib/paths.ts`, `lib/detailTabs.ts`: tabs in this order: `orders`, `wallet`, `billing`, `pricing`, `api`, `profile`,
  `security`, `verification`, `audit`. Orders stays first, so no deep link changes. `DetailTabSpec.permission` becomes
  `string | readonly string[]` (any-of). Permissions: `profile` and `security` `clients:read`; `billing`
  `['invoices:read', 'payments:read']`; `verification` `kyc:read`; `audit` `audit:read`.
- `components/MerchantDetail.tsx`: render the new panels; the dialog state grows.
- New `components/ProfileTab.tsx`: three cards with `KeyValue`: Account (name, company, email with a Verified / Not
  verified chip, phone, country, language, username, referral code, group, referred by, joined), Business (address, tax
  ID), Settings and notes (Telegram linked yes/no, internal notes). An "Edit details" button (`clients:update`).
- New `components/EditMerchantDialog.tsx` (copy `FA/src/features/customers/components/EditCustomerDialog.tsx`): sends only
  the changed fields; `codeFields: { EMAIL_TAKEN: 'email' }`; a note under the email field: "Changing the email sends a new
  verification link and cancels older links. The merchant stays signed in."
- `hooks/useClientMutations.ts`: `useUpdateClientDetails` (toast "Details updated", `NO_ERROR_TOAST`, `staleClient`).
- `components/MerchantNote.tsx`: the suspended text becomes "Sign-in and API calls are refused. Open orders continue." plus
  the reason, who and when from `client.suspension`.
- `components/MerchantHeader.tsx` and `SuspendMerchantDialog.tsx`: a pending merchant gets a second button "Decline…"
  (`clients:update`) that opens the suspend dialog in a `decline` mode (title "Decline <name>'s application", same request
  `{ status: 'suspended', reason }`).
- `components/MerchantTable.tsx`: an "Invitation pending" chip when `security?.hasPassword === false`.
- Mocks: `mocks/store.ts`, `seed.ts`, `dto.ts` (`toClient` builds `security` and `suspension`), `clientRoutes.ts` (PATCH
  accepts details, answers `409 EMAIL_TAKEN` for a taken address and `422` for mixed kinds, keeps the suspension facts).
- Tests: new `pages/MerchantProfile.test.tsx`; update `pages/MerchantPageTabs.test.tsx` (nine tabs by permission) and
  `pages/MerchantsActions.test.tsx`.

Acceptance: the Profile tab shows every field; a role with only `clients:read` sees Profile and Security instead of
"Nothing here for your role"; the edit dialog sends only changed keys, shows `EMAIL_TAKEN` under the email field and a
`422` under its field; the suspended banner shows the server's reason; Decline suspends a pending merchant.

### K2 · Security tab (size M)

- New `api/security.ts`: `setClientPassword` (`@route POST /admin/clients/:id/password`), `resetClientTwoFactor`
  (`@route POST /admin/clients/:id/reset-2fa`), `revokeClientSessions` (`@route POST /admin/clients/:id/sessions/revoke`),
  `resendClientVerification` (`@route POST /admin/clients/:id/verify-email/resend`). Export from `api/index.ts`.
- New `hooks/useSecurityMutations.ts` (copy `FA/src/features/customers/hooks/useCustomerMutations.ts:88-103`: `gcTime: 0`
  for the password mutation, toasts by result: "Invitation sent" / "Reset link sent" / "Temporary password set"; all
  invalidate `staleClient(id)` and the sessions query) and `hooks/useMerchantSessions.ts` (calls `listSessions` from
  `@/features/access` with `filters: { subjectType: 'client', subjectId }`; enabled only with `sessions:read`).
- New `components/SecurityTab.tsx` (composes), `SecurityState.tsx` (KeyValue: password "Set" / "Not set yet (invitation)" /
  "Temporary (must change at next sign-in)"; password changed; 2FA on/off; email verified or "Verification sent <ago>"; last
  sign-in and IP; "Link sent <ago>, works for 1 hour"; active sessions), `SecurityActions.tsx` (buttons, each needing
  `clients:security`: "Password…", "Sign out everywhere" (off when `activeSessions === 0`), "Reset 2FA…" (off when 2FA is
  off), "Resend verification email" (off when verified)), `MerchantPasswordDialog.tsx` (copy
  `FA/src/features/customers/components/PasswordDialog.tsx`; the first option reads "Email the invitation again" when the
  merchant has no password; default `reset_link`, "Sign them out of every device" checked; a line under the temporary
  option: "The merchant must choose a new password at the next sign-in."), `MerchantConfirmDialog.tsx` (sign out, reset
  2FA), `MerchantSessionsTable.tsx` (IP, device, last seen, started, ends; "End" per row with `sessions:revoke`, using
  `revokeSession` from `@/features/access`).
- The temporary password is shown with `RevealPasswordDialog` from `@/features/access` after the password dialog closes (the
  dialog-state pattern of `FA/src/features/customers/components/customerDialogState.ts` and `CustomerDialogs.tsx`).
- Mocks: new `mocks/securityRoutes.ts` (the four routes with their refusals: `NOT_ACTIVE`, `TWOFA_NOT_ENABLED`, `CONFLICT`);
  register in `mocks/index.ts` before `clientRoutes`.
- Tests: new `pages/MerchantSecurity.test.tsx`; extend `api/clients.test.ts` (paths and bodies).

Acceptance: every action is disabled with "You need the clients:security permission" for a role without it; the temporary
password appears once and is gone after the dialog closes (not in the React Query cache); a `409` or `429` shows in the
dialog; the sessions list is hidden without `sessions:read` and the count still shows.

### K3 · Verification, Billing and Audit tabs (size M)

- `hooks/useKycSubmissions.ts`: `useKycList` takes an optional `clientId` (adds the filter). New
  `components/MerchantVerificationTab.tsx`: the merchant's requests, newest first, the current `kycStatus` badge, and the
  existing `KycDrawer` (`?kyc=<id>`).
- New `hooks/useMerchantBilling.ts` and `components/BillingTab.tsx`, `MerchantInvoicesTable.tsx`,
  `MerchantPaymentsTable.tsx`: `listInvoices` and `listPayments` from `@/features/finance` with `filters: { clientId }`, ten
  rows a page each, links to `financeInvoicePath(id)` and `financePaymentPath(id)`; a section whose permission is missing is
  left out.
- New `hooks/useMerchantAudit.ts` and `components/MerchantAuditTab.tsx`: `listAuditLogs` from `@/features/audit` with
  `filters: { entityType: 'merchant', entityId: id }`, 25 rows, "Show more"; each row: when, who, the sentence
  `<action> <entityLabel>`, IP; a link "Open in the audit log" to `/audit?type=merchant&record=<id>`.
- `FA/src/features/audit`: `types` (`AuditFilters.entityId?: Id`), `lib/view.ts` (`AuditView.record`: digits only; `toFilters`
  sends `entityId` when `type` is set; `writeView` keeps it; `hasFilters` counts it), a removable "Record #<id>" chip in
  `components/AuditToolbar.tsx`, `lib/view.test.ts`.
- Tests: new `pages/MerchantVerification.test.tsx`, `pages/MerchantBillingAudit.test.tsx` (the test file answers
  `GET /admin/invoices`, `/admin/payments` and `/admin/audit-logs` itself, as `test/installMerchantMocks.ts` does for
  services).

Acceptance: each tab asks the server with the merchant's id and shows loading, empty and error states through
`QueryState`; a decision in the drawer refreshes the tab and the header; the audit link opens the audit page filtered to
the merchant.

### K4 · API keys: create and limits (size S-M)

- `types/kyc.ts`: `ApiKey` gains `createdByStaff?: boolean`; `CreateApiKeyBody`, `CreatedApiKey`, `UpdateApiKeyBody`.
- `api/apiKeys.ts`: `createClientApiKey` (`@route POST /admin/clients/:id/api-keys`), `updateApiKey`
  (`@route PATCH /admin/api-keys/:id`).
- `components/ApiAccessTab.tsx`: a "New key…" button (`api_keys:create`; off unless the merchant is `active`, with the
  reason as its title). New `CreateKeyDialog.tsx` (name, scope checkboxes for `dhru`, `account:read`, `orders:read`,
  `orders:write`, `services:read`, allowed IPs one per line, optional expiry, per-minute limit default 60), `RevealKeyDialog.tsx`
  (the key once, a copy button, "This key acts as the merchant. Send it over a private channel. It cannot be shown again."),
  `KeyLimitsDialog.tsx` (per-minute limit, allowed IPs). `ApiKeyTable.tsx`: a "Limit" column, a "Made by support" chip, a
  "Limits…" action (`api_keys:update`) on live keys.
- Mutations with `gcTime: 0` for the creation; field errors (`scopes.N`, `allowedIps.N`) shown under their inputs.
- Mocks: `mocks/kycRoutes.ts` gains the two routes. Tests: new `pages/MerchantApiKeys.test.tsx`.

Acceptance: the secret is visible once and never again; `409 NOT_ACTIVE` and `422` refusals show in the dialog; limits
save and the row updates.

### K5 · Access feature: staff mail texts (size S)

- `FA/src/features/access/hooks/useStaffMutations.ts:38-39,71`: "An invitation email is on its way to <email>. The link
  works for 1 hour." and message "Reset link emailed", description "Sent to <email>. The link works for 1 hour.".
- `FA/src/features/access/lib/staffText.ts:21`: "An invitation was emailed. If it did not arrive or has expired, send a new
  one from Password."
- Tests: `pages/AccessPage.test.tsx:149,329`, `lib/staffText.test.ts:41,56`.

Acceptance: the texts are true once backend slice C is merged; a `429` from the password route shows in the dialog.

Console checks at the end: `npm run typecheck && npm run lint && npm run build && npm test`.

## 10. Tests (files)

Unit (no I/O):
- `src/modules/identity/domain/merchant-sign-in-step.spec.ts`, `client-rules.spec.ts`, `client-details.spec.ts` (new),
  `account-mail.spec.ts` (new), `api-key-input.spec.ts`.
- `src/modules/identity/application/mail/identity-templates.spec.ts` (new).
- `src/config/env.spec.ts`, `src/infra/rate-limit/rate-limit.service.spec.ts`.
- `test/unit/staff-mail-wiring.test.ts` (new; pattern `test/unit/commission-engine-wiring.test.ts`), `test/schema/structure.test.ts`.

Integration (real Postgres and Redis; `createTestApp`, `TestClock`, `AdminApi`, `MerchantPortal`, `mailbox`,
`sendAllQueued`, `seedDefaultTemplates`, `seedIdentityTemplates`; never sleep, never fake age by writing a time):
- `test/integration/clients-admin.test.ts` (row, details, email, status hardening, mails).
- `test/integration/client-security-admin.test.ts` (new; R1-R4: success, each refusal, `403`, `429`, parallel link requests
  leave exactly one open link).
- `test/integration/sessions-admin.test.ts` (filter, `422`, the merchant audit row).
- `test/integration/merchant-sign-in.test.ts` (forced change; pending-stage isolation; parallel R7).
- `test/integration/merchant-security.test.ts`, `merchant-registration.test.ts` (R8; suspended verify link).
- `test/integration/kyc.test.ts` (mails, audit entity).
- `test/integration/merchant-lifecycle-mails.test.ts` (new; every event in `en` and `ar`; suspended recipient; template off;
  the three notice phrases).
- `test/integration/staff-mails.test.ts` (new), `test/integration/staff-admin.test.ts`.
- `test/integration/api-keys-admin.test.ts` (new; includes the parallel creation at nine keys).

Scenario style:
- `test/integration/merchant-management-flow.test.ts` (new, ordered steps sharing state like a scenario file; it is not a
  map scenario, so it does not live in `test/scenarios/`): invite → invitation mail → staff resend (old link `410`) →
  the merchant sets a password (email verified) → approve (mail) → sign in → staff change the email (verification mail,
  the session survives) → verify → staff set a temporary password and sign the merchant out → login `next: 'password'` →
  R7 → `done` → staff create an API key → the key authenticates → suspend (key refused, login `403`, mail) → reactivate
  (mail) → `GET /admin/audit-logs?entityType=merchant&entityId=<id>` lists every phrase of the story.
- `test/scenarios/admin-team.e2e.test.ts` step 3 (the invitation mail exists now).

Contract: route parity, shape parity, error parity and the OpenAPI examples run unchanged and must pass with **no** new
allowlist entry. Add one assertion to an integration file: only R7 and logout accept a `pending_password` merchant session
(walk the registered contracts).

Console: `pages/MerchantProfile.test.tsx`, `MerchantSecurity.test.tsx`, `MerchantVerification.test.tsx`,
`MerchantBillingAudit.test.tsx`, `MerchantApiKeys.test.tsx` (new); `MerchantPageTabs.test.tsx`, `MerchantsActions.test.tsx`,
`api/clients.test.ts` (updated); `features/access/pages/AccessPage.test.tsx`, `features/access/lib/staffText.test.ts`,
`features/audit/lib/view.test.ts` (updated).

## 11. Hot shared files this feature appends to (the lead resolves conflicts)

`src/infra/rate-limit/limiters.ts` and its spec; `src/config/env.ts`, `env.spec.ts`, `.env.example` (24D also edits them);
`src/modules/platform/notifications/notification-foreign-reads.ts` (23 also edits it); `test/schema/structure.test.ts`
(`ADDITIONS`); `test/support/app.ts` (`PRODUCTION_ENV`); `src/worker.module.ts`; `src/modules/identity/index.ts` (24A later);
`drizzle/meta/_journal.json` and snapshots; `docs/queues.md`, `docs/cache-keys.md`; every generated file (route manifest,
slices, `docs/COVERAGE.md`, `docs/contract/endpoints/identity.md`, `docs/contract/openapi*.json`: on a conflict take `main`'s
copy and regenerate). Console: `FA/src/mocks/roles.ts`, `FA/src/mocks/handlers/accessSessions.ts`.

## 12. Decisions

### Owner decisions taken with the defaults of LEAD-DECISIONS § 6 (the owner may change them)

| Id | Question | Chosen |
|---|---|---|
| O-1 | Who may do what | Profile and email edits, approve, suspend, reactivate, decline: `clients:update`. Password links, invitation resend, temporary password, 2FA reset, end all sessions, verification resend: new `clients:security`. Create a key: `api_keys:create`. Edit a key's limits: `api_keys:update`. A role that holds `clients:*` or `api_keys:*` gets the new ones automatically (in the dev seed: Admin and Support) |
| O-2 | Forced change for merchants | Yes. Password step first, then the 2FA code. After the change the same sign-in continues (no second login) |
| O-3 | Email change | Staff only. Sessions stay; every open link is cancelled; verification is cleared; a verification (or invitation) goes to the new address. The old address is not notified. An address that a storefront customer also uses is allowed (the merchant wins on the smart sign-in) |
| O-4 | Suspension | Cancels open links. API keys are not revoked: they are refused while suspended and work again after reactivation. The mail does not include the staff reason. A pending applicant can be suspended: this is how an application is declined; reactivating such a merchant makes it active |
| O-5 | Approval conditions | Unchanged: neither a verified email nor an approved KYC is required |
| O-6 | Mails to merchants | Approval, KYC approved, KYC rejected (with the note), suspension, reactivation, and a security notice (temporary password, 2FA reset, key made by staff). Email only, always sent, English and Arabic by the merchant's language |
| O-7 | Verification resend | A merchant route (needs a session) and a staff action. No public route |
| O-8 | Staff mails | Invitation and reset link by email; `CONSOLE_BASE_URL` is required in production |
| O-9 | Staff-made API keys | Built. Only for active merchants; shown once; recorded (`created_by`); the merchant is mailed and sees "made by support"; staff may also change a key's per-minute limit (1-6000) and allowed addresses |
| O-10 | Business information | `address`, `taxId`, `locale` (the merchant and staff edit them), `internalNotes` (staff only). Invoices do not print the address or tax ID yet (money module, a later feature) |
| O-11 | Mail cooldown | Five mails per hour per account and kind (password link, verification, email change), for merchants and staff |
| O-12 | Audit | Staff actions on a merchant's records (KYC decision, one session ended, keys) are filed under the merchant. The merchant's own actions are still not audited |
| O-13 | Not built | Staff editing a merchant's notification preferences or unlinking Telegram; a notice to the old address after an email change; a separate "rejected" status; revoking keys on suspension; address and tax ID on invoices |

### Spec decisions for the lead's B-entries (tags as used in § 4.4)

1. `B-TBD merchant-admin-security`: R1-R3 and the permission `clients:security`; purpose `invite` while there is no
   password; a suspended merchant is `409 NOT_ACTIVE`; the temporary password sets `clients.must_change_password`.
2. `B-TBD merchant-details-edit`: `PATCH /admin/clients/:id` takes details as a third kind of change; the email rules of
   § 5.1.2; `409 EMAIL_TAKEN`.
3. `B-TBD merchant-row-additions`: the optional keys of the merchant row and the key row (optional because fixtures of the
   console are validated against the schema; the lead may make them required after the console's types and fixtures carry
   them), and the schema additions of § 3.2 (B116 style).
4. `B-TBD merchant-forced-password`: `next: 'password'`, the `pending_password` stage for merchants, R7 (`{ password }` only,
   answers the next step and rotates the session), logout from the pending stage, `Me.mustChangePassword`. Note for the
   lead: LEAD-DECISIONS says "mirroring the staff flow"; the flag, the step order and the stage mirror it, but after the
   change the merchant's sign-in continues instead of ending every session, because the merchant flow has an optional 2FA
   step that must still follow and a second login adds nothing.
5. `B-TBD merchant-verification-resend`: R4 and R8; `409 CONFLICT` when verified; a suspended merchant's link is `410`.
6. `B-TBD merchant-suspension-hardening`: a suspension voids every open link; `pending → suspended` is allowed.
7. `B-TBD merchant-lifecycle-mails`: the six merchant events, transactional, `en` and `ar`; `clients.locale` drives the
   language of every merchant mail.
8. `B-TBD staff-mails`: `staff.invited`, `staff.password_reset`, `CONSOLE_BASE_URL`, the staff token rotation in the job.
9. `B-TBD staff-api-keys`: R5 and R6, `api_keys.created_by`, `createdByStaff`, active merchants only.
10. `B-TBD merchant-audit-entity`: KYC decisions and the end of one merchant session are audited under `merchant`.
11. `B-TBD account-mail-limiter`: the limiter and where it applies.
12. `B-TBD sessions-subject-filter`: `subjectId` on `GET /admin/sessions`, with `subjectType` required beside it.

## 13. Storefront handoff (for `STOREFRONT-BACKEND-HANDOFF.md`; the site is not edited here)

1. **Merchant sign-in has a third answer.** `POST /client/auth/login` may answer `{ next: 'password' }` (staff set a
   temporary password). The cookies then hold a `pending_password` session that lives 10 minutes and can call only two
   routes. The site must show a "choose a new password" step and call
   `POST /client/auth/password/change` with `{ password }` and the `X-CSRF-Token` it got from the login answer. The answer
   is `200 { next: 'totp' | 'done' }` with new cookies and a new `X-CSRF-Token`: on `totp` continue with
   `POST /client/auth/2fa`, on `done` load `GET /client/auth/me`. Errors: `422 WEAK_PASSWORD` on `password` (also when the
   new password equals the temporary one), `401` (start again from the sign-in form), `403 ACCOUNT_SUSPENDED`,
   `403 CSRF_FAILED`, `429`. Until the site has this step, a merchant with a temporary password lands back on the sign-in
   form (today any `next` other than `totp` is treated as done, `components/auth/sign-in-flow.tsx:232-235`, and `me` answers
   `401`); "Forgot password" still works for them.
2. `POST /client/auth/logout` also works from the `pending_password` step.
3. **Resend the verification email:** `POST /client/auth/verify-email/resend` (a full session, pending merchants included; no
   body; `204`). `409 CONFLICT` = already verified (refresh `me`); `429` after five in an hour. The newest link replaces the
   older one. The "contact support" text of `lib/i18n/messages/merchant-settings.ts:66` can become a button.
4. **`Me` has four more keys:** `locale` (`'en' | 'ar'`), `address`, `taxId`, `mustChangePassword`. `PATCH /client/profile`
   also accepts `locale`, `address` (≤ 300), `taxId` (≤ 40). Save the language switch for a signed-in merchant with
   `locale`: it is the language of the merchant's emails. When `mustChangePassword` is true on a full session, send the
   merchant to the change-password form (`POST /client/security/password`).
5. **API key rows** have `createdByStaff` (boolean): show "made by support" for such a key.
6. **New emails to merchants** (English or Arabic by `locale`): approved, suspended, reactivated, KYC approved, KYC
   rejected (with the reason), and a security notice. The approval and reactivation mails link to `PORTAL_BASE_URL`. Keep
   polling `GET /client/auth/me` for the status; the mail is the push.
7. **Staff can now change a merchant's email.** The merchant stays signed in; `emailVerifiedAt` becomes `null` again and a
   new verification mail goes to the new address. Older links answer `410`.
8. A suspended merchant's verification link answers `410 TOKEN_INVALID`. A suspension cancels every open link.
9. Staff can send a reset link or a new invitation from the console; both arrive at the pages the site already serves
   (`/merchant/set-password?token=`).
10. Regenerate the types from `docs/contract/openapi.json` after the merge. No existing operation id changed; two were
    added. Nothing here is cacheable: every auth answer is `Cache-Control: no-store`.
11. The smart sign-in (feature 24A) will answer the same `next: 'password'` for a merchant; build the step once.

## 14. What feature 24A (smart sign-in) reuses

- `nextMerchantStep(facts)`, `merchantStageOfStep(step)` and the type `MerchantSignInStep` in
  `src/modules/identity/domain/merchant-sign-in-step.ts`: the only place that decides a merchant's next step.
- `MerchantSignInService.startSession(client, meta, staleToken?)`: everything after a proven password (suspension refusal,
  stale session end, the session of the right stage, the last-login record). 24A verifies the password itself (one argon2
  verify per attempt, as D6 § 3.1 requires) and then calls this. Exporting it (and a narrow credentials reader) from
  `src/modules/identity/index.ts` is 24A's edit.
- The contract enum `MerchantNext` (`'password' | 'totp' | 'done'`) for the merchant branch of its answer.
- R7 and `POST /client/auth/2fa` finish the pending steps whichever route opened the session: 24A adds no step route.
- The merchant sign-in still has no per-email lock (only email + IP); 24A's uniform lock is unchanged by this feature.

## 15. Review against the code, and approval

Checked again after writing:

- Every file, symbol and line cited in § 1, § 5 and § 8 exists at `bd32229` (re-read: `clients.contracts.ts`,
  `client-admin.service.ts`, `client-admin.repository.ts`, `client-rules.ts`, `merchant-sign-in.service.ts`,
  `merchant-sign-in-step.ts`, `merchant-auth.contracts.ts`, `merchant-auth.controller.ts`, `merchant-password.service.ts`,
  `merchant-auth-tokens.ts`, `merchant-token.repository.ts`, `merchant-mail-outbox.ts`, `merchant-mail-jobs.ts`,
  `merchant-registration.service.ts`, `merchant-auth.repository.ts`, `staff-admin.service.ts`, `staff-auth-tokens.ts`,
  `staff-password.service.ts`, `session.service.ts`, `session-admin.repository.ts`, `session-admin.service.ts`,
  `kyc.service.ts`, the API key files, `notification.service.ts`, `notification-delivery.ts`,
  `notification-foreign-reads.ts`, `limiters.ts`, `env.ts`, the contract test library and the console files named in § 9).
- A merchant-session route with `sessionStages: ['pending_password']` is legal (`define-route.ts:494-504`); `rotate` can move
  a pending session to `pending_totp` or `active` (`session.service.ts:111-130`); the guard refuses a pending session on every
  route that does not list its stage (`access-handlers.ts:75-87`).
- A transactional event is delivered to a suspended merchant and to a staff member's own row
  (`notification.service.ts:332`, `notification-delivery.ts:133-149`).
- No new error code, audit word, setting or cache family is needed; the three permissions appear through the contracts.
- No route key is renamed; every change to an existing route is additive, or a relaxation no caller sends today.

Dependencies (not blockers of this plan):

1. **W0 must be merged first.** The eight routes exist only as rows of `scripts/map-additions/20.mjs`; adapt the file to the
   export shape W0's loader documents. If W0 cannot carry a `successStatus` for console-called additions, the lead adds the
   extraction records at the console merge.
2. After the backend merge the lead applies migrations `0020` and `0021` to the owner's `gsm` database (additive), sets
   `CONSOLE_BASE_URL` in production environments, runs `npm run mocks:live` in the console, and after the console merge
   re-harvests the fixtures.
3. The storefront session must build item 1 of § 13 before staff use temporary passwords for real merchants.

**Approved.** No blocking issue.
