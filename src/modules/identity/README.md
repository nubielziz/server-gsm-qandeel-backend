# Identity & access module (`identity`)

Map domain A. Who can sign in and what they may do: staff accounts and roles, **accounts** (the `clients` table: merchants, retail buyers and guests, told apart by their rank, decision 064), sessions, one-time tokens, API keys and IP rules. It owns the authentication and authorization building blocks every surface uses: sessions, CSRF, the rank gate, API keys and the permission check (decision 018).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 007 password hashing, 010 ids and tokens, 018 authentication, sessions and CSRF, 019 encryption and token hashing, 021 rate limiting, 052 sign-in and mail limits and 064 one account type. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: the staff, role, permission, session, IP-rule and account routes of feature 2a, the daily purge of ended sessions and the demo accounts of the seed (see "Staff access, accounts and sessions (feature 2a)" below); the 8 API key routes of feature 7b (see "API keys (feature 7b)" below); the 2 notification routes of feature 12a; the portal and shop sign-in of one account type (see "Accounts, sign-in and the rank gate (decision 064)" below, which replaced the merchant portal sign-in of feature 2b and the shop sign-in of feature 14b); and the staff reads and writes of accounts (see "Staff reads and writes of accounts" below). Built earlier (P2.5a, P2.5c and the P2.6 sign-in routes, code in `security/`): the session service, cookies and CSRF token, the guard dispatcher with the staff and account session guards, the CSRF guard, the permission guard with the permissions catalog and the Owner helpers, the staff gate of the internal API reference, and the machine guards (`security/machine/`): capability tokens, URL secrets, API keys (Dhru credentials of merchant ranks) and gateway webhook signatures. The sign-in routes (P2.6) and the IP rules, maintenance and rate-limit hooks (P2.5b) are built too.

### The ports folder (decision 064)

`ports/` holds the seams other modules code against: abstract classes that the owning use cases implement (the wiring binds each with `useExisting`, so a port is the instance the services inject) and three small registries. Pure helpers (`accounts/account-status.ts`, `accounts/rank-kind.ts`) are leaves of the barrel. The identity barrel's order follows decision 032.

| Port | What it is for | Implemented by |
|---|---|---|
| `AccountPrincipal`, `AccountActor`, `actorOf`, `CurrentAccount` (`ports/account-principal.ts`) | the principal of a signed-in account (`kind: 'account'`, `accountId`, `clientId` (the same value, until the contract release), `rank {id, kind}`, stage, ip, session), the actor it stands for in audit, order events and the ledger (`{type: 'account', id, name}`) and the parameter decorator that hands it to a handler (401 when the principal is not an account's); `MerchantPrincipal` and `CurrentMerchant` are aliases of them until the contract release | the session guard |
| `AccountSessions` | `start(work, reply, {accountId, stage, rankKind})` (opens a session and sets the cookies), `revokeAll(tx, accountId)`, `invalidate(accountId)` (after commit) | the session service |
| `ApiKeyRevocation` | `revokeLiveKeysOf(tx, accountId)`: revokes every live key in the caller's transaction and **never takes** `api-keys:<accountId>` | the API key service |
| `AccountAuthTokens` | one-time links: `issue`, `take` (locks, does not spend), `voidOpenOf`, `askedFrom`; purposes `ACCOUNT_TOKEN_PURPOSES` = `invite`, `reset`, `verify_email`, `magic_link` | `AccountAuthTokenService` |
| `AccountMailOutbox` | `enqueue(work, {kind, accountId, tokenId?})`: the outbox event of an account mail, merchant or customer family by rank kind | `AccountMailOutboxService` |
| `AccountSignIn`, `AccountTwoFactorSetup`, `AccountOwnPassword`, `AccountLinkSignIn`, `AccountEmailVerification` (`ports/account-auth.ts`) | the use cases the portal and the shop controllers call | `AccountSignInService`, `AccountTwoFactorService`, `AccountPasswordService`, `AccountLinkSignInService`, `AccountEmailVerificationService` |
| `OptionalAccountSession` | `retailAccountId(request)`: the retail account of a live full session (403 `RANK_NOT_ALLOWED` for a merchant rank, 403 `CSRF_FAILED` without the token) or undefined | `OptionalAccountSessionService` |
| `AccountOwnProfile` | `meOf`, `lockMeOf` and `saveRetailProfile`: the `AccountMe` view and the retail own profile write (the customers module's controllers use it) | `MerchantAccountService` |
| `AccountAccessEffects` | `rankChanged` and `statusChanged`: what a status or rank change does to sessions, links, API keys and invitations, in the caller's transaction | `AccountAccessEffectsService` |
| `AccountCreateGuards` (registry) | `register(name, check)`, `run`: checks other modules add to every account create and every email change (the blocklist) | entry: customers |
| `GuestClaimParticipants` (registry) | `register(name, move)`, `moveAll`; `GuestClaimBusy` and `ORDERS_PARTICIPANT` | entries: orders, customers, money, risk, support, platform files |
| `AccountListSql` (registry) | `registerOrderFigure` and `registerWalletBalance`: the two SQL fragments of the account list, so a sort by them is one query | entries: orders, money |

`AccountDirectory`, `LegacyAccounts` and `AccountRanks` (`accounts/`) are classes, not ports: see "Accounts directory" below.

### Accounts directory (decision 064)

`accounts/` holds the one reader of an account by email and the helpers the rest of the system shares: `account-directory.ts` and `account-directory.repository.ts` (the only file that compares `clients.email`; a tooling test fails on an equality lookup anywhere else), `legacy-accounts.ts` (the append-only map of old merchant and customer numbers to accounts, `account_legacy_ids`; an old customer number is never an account id) and its repository, `account-status.ts` (`canAct`, `sessionStateOf`: the one reading of `clients.status`, a tooling test fails on a status compared with `suspended` elsewhere), `rank-kind.ts` (`rankKindOf`: only the stored kind `b2b` is a merchant, anything else is retail) and `account-ranks.ts` with its repository (identity's two writes of a rank change: `setRank` and `ensureUsername`, each in a savepoint).

- **Two partitions of one table.** Login rows (`has_account`) and guest rows each have a unique index on `lower(email)` (`clients_login_email_uq`, `clients_guest_email_uq`), so one email may belong to one row of each. `findLoginByEmail` reads the login partition only: password sign-in, forgot password, the sign-in lock and the sign-in limiter use it, so a guest row is never what they find. `findGuestByEmail` and `findOrCreateGuest` read and write the guest partition only (`INSERT ... ON CONFLICT (lower(email)) WHERE NOT has_account DO NOTHING`, then read; one retry when the row became an account in between). `lockGuestNoWait` takes the guest row `FOR UPDATE NOWAIT` for the claim and throws the `55P03` error the claim catches. `findById`, `lockForKeyShare` and `lockForUpdate` answer an `AccountRecord` (`id, email, name, status, groupId, rankKind, hasAccount, hasPassword, emailVerifiedAt, country, currency`; the rank kind comes from the catalog's `RankGroupReads`).
- **Legacy numbers.** `LegacyAccounts.resolve(db, type, id)` (`account` returns the id without a read; `client` and `merchant` the same number; `customer` through the map), `legacyIdsOf(db, accountId)`, and the two SQL fragments `legacyAccountIdSql` and `accountHistorySql` readers of never-rewritten rows use. `GET /admin/legacy-accounts/:type/:id` (`clients:read`) answers the account of an old merchant or customer number, or 404.
- **No cache key, queue, job or error code of its own.**

## Public API (`index.ts`)

Exports `IdentityModule` and the security stack (`SecurityModule`, global). Other modules import only `src/modules/identity/index.ts` (lint rule `gsm/module-boundaries`). The ports above (`AccountSessions`, `ApiKeyRevocation`, `AccountAuthTokens`, `AccountMailOutbox`, `AccountSignIn` and the other four of `ports/account-auth.ts`, `OptionalAccountSession`, `AccountOwnProfile`, `AccountAccessEffects`, `AccountCreateGuards`, `GuestClaimParticipants`, `AccountListSql`), the helpers `canAct`, `sessionStateOf`, `rankKindOf`, `actorOf`, `assertMayChangeRank` and `RANK_OWNER_DETAIL` (the rank change route of money asks them) and the classes `AccountDirectory`, `LegacyAccounts` (with `legacyAccountIdSql`, `accountHistorySql`, `legacySpaceOf`) and `AccountRanks` are part of it, as are the rest:

| Export | Use |
|---|---|
| `SessionService` | `create`, `rotate`, `lookup`, `touch`, `revoke`, `revokeAllOf`, `invalidateSubject` (see below), `openedAt` (a session's `created_at`, read from Postgres: the finish of a sign-up needs a session at most an hour old, decision 079); the subject types are `staff` and `account` |
| `SessionCookies` | `set` (staff) and `setAccount(reply, token, expiresAt, rankKind)` / `clearAccount` (the one account session cookie plus the CSRF cookie named by the rank kind, and `X-CSRF-Token`), `readToken`, `csrfCookieName`, cookie names (`SESSION_COOKIE_NAMES`, `CSRF_COOKIE_NAMES`); `setLinkBrowser` and `readLinkBrowser` (the HttpOnly cookie that marks the browser which asked for a shop sign-in link) |
| `CsrfService`, `csrfTokenFor`, `CSRF_HEADER` | derive and check the CSRF token |
| `SessionAuthenticator` | `authenticate` / `authenticateOptional(subject, request, { stages })` and `precheck` (the upload stage, which also judges the rank) |
| `CurrentPrincipal`, `CurrentStaff`, `CurrentAccount`, `CurrentMerchant` (alias), `CurrentLink`, `principalOf`, `Principal` types | the caller inside a handler; `CurrentLink` is the link id of a `link-token` route (410 `TOKEN_INVALID` otherwise) |
| `grants`, `isValidPermission`, `isOwner`, `assertOwnerTargetAllowed`, `customerContactOf` | the permission grammar and the Owner rules; `customerContactOf(caller)` is `'full'` for a role that grants `clients:read`, else `'masked'` (decision 047: the form of an account's address in staff answers; the contact permission is `clients:read` for every rank since decision 064) |
| `RolePermissions` | the permissions of a role, cached per role; `invalidate(roleId, work)` after a role change |
| `PermissionsCatalog` | `list()`: every concrete permission the registered contracts require, without `area:*` wildcards such as the literal `risk:*` (for `GET /admin/permissions`) |
| `SessionSubjects` | register the session resolver of a subject type (identity registers the `account` resolver, which reads the rank through `RankKinds`) |
| `AccessHandlers` | `replace(kind, handler)`: P2.5c gave the machine kinds their real guards; a test installs a stand-in with it |
| `ApiKeyDirectory` | `invalidate(keyHashes, work)` after a key is revoked or edited, `invalidateClient(accountId, work)` after an account's status or rank changes (it lists revoked keys too); `findByKey` |
| `CapabilityTokenResolvers` | `register({ kind, resolve })`: the owning module's lookup of a checkout, tracking, ticket or sign-in link token |
| `UrlSecretVerifiers` | `register({ routeKey, load })`: where a URL-secret webhook finds its stored secret |
| `WebhookVerifiers` | `register({ gateway, verify })`: one signature adapter per payment gateway (billing) |
| `ApiKeyPrincipal`, `CapabilityPrincipal`, `WebhookPrincipal` | the caller of a machine route: account id and key id / the id a token opens / gateway, event id and `duplicate` |
| `SessionPolicy`, `SESSION_SETTING_KEYS` | the lifetimes and their settings keys (staff and account only; the customer entries are gone) |
| `StaffAuthTokens` | `issue(work, { staffId, purpose: 'invite' \| 'reset', createdBy?, ip? })`: the one-hour, single-use link token of `POST /admin/auth/password/set` (feature 2a calls it when it adds a member by invitation or sends a reset; it voids the account's older links) |
| `checkPasswordPolicy`, `MIN_PASSWORD_LENGTH` | the password policy (staff and accounts; also for a temporary password the server generates) |
| `OWNER_ROLE_NAME`, `OWNER_ROLE_PERMISSIONS`, `EmailField`, `NameField`, `temporaryPasswordFor` | what `bun run setup` (P4b) shares with the seed and the staff routes: the Owner role definition, the email and name rules, the temporary password |
| `TEMPORARY_PASSWORD_TTL_MS`, `temporaryPasswordExpired` | a temporary password works 72 hours from `password_changed_at` (decision 052) |
| `SignInLockModule`, `SignInLock`, `SignInAccount`, `SignInScope` | the failed-sign-in lock of an email (decision 052, section "Sign-in lock" below); the shop's sign-in routes use it |
| `takePublicMailPoint`, `NO_ACCOUNT_ID`, `MAX_LIVE_PUBLIC_LINKS` | the per-recipient budget of the mails a visitor can ask for, the id of "no account" of a run that is rolled back, and the three live links a visitor's requests may hold (decision 052) |
| `ACCOUNT_AREA_PATH`, `accountAreaUrl`, `accountMailLink`, `ACCOUNT_MAIL_EVENTS` | the shop address of the signed-in area (`/account`) and of each mailed link, and the event names of the merchant and customer families |
| `STAFF_TOTP_AAD`, `CLIENT_TOTP_AAD`, `TOTP_ISSUER` | the encryption contexts of `staff_users.totp_secret_enc` and `clients.totp_secret_enc`, and the name authenticator apps show |
| `MerchantAuthTokens`, `MerchantMailOutbox`, `MERCHANT_MAIL_EVENTS`, `MERCHANT_INVITED_EVENT`, `CLIENT_TOKEN_PURPOSES` | the merchant-era link and mail classes, kept only until the contract release (new code uses `AccountAuthTokens` and `AccountMailOutbox`) |
| `StaffMailModule`, `StaffMailOutbox`, `STAFF_MAIL_EVENTS` | feature 20: `enqueue(work, { kind: 'invited' \| 'password_reset', staffId, tokenId })` writes the outbox event of a staff mail (ids only); the module is loaded by the API (through `AccessAdminModule`) and by the worker |
| `MerchantNotificationsModule` | the account's notification preferences (feature 12a) |
| `MerchantGroupMembers` | `countByGroup(db, groupIds)` (the `accountCount` of the catalog's rank routes and their delete guard) and `countInGroup(db, groupId, clientIds)` (the overdraft rule); read-only, no dependencies, exported in the leaf block of `index.ts` (decision 032) |
| `ClientStatsDirectory`, `NO_ORDERS` | the lifetime order figures of accounts (orders registers its source) |
| `StreamRoutesModule` | the three live event stream routes (feature 27, decision 037), loaded by the API only; the hub it uses is `RealtimeHubModule` of `src/infra/realtime` |
| `AccountsModule` (not in the barrel), `AccountWiringCheckModule` | the global module that provides `AccountDirectory`, `LegacyAccounts`, `AccountRanks` and the three registries to both processes, and the API's boot check that every registry holds its entries |

The classes of the shop's customer links (`CustomerAuthTokens`, `CustomerTokensModule`, `CUSTOMER_TOKEN_PURPOSES` and the rest) and `MerchantPasswordSignIn` are gone: there is one set for every account.

## The security stack (decision 018)

One global guard, `AccessGuard`, reads each route's contract (`getContract`) and runs, in this order: **authentication by access
kind**, the **CSRF guard**, the **permission guard**, then, for a `turnstile: true` storefront route only, the **anti-bot check**
(`TurnstileGuard`, `src/infra/turnstile`, decision 034: `403 TURNSTILE_FAILED`; also public `/client` routes since feature 24A). Validation, the handler and the audit follow in the
route's own pipes and interceptors. A route without a contract is refused (`500`), except `DOCUMENTATION_ROUTES`, which keep their own guard.

| Access kind | Who authenticates |
|---|---|
| `public` | nobody; a mutation on `/admin` or `/client` still needs an `Origin` of the route's audience (`CONSOLE_ORIGINS`, `SHOP_ORIGINS`; `403 CSRF_FAILED` otherwise); on `/store/v1` only the routes with `originCheck` (the sign-in routes, the link exchange included) |
| `staff-session`, `staff-permission` | the staff session cookie; `staff-permission` adds the contract's `permission` (`403 FORBIDDEN`, the detail names it) |
| `merchant-session`, `customer-session` | the one account session (the cookie `gsm_client_session`, the table `sessions`, the statuses of `clients`): both access names authenticate the same session of any account, and the **rank gate** below decides which routes the account may call (a `merchant-session` route serves merchant ranks, a `customer-session` route the retail rank) |
| `internal-or-token` | the network-or-token rule of `/metrics` (`MetricsAccessGuard`) |
| `dhru-credentials` | `username` + `apiaccesskey` in the JSON or form body of `POST /api/index.php`; every refusal is the Dhru envelope with HTTP 200 |
| `gateway-signature` | the adapter of the `:gateway` in the URL, the 5 minute window, the replay filter |
| `url-secret` | a secret in the URL path, compared in constant time with the stored hash or decrypted value |
| `checkout-token`, `tracking-token`, `ticket-token`, `link-token` | the token in the path (`:token`) or the body (`token`), looked up by the resolver the owning module registered |

**Failed session lookups (decision 053).** In required mode (the guard, the queues board, the `upload-session` stage) a cookie that names no live session of the audience costs
one point of the budget `session-failures:<subject>:<address key>` on the `ip` limiter (300 a minute per client address and audience, the budget of unknown API keys; `sessionFailureKey`; the subject is `staff` or `account`, so the portal and the shop family share one budget);
the budget is read first (`RateLimitService.peek`); an address that used it up costs no database lookup: its cookies are looked up in the session cache only
(`SessionService.lookupCached`), so a live session whose view is cached is served, and any other cookie is answered `429 RATE_LIMITED` with `Retry-After` (the queues board gate
sends the header too). A session in use keeps its view cached: a new or rotated session's view is loaded after the commit, a view read with less than 30 s left is loaded again in
the background, the once-a-minute touch loads it again after its write and writes it over the old view (`CacheService.reload`, never deleting it first), and the cache-only lookup answers a view for 60 s (the budget window, `SESSION_CACHE_GRACE_SECONDS`) after its
freshness and loads it again then, so a session used at least every 90 s stays served, also when it sends requests side by side. A request without the cookie and a live session cost nothing; `authenticateOptional` (public routes that accept an optional session) charges nothing.
**`upload-session` stage** (`security/upload-session.hook.ts`, `UploadSessionModule`, API only, the fourth stage of `PIPELINE_STAGES`): for a `multipart/form-data` request on a route of
`MULTIPART_ROUTES` whose contract signs in with a session cookie (`POST /client/files`, `POST /store/v1/files`, the three console uploads), `SessionAuthenticator.precheck(subject, request)` refuses
with `401 UNAUTHORIZED` unless the cookie of the route's audience names a live session, and with `403 RANK_NOT_ALLOWED` when the session is an account of another rank than the route serves, before the body is read (the same rule as the guard, from the route's compiled `rank`); suspension, stage, CSRF and permission stay in the guard.
API keys and ticket links are not judged here (the `upload` limiter and the 5 MiB bound of the ticket route bound them).

**Session checks**, in this order: cookie present, the session is known and belongs to the subject (`401`); absolute expiry and idle
expiry (`401`); the account may act (`canAct`: a suspended or blocked account is `403 ACCOUNT_SUSPENDED`, and every session of the account is revoked; an anonymized one is `401`); the stage is one
the contract accepts (`sessionStages`, default `['active']`; `401`); **the rank** of the account is one the route serves (`403 RANK_NOT_ALLOWED`, never a sign-out); then CSRF, permission and the anti-bot check; `last_seen_at` is written at most once a minute. A pending
sign-in session has a principal without permissions. `403 FORBIDDEN`, `403 CSRF_FAILED` and `403 RANK_NOT_ALLOWED` never sign the caller out.

**The rank gate (decision 064).** A route that needs an account session says whom it serves. The compiled contract carries `rank`: `merchant` for `merchant-session`, `retail` for `customer-session`, `any` when the contract says `rank: 'any'` and its key is also in `test/contract/rank-open-routes.ts` (see `src/common/contract/README.md`, "Rank"), and `null` for every other access kind. The check lives in the one session access handler (`security/session-authenticator.ts`, `assertRankAllowed`) and reads the rank kind of the cached session view (`SubjectSnapshot.rank`, `{id, kind}`, which the account subject resolver fills through `RankKinds`, installed at boot by `RankKindsInstaller` from the catalog's `RankGroupReads`; a view without a rank is refused, so the gate fails closed). The order in the handler: 401 no or dead session; 403 `ACCOUNT_SUSPENDED`; 401 wrong stage; 403 `RANK_NOT_ALLOWED`; then CSRF, permission, Turnstile. A guest row and an anonymized account have no session at all. `pendingMerchant` on a contract is accepted and ignored: the status `pending` no longer exists (the expand migration turned every pending merchant into a suspended one), so `ACCOUNT_PENDING_APPROVAL` is never produced by the guard. **A route that changes an account's status or rank calls `SessionService.invalidateSubject('account', id, work)` and `ApiKeyDirectory.invalidateClient(id, work)` after its commit** (in practice through `AccountAccessEffects`), or the old view is served for up to a minute. Placement from a wallet, the store balance, the checkout and both ways of creating an API key read the rank again under their own locks (defence in depth).

**Cookies.** One session cookie for every account, `gsm_client_session` (and `gsm_admin_session` for staff; httpOnly, `Secure` from `COOKIE_SECURE`, `SameSite=Lax`, `Path=/`, `__Host-` prefix when secure), read by both URL families. The shop's old session cookie `gsm_store_session` is never read: it is cleared on every account sign-in and sign-out (the contract release stops touching it). The readable CSRF cookies are `csrf_token` (staff) and, for an account, **named by the kind of its rank**: `csrf_token_client` for a merchant rank and `csrf_token_store` for the retail rank; the other name is cleared on every sign-in and sign-out, and a rank change across kinds ends every session, so a cookie name never outlives the kind it names (`SessionCookies.setAccount`, `clearAccount`, `csrfCookieName`; the shop picks its family from the name). The CSRF token is `HMAC(CSRF_SECRET, session token hash)`, so it changes when the session is rotated (`Domain` from `CSRF_COOKIE_DOMAIN`). The Origin checks use the origins of the route's audience (decision 045): `CONSOLE_ORIGINS` and `SHOP_ORIGINS`, which production derives from `CONSOLE_BASE_URL`, `STORE_BASE_URL` and `PORTAL_BASE_URL`; a deployment that serves a page from another host lists that origin too. The readable CSRF cookies are not host-locked (the console and the storefront read them by name). The session view is cached under `gsm:{env}:identity:session:{tokenHash}:v2` (the version keeps a view of the old shape from being read; see "Cache keys").

**Lifetimes** are settings in minutes, with the defaults of decision 018: `sessions.staff_absolute_minutes` 480, `sessions.staff_idle_minutes` 30, `sessions.client_absolute_minutes` 43200, `sessions.client_idle_minutes` 10080 (the account lifetimes, for every rank), `sessions.pending_minutes` 10. The settings `sessions.customer_absolute_minutes` and `sessions.customer_idle_minutes` are no longer read (the contract release deletes them). An invalid value is ignored (the default applies, with a warning in the log).

**One "live session" predicate** (lead resolution identity-platform-6, built by feature 2a in the sessions repository):
`revoked_at IS NULL AND expires_at > $now AND (stage <> 'active' OR last_seen_at > $now - the idle limit of the subject
type)`, where `$now` is the injected clock's time passed in (decision 031), never the database's `now()`. `GET /admin/sessions` (limited to fully signed-in staff sessions, B9), `StaffMember.activeSessions` and the merchant's
`security.activeSessions` (which enable "Sign out all devices") and the `DELETE /admin/sessions/:id` 404 (an idle-dead session reads
as already ended) all use it; `SessionService.revokeAllOf` keeps revoking every non-revoked row, idle-dead ones
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

**Accounts.** Every account, whatever its rank, is one session subject type, `account` (`SUBJECT_TYPES` = `staff`, `account`). The resolver reads the status, the name, the group and whether the row has a login, and the rank kind through `RankKinds`: no row, a guest row or an anonymized account is `gone` (401); a suspended or blocked one is `suspended` (403); an active one is `ok` with its `rank`.

### Machine guards (P2.5c, `security/machine/`)

`MachineAccessInstaller` replaces the fail-closed placeholders of the machine kinds with their guards through `AccessHandlers.replace`.
It does so in its constructor, before any `onModuleInit`, so a test module that installs its own stand-in handler in
`onModuleInit` (`test/support/pipeline-routes.ts`) wins and is never overwritten.

**API keys** (`api-keys/`). `username` + `apiaccesskey` (Dhru; the username
is `clients.username` compared case-insensitively) resolve an `api_keys` row by `HMAC-SHA256(TOKEN_PEPPER, key)` (decision 019: only
the hash and the 8 character display `prefix` are stored; the key is shown once when the merchant creates it). The checks, in this
order, with the answer of each:

| Check | Dhru (HTTP 200, envelope) |
|---|---|
| no key, unknown key, malformed, wrong Dhru username | `Authentication Failed` |
| revoked or expired (`revoked_at`, `expires_at <= now`) | `Authentication Failed` |
| account `suspended` or `blocked` | the message (account suspended) |
| account not `active` (any other status) | `Authentication Failed` |
| the account's rank is not a merchant rank (`not_merchant`) | `Authentication Failed` |
| `allowed_ips` non-empty and the client address (`request.ip`, `TRUST_PROXY`) is outside every CIDR, IPv4 or IPv6 (empty = any) | the message |
| more than `rate_limit_per_min` accepted calls in a minute (limiter `api-key`, key = key id) | the message (`Too many requests`) |

**API keys follow the rank (decision 064).** A key works only for an active account of a merchant rank, and the checks run in the order of the table. The rank kind is part of the cached key view (`ApiKeyView.client.rankKind`, read through the catalog's rank seam and never from the ranks table; `apiKeyViewOf(stored, groupKind)`; a view without it is refused), and the view is cached under `api-key:{keyHash}:v3`. Both ways of creating a key take the advisory lock `api-keys:<accountId>` first and then lock the account row, and refuse from that locked read (see "API keys (feature 7b)"); a rank change that leaves the merchant kind, and an erasure, revoke every live key in their own transaction through `ApiKeyRevocation`. A key carries no scope: every live key of an active merchant-rank account is a Dhru credential (the `api_keys.scopes` column is unread and unwritten).

Only accepted calls count against the key's limit. Unknown keys and wrong usernames are counted per client address (the `ip` limiter,
300 a minute, under the key `api-key-failures:<ip>`; IPv6 by /64): Dhru has no per-IP stage in the pipeline and an unknown
key has no limit of its own; that budget is peeked before the lookup (decision 053), so an address that used it up costs no database lookup: its keys are
looked up in the key cache only (`ApiKeyDirectory.findCached`), a key whose view is cached is judged as usual, and a key the cache does not hold gets `429` (a
username that is not the cached key's is still charged, and answered `429` then). A key in use keeps its view cached: a view read with less than 30 s left is
loaded again in the background, the once-a-minute "last used" write loads it again over the old view (`CacheService.reload`), and the cache-only lookup answers a view for 60 s (the budget window,
`API_KEY_CACHE_GRACE_SECONDS`) after its freshness and loads it again then, so a key used at least every 90 s stays served, also when it sends calls side by side.
A bulk placement costs more than one point: `ApiKeyCredentials.points` (default 1; `requestPoints` in `api-keys/request-points.ts`:
the item ids of a Dhru `placeimeiorderbulk`, clamped to 1 to 100; `getimeiorderbulk` stays one) is charged in the one `consume`, at most the key's own limit. A request without any key is refused without a lookup and without counting. A stored `rate_limit_per_min`
below 1 is a data error: the limiter's default (60) applies. `last_used_at` / `last_used_ip` are written at most once a minute (best
effort). The principal is `{ kind: 'api-key', clientId, clientName, keyId, ip }` (`clientId` is the account id); the request context actor is the account (`account`).

The lookup is cached 60 s (a key that matches nothing 10 s). **The features that revoke a key, change its allowed IPs, or
change an account's status or rank call, after their commit:** `afterCommit(() => directory.invalidate([keyHash]))` /
`directory.invalidateClient(clientId, work)`; until then the old view is served for up to a minute.

**Cached views are bound to their credential (decision 055).** A cached session view is used only when its `tokenHash` equals the hash of
the presented cookie, and a cached API key view only when its `keyHash` equals the hash of the presented key (constant-time compare); a
view of another credential answers 401, is deleted and logs one warning a minute. The deletes that follow a security change (sessions,
API keys, role permissions, IP rules) go through `CacheService.invalidate`: retried, reported, never thrown.

**Capability tokens** (`capability-tokens.ts`). The guard takes the `token` path parameter or, for the sign-in link routes, the `token`
field of the body; a token that is not 16 to 128 base64url characters never reaches a resolver. The owning module registers a
`CapabilityTokenResolver` per kind in `onModuleInit` (orders: `tracking-token`; customers: `checkout-token`; identity: `link-token`, registered by `AccountIdentityRegistrar`; support:
`ticket-token`): `resolve(token)` returns `{ id }` or `null` (unknown, expired, used) and **must not consume** the token; a single-use link is
marked used by the use case, in its own transaction. A kind without a resolver refuses every request. The answer to a token that opens
nothing is always the same: `404 NOT_FOUND`, or `410 TOKEN_INVALID` for a sign-in link; never `401`, which would sign out a customer who
follows an old link. Brute force is limited per client address by the pipeline's `token` limiter before the guard runs. The principal is
`{ kind: 'capability', access, resourceId, ip }`.

**URL secrets** (`url-secrets.ts`). `UrlSecretVerifiers.register({ routeKey: 'POST /webhooks/<name>/:secret', load })`; `load` returns
`{ form: 'hash', value: TokenService.hash(secret) }` or `{ form: 'secret', value }` (decrypted by the owning module for the comparison only).
The comparison is constant time and always runs, so a missing configuration takes as long to refuse as a wrong secret. A route without a
source, or without a stored secret, refuses every request with `401`. A source may also name a request `header` that must carry the same
secret (both are compared, both always, so the time does not say which failed) and a `refusal` of `not_found` (404, so a scanner cannot tell
the route exists); a stored `secret` may name a separate `header` value, which the header is then compared with instead of the path's
(decision 054). No route uses the kind today (the one that did, a chat bot's webhook, was retired with decision 062).

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

## Staff access, accounts and sessions (feature 2a)

Scenarios `admin-team` and `ip-rules` (tests: `test/e2e/admin-team.e2e.test.ts` and `ip-rules.e2e.test.ts`). 27 routes, each a
contract under `contracts/`, a thin controller under `controllers/`, a use case under `application/` (one transaction, an audit row
for every write), queries under `infra/`, pure rules under `domain/`. Wired by `AccessAdminModule` (staff, roles, sessions, IP rules)
and `MerchantAdminModule` (the staff reads and writes of accounts), both imported by `IdentityModule`. The detail of each route is `docs/contract/endpoints/identity.md`;
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
| `GET /admin/sessions`, `DELETE /admin/sessions/:id` | `sessions:read`, `sessions:revoke` | `SessionAdminService` (staff sessions only; the list names the subject types `staff` and `account`, and the filters `client` and `customer` are `422`) |
| `GET /admin/ip-rules`, `GET /admin/ip-rules/:id`, `POST /admin/ip-rules/check` | `access:read` | `IpRuleAdminService` |
| `POST /admin/ip-rules`, `DELETE /admin/ip-rules/:id`, `PUT /admin/access/restriction` | `access:create`, `access:delete`, `access:update` | |
| `GET /admin/clients`, `GET /admin/clients/counts`, `GET /admin/clients/:id`, `GET /admin/legacy-accounts/:type/:id` | `clients:read` (`wallet` and `stats` only with `wallet:read`) | `ClientAdminService`, `ClientViews`, `AccountCountsService` (see "Staff reads and writes of accounts") |
| `POST /admin/clients`, `PATCH /admin/clients/:id`, `POST /admin/clients/:id/account` | `clients:create` (and `wallet:credit_limit` for a credit limit above zero; a merchant rank is the Owner's), `clients:update` (and `clients:security` to suspend or reactivate or to change the email) | `ClientWriteService`, `AccountGuestService`, decisions 046, 047 and 064 |

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
  everyone but an Owner). An account's session is neither listed nor ended there: the per-device list of an account is retired, and an
  account is signed out of every device by `POST /admin/clients/:id/sessions/revoke` (`clients:security`).
  **Money rules per person** (decision 049, `grantsPerPersonMoney`): the limits and the second-person rule of `wallet:adjust`,
  `wallet:credit_limit`, `payments:approve` and `invoices:create` count per staff account (`PER_PERSON_MONEY_PERMISSIONS`), so only an
  Owner adds a member whose role grants one of them, gives such a role to another member, sets a temporary password for another member
  whose role does, or changes that member's email (`403 FORBIDDEN`). Only an Owner adds one of them to a role that a member of any
  status holds (`RoleAdminService.update`, under the role's row lock that adding a member and a role change also take); a role nobody
  holds stays editable.
- **What a change does to sessions and caches:** a suspension, "end all sessions", a password reset with `revokeSessions` and a 2FA reset
  call `SessionService.revokeAllOf` (the caller keeps their own session when they reset their own 2FA); a rename or role change, and a
  reactivation, call `invalidateSubject`; a role change calls `RolePermissions.invalidate`, and a change of a role's permissions also calls
  `invalidateSubject` for each member, so their open streams end with `bye reauth` (a rename does not); an account status or rank change calls
  `ApiKeyDirectory.invalidateClient`. All after the commit.
- **Staff links** (`StaffAuthTokens`): `POST /admin/staff` (invite) and `reset_link` issue an `auth_tokens` row (purpose `invite` while the member
  is `invited`, `reset` otherwise; hash only, one hour, only the newest link works). The link itself is built and mailed by the
  notifications feature (12a): until then the raw token is not delivered anywhere. A temporary password stores only its argon2id hash,
  forces a change, voids unused links and is shown once (never in the audit log). A change of the member's email voids their unused links
  in the same transaction (they were mailed to the old address); a queued mail of such a link is then skipped and staff send a new one.
- **One live-session rule** (`liveSessionCondition`, `security/session.repository.ts`, resolution `identity-platform-6`): not revoked, not past
  `expires_at`, and (for a full session) used within the idle limit of its subject type. `GET /admin/sessions` (staff sessions at
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
- **Accounts:** the staff create, edit and status writes are one use case each, described in "Staff reads and writes of accounts" below (decision 064).
- **Times the API returns or decides on come from the clock** (decision 031): `createdAt` of staff, IP rules, merchants, sessions and
  invite/reset tokens is written by the service, not by the column default.

**Seed** (`scripts/seed/identity.ts`, decision 064): the 6 roles, 6 staff, the IP rules, the 4 demo client groups (ids 1 to 4 as the frontend mock; the
catalog feature's seeder takes them over) and the 20 demo merchants, which are the accounts 1 to 20 (`m3` is account 3, username the name's slug,
group and status as the mock, no password and no referral link; each has its row of the legacy id map). The demo's customers are retail accounts 101 to 130 (see the customers module); the next account made in a development database is 131. Their wallets are feature 3's seed. Open point for that seed: the frontend mock gives
the Standard group `overdraft_allowed = false` but its merchants a credit limit above zero, which user rule 2 forbids.

## Accounts, sign-in and the rank gate (decision 064): `/client/auth/*`, `/client/security/*`

One use case serves the three password sign-in routes and both ranks. The use cases are `AccountSignInService`, `AccountTwoFactorService`, `AccountPasswordService`, `AccountLinkSignInService` and `AccountEmailVerificationService` (`application/`, behind the ports of `ports/account-auth.ts`); the routes are the portal's own (`contracts/merchant-auth.contracts.ts`, `merchant-account.contracts.ts`, controllers `merchant-auth.controller.ts` and `merchant-account.controller.ts`, queries in `infra/merchant-auth.repository.ts`, pure rules in `domain/account-*.ts`), wired by `MerchantAuthModule`, which also binds the six ports and provides `GuestClaimService` and `AccountIdentityRegistrar` (the `link-token` resolver). The customers module hosts the shop's controllers and calls the ports. Spec: MISMATCHES (the B-entries of decision 064) and ALIGNMENT § 7. Session cookie `gsm_client_session`, CSRF cookie by rank kind and the `X-CSRF-Token` header.

| Route | Access, rank | What it does |
|---|---|---|
| `POST /client/auth/sign-in` | public, Turnstile, Origin check | the one sign-in form (hosted by the customers module): `{ kind, next, rank }` and the session, for every account (below) |
| `POST /client/auth/login` | public (Turnstile while `TURNSTILE_MERCHANT_AUTH` is on, the default in production) | the map's sign-in route, the same use case answering `{ next }`; retired by the contract release |
| `POST /client/auth/2fa` | session `pending_totp`, **rank any** | six digits → `204`; rotates the session to `active` |
| `POST /client/auth/logout` | session, **rank any** | revokes the session, clears the cookies (the session cookie, both CSRF names and the shop's old cookie), `204` |
| `POST /client/auth/password/change` | session `pending_password`, **rank any** | the forced change of a temporary password (needs its `X-CSRF-Token`); the change rotates the session (no fixation), ends the other sessions and voids password links |
| `POST /client/auth/password/forgot` | public, **Turnstile always** | `{ email }` → `204` for any email; a login row that may act (also one without a password yet) gets a `reset` link; at most five an hour; the earlier links keep working (at most three) |
| `POST /client/auth/password/reset` | public | `{ token, password }` with a `reset` or `invite` link → `204`; sets the password, uses the link, ends every session, signs nobody in; `410 TOKEN_INVALID` for a link of an account that may not act; an invitation also sets `email_verified_at` |
| `POST /client/auth/verify-email` | public | `{ token }` → `204`; sets `email_verified_at`, uses the link; signs nobody in. The mailbox and the password holder prove the account together: without a full session of the same account on the request it also clears the password, turns two-factor sign-in off, ends every session and mails a password link; that session without its `X-CSRF-Token` is `403 CSRF_FAILED` (the link stays usable); `410` for an account that may not act. Only an account without a password is just stamped |
| `POST /client/auth/verify-email/resend` | merchant rank | a new verification link for the signed-in account |
| `GET /client/auth/me` | session `active`, merchant rank | `AccountMe` (below); `no-store`; repeats `X-CSRF-Token` |
| `PATCH /client/profile` | merchant rank | name, company, phone, country, address and tax id (partial) → `AccountMe` |
| `POST /client/security/password` | merchant rank | `{ currentPassword, newPassword }` → `204`; ends the other sessions; `409 CONFLICT` "Choose a password first." for an account without a password (it was `401`, which signed the caller out) |
| `POST /client/security/2fa/setup`, `/enable`, `/disable` | merchant rank | a pending secret and QR code, confirm, switch off; the shop family has the same three on `/store/v1/me/2fa/*` (the customers module's controller, the same use case) |

**Rules worth knowing**

- **AccountMe** answers both families (`GET /client/auth/me` and `GET /store/v1/me`): the account with its rank (`rank {id, name, kind, discountPercent}`, `kind` is `merchant` or `retail`), whether it has a password, whether a password change is forced, whether two-step sign-in is on, the shown currency, the marketing choice and the profile fields (empty text when empty, never null). It replaces the merchant-only `Me` and the shop's account keys; `group` is gone and the status has no `pending`.
- **One email lookup.** The three sign-in routes, both forgot routes, `SignInLock` and the sign-in limiter's account lookup call `AccountDirectory.findLoginByEmail` and nothing else, so a guest row that shares the email of a login row changes nothing for that login's sign-in or reset.
- **No enumeration.** `password/forgot` answers `204` whatever the email and runs the same statements for every email (decision 052: `DbService.runOrDiscard`; `forgot` writes for `NO_ACCOUNT_ID`, and the transaction is rolled back at its end when nothing may be kept). It is counted per email + network by the `sign-in` limiter, known email or not, and spends one point of the account's `account-mail` budget (kind `forgot_password`, five an hour; beyond it nothing is sent). A sign-in is one `401` for an unknown email, a wrong password and an account with no password yet (each verifies one argon2 hash, a dummy one when there is none); `403 ACCOUNT_SUSPENDED` only follows a correct password.
- **A wrong current password or code is `422` on its field (`currentPassword`, `code`), never `401`**, which would sign the caller out (B121). `WEAK_PASSWORD` names `password` (reset) or `newPassword` (change).
- **Rate limits** (`AccountSignInLimiter`, keys are `HMAC(TOKEN_PEPPER, ...)` hashes under the prefix `merchant-sign-in`, kept so no counter resets for merchants, and apart from the staff ones): login per email + network (one budget for all three sign-in routes); forgot per email + network; codes (sign-in, enable, disable; limiter `sign-in-code`, never counted in process memory), 2FA setups and password changes **per account**; emailed links (`verify-email`, `password/reset`) by the `token` limiter per address. The per-IP limit of the pipeline covers the public routes first.
- **The sign-in code step closes after twenty wrong codes within 24 hours**, the staff rule (`CodeStepLock`, columns `clients.totp_failures`, `totp_failures_since` and `totp_locked_at`, audit row `locked the authenticator step of` with entity `account`): from then on `POST /client/auth/2fa` answers `429 RATE_LIMITED` to every code until the 24 hours from the first counted wrong code end (`Retry-After`), or sooner until a new password is set by a reset or invitation link or by a temporary password from staff, or staff reset two-factor sign-in (`POST /admin/clients/:id/reset-2fa`); the account's own or forced change leaves it closed. The enable and disable codes of a signed-in account are not counted.
- **Links** (`auth_tokens`, purposes `verify_email`, `reset`, `invite`, `magic_link`; `AccountAuthTokens`): 256 random bits, only the keyed hash stored, one hour, one use, subject type `account`. A newer `reset` or `invite` voids the older ones, except a `reset` the visitor asked for on `forgot`, which keeps the two newest unused ones (at most three work at once, decision 052); a newer `verify_email` voids the older one. Unknown, used, expired, superseded and may-not-act links are all `410 TOKEN_INVALID`. A weak password does not use the link up. Changing the password voids open `reset` and `invite` links.
- **A proven password counts only while it is stored.** The change writes over the hash its current password was checked against, the hash upgrade of a sign-in likewise, and the session opens under the `clients` row lock only while the row still holds the hash that was proven, or a hash that verifies the same password again under the lock (the upgrade of a parallel sign-in; `401` otherwise). The session reads the account again under its row lock and asks the same status helper (`canAct`). A password change or a sign-in that meets the verification of `verify-email` without a session therefore either finds no password or has its session ended by it.
- **Two-step sign-in is for every account with a password** and needs a confirmed email address (decision 052; `AccountTwoFactorService`): `2fa/setup` and `2fa/enable` answer `409 CONFLICT` ("Confirm your email address first; two-step sign-in can be switched on after that.") while `clients.email_verified_at` is empty, and `409 CONFLICT` "Choose a password first." for an account without a password; nothing is stored. The row is read under its lock in the transaction that writes. Switching it off and using it at sign-in do not depend on the address; a reset or invitation link keeps turning it off on an unconfirmed account (rows from before the rule).
- **Forced password change.** `nextAccountStep` (`domain/account-sign-in-step.ts`) decides password, then code, then done, for both ranks; an account with `must_change_password` gets `next: 'password'` and a `pending_password` session that only `POST /client/auth/password/change` and logout accept. `CodeStepAccount.type` is `account`. The SQL twin of `canAct` lives in `merchant-auth.repository.ts`.
- **TOTP.** The same `TotpService` as staff (SHA-1, 6 digits, 30 s, ±1 step) with the encryption context `CLIENT_TOTP_AAD`. A code is accepted only if its time step is newer than `clients.totp_last_step`, written by a guarded `UPDATE` (so a code works once even in parallel). Enabling or disabling 2FA, changing the password and resetting it end the account's other sessions; `ApiKeyDirectory` is not affected.
- **The database decides.** The code, password, 2FA, `me` and profile steps read the account from `clients`, not from the cached session view: a suspension applies at once (`403`, every session of the account revoked).
- **Audit.** The account's own routes write no `audit_logs` rows (the audit log records staff writes); failed attempts are logged without the email.

### The one sign-in form (feature 24A, decision 064)

`POST /client/auth/sign-in` is hosted by the customers module (`SmartSignInController`), which calls `AccountSignIn.signIn` (customers may import identity, not the reverse, decision 032). It counts every attempt per email and network on the one `sign-in` limiter, asks for the login row of the email (never a guest row), takes the email's shop lock (`SignInLock`, scope `shop`, shared with `POST /client/auth/login` and the shop's aliases) and runs **exactly one** argon2 verify (the account's hash, or a dummy hash made at boot). A temporary password older than 72 hours is refused like a wrong one. Every `401` is one answer and stays counted towards the lock; a correct password takes back its own count (`403 ACCOUNT_SUSPENDED` comes only after one); a success opens the session of the next step (`password`, `totp` or `done`), ends the stale session of the same browser, and clears the login counter (the lock keeps the failures of other attempts). The answer is `{ kind, next, rank }` with `Cache-Control: no-store`: `rank.kind` tells the shop which area to show; `kind` (`merchant` or `customer`) stays until the contract release.

### The emailed sign-in link and the guest claim (retail rank)

`AccountLinkSignIn` serves `POST /store/v1/auth/magic-link`, `POST /store/v1/auth/sign-up`, `POST /store/v1/auth/verify` and `POST /store/v1/auth/sign-up/finish` (controllers in the customers module). Asking for a link never tells whether an address has an account: a run that sends nothing is rolled back. A login row of the email that is retail and may act gets the link; any other login row is silent; **with no login row (decision 079) no link is issued**: the note `customer.no_account` with the shop's sign-up page (`<STORE_BASE_URL>/en/sign-up`, `NoAccountNote`) goes to the **typed address**, and the request makes no row of `clients` (the review of decision 079: a guest row made only to address the note let anybody plant rows). The note is a `notifications` row of the pseudo-recipient (`account`, 0) with the address in its payload's `to` (`NotificationService.enqueueToEmail`, the event registered `namedAddress`) and its `notification.send` event, in the request's transaction; an address whose guest row is blocked, or that a create check refuses, is silent; its budget is the address's own (`account-mail`, key `compositeKey('address', email, 'sign_in_link')`, five an hour), shared with the sign-up links of the address (the re-review: one budget per address); a security notice of decision 047 whose text ships with the code. **The sign-up** (`signUp`) is the one way an account is made: the password policy (with the email and the names) and the country rule of a retail account (`application/retail-country.ts`, shared with the staff create and edit and the finish: a country of the tax windows in force, or any code of `common/countries.ts` while none is) are judged first, then the budget of the sign-in link (the same `sign-in` key and `account-mail` points; an address without a login account spends the address's points, the note's), then the password is hashed (argon2id) before the address is looked up, in every branch. An address with a login account gets its ordinary sign-in link in the mail `customer.sign_up_existing` ("You already have an account. Nothing was changed."; silence where asking for a link is silent) and keeps nothing of the form; any other address gets the sign-in link of its guest row (found or made) in the mail `customer.sign_up_link` ("Finish creating your account"; no account is made until the link is opened), with the form waiting beside that link (`account_signups`: the hash, the names, the country, the phone; **one row per link**: a newer sign-up leaves the older form beside the older link, and each link applies its own). A link request and a sign-up take the account row `FOR KEY SHARE` only (the review's S2): it holds off the writers that take `FOR UPDATE` (the exchange, the finish, the status and rank writers) until the link and its mail are committed, and never makes two public requests of one address wait for each other. The field rules are `domain/sign-up.ts` (names trimmed, 1 to 60 characters each and at most 120 together with the space, no control character, no line or paragraph separator (U+2028, U+2029) and no invisible direction mark (U+061C included); the phone without spaces, dashes, dots and brackets, an optional `+` and 7 to 15 digits, tabs and marks refused), re-exported for the shop's contracts by the leaf seam `ports/sign-up-fields.ts`. Using the link proves the mailbox: it makes an account of a guest row (a link mailed before decision 079 still does, without details), stamps the address, voids the account's other sign-in links and opens the session, with a code step first when two-step sign-in is on (the answer says `next`). When the address gained another login row after the mail was sent (`clients_login_email_uq` refuses the change), the exchange answers `410 TOKEN_INVALID` and changes nothing. **A link of a sign-up** has its form taken (read and deleted) in the exchange's transaction, and every other waiting form of the address goes with it (the links it voids included); `signUpOutcome` decides: when this exchange made the account **in the browser that sent the form** (`requestedHere`) the form is applied (`name` = first name, a space, last name; `country` with its derived currency; `phone`; the password, set as a reset link sets one: `password_changed_at`, no forced change, `password_set_by_staff` cleared, the code failures forgotten, invitation and reset links voided, the other sessions ended before this exchange's session opens, the shop sign-in lock cleared after the commit) and the answer says `passwordSet: true`; **in any other browser** (phone mail apps open links in their own) nothing of the form is applied (no name, country, phone or password: otherwise a stranger who signed up with someone else's address could sign in to the account the owner of the mailbox opens, or leave their details on it), the hash is discarded, and the answer says `passwordSet: false` with `pendingDetails` (the names, country and phone as typed, never the password) for the owner to confirm; an account that already had its login takes nothing and the answer has neither key. **The finish** (`finishSignUp`, `POST /store/v1/auth/sign-up/finish`) is for a signed-in retail account that has no password yet (that pending account, or an older one made by a link without details): the rules of the sign-up, five tries per account in 15 minutes (`sign-in` limiter, kind `sign-up-finish`), only on a session opened at most 60 minutes ago (`SIGN_UP_FINISH_SESSION_MAX_AGE_MS`; its `created_at` read by `SessionService.openedAt`; an older one is `409 CONFLICT`: ask for a new sign-in link), `409 CONFLICT` when the account has a password (read again under its `FOR UPDATE` lock, and the write guarded by `password_hash IS NULL`); it writes the name, the country (and its currency only when the country changes, as `PATCH /store/v1/me`), the phone and the password as an own change does (`password_changed_at`, no forced change, invitation and reset links voided, the other sessions ended, this one kept), and queues the mail `customer.password_set` (`MerchantLifecycleMails.passwordSet`; its own event, not the staff notice) to the account's own address in the same transaction. The job `sign_up_purge` (every 15 minutes) and the daily `session_purge` delete the waiting forms whose link expired or was used, and a deleted link takes its form with it (cascade). `GuestClaimService` runs inside the exchange when the body says `claimGuestOrders: true`, for a retail active account whose row is not the guest row itself: in the exchange's transaction, after its own lock of the account row, a savepoint; the guest row `FOR UPDATE NOWAIT`; the claim is skipped (`claimedOrders: 0`, `claimSkipped: 'busy'`) when the guest row has an open checkout session, a pending payment or any ledger account; otherwise every registered `GuestClaimParticipant` takes its rows `FOR UPDATE NOWAIT` and moves them from the guest id to the account id, and one audit row `claimed guest orders` (entity `account`, counts) is written. A lock conflict (`55P03`) anywhere rolls back to the savepoint and answers `claimSkipped: 'busy'`; the sign-in itself still succeeds. A participant refuses with `GuestClaimBusy`. The guest row stays, empty. The links of an account in the other direction (the mailbox proven by `verify_email`) and the optional session of the shop checkout (`OptionalAccountSession`: CSRF first, then the rank) are the same flows for every account.

### Sign-in lock (decision 052)

`SignInLockModule` (`sign-in-lock.module.ts`, imported by `StaffAuthModule`, `MerchantAuthModule`, `AccessAdminModule`,
`MerchantAdminModule` and the customers module) provides `SignInLock` (`application/sign-in-lock.ts`) on top of `SignInFailures`
(`infra/sign-in-failures.ts`). Failed password sign-ins are counted per email in two scopes, `staff` (the console) and `shop` (every account's
sign-in: the three password routes and the shop's aliases share one count), whether or not an account has the email. `assertMayTry(scope, email,
account, meta)` counts the attempt before the password is checked (`SignInFailures.charge`: one `MULTI` that raises the count, renews
the TTL and reads the lock, so parallel attempts each see their own count) and refuses it (`429 RATE_LIMITED`, `Retry-After` = the time
left) while the email is locked, or when it is the first attempt beyond ten failures, which starts the 15-minute lock and the count again
(`domain/sign-in-lock.ts`), unless the request's network (an IPv4 /24 or an IPv6 /64, `signInNetworkKey`) is one of the networks of the
50 newest full (`active`) sessions of the account being signed into (`fullSignInAddresses`); it reads the sessions whenever the email is
locked, with an id no account has when there is no account, so a locked email answers alike for every email. The attempts a familiar network is still allowed while the lock runs share one budget per scope, email and network:
`takeFamiliarPoint` takes one point of the limiter `sign-in-familiar` (5 in 15 minutes; the key is a keyed hash of scope, email and network
key, `gsm:{env}:ratelimit:sign-in-familiar:{hash}`), and the sixth attempt is refused like any other one on a locked email, before its password
is checked; nothing of this runs while no lock runs. A refused attempt's count goes back while a lock runs. Every `401` stays counted; `giveBack` (a Lua script, never below 0) takes back the attempt of a correct
password, before a `403` too, and never the failures of other attempts: a password chosen without the emailed link proves no mailbox. `clear` (after the commit of a new password from a link, a temporary password set by staff, an account made by staff) deletes count and lock; an account's own or forced change does not, for any rank. The state is the hash `gsm:{env}:identity:sign-in-failures:{hash}` (fields `n`, `until`; the hash is keyed on the scope and
the email) on the cache Redis; while it cannot be reached each process counts in memory.

### Account mail (decision 064)

An email is outbox work (decision 020): a use case writes the mail of a link in its transaction with `AccountMailOutbox.enqueue(work, { kind, accountId, tokenId })`, with `kind` `email_verification`, `password_reset`, `invited` or `magic_link` (the last for the retail rank only). **The mail of a link is chosen when it is queued, by the rank kind of the account, read under the account row lock**: a merchant rank gets the `merchant.*` events (`merchant.email_verification`, `merchant.password_reset`, `merchant.invited`), a retail rank the `customer.*` events (`customer.magic_link`, `customer.password_reset`, `customer.invited`, `customer.email_verification`); the stored templates keep their names and there are no `account.*` events (`ACCOUNT_MAIL_EVENTS`). The payload is `{ accountId, tokenId }` and the aggregate is `clients` with the account as its id: ids only, never the token or the address. The events map to the `notifications` queue; `MerchantMailModule` (loaded by the API and by the worker) registers them and provides one processor per type (`jobs/account-mail.processors.ts`: seven classes, three merchant and four customer) that run `AccountMailJobs.handle` (decision 033): it re-reads the account and the link and skips what is no longer worth sending (an account that may not act, a rank kind that is no longer the one the mail was written for, a link that was used, replaced or has expired, a mail that already went out); **a job that names only an old customer number is discarded** with `UnrecoverableError` and the number is never read as an account id; a mail queued before the cut-over, with no `accountId` and the aggregate `clients`, names the account as its aggregate and is sent. A missing or switched-off template does not stop the mail, the shipped text is sent (decision 047). The request makes a placeholder token that nobody receives (the clear value is not kept anywhere); **the job rotates it**: it puts a new random token's hash on the same `auth_tokens` row (same id, same expiry, only while the row is unused and unexpired) and sends the link through the platform's `NotificationService.sendNow`, with the clear link as a *secret* placeholder that is never stored or logged. **Every link points at the shop**: `<STORE_BASE_URL>/sign-in?token=`, `/set-password?token=` or `/verify-email?token=` (`accountMailLink`); the pages of the signed-in area are under `/account` (`ACCOUNT_AREA_PATH`). The `notifications` row (`outbox-<event id>:email`) logs the mail without the link; a retry of the job rotates again and resends (the earlier value never arrived), and a repeat after a delivered mail is skipped before it can spoil the link that arrived. In development the mail lands in Mailpit (`http://localhost:8025`). The merchant-era classes `MerchantMailOutbox`, `MerchantAuthTokens`, `merchant-token.repository` re-exports, `merchant-mail-jobs` (only `formatExpiry` is still read), the old processor names and `MERCHANT_INVITED_EVENT` stay until the contract release deletes them.

### Notification settings (feature 12a)

Two routes (contracts `contracts/merchant-notifications.contracts.ts`; controller `controllers/merchant-notifications.controller.ts`; use case
`application/merchant-notification-settings.service.ts`; queries `infra/merchant-notification.repository.ts`; module `merchant-notifications.module.ts`).
They live here because they need `CurrentMerchant` (the signed-in account of a merchant rank) and the account's own column (`notification_prefs`); the delivery path itself is the platform's.
Spec: MISMATCHES B165. The Telegram link and the bot's webhook of the same feature were retired with decision 062.

| Route | Access | What it does |
|---|---|---|
| `GET /client/notification-preferences` | merchant rank | `{ email: { address }, lowBalanceThreshold (money or null), events: [{ event, label, email }] }`: the non-transactional merchant events of the platform's registry; never saved reads as email on (the order results stay off until chosen) |
| `PUT /client/notification-preferences` | merchant rank | `{ lowBalanceThreshold?, events }` replaces the listed events, keeps the others and the keys it does not know; `422` on `events.N.event` (unknown, always-sent or repeated) and on `lowBalanceThreshold` (negative or malformed); a `telegram` field in a row (an older portal still sends it) is dropped; answers the GET body; the row is locked, so two saves take turns |

The portal writes no audit rows (B121). `ACCOUNT_PENDING_APPROVAL` is not among the documented errors of these routes any more (the status `pending` is gone). `clients.telegram_chat_id`, the `telegram_link` purpose of `auth_tokens` and the `telegram` keys that older
saves put in `notification_prefs` are retired (decision 062): nothing reads or writes them.

### Staff reads and writes of accounts (decision 064; plan `docs/briefs/20-merchant-management.md` for the history)

Staff tools, the accounts' own sign-in changes, the staff link mails and staff-made API keys, all inside this module. One list, one create, one edit, one status write; the rank changes only through `POST /admin/clients/:id/rank` (the money module).

- **Reads** (`ClientAdminService`, `ClientViews` in `application/client-views.ts`, `AccountCountsService`, `infra/client-admin.repository.ts`, `infra/account-counts.repository.ts`). `GET /admin/clients` returns **every account**, whatever its rank, guests included; without a `rankKind` filter nothing is left out. A row has `rank {id, name, kind}` (`retail` or `merchant`), `hasAccount`, `invitationPending` (an invitation link waits: `INVITATION_PENDING_SQL`), `currencyCode`, `marketingOptIn`, `createdBy`, `anonymizedAt`, `lastLoginAt`, `ordersCount` and `lastOrderAt` (both doors, any status); `status` has four words (no `pending`); the wallet has `kind` and `frozen`; `security` is null for a guest. The wallet and the 30-day figures are sent only to staff who hold `wallet:read`, and so is the sort by `balance` (403 without it). Filters: `rankKind`, `rankId`, `hasAccount`, `country`, `invitationPending`, a repeated `status`, `q`; sorts: `rank`, `ordersCount`, `lastOrderAt`, `balance` and the old ones. The order figures and the wallet balance reach the list as SQL fragments the orders and money modules register with `AccountListSql` (a sort by them is one query; reading before they are registered is a boot error), and the wallet of a whole page is read through `AccountWallets.viewsOf` in a fixed number of statements. The row also has the keys of feature 20: `address`, `taxId`, `internalNotes`, `security` (`hasPassword`, `mustChangePassword`, `passwordChangedAt`, `twofaEnabled`, `lastLoginAt`, `lastLoginIp`, `activeSessions`, `linkSentAt`, `verificationSentAt`) and `suspension` (`at`, `reason`, `by`). `GET /admin/clients/counts` returns the numbers of the chips (all, retail, merchant, guests, by status, invitations pending) from one aggregate, never cached. The consent evidence and the risk summary of the detail come through the customers module's `AccountPrivacyReads`. An account has no language (decision 039): every mail is English.
- **Create** (`POST /admin/clients`, `ClientWriteService.create`, `domain/account-rules.ts`): an account of any rank. An omitted rank is the retail rank; **a merchant rank is the Owner's** and is checked (`assertMayGiveRank`) before anything is read for writing; the email follows the rule of the two partitions (a login row stops the create with `409 EMAIL_TAKEN`; a guest row stops a retail create (`errors[0].code` `guest`) and is left alone by a merchant create, which voids the guest row's open sign-in links in the same transaction); the checks other modules registered (`AccountCreateGuards`: the blocklist) run before the first write; the password is an emailed invitation or a temporary password returned once (`password.mode`; the answer carries `temporaryPassword` with `Cache-Control: no-store`). A merchant rank gets its wallet and hold accounts through `MerchantAccounts.open` (`overdraft_limit` = credit limit; credit above zero on a rank without `overdraft_allowed` is `422` on `creditLimit`), a generated Dhru username and, for an invitation, the one-hour `invite` link and the mail through `AccountMailOutbox`; a retail rank has no username and no credit. A credit limit above zero also needs `wallet:credit_limit`.
- **Edit and status** (`PATCH /admin/clients/:id`, `ClientWriteService.update`): one kind of change per call: details (below), or a status write, which is only `active` or `suspended` (suspend with a reason of 3 to 140 characters, reactivate; any other word is `422`); **the rank never travels in the edit** (`groupId` is `422` on `groupId`, code `use_rank_route`). A status that may not act ends every session, voids every link and (on an erasure) revokes every key through `AccountAccessEffects.statusChanged`, in the same transaction. Suspension and reactivation mails stay merchant-only (a retail rank is not mailed). The same email rule and the same checks judge the new address of an edit; an email change needs `clients:security` (decision 047).
- **Make an account** (`POST /admin/clients/:id/account`, `AccountGuestService`, `clients:update`): a guest row becomes a login account, with `{ mode }` (default `reset_link`: a set-password link; or a temporary password) answering `{ temporaryPassword?, link?: 'invite' }`; `409 ACCOUNT_EXISTS` for a row that already has a login, `409 EMAIL_TAKEN` with `errors[0].code` `login_exists` when a login row holds the email.
- **Edit details** (`domain/client-details.ts`, `ClientDetailsEditor`). An email change also needs `clients:security` (checked before the limiter and again on the locked row), clears `email_verified_at`, uses every open link up, ends every session of the account, sends a security notice (`merchant.security_notice` or `customer.security_notice` by the rank kind of the locked account, kind `email_changed`) to the address before the change, sends a verification (or the invitation while there is no password) to the new address, drops the session and API key cache keys, sets `email_set_by_staff` when the caller is not an Owner and clears it when the caller is an Owner (the marks below), and counts on the `account-mail` limiter. An Owner's edit that carries the stored `email` clears a set `email_set_by_staff` and does nothing else to the email; its audit row records `emailSetByStaff` going from `true` to `false`. A name change keeps the sessions.
- **Security tools** (`ClientSecurityAdminService`, permission `clients:security`): `POST /admin/clients/:id/password` (`reset_link` mails an invitation or reset link, `temporary_password` shows a 14-character password once and sets `must_change_password` and `password_set_by_staff`), `POST /admin/clients/:id/reset-2fa`, `POST /admin/clients/:id/sessions/revoke`, `POST /admin/clients/:id/verify-email/resend`. They work on **any account with a login**; a guest has nothing to secure (`NO_ACCOUNT`, `NOT_ACTIVE`, `ANONYMIZED` by `securityToolError`). Each locks the `clients` row first, writes one audit row under the account (`credential`, never `password`) and returns no link: the outbox carries ids, the mail job rotates the token.
- **Forced password change.** Described under "Accounts, sign-in and the rank gate". Every chosen password (reset link, invitation, security page) clears the flag.
- **The two marks of a staff-set password or address** (decisions 046 and 067). `password_set_by_staff` is set with a temporary password and cleared only by a password from a link mailed to the account's address (reset or invitation; the forced change and the security page do not clear it). A change of the email address by a staff member who is not an Owner sets `email_set_by_staff`; a password from a link does not clear it, because the link goes to the address staff chose. An Owner's change of the address sets no mark and clears one, and an Owner's details edit that carries the stored address clears a set mark. The marks held back the merchant's own creation of API keys (`MachineCredentialHold`, decision 046). Merchants create no key since decision 067, so nothing reads the marks any more: they stay in the database and are still written, as before, until the migration of the accounts model drops them.
- **Verification resend.** `POST /client/auth/verify-email/resend` and the staff action share the `account-mail` counter (5 an hour per account and kind); there is no public route. `verify-email` answers `410` for an account that may not act.
- **Lifecycle mails** (`MerchantLifecycleMails`): `merchant.suspended`, `merchant.reactivated`, `merchant.security_notice` are transactional, registered at boot by `IdentityMailEventsModule`, with English default templates (`application/mail/identity-templates.ts` keeps the text; `drizzle/0025_merchant_management_templates.sql` shipped it, and a spec finds every default row of the code in the applied file). `securityNotice(work, {id, name, rankKind?}, kind, {to?})` takes the rank kind of the locked account: omitted means the merchant family, `retail` writes `customer.security_notice` (API key notices throw for a retail rank); the recipient is `{type: 'account', id}`. The module also registers the shipped texts with the event registry (`registerBuiltInTemplates`), the fallback of the security emails (decision 047). The security notice has five kinds, each one fixed sentence (`SECURITY_NOTICE_PHRASES`): `temporary_password`, `twofa_reset`, `api_key_created`, `api_key_changed` and `email_changed`; the `email_changed` notice names the address it goes to (`to`: the address before the change). The finish of a sign-up (decision 079) does not use the notice, whose stored text says that support made the change: `passwordSet(work, {id, name})` writes its own event `customer.password_set` (variables `customerName` and `change`, the one sentence `PASSWORD_SET_SENTENCE`; a security mail like the notice, so its shipped text is sent when no template stands, and no migration installs it, `IDENTITY_SHIPPED_TEXT_ONLY`) to the account's own address, and greets an account without a name as "there". The notice of a key the account made in the portal was its own event, `merchant.portal_api_key_created` (flagged `security`; no migration installs its text, so the shipped text is what is sent until staff add a template for the event, `IDENTITY_SHIPPED_TEXT_ONLY`). Nothing sends it since decision 067 (merchants no longer create keys); the event stays registered with its shipped text so a notification written before still reads and sends. The end of one account session is audited under `account`.
- **Staff link mails** (`StaffMailModule`, loaded by the API through `AccessAdminModule` and by the worker): `POST /admin/staff` (onboarding `invite`) and `POST /admin/staff/:id/password` (`reset_link`) write `staff.invited` (while the member is `invited`) or `staff.password_reset` with `StaffMailOutbox.enqueue` (payload `{ tokenId }`, aggregate `staff_users`). `StaffMailJobs` does what `AccountMailJobs` does for accounts: re-reads the member and the link, skips a suspended or deleted member and a used, replaced or expired link, rotates the token on the same row and sends `<CONSOLE_BASE_URL>/set-password?token=<token>` as a secret that is never stored or logged. The link request counts on the `account-mail` limiter (five an hour per member, `429`); the temporary-password mode sends no mail.
- **API keys by staff** (`ApiKeyAdminService`, `ApiKeyIssuer`): see "API keys (feature 7b)".

### What happens when an account changes

| Change | Sessions | Open links | Caches | Mail |
|---|---|---|---|---|
| Staff set a temporary password (`revokeSessions` on by default in the console) | ended when asked | all password links voided | session views dropped | security notice (`merchant.` or `customer.` family by rank) |
| Staff send a reset or invitation link | kept (or ended when asked) | the newer link voids the older | none | the link mail (rotated in the job) |
| Staff reset 2FA | all ended | none | session views dropped | security notice |
| Staff change the email (needs `clients:security`) | all ended | every open link voided | session and API key views dropped | security notice to the address before the change; verification (or invitation) to the new address |
| Suspension (or a block) | all ended | every open link voided | session and API key views dropped | `merchant.suspended` for a merchant rank only (no reason) |
| Reactivation | none (already ended) | none | API key views dropped | `merchant.reactivated` for a merchant rank only |
| Erasure of an account | all ended | every open link voided | session and API key views dropped | none; every API key revoked |
| **Rank change across kinds** (money module) | all ended | none | session and API key views dropped | none; an invitation when an account without a password is raised to a merchant rank; every live API key revoked when it leaves the merchant kind |
| Rank change inside the merchant kind | none | none | the session view is dropped after commit | none |
| Staff create a key | none | none | none | security notice |
| Staff edit a key's limits or revoke it | none | none | that key's view dropped | none |
| The account chooses a password (change, reset, invitation) | the others ended, this one rotated | password links voided | session views dropped | none |

All of the first rows (status and rank) go through `AccountAccessEffects` (`statusChanged`, `rankChanged`), which the staff status write, the block, the erasure and the rank change call in their own transaction; it answers the counts (sessions ended, keys revoked, invited) the audit row keeps.

### Notification center audiences (feature 23)

`notifications/` holds the staff and merchant-rank audience providers of the platform's notification center (`StaffAudience`,
`MerchantAudience`), registered with `NotificationAudiences` by `IdentityAudienceModule` at boot (imported by `IdentityModule` and the
worker). Staff: active members, optionally of some roles. Merchant ranks: by status (default active; the status filter `merchants.statuses` of a campaign is accepted and ignored, because only an active account is mailed),
rank and country, never suspended; their email flag is the SQL twin of `choiceFor` for `broadcast.announcement`.
Merchants and staff read English. The providers only read `staff_users` and `clients` (the retail audience, which also takes the guests, is the customers module's).

### Live event streams and session doorbells (feature 27)

Three routes beyond the map (`scripts/map-additions/27.mjs`; decisions 035 and 037; plan `docs/briefs/27-realtime-notifications.md`)
answer `text/event-stream` to the signed-in person, so a notification appears at once. The routes live here because identity owns
sessions, principals and the guard; the layer itself (hub, publisher, registry, wire format) is `src/infra/realtime` (see its
README) and the inbox is its first source (platform). Code: `realtime/` (`stream.contracts.ts`, `stream.controller.ts`,
`stream-viewer.ts`, `stream.module.ts` = `StreamRoutesModule`).

- **Thin controller.** The session guard authenticates the request like any other (stage, account state, IP rules, and `originCheck`:
  `Sec-Fetch-Site: same-origin` or an `Origin` of the surface's audience, else `403 CSRF_FAILED`); the handler maps the principal to a `StreamViewer`
  (`streamViewerOf`: staff, or an account, whatever its rank, as `account`, key `u:account:<id>`; an API-key, capability or webhook principal is `401`) and the caps
  `session:<id>` (`REALTIME_MAX_PER_SESSION`) and `ip:<address>` (`REALTIME_MAX_PER_IP`) (`streamCapsOf`), then calls `RealtimeHub.open`.
  The hub refuses (problem+json, before the stream starts) or hijacks the reply and streams. `GET /client/stream` serves merchant ranks and `GET /store/v1/me/stream` the retail rank; an account has one inbox and one stream key, whichever family it connects through; a suspended one is `ACCOUNT_SUSPENDED`.
- **Events and refusals:** `docs/contract/realtime-events.md`.
- **Session doorbells.** `SessionService` rings the hub after the commit, ids only (topic `session`, never a source): `revoke`,
  `revokeAllOf` and `rotate` (the old row) ring `ended` with the session ids (500 per message), so the streams of those sessions get
  `bye session_ended` and close at once; `invalidateSubject` (suspension, password or role change, a change of the permissions of a role for each of its members, a staff edit of an account, a rank change) rings
  `subject` with the subject type and id when the account has live sessions, so its streams get `bye reauth`, reconnect, and the guard
  answers 401 or 403 for a suspended account (which stops the browser's `EventSource`). Beside the cache `forget`, after the commit
  (`afterCommit` and `onCommit`), through `RealtimePublisher.publishOnCommit`; a failed publish never fails the use case. A stream
  also ends by itself every 15 minutes (`bye max_age`), so the idle and absolute expiry of a session, IP rules and a changed role
  apply to an open stream.
- **No new table, migration, permission or error code** (`RATE_LIMITED`, `UNAVAILABLE` and `CSRF_FAILED` are in the catalog); the
  limiter `stream-connect` (20 a minute per session) is in `src/infra/rate-limit/limiters.ts`.

## Owned tables

Only this module reads and writes these 10 tables (`scripts/module-map.mjs`, `account_legacy_ids` and `account_signups` among its additions); other modules call its public service. Schema: `db/schema.ts`.

| Table | What it holds |
|---|---|
| `staff_users` | Admin console staff. Two-factor authentication is mandatory. Status is invited until the first sign-in, then active, or suspended (a reversible stop that ends the sessions and keeps the record). The last owner and the staff member themselves cannot be suspended. Allowed addresses live in ip_rules, not in a column. |
| `roles` | Roles and their permissions (RBAC). |
| `clients` | Every account (decision 064): a merchant, a retail buyer or a guest, told apart by the rank (`group_id`, kind `b2b` or `b2c_retail`) and by `has_account` (false for a guest). Status is `active`, `suspended`, `blocked` or `anonymized`. Email is unique among login rows and, separately, among guest rows; `username` (the Dhru username) is set for a merchant rank only and is nullable; `referral_code` is nullable and unwritten. The columns `kyc_status`, `referred_by_id`, `telegram_chat_id` are retired and unread (decisions 061 and 062). |
| `account_legacy_ids` | The append-only map of old merchant and customer numbers to accounts (`legacy_type` `client` or `customer`, `legacy_id`, `account_id`, `merged`); never dropped. An old customer number is never an account id. |
| `account_signups` | Decision 079: the details of a shop sign-up waiting beside its one-time link (`auth_token_id` unique, `ON DELETE CASCADE`; the argon2id `password_hash`, `first_name`, `last_name`, `country`, `phone`). One row per link. Written once, deleted by the exchange of any link of the address, by the purge every 15 minutes (`sign_up_purge`) or the daily one, never updated (no `updated_at`); never holds a plain password. |
| `sessions` | Sign-in sessions for staff and for accounts of every rank (subject type `staff` or `account`; the stage `pending_password`, `pending_totp`, `pending_totp_setup` or `active`). |
| `auth_tokens` | One-time tokens for invite and password-reset links for accounts and staff, and for link sign-in and email verification: hash only, valid for one hour and one use (subject type `staff` or `account`). |
| `api_keys` | API keys of accounts of a merchant rank, stored as a hash. |
| `kyc_submissions` | Retired (decision 061): requests of merchant verification by documents. No code reads or writes it; its rows keep the stored documents referenced until the owner decides how long to keep them. |
| `ip_rules` | Network rules checked before any other logic: allow addresses for the admin console, and block an address or range for one audience (storefront, API or admin) or for all. A block beats an allow. Restricting the console to the allowlist is a switch in settings. Active rules are loaded into Redis, so no query runs per request. |

## Routes

The map has 59 endpoints of this module, eight of them retired by decisions 061 and 062 and not built; feature 20 adds 8 routes beyond it, feature 27 the 3 live event streams and decision 064 three more (`GET /admin/clients/counts`, `GET /admin/legacy-accounts/:type/:id` and `POST /admin/clients/:id/account`; the customers module hosts the shop's sign-in routes and the one sign-in form `POST /client/auth/sign-in`). Source: `docs/slices/identity.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built; the staff sign-in (6) and the account portal routes of stage 2 (2b) are built.

### Admin console

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/api-keys/:id` | staff-permission · `api_keys:revoke` | Revoke a merchant API key. | 7 |
| `DELETE /admin/ip-rules/:id` | staff-permission · `access:*` | Allowed and blocked addresses: range, audience, reason and duration. | 2 |
| `DELETE /admin/roles/:id` | staff-permission · `roles:*` | Roles and their permissions. | 2 |
| `DELETE /admin/sessions/:id` | staff-permission · `sessions:revoke` | End a session. | 2 |
| `GET /admin/auth/me` | staff-session | The signed-in staff member and their permissions, for Refine. | 2 |
| `GET /admin/clients` | staff-permission · `clients:*` | Accounts of every rank: list, detail, create and edit (the rank only through `POST /admin/clients/:id/rank`). | 2 |
| `GET /admin/clients/:id` | staff-permission · `clients:*` | Accounts of every rank: list, detail, create and edit (the rank only through `POST /admin/clients/:id/rank`). | 2 |
| `GET /admin/clients/counts` | staff-permission · `clients:read` | The counts of the chips: all, retail, merchant, guests, by status, invitations pending (decision 064, route beyond the map). | 64 |
| `GET /admin/legacy-accounts/:type/:id` | staff-permission · `clients:read` | The account an old merchant or customer number belongs to now, or 404 (decision 064). | 64 |
| `POST /admin/clients/:id/account` | staff-permission · `clients:update` | Make a login account of a guest: a set-password link or a temporary password (decision 064). | 64 |
| `GET /admin/clients/:id/api-keys` | staff-permission · `api_keys:read` | API keys of an account (any rank). | 7 |
| `GET /admin/ip-rules` | staff-permission · `access:*` | Allowed and blocked addresses: range, audience, reason and duration. | 2 |
| `GET /admin/ip-rules/:id` | staff-permission · `access:*` | Allowed and blocked addresses: range, audience, reason and duration. | 2 |
| `GET /admin/permissions` | staff-permission · `roles:read` | All available permissions. | 2 |
| `GET /admin/roles` | staff-permission · `roles:*` | Roles and their permissions. | 2 |
| `GET /admin/roles/:id` | staff-permission · `roles:*` | Roles and their permissions. | 2 |
| `GET /admin/sessions` | staff-permission · `sessions:read` | Active sessions of staff members (the rows name the subject types `staff` and `account`; the filters `client` and `customer` are 422). | 2 |
| `GET /admin/staff` | staff-permission · `staff:*` | Staff members: add by invitation or temporary password, set the role, and edit details. | 2 |
| `GET /admin/staff/:id` | staff-permission · `staff:*` | Staff members: add by invitation or temporary password, set the role, and edit details. | 2 |
| `PATCH /admin/clients/:id` | staff-permission · `clients:*` | Accounts of every rank: list, detail, create and edit (the rank only through `POST /admin/clients/:id/rank`). | 2 |
| `PATCH /admin/api-keys/:id` | staff-permission · `api_keys:update` | Change a merchant key's per-minute limit and allowed addresses (feature 20). | 7 |
| `PATCH /admin/roles/:id` | staff-permission · `roles:*` | Roles and their permissions. | 2 |
| `PATCH /admin/staff/:id` | staff-permission · `staff:*` | Staff members: add by invitation or temporary password, set the role, and edit details. | 2 |
| `POST /admin/auth/2fa` | public | Complete the sign-in with a TOTP code. | 2 |
| `POST /admin/auth/2fa/setup` | public | First sign-in: the TOTP secret with a QR code. | 2 |
| `POST /admin/auth/login` | public | Sign in with email and password; a TOTP step follows. | 2 |
| `POST /admin/auth/logout` | staff-session | Sign out. | 2 |
| `POST /admin/auth/password/set` | public | An invited or recovering staff member chooses their own password with a one-time token. | 2 |
| `POST /admin/clients` | staff-permission · `clients:*` | Accounts of every rank: list, detail, create and edit (the rank only through `POST /admin/clients/:id/rank`). | 2 |
| `POST /admin/clients/:id/password` | staff-permission · `clients:security` | Send an account a set-password or invitation link, or set a temporary password that must be changed at the next sign-in (feature 20). | 20 |
| `POST /admin/clients/:id/reset-2fa` | staff-permission · `clients:security` | Turn off an account's two-factor sign-in and end their sessions (feature 20). | 20 |
| `POST /admin/clients/:id/sessions/revoke` | staff-permission · `clients:security` | Sign an account out of every device (feature 20). | 20 |
| `POST /admin/clients/:id/verify-email/resend` | staff-permission · `clients:security` | Send the account a new email verification link (feature 20). | 20 |
| `POST /admin/clients/:id/api-keys` | staff-permission · `api_keys:create` | Create an API key for an account of a merchant rank (409 `CONFLICT` for another rank); the key is shown once (feature 20). | 7 |
| `POST /admin/ip-rules` | staff-permission · `access:*` | Allowed and blocked addresses: range, audience, reason and duration. | 2 |
| `POST /admin/ip-rules/check` | staff-permission · `access:read` | Test an address before the change; it returns the decision and the matching rule. | 2 |
| `POST /admin/roles` | staff-permission · `roles:*` | Roles and their permissions. | 2 |
| `POST /admin/staff` | staff-permission · `staff:*` | Staff members: add by invitation or temporary password, set the role, and edit details. | 2 |
| `POST /admin/staff/:id/password` | staff-permission · `staff:update` | Send a link to set a new password, or set a temporary one; the current password is never readable and never enters the log. | 2 |
| `POST /admin/staff/:id/reactivate` | staff-permission · `staff:suspend` | Reactivate a suspended staff member. | 2 |
| `POST /admin/staff/:id/reset-2fa` | staff-permission · `staff:update` | Reset 2FA for a staff member. | 2 |
| `POST /admin/staff/:id/sessions/revoke` | staff-permission · `staff:update` | End all sessions of a staff member. | 2 |
| `POST /admin/staff/:id/suspend` | staff-permission · `staff:suspend` | Suspend a staff member with a reason, which ends their sessions; suspending yourself or the last Owner is rejected. | 2 |
| `PUT /admin/access/restriction` | staff-permission · `access:update` | Turn the allow-list restriction on the admin panel on or off; turning it on is rejected if the address of the requester is outside the list. | 2 |

### Account portal (`/client`; merchant rank unless a row says it is open to every rank)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /client/api-keys` | merchant-session | My API keys (prefix only). | 7 |
| `GET /client/auth/me` | merchant-session | The account's details and rank (`AccountMe`). | 2 |
| `PATCH /client/profile` | merchant-session | Update name, company, phone, country, address and tax id. | 2 |
| `POST /client/auth/2fa` | merchant-session, rank any | Complete the sign-in with a TOTP code. | 2 |
| `POST /client/auth/login` | public | Sign in; asks for a 2FA code when 2FA is enabled (alias of the one sign-in, retired by the contract release). | 2 |
| `POST /client/auth/logout` | merchant-session, rank any | Sign out and end the session. | 2 |
| `POST /client/auth/password/change` | merchant-session (`pending_password`), rank any | Replace a temporary password during sign-in (feature 20). | 20 |
| `POST /client/auth/password/forgot` | public | Send a password reset link. | 2 |
| `POST /client/auth/password/reset` | public | Set a new password with the reset token. | 2 |
| `POST /client/auth/verify-email` | public | Verify the email with the token. | 2 |
| `POST /client/auth/verify-email/resend` | merchant-session | Send the signed-in merchant a new verification link (feature 20). | 20 |
| `POST /client/security/2fa/disable` | merchant-session | Disable 2FA with a code. | 2 |
| `POST /client/security/2fa/enable` | merchant-session | Enable 2FA after confirming a code. | 2 |
| `POST /client/security/2fa/setup` | merchant-session | A new TOTP secret with a QR code. | 2 |
| `POST /client/security/password` | merchant-session | Change the password. | 2 |

### Live event streams (3, beyond the map: feature 27)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /admin/stream` | staff-session | The staff member's live event stream (server-sent events). | 27 |
| `GET /client/stream` | merchant-session | The live event stream of an account of a merchant rank (server-sent events; viewer `account`). | 27 |
| `GET /store/v1/me/stream` | customer-session | The live event stream of an account of the retail rank (server-sent events; viewer `account`). | 27 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/e2e/`).

- `success`: Order completed by the supplier (tables: `api_keys`)
- `reject`: Supplier rejects the order (tables: `api_keys`)
- `manual`: Manual fulfilment by staff (tables: `api_keys`)
- `timeout`: Supplier timeout (the order needs attention) (tables: `api_keys`)
- `b2c-account`: Managing a storefront account (tables: `auth_tokens`, `sessions`)
- `admin-team`: Adding and suspending a staff member (tables: `auth_tokens`, `ip_rules`, `roles`, `sessions`, `staff_users`)
- `ip-rules`: IP block list and allowlist (tables: `ip_rules`, `sessions`)

End-to-end tests: `test/e2e/admin-team.e2e.test.ts` (steps 1 to 9) and `test/e2e/ip-rules.e2e.test.ts` (steps 1 to 9; step 7, the risk engine's automatic block, is a row written the way feature 18 will write it). Route tests: `test/integration/{staff-admin,roles-admin,sessions-admin,ip-rules-admin,clients-admin}.test.ts`.

## Permissions

Feature 20 adds `clients:security` (password links, temporary password, 2FA reset, end all sessions, verification resend, an email change and suspending or reactivating); decision 064 adds `clients:block` (block an account; a stored role that held `customers:block` receives it by the migration `0067_account_permissions`) and keeps `customers:privacy` for the export and the erasure and, in slice D, `api_keys:create` and `api_keys:update`; a role that holds `clients:*` or `api_keys:*` receives them through the grammar.

Staff permissions the map requires on this module's admin routes: `access:*`, `access:read`, `access:update`, `api_keys:read`, `api_keys:revoke`, `clients:*`, `roles:*`, `roles:read`, `sessions:read`, `sessions:revoke`, `staff:*`, `staff:suspend`, `staff:update`.

The contracts of feature 2a name the concrete permissions: `access:read|create|update|delete`, `clients:read|create|update|block|security`, `roles:read|create|update|delete`, `sessions:read|revoke`, `staff:read|create|update|suspend` (a role may hold `area:*` for each area).

Keep this list in step with the contracts (`permission` of each `defineRoute`).

### Permissions that reach owner-level power (decision 046)

The server keeps every staff member inside their own permissions (the privilege ceiling) and keeps a few actions for Owners: a payment
method's secrets and automatic methods, API keys made for a merchant from the console, and IP rule changes that would shut out an
Owner. Some permissions still let one person move money or act for other accounts on their own. Give them only to people you trust as
you trust an Owner, and remember that an area wildcard (`wallet:*`, `clients:*`, `payments:*`, ...) includes every permission of its
area:

- money: `wallet:adjust`, `wallet:credit_limit`, `payments:approve`, `invoices:create`, `refunds:approve`, `orders:reopen`;
- other people's accounts: `clients:security`, `clients:update`, `clients:block`, `staff:create`, `staff:update`,
  `roles:create`, `roles:update` (the last four only up to the holder's own permissions); `clients:security` also guards the change of
  an account's email address and the creation of an account with a temporary password, because the address is where the account's
  sign-in and password links go (decision 047). The seven retired `customers:*` permissions of the old customer routes stay in stored roles until the contract release strips them;
- who reaches the console: `access:create`, `access:update`, `access:delete`, `sessions:revoke`;
- personal data: `payments:read` (payment receipts), `clients:read` (the address of an account of any rank in every staff page, and the identity documents stored before decision 061),
  `customers:privacy` (exports and erasures), `reports:read` (the order export); `files:read` alone opens only files nothing uses yet and
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
- **Audience of a request** (`ip-audience.ts`): `/admin` is `admin`, `/store/v1` is `store`, `/api/index.php` is `api`
  (the console's "Merchants using the API"), everything else (the portal `/client`, `/webhooks`, the documentation pages) is
  `other`. **The eight sign-in routes of the portal family that every account uses** (`SHARED_SIGN_IN_PATHS`: sign-in, login, 2fa, logout, password/change, password/forgot, password/reset, verify-email) count as **both** audiences, `store` and `other` (`ipAudienceOf` answers a list; `decideIpAccess` takes one audience or several), so a block on the shop also stops a blocked buyer from signing in, and a merchant behind a store-blocked address is refused there too (a store block is a fraud block). Store maintenance does not cover them (the portal must not go down with the shop). The path is the route template of a matched route and the decoded path of an unknown one, so an escaped spelling
  such as `/%61dmin` cannot dodge a rule.
- **Verdict** (`decideIpAccess`, the same words as `POST /admin/ip-rules/check`): (1) a live **block** rule with the audience's
  scope, or with scope `all`, that covers the address refuses it (the most specific rule is reported, then the lowest id);
  (2) for `admin`, when the setting `adminAllowlistOnly` is on, the address needs a live **allow** rule (scope `admin`), else it
  is refused as "not listed"; (3) otherwise it passes. A rule past its `expires_at` drops out by itself, without a reload.
  `all` therefore reaches the portal, webhooks and the docs too; `/health` and `/metrics` are never judged.
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

Feature 20's lifecycle mails are not outbox types of this module: they are `notifications` rows with a `notification.send` event written by `MerchantLifecycleMails` in the transaction of the staff action (events `merchant.suspended`, `merchant.reactivated`, `merchant.security_notice`, `customer.security_notice`, and `customer.password_set` of the finish of a sign-up, decision 079; `merchant.portal_api_key_created` is registered but nothing writes it since decision 067). The note to an address without an account (decision 079, event `customer.no_account`, variables `change` and `signUpUrl`) is the same kind of row, written by `NoAccountNote` in the transaction of `POST /store/v1/auth/magic-link`, addressed to the typed email (recipient `account` 0, the address in the payload's `to`): no row of `clients` is made for it.

Outbox events produced (types, payload ids; all on the `notifications` queue, registered by `AccountMailOutbox`, decision 064): the merchant family `merchant.email_verification`, `merchant.password_reset` and `merchant.invited` and the customer family `customer.magic_link`, `customer.password_reset`, `customer.invited` and `customer.email_verification`, and the two mails of the shop's sign-up `customer.sign_up_link` and `customer.sign_up_existing` (decision 079: identity's own events with shipped texts, `SIGN_UP_MAIL_EVENTS`), chosen by the rank kind of the account when the mail is queued (see "Account mail"). The payload is `{ accountId, tokenId }` (the `auth_tokens` row), the aggregate is `clients` with the account as its id: ids only, never a token. The job rotates the link's token and sends the mail through the platform's notification delivery. `auth_tokens.purpose` is closed to `invite | reset | verify_email | magic_link | telegram_link` (`AUTH_TOKEN_PURPOSES`; `telegram_link` is only in rows written before decision 062, and the contract release narrows the check to the four live purposes); `POST /client/auth/password/reset` accepts `reset` and `invite`. Consumed: the seven types above, by `jobs/account-mail.processors.ts` (worker). Feature 20 adds `staff.invited` and `staff.password_reset` (`StaffMailOutbox`, payload `{ tokenId }`, aggregate `staff_users`; written by `POST /admin/staff` and `POST /admin/staff/:id/password`, consumed by `jobs/staff-mail.processors.ts`; links `<CONSOLE_BASE_URL>/set-password?token=`). Record each outbox type and the queue it maps to here and in `docs/queues.md`.

## Jobs and schedules

- `ip_rule_hits_flush` on the `maintenance` queue, scheduler `ip-rule-hits-flush`, every minute (`IpRuleHitsFlushModule`, imported
  by `src/worker.module.ts` only; processor `IpRuleHitsFlushProcessor`). Not recorded in `job_runs` (decision 020); metrics
  `ip_rule_hits_flush_last_success_timestamp_seconds`, `ip_rule_hits_flush_failures_total`, `ip_rule_hits_flushed_total`.
  Listed in `docs/queues.md`.
- `session_purge` on the `maintenance` queue, scheduler `session-purge`, daily at 03:15 UTC (`SessionPurgeModule`, imported by
  `src/worker.module.ts` only; processor `SessionPurgeProcessor`, use case `SessionPurge`). Deletes `sessions` rows that ended (revoked, or
  past `expires_at`) more than 30 days ago, in batches of 1000, then the `account_signups` rows whose link expired or was used (decision 079);
  safe to repeat or run in parallel; every run writes a `job_runs` row (`JobRunsService.run`). Listed in `docs/queues.md`.
- `sign_up_purge` on the `maintenance` queue, scheduler `sign-up-purge`, every 15 minutes (the same module; processor `SignUpPurgeProcessor`, use case
  `SessionPurge.purgeLapsedSignUps`, decision 079): deletes the `account_signups` rows whose link expired or was used, so a password hash outlives its
  link by at most 15 minutes; safe to repeat or run in parallel; every run writes a `job_runs` row. Listed in `docs/queues.md`.

- `merchant.email_verification`, `merchant.password_reset`, `merchant.invited`, `customer.magic_link`, `customer.password_reset`, `customer.invited`, `customer.email_verification` on the `notifications` queue (seven processors in `jobs/account-mail.processors.ts`, handled by `AccountMailJobs`, in `MerchantMailModule`, imported by the API and by `src/worker.module.ts`). Event-driven, no
  schedule, no `job_runs`; safe to run twice (the job re-reads the account and the link and skips what is no longer worth
  sending). Retry: the queue's 5 attempts with backoff from 30 s for a failing sender, `UnrecoverableError` for a job without a
  token id and for a job of the retired customer table (no `accountId`: its customer number is never read as an account id). Listed in `docs/queues.md`.

- `staff.invited`, `staff.password_reset` on the `notifications` queue (processors `StaffInvitedMailProcessor`, `StaffPasswordResetMailProcessor` in `StaffMailModule`,
  imported by the API and by `src/worker.module.ts`; feature 20). Same design and retry policy as the account mails (`StaffMailJobs`); a suspended or deleted member, a used or
  expired link send nothing and leave no `queued` row; a missing or switched-off template does not stop the mail, the shipped text is sent (decision 047). Listed in `docs/queues.md`.

- The nightly promotion by spend (`client_group_promotion`, scheduler `client-group-promotion`) is retired: ranks are set by hand. `SessionPurgeModule`
  lists its scheduler id with `JobSchedulerRegistry.retire`, so the worker removes it from Redis at boot (`docs/queues.md`).

Add the next job here and in `docs/queues.md` (see `CONTRIBUTING.md` → "Add a job").

## Cache keys

- `gsm:{env}:identity:session:{tokenHash}:v2` (`CacheKeys.session`): the cached view of a session, the state of its account and its rank (`rank {id, kind}`), 60 s (an unknown token 10 s). The version, last as in every key of the repository, keeps a view of the old shape from being read; never build the key by hand. `SessionService` deletes it after the commit of a revoke or rotation; `invalidateSubject` does after a suspension, password change or role change.
- `gsm:{env}:identity:role:{roleId}` (`CacheKeys.rolePermissions`): the permissions of a role, 300 s. `RolePermissions.invalidate(roleId)` after the commit of a role change.

Both are listed in `docs/cache-keys.md`, and so is the sign-in lock `gsm:{env}:identity:sign-in-failures:{emailHash}` (`CacheKeys.signInFailures`,
decision 052: 16 minutes after the last attempt; a correct password takes back only its own count and keeps a running lock, a new
password from a link or staff deletes it).
Feature 2a added no key family: its routes clear the existing ones after their commit (`RolePermissions.invalidate`, `SessionService.invalidateSubject` / `revokeAllOf`, `IpRuleCache.invalidate`, `ApiKeyDirectory.invalidateClient`). Decision 064 adds none either: it renames the two cache versions above and the failed-lookup budget `session-failures:account:{addressKey}` (one budget for both URL families), and the limiter keys `account-mail` (subject `account` or `staff`) and `wallet-topup:a:{accountId}` are the rate-limit infrastructure's. The sign-in rate limits use the existing `gsm:{env}:ratelimit:sign-in:{hash}` and `...:token:{address}` families, and `...:sign-in-familiar:{hash}` (decision 052, listed in `docs/cache-keys.md`). Register every other key family there too (see `CONTRIBUTING.md` → "Add a cache key").

| Key | What | TTL | Invalidation |
|---|---|---|---|
| `gsm:{env}:identity:ip-rules:active` | live IP rules + `adminAllowlistOnly` | 60 s, then stale for 5 min while one refresh runs | `IpRuleCache.invalidate()` after the commit of any rule or restriction change |
| `gsm:{env}:identity:ip-rule-hits:pending` | hash of hit counters (`<rule id>`, `<rule id>:at`) | 24 h, renewed by every hit | emptied by the flush job every minute |
| `gsm:{env}:identity:api-key:{keyHash}:v3` | cached view of an API key, its account's status and the rank kind; the version (decisions 062 and 064) keeps the new code from reading a view cached under an older access rule | 60 s (a key that matches nothing: 10 s) | `ApiKeyDirectory.invalidate(keyHashes)` / `invalidateClient(accountId)` after the commit of a revoke, an edit, a status change or a rank change |
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
- `identity-platform-16` · POST /client/* (the 15 sign-in routes are specified by B121 to B136 and built by feature 2b)

## API keys (feature 7b)

Five routes, for accounts of a merchant rank (contracts `contracts/api-keys.contracts.ts`, controllers `controllers/api-keys.controller.ts`, use cases `application/merchant-api-key.service.ts` (the
read-only list) and `application/api-key-admin.service.ts`, shared checks and insert `application/api-key-issuer.ts`, queries `infra/api-key-manage.repository.ts`, pure rules `domain/api-key-input.ts`), wired by `ApiKeysModule`. Spec: MISMATCHES B155
(portal) and identity.md (staff). Since decision 067 staff make and manage every key; the merchant only reads its own list.

| Route | Access | What it does |
|---|---|---|
| `GET /client/api-keys` | merchant rank | the account's keys, live first then revoked, newest first, `x-total-count`; the console's `ApiKey` (never the hash); read only |
| `GET /admin/clients/:id/api-keys` | `api_keys:read` | every key of the account (any rank), plain array, newest first |
| `POST /admin/clients/:id/api-keys` | `api_keys:create` | feature 20, an Owner only (decision 046): `{ name? 1-60, allowedIps?, expiresAt?, rateLimitPerMin? }` with `rateLimitPerMin` (1-6000, default 60); a name left out is `API key <n>`, n the smallest whole number from 1 that no key of the account (revoked and expired ones included) holds in that exact form, chosen under the account's key lock (decision 078) → `201 { key, secret }`, `no-store`; active accounts of a merchant rank only (`409 NOT_ACTIVE` for a status that cannot act, `409 CONFLICT` for another rank); `created_by` = the staff member (`createdByStaff: true`); a `merchant.security_notice` mail; audited `created API key for <merchant>` (never the key) |
| `PATCH /admin/api-keys/:id` | `api_keys:update` | feature 20 and decision 078: `{ name?, rateLimitPerMin?, allowedIps?, expiresAt? }` (at least one; `name` trimmed 1-60, `expiresAt` an ISO time in the future or `null` for no expiry); `403 FORBIDDEN` for a non-Owner when the change widens the key (an empty list, an address not stored, a higher limit, no expiry or a later one); `409 ALREADY_REVOKED` for every field; drops the cached view; a changed address list, limit or expiry mails the merchant a security notice (a new name alone does not); audited `changed limits of API key of <merchant>` with before and after (name, limit, addresses, expiry) |
| `DELETE /admin/api-keys/:id` | `api_keys:revoke` | `204`; `409 ALREADY_REVOKED`; drops the cached view; audited `revoked API key of <account>` (entity `account`) |

A key has no scopes: the body of a creation may still carry a `scopes` list (older clients send one), which is ignored, and no answer or audit entry
shows one. `secret` is `gsm_` + 32 random bytes in base64url, shown once; stored: the keyed hash (decision 019) and the first 8 characters; at most 10 live keys per account
(`422` on `name`, advisory lock against races). `allowedIps` entries are an address or a CIDR range checked like the
IP rules (`normaliseCidr`: host bits and ranges wider than /16 are refused, a bare address is stored as `/32` or `/128`); the wire drops the host prefix (`cidrToWire`);
`lastUsedIp` is `''` for a key never used. A key a merchant made before decision 067 has `api_keys.created_by` null and `createdByStaff: false`; it keeps working until staff revoke it.

**What staff may edit on a key (decision 078).** The owner's ruling: a key's permissions are the addresses that may use it (`allowedIps`) and the period it is valid (`expiresAt`); there is no other permission list. The expiry follows the Owner rule of decision 046 like the list and the limit (`classifyKeyChange`, `domain/api-key-input.ts`): no expiry or a later one widens the key (an Owner), a first expiry or an earlier one narrows it, a new name changes no reach. An **expired key may get a later expiry (or none) and works again**, which is a widening and so an Owner's; it counts as a live key again, so `update` takes the advisory lock `api-keys:<accountId>` (before the key row, the creation's order, only when `expiresAt` is sent) and refuses with `422` on `expiresAt` when the account already holds ten live keys. A **revoked key stays revoked** (`409 ALREADY_REVOKED` for every field). The action text of the audit row stays `changed limits of API key of`; its before and after carry the name and the expiry (never the key or its hash).

**Creation, the rank and the lock order (decisions 064 and 067).** Staff's `POST /admin/clients/:id/api-keys` (`ApiKeyAdminService`) goes through `ApiKeyIssuer`, which takes the advisory lock `api-keys:<accountId>` **first** and then locks the account row `FOR UPDATE` (`ApiKeyIssuer.lockOwner`), and refuses from that locked read: a rank that is not a merchant rank is `409 CONFLICT` and a status that cannot act `409 NOT_ACTIVE`. A rank change that leaves the merchant kind, and an erasure, revoke every live key through `ApiKeyRevocation.revokeLiveKeysOf` in their own transaction, which already holds the account row, **without taking the advisory lock**: this is the one named exception to the lock order of the money paths (the creation takes the advisory lock before the row, and nothing that holds the row ever takes it, so no cycle can form). A creation that waited behind the rank change therefore reads the new rank and refuses, and no key is born on a retail account; a later change back never restores a key. Audit entries about keys name the entity `account`.

## Merchant API key writes, retired (decision 067)

The owner decided on 2026-11-24 that merchants no longer create, change or revoke their own API keys: an Owner creates a key in the console, staff change its limits and revoke it. The three routes are rows of the read-only map, so they are listed in
`test/contract/retired.ts` and are not built (a merchant session gets `404`, like any path nothing serves):

| Route | Replaced by |
|---|---|
| `POST /client/api-keys` | `POST /admin/clients/:id/api-keys` (Owner) |
| `PATCH /client/api-keys/:id` | `PATCH /admin/api-keys/:id` |
| `DELETE /client/api-keys/:id` | `DELETE /admin/api-keys/:id` |

`GET /client/api-keys` stays. Gone with the routes: `MerchantApiKeyService.create`, `update` and `revoke`, `MachineCredentialHold` (the `403` that stopped a session started from a staff password or a staff-chosen address from creating a key) with its two sentences and
`machineHoldOf`, and `MerchantLifecycleMails.portalApiKeyCreated` with its sentence. What stays: the columns `clients.password_set_by_staff` and `clients.email_set_by_staff` with every writer (nothing reads them any more; the migration of the accounts model drops them),
the event `merchant.portal_api_key_created` registered with its shipped text so notifications written before still read and send, the keys merchants made before (they work until staff revoke them) and the whole Dhru side. No migration.

## Merchant verification by documents, retired (decision 061)

Merchant verification by documents was retired: the owner creates merchant accounts and no documents are collected. The module that
served it (`KycModule`, its contracts, controllers, use case, queries and rules) is gone, with `kycStatus` on the merchant row of
`GET /admin/clients` and `GET /admin/clients/:id` and on `GET /client/auth/me`, the two mail events and their templates, and the two
staff permissions of its routes. The five routes are rows of the read-only map, so they are listed in `test/contract/retired.ts`
and are not built:

| Route | Replaced by |
|---|---|
| `GET /client/kyc`, `POST /client/kyc` | nothing |
| `GET /admin/kyc-submissions`, `GET /admin/kyc-submissions/:id` | nothing |
| `POST /admin/kyc-submissions/:id/decide` | nothing |

What stays, unread and unwritten, until the contract release of the one account type drops it: the table `kyc_submissions` and the column
`clients.kyc_status` (it keeps its default). The files module still names `kyc_submissions.file_ids` in its reference SQL, so the
documents stored earlier stay referenced and the janitor does not delete them. Migration `0064_merchant_verification_retired.sql`
(data only) removes `kyc:read`, `kyc:decide` and `kyc:*` from every stored role and deletes the stored templates of
`merchant.kyc_approved` and `merchant.kyc_rejected`. The error codes `KYC_REQUIRED` and `ALREADY_DECIDED` left the catalog. The
approval status of a merchant (`pending` and its guard) is a separate rule and did not change here; decision 062 below stopped creating such rows and decision 064 removed the status.

## Merchant sign-up and approval, retired (decision 062)

The owner creates every merchant account, so nothing waits for an approval and nobody signs up. A merchant made by staff
(`POST /admin/clients`) is inserted `active` at once, with its wallet and its one-hour invitation link; until it follows the link and chooses a
password the console reads the invitation as pending from `security.hasPassword` and `security.linkSentAt`. The mail of the approval
(`merchant.approved`, `MerchantLifecycleMails.approved`) and its stored template are gone, and so are the dashboard item
`merchants_pending` and the sidebar count `navCounts.merchants`. `POST /client/auth/register` is gone with its limiter bucket, its Turnstile
row and the referral code at sign-up (the read-only map still has its row, so it is listed in `test/contract/retired.ts`). What stays:

- the status `pending` is **gone** (decision 064): the expand migration turned every row that was still `pending` into `suspended` with a fixed reason and narrowed the status check to `active`, `suspended`, `blocked` and `anonymized`; the guard `ACCOUNT_PENDING_APPROVAL` and the contract field `pendingMerchant` are accepted by the code but never produced (the contract release removes them), and there is no pending upload quota;
- the email-verification routes (`POST /client/auth/verify-email` and `/verify-email/resend`): a staff change of the address uses them
  (`AccountEmailVerificationService`, which replaced the registration service and the merchant verification service) and the invitation flow.


## Telegram for merchants, retired (decision 062)

A merchant's Telegram chat was retired: email and the inbox stay. The use case that linked and unlinked chats (`TelegramLinking`), the secret of
the bot's webhook (`TelegramWebhookSecret`), their contracts and controller methods, `telegramLinked` on the merchant row of `GET /admin/clients` and
`GET /admin/clients/:id`, the `telegram` switches of `GET` and `PUT /client/notification-preferences`, the setup script `scripts/telegram-webhook.ts` and the
environment variables `TELEGRAM_BOT_USERNAME` and `TELEGRAM_WEBHOOK_SECRET` are gone. The two routes are rows of the read-only map, so they are listed
in `test/contract/retired.ts` and are not built:

| Route | Replaced by |
|---|---|
| `POST /client/telegram/link` | nothing |
| `POST /webhooks/telegram/:secret` | nothing |

What stays, unread and unwritten, until the contract release of the one account type drops it: the column `clients.telegram_chat_id` (with its unique index)
and the purpose `telegram_link` that the CHECK of `auth_tokens` still allows for the rows an older version wrote. The `url-secret` access kind has no route
of its own left; it stays as part of the machine guards.

## Gateway webhook adapters (feature 8)

`WebhookVerifiers` (P2.5c) keeps adapters by gateway slug and now also takes one **resolver** (`setResolver`, `resolve`): a registered adapter wins, then the resolver is asked
for a valid slug nobody registered. Payment gateways are rows staff add at run time, so money's `PaymentWebhookVerifier` registers a resolver that reads the gateway row by
`code`, decrypts its signing key and hands the delivery to the driver. The guard (`GatewaySignatureAccessHandler`) calls `await verifiers.resolve(gateway)`; an unknown slug,
a manual gateway and a gateway without a key all answer `400 WEBHOOK_SIGNATURE_INVALID`.
