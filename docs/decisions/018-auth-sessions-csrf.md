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
- **CSRF** (cookie-authenticated surfaces): a readable `csrf_token` cookie (Secure, SameSite=Lax, Path=/, Domain
  from config so the console origin can read it) whose value is `HMAC(CSRF_SECRET, session token hash)`; the same
  value is sent as `X-CSRF-Token` on login, 2fa and me responses (cross-site consoles cannot read the cookie). Every
  mutation that carries a session must send the header (`403 CSRF_FAILED`, does not sign out). Mutations without a
  session (login, token-mode password set, public store routes) are protected by the exact-origin check and the
  rate limits instead. GETs never change state, except the customer data export, which also requires
  `Sec-Fetch-Site: same-origin|same-site` or a matching Origin.
- **API keys** (REST v1) `Authorization: Bearer <key>`; **Dhru** `username` + `apiaccesskey`: both resolve an
  `api_keys` row by keyed hash, then check revoked/expired, `allowed_ips`, scopes (`dhru` scope for Dhru), the key's
  per-minute limit and the merchant's status.
- **Permissions**: `resource:action`; granted `x:*` covers every `x:` action, `*` covers everything; a required
  `x:*` needs `x:*` or `*`. CRUD rows map to `x:read|create|update|delete`. Checked on every request from the role's
  current permissions (no snapshot per session). An Owner is a staff member whose role contains `*`. Guards: no
  change may leave zero active Owners (`409 LAST_OWNER`); actions on an Owner account need `*`; nobody changes their
  own role or suspends themselves; IP rules are judged against the real request IP behind the trusted proxy chain.
- **Pipeline order** (ARCHITECTURE § 3): CORS preflight → request id → IP rules → maintenance → per-IP rate limit →
  authentication (+ per-principal limit) → CSRF → permission → validation → handler → audit.

**Consequences.** One session service for three kinds of users; the admin flow matches the console without any
frontend change; credentials and sessions never exist in clear text at rest.
