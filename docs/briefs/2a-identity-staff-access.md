# 2a identity-staff-access

Phase 3, map stage 2 (admin surface). Read `_common.md` and `_feature.md` first: this brief only names the scope.
Module: identity (plus two platform routes). Scenarios to complete: **admin-team**, **ip-rules** (write
`test/scenarios/admin-team.e2e.ts` and `test/scenarios/ip-rules.e2e.ts`, every step of `docs/slices/identity.json`
`scenarios`).

## Routes (31; remove them from `test/contract/pending.ts`)
- Staff: `GET /admin/staff`, `GET /admin/staff/:id`, `POST /admin/staff` (invite: uses P2.6's `StaffAuthTokens`),
  `PATCH /admin/staff/:id`, `POST /admin/staff/:id/password`, `POST /admin/staff/:id/sessions/revoke`,
  `POST /admin/staff/:id/suspend`, `POST /admin/staff/:id/reactivate`, `POST /admin/staff/:id/reset-2fa`.
- Roles and permissions: `GET /admin/roles`, `GET /admin/roles/:id`, `POST /admin/roles`, `PATCH /admin/roles/:id`,
  `DELETE /admin/roles/:id`, `GET /admin/permissions`.
- Sessions: `GET /admin/sessions`, `DELETE /admin/sessions/:id`.
- IP rules: `GET /admin/ip-rules`, `GET /admin/ip-rules/:id`, `POST /admin/ip-rules`, `DELETE /admin/ip-rules/:id`,
  `POST /admin/ip-rules/check`, `PUT /admin/access/restriction`.
- Merchants (accounts): `GET /admin/clients`, `GET /admin/clients/:id`, `POST /admin/clients`, `PATCH /admin/clients/:id`.
- Platform: `GET /admin/audit-logs`, `GET /admin/audit-logs/:id`, `GET /admin/settings`, `PATCH /admin/settings`.

## Rules that matter (beyond the endpoint docs)
- Owner rules: actions on an Owner need `*` (`assertOwnerTargetAllowed`); the last Owner cannot be removed, demoted or
  suspended (`LAST_OWNER`); nobody changes their own role (`CANNOT_CHANGE_OWN_ROLE`); `SELF_LOCKOUT` where the docs say.
- Role validation accepts `x:*` by area prefix (the permissions catalog lists concrete permissions only); a role
  change calls `RolePermissions.invalidate` after commit; suspension, password reset, 2FA reset and "revoke sessions"
  call `SessionService.revokeAllOf` / `invalidateSubject` (identity README "What a feature does when an account
  changes"); sensitive actions re-check the database, not the session cache.
- IP rules: CRUD and the restriction switch call `IpRuleCache.invalidate()` after commit; normalise `cidr` on write
  (host bits refused, 422) and drop `/32` and `/128` on read (the wire omits them); `POST /admin/ip-rules/check` reuses
  `decideIpAccess`. Refuse a change that would lock the caller out (`SELF_LOCKOUT`).
- Settings: `PATCH /admin/settings` is an allow-list (resolution ip-13): only the keys of a settings registry in the platform
  module, each with its validator (today `imeiRetentionDays`, integer 0 to 3650); any other key is `422` with
  `errors[].field` = the key. Then `SettingsReader.invalidate()` and the derived caches (`MaintenanceService.invalidate()`,
  `IpRuleCache.invalidate()`) after commit; audited with secrets redacted.
- Merchants: `POST/PATCH /admin/clients` follow `docs/contract/endpoints/identity.md`; status changes call
  `ApiKeyDirectory.invalidateClient` and revoke the merchant's sessions where the docs say. User rule 1 (group
  promotion) belongs to feature 4a, not here. User rule 2 (credit only for groups with `overdraft_allowed`) applies to
  `POST /admin/clients` (`creditLimit`) and to a group move in `PATCH /admin/clients/:id`: see Resolutions.
- Ended sessions: add a daily purge job (worker scheduler) that deletes sessions ended more than 30 days ago.
- Seed: extend `scripts/seed/identity.ts` with the demo merchants (`clients`, same ids and names as the frontend mocks;
  their groups only if the column needs one: create the demo client groups too if no other seeder does). Feature 3 seeds
  wallets for these merchants.
- Every mutation writes `audit_logs` (`AuditService.record`); `GET /admin/audit-logs` lists with the filters of the
  endpoints doc.

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
- **ip-1 merchant accounts.** `POST /admin/clients` opens the merchant's ledger accounts in the same DB transaction as the
  `clients` insert by calling feature 3's public `MerchantAccounts.open(tx, { clientId, currency: 'USD', creditLimit,
  overdraftAllowed })` (exported from `src/modules/money/index.ts`; feature 3 merges first and the lead writes the signature
  before wave 1). It returns the wallet view the 201 Client carries. The integration test asserts that both ledger rows
  exist and `overdraft_limit = creditLimit`. Feature 3's seed creates the accounts of the demo merchants you seed.
- **ip-2 invite.** The invite token is an `auth_tokens` row (purpose `invite`, subject type `client`, hash only, 1 hour) plus
  the outbox event `merchant.invited` (ids only, never the token). The link is `<PORTAL_BASE_URL>/set-password?token=<token>`:
  the config key `PORTAL_BASE_URL` already exists in `src/config/env.ts` (required in production, development
  default; added with migration `0003`), so you only read it and add nothing to config. The
  consuming route is 2b's `POST /client/auth/password/reset`; the merchant stays `pending` until staff approve. The lead's
  migration `0003` adds the `auth_tokens_purpose_check` CHECK and the exported `AUTH_TOKEN_PURPOSES`.
- **ip-3 credit rule.** `creditLimit > 0` with a group that has `overdraft_allowed = false` (the chosen `groupId`, or the
  `is_default` group when omitted) answers `422` `errors[{field:'creditLimit', message:'This group does not allow credit.'}]`;
  the check lives in `MerchantAccounts.open`, so `PATCH /admin/clients/:id/credit-limit` (feature 3) answers the same. Read the
  group (exists, kind not `b2c_retail`, `overdraft_allowed`) through a small read-only `ClientGroupDirectory` in the catalog
  module's public index. A group move to a group without overdraft while the wallet's `overdraft_limit > 0` is `422` on
  `groupId`. A negative `creditLimit` is `422` on `creditLimit`.
- **ip-4 roles.** No `ROLE_PROTECTED`. `PATCH /admin/roles/:id` answers `409 LAST_OWNER` `errors[{field:'permissions'}]` when
  removing `*` would leave no active staff member whose role holds `*` (the Owner role may be renamed); the same guard covers
  staff role changes and suspensions; use the Owner helpers of P2.5a.
- **ip-6 live sessions.** One predicate in the sessions repository: `revoked_at IS NULL AND expires_at > now() AND (stage <>
  'active' OR last_seen_at > now() - idle limit)` (limits from `SessionPolicy`). `GET /admin/sessions` (staff and merchant
  sessions only, B9), `StaffMember.activeSessions` and the `DELETE /admin/sessions/:id` 404 all use it; 2b reuses it.
- **ip-7 audit actor.** `audit_logs.actor_name` is a snapshot: `RequestActor` gains `name`, the session guards fill it from the
  subject (`SubjectSnapshot` gains `name`; a staff or merchant rename calls `SessionService.invalidateSubject`), the API-key and
  Dhru guards set `{type: 'client', id, name}`, `AuditService.record` writes `actor_name` (`''` for system). Wire `actorName` is
  `null` when `''`; `actorType` is `staff|client|customer|system` (`AUDIT_ACTOR_TYPES`); `q` is a case-insensitive contains over
  `actor_name`, `action` and `entity_label`.
- **ip-13 settings.** See the Settings rule above (allow-list, `422` on the key).
- **ip-14 staff password.** `POST /admin/staff/:id/password` always answers `200` with `Cache-Control: no-store`: `{}` for
  `reset_link`, `{temporaryPassword}` for `temporary_password`; there is no 204.
- **ip-15 audit types.** `entityType` comes from the exported `AUDIT_ENTITY_TYPES` (19 console words plus the backend
  additions); `AuditService.record` throws a `RangeError` on any other value; no DB CHECK.

## Out of scope
Merchant portal sign-in (2b), wallets (3; you only call the public `MerchantAccounts.open` that feature 3 exports), groups and
prices (4a/4b), API keys (7b).
