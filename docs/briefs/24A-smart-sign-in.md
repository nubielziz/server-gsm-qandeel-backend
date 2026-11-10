# Feature 24A: One smart sign-in, and Turnstile on the public merchant auth routes (ROADMAP 1.3, 1.4, 1.7)

Plan by Fable 5.2 (planner), 2026-11-10, against backend `main` @ `bd32229` **plus the approved plan of feature 20**
(`docs/briefs/20-merchant-management.md` §3.4, §4, §14). Implementer: one Sonnet 5.5, slices A to C. Worktree
`../backend-24a` on `feat/backend-24a`, test database `gsm_24a_test`, Redis DB 6 (LEAD-DECISIONS §1). **Start only after W0
and feature 20 are merged** (the route is a W0 map addition; 20 adds the merchant `next: 'password'` step and
`MerchantSignInService.startSession`). No console work. Read first: `backend/CLAUDE.md`, `docs/briefs/_common.md` (its
frontend-cwd and Serena lines are stale), `_feature.md`, `CONTRIBUTING.md`, `scripts/map-additions/README.md`,
`docs/decisions/018` (sessions, CSRF), `021` (rate limits), `032` (module import order), `034` (Turnstile). Paths are
backend-relative. The storefront (`../storefront`) is READ ONLY; its needs are §9.

Rules (LEAD-DECISIONS §7): work only in the worktree; never run `docker compose`, `db:migrate`, `db:seed`, `src/main.ts` or
`scripts/ci.sh` there; no git command that changes state; no agents. Targeted tests while developing, heavy runs through
`bash scripts/with-slot.sh …`, `bun run check` once at the end in the foreground.

## 1. What exists and what is missing

| # | Requirement | Status | Evidence (verified in the code) |
|---|---|---|---|
| 1 | One email + password route for both account types | missing | No smart route in `src/`. Two logins: `POST /client/auth/login` (`identity/contracts/merchant-auth.contracts.ts:124-140`, `MerchantSignInService.login`) and `POST /store/v1/auth/login` (`customers/contracts/store-auth.contracts.ts:67-75`, `CustomerSignInService.login`) |
| 2 | Merchant password check | exists | Order: limiter `sign-in` per email + IP (`merchant-sign-in-limiter.ts`: key `merchant-sign-in\0login\0email\0ip`, hashed) → `findClientByEmail` (`lower(email)`) → **one** `hasher.verify` against the stored hash or a boot-time dummy hash (`merchant-sign-in.service.ts:171-176`) → `401` "The email or password is not correct." → `403 ACCOUNT_SUSPENDED` only after a correct password → limiter reset, hash upgrade, stale merchant session ended, session of the next step. **No per-email lock** |
| 3 | Customer password check | exists | Same order with its own counter (`customer-sign-in` prefix) **plus a per-email lock**: `CustomerSignInFailures.lockedFor(email)` is read before the account, every `401` calls `recordFailure(email)` (10 failures lock 15 min, `customers/domain/lockout.ts`), success clears it (`customer-sign-in.service.ts:177-196`); an anonymized customer and an account with no password are the same `401`; `next` is `password` after a temporary password |
| 4 | Feature 20's merchant step (approved plan, not yet in `main`) | planned | `domain/merchant-sign-in-step.ts`: `nextMerchantStep(facts)`, `merchantStageOfStep(step)`; `MerchantSignInService.startSession(client, meta, staleToken?)` = suspension refusal, stale session end, session of the stage, last-login record; `MerchantNext = 'password' \| 'totp' \| 'done'`; the pending steps are finished by `POST /client/auth/2fa` and 20's forced-password route |
| 5 | Cookies and CSRF per surface | exists | `SessionCookies.set(reply, 'client' \| 'customer', token, expiresAt)` sets the session cookie, the readable CSRF cookie and the `X-CSRF-Token` header (`merchant-auth.controller.ts:112`, `store-auth.controller.ts:102`); the two cookie pairs coexist in one browser (handoff §3.6) |
| 6 | Module direction | fixed | customers imports identity; identity imports nothing from customers (decision 032). `identity/index.ts` exports no sign-in piece today |
| 7 | Surface of the path | fixed by the prefix | `/client/*` = surface `client` (`common/surface.ts:12-19`): a public POST gets the exact Origin check (`csrf.guard.ts:61,75-83`), the per-IP `ip` limiter (`public-ip-limit.ts`), no maintenance scope, IP rules of scope `all` only |
| 8 | Turnstile on `/client` | refused today | `defineRoute`: "turnstile: true only applies to /store/v1 routes" (`define-route.ts:533-537`); the check itself is generic (`TurnstileGuard.canActivate` reads `contract.turnstile`, called from `AccessGuard`), `TURNSTILE_FAILED` is appended automatically (`:584-588`) |
| 9 | Turnstile on merchant register, login, forgot | missing | Map rows are `عام` (public, `turnstile: false`, `docs/route-manifest.json`); Turnstile parity compares the contract with the row (`test/contract/lib/manifest-parity.ts` after W0); W0's additions cannot change a map row ("repeats the map row"); `ACCESS.client` has no `عام + Turnstile` text (`scripts/lib/map.mjs`) |

## 2. Design

### 2.1 Decisions (D6 D-1 to D-4)

1. **Path and owner (D-1): `POST /client/auth/sign-in`, hosted in the customers module.** `/client` keeps the Origin check
   (login CSRF), the per-IP limit and no maintenance scope; `/store/v1/auth/sign-in` would lock merchants out during shop
   maintenance and under store IP rules; a root path would have no per-IP limit and no Origin check. Customers hosts it
   because it may import identity and not the reverse. Identity exports one narrow class (below); the password hash never
   leaves identity.
2. **Uniform limits and lock (D-2).** Every attempt, whatever the email belongs to, charges **both** login counters (the
   merchant one and the customer one, the same keys the two old routes use) and is subject to the customer per-email lock;
   every `401` records a failure for the email; a success clears the lock and resets both counters. So `429` and `401`
   never depend on which table holds the email, and the smart route is never weaker than either old route.
   `POST /client/auth/login` itself gets no per-email lock in this feature (recorded in §8).
3. **Email in both tables (D-3): the merchant wins.** Exactly one argon2 verify per attempt: against the merchant's hash
   when a merchant with a password exists; else against the customer's hash when the customer holds an account with a
   password; else against a dummy hash. A wrong merchant password is `401` even when it is the customer's password: the
   customer area stays reachable through the emailed sign-in link. A merchant row without a password does not shadow the
   customer.
4. **Stale sessions:** a success ends only the stale session of the **same kind** the request carried (the cookie it is
   about to replace). A session of the other kind stays (both may coexist).
5. **Turnstile (D-4):** required on the new route from day one. On the three existing merchant routes it is declared in
   the contract and the manifest but **enforced only when `TURNSTILE_MERCHANT_AUTH=true`** (default `false`), so the merge
   breaks no caller; the owner switches it on when the site sends the header (§9).

### 2.2 Identity: the narrow export

New `src/modules/identity/application/merchant-password-sign-in.ts`, provided and exported by `MerchantAuthModule`,
exported from `identity/index.ts` next to `MerchantAuthModule` (keep the load order of decision 032;
`test/unit/module-load.test.ts` must stay green):

```ts
/** A merchant found by email. The hash stays inside identity. */
export interface MerchantCandidate {
  readonly clientId: number;
  readonly hasPassword: boolean;
  /** One argon2 verify against the stored hash. Call only when `hasPassword`. */
  verify(password: string): Promise<boolean>;
  /** After `verify` returned true: upgrade the hash when needed, then `MerchantSignInService.startSession`.
   *  @throws {AppError} `ACCOUNT_SUSPENDED` (403) */
  open(password: string, meta: { ip: string; userAgent: string }, staleToken?: string): Promise<MerchantLoginResult>;
}
@Injectable() export class MerchantPasswordSignIn {
  /** Charges the counter of `POST /client/auth/login` for this email and address. @throws {AppError} `RATE_LIMITED` */
  charge(email: string, ip: string): Promise<void>;
  /** Clears that counter after a success. */
  reset(email: string, ip: string): Promise<void>;
  /** Finds the merchant of an email (any status), or `undefined`. No hashing. */
  find(email: string): Promise<MerchantCandidate | undefined>;
}
```
It reuses `MerchantSignInLimiter.enforceLogin/resetLogin`, `findClientByEmail`, `PasswordHasher`, the private
`upgradeHash` logic (move it to a small shared function inside identity) and `startSession`. `MerchantSignInService.login`
is not changed.

### 2.3 Customers: one small refactor and the use case

- `CustomerSignInService` gains a public `startSession(customer, credentials, password, meta, staleToken?)`: the part of
  `login` after the password is proven (status check → `403 ACCOUNT_SUSPENDED`, hash upgrade, stale customer session end,
  `lastLoginAt`, session `pending_password` or `active`) returning `CustomerLoginResult`. `login` calls it; its behaviour and
  its tests do not change.
- New `src/modules/customers/application/smart-sign-in.service.ts` (`SmartSignInService`; makes its own dummy hash in
  `onModuleInit`, like the two services). `signIn({ email, password }, meta, stale: { client?: string; customer?: string })`:

  1. `email = normaliseEmail(input.email)`.
  2. `await merchants.charge(email, ip)` then `await customerLimiter.enforceLogin(email, ip)`: both are always called, in
     this order (when the first throws the second is still charged: wrap so both run, then rethrow the first refusal).
  3. `lockedFor = await failures.lockedFor(email)`; `> 0` → `429 RATE_LIMITED` with `retryAfterSeconds` (same text as the
     customer route).
  4. Always both lookups, in parallel: `merchant = merchants.find(email)`; `customer = findCustomerByEmail`, and its
     credentials when it has an account.
  5. Pick the verifier (decision 3) and call **exactly one** verify:
     `merchant?.hasPassword` → `merchant.verify(password)`; else a customer with an account, a password hash and a status
     other than `anonymized` → `hasher.verify(customerHash, password)`; else `hasher.verify(dummyHash, password)` → false.
  6. Not verified → `failures.recordFailure(email)`, a log line without the email, `401 UNAUTHORIZED` with the detail
     "The email or password is not correct." (the text both old routes use).
  7. Verified merchant → `merchant.open(password, meta, stale.client)` → `{ kind: 'merchant', next, session }`.
     Verified customer → `customerSignIn.startSession(…, stale.customer)` → `{ kind: 'customer', next, session }`.
     A `403 ACCOUNT_SUSPENDED` from either leaves the counters as they are (as the old routes do).
  8. On success: `merchants.reset(email, ip)`, `customerLimiter.resetLogin(email, ip)`, `failures.clear(email)`.
- New `contracts/smart-sign-in.contracts.ts`, `controllers/smart-sign-in.controller.ts` (thin: reads both cookies with
  `SessionCookies.readToken(request, 'client' | 'customer')`, calls the use case, sets the cookies of `kind` with
  `SessionCookies.set(reply, kind === 'merchant' ? 'client' : 'customer', …)`, `Cache-Control: no-store`, answers
  `{ kind, next }`). Registered in `customers-accounts.module.ts`, which imports `MerchantAuthModule`.
- No transaction spans the two modules: each side's `startSession` owns its own writes (a session row, last-login), exactly
  as today. No audit row (sign-ins of merchants and customers write none), no outbox, no cache key, no job.

### 2.4 Turnstile on public `/client` routes

- `src/common/contract/define-route.ts`: `turnstile: true` is allowed on surface `store`, and on surface `client` when
  `access === 'public'`; the message names both. New optional field `turnstileRollout?: 'merchant-auth'` (only with
  `turnstile: true`; a closed union, one value today): the check is skipped while that rollout is off.
- `src/config/env.ts`: `TURNSTILE_MERCHANT_AUTH` (boolean, default `false` in every environment) →
  `config.turnstile.merchantAuth`; `.env.example` line; `env.spec.ts`; the config summary.
- `src/infra/turnstile/turnstile.guard.ts`: after reading the contract, `if (contract.turnstileRollout === 'merchant-auth'
  && !config.turnstile.merchantAuth) return true;` (no token read, no verifier call). Reword the metric help text
  ("writes refused by the anti-bot check"); the metric name stays.
- `identity/contracts/merchant-auth.contracts.ts`: `merchantRegister`, `merchantLogin`, `merchantForgotPassword` gain
  `turnstile: true, turnstileRollout: 'merchant-auth'` and one sentence in their description ("Send `X-Turnstile-Token`;
  it is required once the server enforces the anti-bot check on merchant sign-up and sign-in."). `TURNSTILE_FAILED` joins
  their errors automatically.
- `docs/decisions/034-turnstile.md`: an amendment paragraph (public `/client` routes, the rollout switch and when to remove
  it); `docs/contract/ALIGNMENT.md` where it lists the Turnstile routes; `src/infra/turnstile/README.md`.

### 2.5 Map tooling: one auth text and "row flags" (extends W0, smallest change)

- `scripts/lib/map.mjs`: `ACCESS.client` gains `'عام + Turnstile': 'public'` (the README says a new combination needs this
  line, named in the feature's plan).
- **Row flags.** An additions file may export, beside `rows`, `rowFlags`: an array of
  `{ row: '<map row key>', turnstile: true, spec: 'B<n>' | 'B-TBD <slug>' }`. Rules, checked by the loader with the same
  error style (`map additions problems: <file> flag <n> (<row>): …`): `row` is the key of a **map** row (never an addition)
  on surface `client` or `store`, not `CRUD`, whose access is `public`; the only flag is `turnstile: true` (a flag can add
  protection, never remove it); the row does not already have it; no row is flagged twice across files; any other key is an
  error. Files: `scripts/lib/map-additions.mjs` (`readAdditionFiles` returns `rowFlags` too, default `[]`; new
  `validateRowFlags(files, ctx)`), `scripts/lib/map.mjs` (`export const rowFlags = …`), `scripts/lib/manifest.mjs` (an endpoint
  of a flagged row gets `turnstile: true` and `rowFlag: { file, spec }`; every other map endpoint stays byte-identical;
  `rules.rowFlags` one sentence), `scripts/build-route-manifest.mjs` (the description cell ends with
  ` (Turnstile added, <spec>)`), `scripts/map-additions/README.md` (a "Row flags" section), the tooling test that uses
  `GSM_MAP_ADDITIONS_EXTRA_DIR` (find it with grep; add a fixture with a valid flag and one test per rule).
- `scripts/map-additions/24a.mjs`:

```js
import { R } from '../lib/map-additions.mjs';
export const rows = [
  R('client', 'auth', 'POST', '/client/auth/sign-in', 'تسجيل دخول موحّد: تاجر أو زبون بالبريد وكلمة المرور', 'عام + Turnstile', 24,
    ['clients', 'customers', 'customer_credentials', 'sessions'],
    { en: 'Sign in with email and password as a merchant or a customer.', module: 'customers', spec: 'B-TBD smart-sign-in' }),
];
export const rowFlags = [
  { row: 'client POST /client/auth/register', turnstile: true, spec: 'B-TBD merchant-auth-turnstile' },
  { row: 'client POST /client/auth/login', turnstile: true, spec: 'B-TBD merchant-auth-turnstile' },
  { row: 'client POST /client/auth/password/forgot', turnstile: true, spec: 'B-TBD merchant-auth-turnstile' },
];
```
Confirm the three row keys against `rowKey()` output (`docs/route-manifest.json` `origin.row`) before writing them.

## 3. Database and API

No migration. No new error code, permission, audit word, cache key, queue or setting key (one env variable).

**New route `POST /client/auth/sign-in`** (surface `client`, group `auth`, access `public`, owner module customers)

| Aspect | Value |
|---|---|
| Protection | Turnstile **always** (`X-Turnstile-Token`, checked before the body is validated and before any counter or hash); exact Origin check (`Origin` must be in `CORS_ORIGINS`, else `403 CSRF_FAILED`); no session, no CSRF token |
| Limits | `ip` 300/min per IP (pipeline); `sign-in` 5 per 15 min per email + IP on **both** the merchant and the customer counter; the customer per-email lock (10 failures → 15 min) |
| Request | `{ email: string (trimmed, 1 to 254), password: string (1 to 1024) }` (the bodies of the two old routes) |
| Answer | `200 { kind: 'merchant' \| 'customer', next: 'password' \| 'totp' \| 'done' }`, `Cache-Control: no-store`; `Set-Cookie` of that kind's session and CSRF cookies; response header `X-CSRF-Token` = the token of **that kind's** surface |
| `next` | merchant: `password` (temporary password: 20's forced-password route, session `pending_password`), `totp` (`POST /client/auth/2fa`, session `pending_totp`), `done`; customer: `password` (`POST /store/v1/me/password`, session `pending_password`), `done` |
| Errors | `422 VALIDATION_FAILED`; `401 UNAUTHORIZED` (unknown email, wrong password, no password yet, anonymized: one answer); `403 ACCOUNT_SUSPENDED` (only after a correct password); `403 CSRF_FAILED` (Origin); `403 TURNSTILE_FAILED`; `403 IP_NOT_ALLOWED`; `429 RATE_LIMITED` (with `Retry-After`) |
| Audit, idempotency | none (not a staff write; a repeat is another attempt) |
| Map addition | the `rows` entry of §2.5 (no `successStatus`: the console never calls it) |

**Changed routes** `POST /client/auth/register`, `POST /client/auth/login`, `POST /client/auth/password/forgot`: additive in
effect. The contract and OpenAPI now show the optional header `X-Turnstile-Token` and the error `TURNSTILE_FAILED`; with
`TURNSTILE_MERCHANT_AUTH=false` (default) they behave exactly as today, with `true` a missing or bad token is
`403 TURNSTILE_FAILED` before anything else. Keys and `operationId`s unchanged.

Regenerate: `bun run routes:build`, `bun run contract:docs`, `bun run docs:openapi`, `bun run coverage:build`.

## 4. Admin console

None (the console never calls `/client`).

## 5. Risks and how the design closes them

| Area | Risk | Closure |
|---|---|---|
| Enumeration | `429` or the lock appears only for emails of one table | both counters and the lock are charged and read for every email kind, before any lookup; test over four email kinds (merchant only, customer only, both, none) |
| Enumeration | Timing differs by email kind | both lookups always run; exactly one argon2 verify at the configured cost per attempt (dummy hash made at boot); test counts `PasswordHasher.verify` calls per kind |
| Enumeration | `403 ACCOUNT_SUSPENDED` reveals an account | only after a correct password, as both old routes already do |
| Enumeration | The magic link hint reveals "no password" | the site shows the link option always (§9); the API never says why a sign-in failed |
| Brute force | The smart route multiplies tries | it spends the old routes' counters, so smart + old attempts share one budget per email + IP; the lock covers rotating IPs; Turnstile is checked first |
| Lockout abuse | Someone locks a merchant's email with ten wrong tries on the smart form | the same property customers already have; 15 minutes; Turnstile raises the cost; the merchant can still use `POST /client/auth/login` |
| Session fixation | A planted session cookie survives the sign-in | the same-kind stale session is ended and a new token issued (`startSession` of each side) |
| Login CSRF | A foreign site signs the browser in | exact Origin check on the public `/client` POST; `SameSite=Lax` cookies |
| Wrong surface token | The client uses the CSRF token with the wrong surface | `kind` in the body says which surface the header and cookies belong to |
| Compatibility | Turnstile breaks today's merchant sign-up, sign-in or reset (the site, the owner's curl recipe, every existing test) | enforcement is behind `TURNSTILE_MERCHANT_AUTH`, default off; existing tests run unchanged |
| Compatibility | The row-flag tooling changes other manifest rows | only flagged rows gain fields; a tooling test compares the manifest of an unflagged run with today's |
| Integrity | A module boundary leak (hashes or tables across modules) | identity exposes `verify`/`open` closures, never the hash; customers reads only its own tables |
| Financial | none | no money path is touched |
| Performance | Two lookups and two counters per attempt | indexed point reads and two Redis increments; argon2 dominates |

## 6. Slices

**A. Turnstile on public `/client` routes and the row flags (medium).** Files of §2.4 and §2.5 (not the `rows` entry yet).
Acceptance: with the switch off every existing test passes untouched; with it on, the three routes refuse a missing token
and accept the dev dummy token; `defineRoute` still refuses `turnstile` on a session route of `/client` and on `/admin`;
`bun run routes:build` shows `turnstile: true` on exactly the three rows; Turnstile parity is green.

**B. Smart sign-in (medium).** `scripts/map-additions/24a.mjs` (`rows`), identity: `merchant-password-sign-in.ts`,
`merchant-auth.module.ts`, `index.ts`, README; customers: `customer-sign-in.service.ts` (`startSession`),
`smart-sign-in.service.ts`, `contracts/smart-sign-in.contracts.ts`, `controllers/smart-sign-in.controller.ts`,
`customers-accounts.module.ts`, README; `test/support/app.ts` only if the test app needs the module listed.
Acceptance: the behaviour of §2.3 and §3; the two old login routes and their tests unchanged.

**C. Docs and generated files (small).** Decision 034, ALIGNMENT, the two READMEs, `routes:build`, `contract:docs`,
`docs:openapi`, `coverage:build`, `format`, then `bun run check` (foreground). Report: files by folder, the spec
decisions of §8.

## 7. Tests

| File | Covers |
|---|---|
| `src/common/contract/define-route.spec.ts` (extend) | `turnstile: true` accepted on a public `/client` route and on `/store/v1`; refused on a `/client` session route, `/admin`, `/v1`; `turnstileRollout` without `turnstile` refused; `TURNSTILE_FAILED` appended |
| `src/infra/turnstile/turnstile.spec.ts` (extend) | rollout off → no token read, no verifier call; rollout on → enforced; a route without the rollout field is always enforced |
| the W0 tooling test (extend) | a valid flag sets `turnstile` on its endpoints only; each rule of §2.5 fails with its message; an unflagged run leaves the manifest unchanged |
| `test/integration/merchant-auth-turnstile.test.ts` (new) | switch on (`createTestApp({ env })`): register, login, forgot → `403 TURNSTILE_FAILED` without the header and before any limiter charge; pass with the dummy token; switch off → today's answers |
| `test/integration/smart-sign-in.test.ts` (new) | **success**: merchant `done`, `totp` (then `POST /client/auth/2fa` with the pending cookie and the returned CSRF token), `password` (then 20's forced-password route); customer `done`, `password` (then `POST /store/v1/me/password`); cookies and `X-CSRF-Token` of the right surface, `no-store`. **Both tables**: merchant password → merchant; customer password → `401`, no session; merchant without a password + customer with one → customer. **Refusals**: unknown email, wrong password, customer without a password, anonymized customer → the same `401` body; suspended merchant and suspended or blocked customer with the right password → `403`; missing Turnstile token → `403` with no counter charged and no hash; foreign or missing `Origin` → `403 CSRF_FAILED`; bad body → `422`. **Uniformity over the four email kinds**: the sixth attempt from one address is `429` for each; ten failures from rotating addresses lock each for 15 min (`TestClock`), and the lock ends with the clock; exactly one `PasswordHasher.verify` call per attempt for each kind and none on a `429` (spy provider). **Shared budget**: after five smart failures `POST /client/auth/login` and `POST /store/v1/auth/login` answer `429` for that email and address; a success resets all three. **Sessions**: a stale session of the same kind is revoked, a live session of the other kind survives |
| `test/integration/store-sign-in.test.ts`, the merchant auth tests | pass unchanged |
| Contract suite, `test/unit/module-load.test.ts` | route, access and Turnstile parity for the addition and the three flags; OpenAPI examples; identity's index still loads alone |

## 8. Decisions

Owner decisions taken with defaults (the owner may change them):
1. One form: a merchant's email always signs in as the merchant. If the same email is also a customer and only the customer
   password matches, the form says "email or password not correct"; the customer area opens through the emailed sign-in link.
2. Signing in as one kind never signs the other kind out in the same browser.
3. The anti-bot check on merchant sign-up, sign-in and password reset is built but off until the site sends the token;
   switching it on is one environment variable (`TURNSTILE_MERCHANT_AUTH=true`), to be set before go-live.

Spec decisions for the lead's B-entries: (a) `POST /client/auth/sign-in` (addition; customers module; `kind` + `next`; the
merchant wins; one verify per attempt; both counters and the email lock on every attempt; same-kind stale session only);
(b) Turnstile may guard public `/client` routes; `ACCESS.client` gains `عام + Turnstile`; map additions gain `rowFlags`
(add-only Turnstile flags on existing public rows); the three merchant routes are flagged, enforced behind
`TURNSTILE_MERCHANT_AUTH`; (c) decision 034 amended. Remove `turnstileRollout` and the variable one release after
production runs with it on.

Not done, recorded: a per-email lock on `POST /client/auth/login` itself (the old route keeps only its email + IP limit; the
lock lives in the customers module, which identity cannot import: it would need a neutral home, a separate security
change for the lead, D-2); the risk blocklist on merchant registration (D6 §3, row 1.4c); retiring the two old login routes
(they stay public: the API recipe and existing clients use them); `X-Turnstile-Token` in the CORS allow list (only needed
for a cross-origin topology; feature 24D chose same-origin).

## 9. Storefront handoff

- **Sign in:** `POST /client/auth/sign-in` with `{ email, password }`, header `X-Turnstile-Token` (reset the widget after
  every submit: a token works once), from the browser through the same-origin proxy (the Origin must be in
  `CORS_ORIGINS`). `200 { kind, next }`: keep the `X-CSRF-Token` response header as the token of surface `kind`
  (`merchant` → `/client`, `customer` → `/store/v1`). Then: merchant `totp` → the code page (`POST /client/auth/2fa`);
  merchant `password` → the forced password page of feature 20; customer `password` → `POST /store/v1/me/password`; `done`
  → the merchant portal or the customer account.
- **Errors:** `401` one message for every failure ("email or password not correct"); `403 ACCOUNT_SUSPENDED`;
  `403 TURNSTILE_FAILED` (refresh the widget); `429` with `Retry-After`. Never show whether an email exists.
- **Always show "Email me a sign-in link"** (`POST /store/v1/auth/magic-link`) beside the form, labelled for customers: it
  is the way in for customers without a password and for a customer whose email is also a merchant's. A merchant's email
  sent there creates or signs in a **customer**, as today.
- **Merchant sign-up and forgot password:** start sending `X-Turnstile-Token` on `POST /client/auth/register`,
  `POST /client/auth/password/forgot` (and on `POST /client/auth/login` if the site still calls it). The server ignores it
  until `TURNSTILE_MERCHANT_AUTH` is on and requires it afterwards: tell the lead when the site sends it.
- The interim two-form switch (`components/auth/sign-in-flow.tsx`) can go once the route is merged. Regenerate
  `lib/api/schema.gen.ts`. No new proxy rule: the path is under `/client`.

## 10. Review against the code, and approval

Checked in the code: both sign-in services line by line (order of limiter, lookup, verify, refusals, resets, stale session),
both limiters and their key prefixes, `CustomerSignInFailures` and the lockout rules, the two auth controllers and
`SessionCookies`, `identity/index.ts` and the two Nest modules that provide the services, `findClientByEmail` and
`normaliseEmail`, `surfaceOfPath`, `publicLimiterFor`, the CSRF guard's Origin branch, `defineRoute`'s Turnstile rules and
the automatic error, `TurnstileGuard` and where it is called, the Turnstile config in `env.ts`, the manifest rows of the three
merchant routes, W0's `map.mjs`, `map-additions.mjs`, `manifest.mjs` and Turnstile parity, and sections 3.4, 4 and 14 of
the approved plan 20.

Depends on unmerged work: `startSession`, `nextMerchantStep(facts)`, `MerchantNext` with `password` and the forced-password
route are feature 20's (plan §3.4, §14). If 20 lands with other names, follow the merged code; the design does not change.
Correction to D6 §3.2: W0 as built refuses any change to a map row, so the flag override is new tooling in this feature
(§2.5), kept add-only. No lead decision conflicts with the design.

**Approved by Fable 5.2**
