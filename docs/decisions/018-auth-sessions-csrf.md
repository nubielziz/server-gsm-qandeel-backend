# 018: Authentication, sessions, CSRF and the request pipeline

Status: accepted, 2026-10-31. Source of the staff flow: `docs/contract/ALIGNMENT.md` § 3 (frontend contract).

**Decision.**
- **Sessions** (`sessions` table, all subjects): opaque 256-bit token in an httpOnly, Secure, SameSite=Lax, Path=/
  cookie, stored as a keyed hash (D019). One cookie name per subject so they never collide on the API host:
  `gsm_admin_session`, `gsm_client_session`, `gsm_store_session` (`__Host-` prefixed in production). New column
  `sessions.stage` (`pending_password | pending_totp_setup | pending_totp | active`, B-entry in MISMATCHES): login
  creates a pending session (10 min); a pending session unlocks only its next step and logout; `GET …/me` answers
  401 until the stage is `active`. Reaching `active` rotates the token (no fixation). Lifetimes are settings: staff 8 h
  absolute and 30 min idle, merchants and customers 30 days absolute and 7 days idle (defaults). `last_seen_at`
  is written at most once a minute; a session lookup is cached 60 s in the cache Redis and deleted on revoke,
  suspend, password change and role change.
- **Staff sign-in** exactly as the frontend implements it: `POST /admin/auth/login` → IP rules → rate limit →
  `401 UNAUTHORIZED` (same for unknown email, wrong password, no password yet) → `403 ACCOUNT_SUSPENDED` → pending
  session and `{ next: password | totp | totp_setup }` (password first). `2fa/setup` stores a pending TOTP secret
  (encrypted) and answers `{ secret, otpauthUrl, qrSvg }`; refused once 2FA is on (`409 TWOFA_ALREADY_ENABLED`).
  `2fa` verifies a 6-digit TOTP (±1 step, a used step is never accepted twice), activates the session, sets
  `last_login_*`, turns `invited` into `active`. `password/set` takes `{ token, password }` (public, `410
  TOKEN_INVALID`) or `{ password }` on a `pending_password` session; neither signs in; both revoke the subject's
  sessions. Merchant (`/client/auth/*`) and customer (`/store/v1/auth/*`) sign-in reuse the same session and token
  services with their own rules (optional TOTP for merchants; password or magic link and lockout for customers).
- **Session-ending codes.** `401`, `403 ACCOUNT_SUSPENDED` and `403 IP_NOT_ALLOWED` sign the caller out wherever they
  appear, so they are only ever about the caller. Refusals about other records use their own 409/422 codes.
- **CSRF** (cookie-authenticated surfaces): a readable CSRF cookie, `csrf_token` for the admin console (`csrf_token_client`
  and `csrf_token_store` for the merchant portal and the storefront, so consoles that share a parent domain never
  overwrite each other's token) (Secure, SameSite=Lax, Path=/, Domain
  from config so the console origin can read it) whose value is `HMAC(CSRF_SECRET, session token hash)`; the same
  value is sent as `X-CSRF-Token` on login, 2fa and me responses (cross-site consoles cannot read the cookie). Every
  mutation that carries a session must send the header (`403 CSRF_FAILED`, does not sign out). Mutations without a
  session (login, token-mode password set, public store routes) are protected by the exact-origin check and the
  rate limits instead. GETs never change state, except routes whose contract sets `originCheck: true` (only allowed on GET routes
  with a session access; today the customer data export): the CSRF guard then requires `Sec-Fetch-Site: same-origin|same-site`
  or, when that header is absent, an `Origin` exactly in the configured CORS origins, else `403 CSRF_FAILED`; such a GET sends
  no CSRF token. (Amended by decision 045: the Origin lists are per surface, the storefront's sign-in routes are Origin-checked,
  and an `originCheck` GET needs `Sec-Fetch-Site: same-origin` or an `Origin` on its surface's list.)
- **API keys** (REST v1) `Authorization: Bearer <key>`; **Dhru** `username` + `apiaccesskey`: both resolve an
  `api_keys` row by keyed hash, then check revoked/expired, `allowed_ips`, scopes (`dhru` scope for Dhru), the key's
  per-minute limit and the merchant's status.
- **Permissions**: `resource:action`; granted `x:*` covers every `x:` action, `*` covers everything; a required
  `x:*` needs `x:*` or `*`. CRUD rows map to `x:read|create|update|delete`. Checked on every request from the role's
  current permissions (no snapshot per session). An Owner is a staff member whose role contains `*`. Guards: no
  change may leave zero active Owners (`409 LAST_OWNER`); actions on an Owner account need `*`; nobody changes their
  own role or suspends themselves; IP rules are judged against the real request IP behind the trusted proxy chain.
- **Pipeline order** (ARCHITECTURE § 3): CORS preflight (from a listed origin of the path's surface, decision 045) → request id → IP rules → maintenance → per-IP rate limit →
  authentication (+ per-principal limit) → CSRF → permission → validation → handler → audit. The three checks before
  authentication are Fastify hooks installed in this order by `RequestPipeline` (`PIPELINE_STAGES`, `src/common/pipeline`), so
  the order is a table and not an accident of module loading.

**Consequences.** One session service for three kinds of users; the admin flow matches the console without any
frontend change; credentials and sessions never exist in clear text at rest.

**Amendment (decision 046, 2026-11-20).** The guards gain a privilege ceiling (nobody grants, assigns or acts on permissions they do
not hold; only an Owner edits the role they hold), actions kept for Owners (payment method secrets, merchant API keys made by staff,
IP changes that would shut out an Owner) and second permissions for stronger actions inside coarse routes.

**Amended (decision 053, feature 43).** A fourth pipeline stage, `upload-session`, runs after the per-IP limit and before the body is read: a
multipart body of a route that signs in with a session cookie (the portal and customer uploads, the three console uploads) is read only when
the request carries a live session of the route's audience (`401` otherwise; the full checks stay in the guard). In required mode the
session authenticator charges a cookie that names no live session to a budget of the client address and audience on the `ip` limiter
(`session-failures:<subject>:<address key>`, 300 a minute), read before the lookup and answered `429` when used up.
