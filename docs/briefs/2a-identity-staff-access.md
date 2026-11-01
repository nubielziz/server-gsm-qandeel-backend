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
- Settings: `PATCH /admin/settings` writes only known keys (validate each), then `SettingsReader.invalidate()` and the
  derived caches (`MaintenanceService.invalidate()`, `IpRuleCache.invalidate()`) after commit; audited with secrets
  redacted.
- Merchants: `POST/PATCH /admin/clients` follow `docs/contract/endpoints/identity.md`; status changes call
  `ApiKeyDirectory.invalidateClient` and revoke the merchant's sessions where the docs say. User rule 1 (group
  promotion) belongs to feature 4a, not here.
- Ended sessions: add a daily purge job (worker scheduler) that deletes sessions ended more than 30 days ago.
- Seed: extend `scripts/seed/identity.ts` with the demo merchants (`clients`, same ids and names as the frontend mocks;
  their groups only if the column needs one: create the demo client groups too if no other seeder does). Feature 3 seeds
  wallets for these merchants.
- Every mutation writes `audit_logs` (`AuditService.record`); `GET /admin/audit-logs` lists with the filters of the
  endpoints doc.

## Out of scope
Merchant portal sign-in (2b), wallets (3), groups and prices (4a/4b), API keys (7b).
