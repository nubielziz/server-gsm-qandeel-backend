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
- The console does not call these routes (the merchant portal is another frontend): follow the per-route specs the lead wrote
  for them (`docs/contract/MISMATCHES.md` B121 for the common rules and B122 to B136, one entry per route: request, response,
  errors, effects; resolution ip-16), then the map rows, `docs/contract/endpoints/identity.md` and ALIGNMENT § 7
  (non-admin conventions). No user enumeration on register,
  login and forgot-password (same answer, comparable timing); tokens hashed, single use, 1-hour expiry where the map
  says; per-IP limits already cover `/client/auth/login|2fa|password` (pipeline).
- A new merchant is `pending` until staff approve it (feature 2a's admin routes); a pending merchant may sign in
  only as far as the map allows (read the map row descriptions).
- Email: no mail transport exists yet. Write an outbox event per email (`merchant.email_verification`,
  `merchant.password_reset`, and `merchant.invited` which 2a writes for `POST /admin/clients`; ids only, never the token) and register a worker processor that hands the message to a
  `MailSender` interface with a development implementation that logs a redacted line; feature 12a replaces it with
  templates and real delivery. The token itself is created in the use case and only its hash is stored; the dev
  sender may print the link to the log in development only (never in production).
- 2FA for merchants is optional (setup/enable/disable with a current code); a used TOTP step is never accepted twice
  (add the column on `clients` the same way as `staff_users.totp_last_step`, with a migration and a B116 note).
- Every change of password, 2FA or email revokes the merchant's other sessions; `ApiKeyDirectory` is not affected.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
- **ip-1.** `POST /client/auth/register` opens the merchant's ledger accounts in the same transaction as the `clients` insert
  with feature 3's public `MerchantAccounts.open(tx, { clientId, currency: 'USD', creditLimit: '0.0000', overdraftAllowed })`,
  so no merchant exists without accounts; the registration answer is the same for a new and an existing email (no
  enumeration), and the account is created `pending` in the `is_default` group.
- **ip-2 invite and reset.** `POST /client/auth/password/reset {token, password}` accepts the purposes `reset` and `invite`.
  With an invite token it sets `password_hash` (argon2id), `password_changed_at = now` and `email_verified_at = now` (the link
  proves the email), sets `used_at`, voids the merchant's other unused tokens, revokes the merchant's sessions and answers
  `204`; it does not sign in and the status stays `pending` until staff approve. `POST /client/auth/password/forgot` also
  works for a pending merchant that has no password yet. The links are `<PORTAL_BASE_URL>/set-password?token=<token>`
  (config key `PORTAL_BASE_URL`, already in `src/config/env.ts` and required in production; 2a only reads it). Outbox events: `merchant.invited` (2a), `merchant.email_verification`,
  `merchant.password_reset`. `auth_tokens.purpose` is closed to `invite|reset|verify_email|magic_link`.
- **ip-6 live sessions.** `GET /client/sessions` and `DELETE /client/sessions/:id` reuse the one live-session predicate of the
  identity sessions repository (built by 2a): not revoked, not past `expires_at`, and for active sessions `last_seen_at`
  within the idle limit (`sessions.client_idle_minutes`).
- **ip-16 specs.** B121 to B136 define the 15 routes. Their columns (`clients.twofa_enabled`, `totp_last_step`,
  `password_changed_at`) come with your migration (unless the lead's `0003` already has them) and a B116 note.

## Out of scope
Admin merchant management (2a), wallets (3; you call the public `MerchantAccounts.open`), API keys (7b), notification
templates (12a).
