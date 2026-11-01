# 2b identity-merchant-auth

Phase 3, map stage 2 (client surface: the merchant portal). Read `_common.md` and `_feature.md` first.
Module: identity. Use P2.5a's session service with subject `client` (cookie `gsm_client_session`, CSRF cookie
`csrf_token_client`) and the patterns of P2.6's staff sign-in (`src/modules/identity/application/`): reuse its
token, TOTP and password-policy pieces instead of copying them.

## Routes (15; remove them from `test/contract/pending.ts`)
`POST /client/auth/register`, `POST /client/auth/verify-email`, `POST /client/auth/login`, `POST /client/auth/2fa`,
`POST /client/auth/logout`, `POST /client/auth/password/forgot`, `POST /client/auth/password/reset`,
`GET /client/auth/me`, `PATCH /client/profile`, `POST /client/security/password`, `POST /client/security/2fa/setup`,
`POST /client/security/2fa/enable`, `POST /client/security/2fa/disable`, `GET /client/sessions`,
`DELETE /client/sessions/:id`.

## Rules that matter
- The console does not call these routes (the merchant portal is another frontend): follow the map rows,
  `docs/contract/endpoints/identity.md` and ALIGNMENT § 7 (non-admin conventions). No user enumeration on register,
  login and forgot-password (same answer, comparable timing); tokens hashed, single use, 1-hour expiry where the map
  says; per-IP limits already cover `/client/auth/login|2fa|password` (pipeline).
- A new merchant is `pending` until staff approve it (feature 2a's admin routes); a pending merchant may sign in
  only as far as the map allows (read the map row descriptions).
- Email: no mail transport exists yet. Write an outbox event per email (`merchant.email_verification`,
  `merchant.password_reset`; ids only, never the token) and register a worker processor that hands the message to a
  `MailSender` interface with a development implementation that logs a redacted line; feature 12a replaces it with
  templates and real delivery. The token itself is created in the use case and only its hash is stored; the dev
  sender may print the link to the log in development only (never in production).
- 2FA for merchants is optional (setup/enable/disable with a current code); a used TOTP step is never accepted twice
  (add the column on `clients` the same way as `staff_users.totp_last_step`, with a migration and a B116 note).
- Every change of password, 2FA or email revokes the merchant's other sessions; `ApiKeyDirectory` is not affected.

## Out of scope
Admin merchant management (2a), wallets (3), API keys (7b), notification templates (12a).
