# 067: API keys are made by staff

Status: accepted, 2026-11-24. Builds on decisions 019 (how a key is stored), 046 (the privilege ceiling and the hold on machine credentials), 062 (retired features) and 064 (one account type with a rank).

**Context.** A merchant account is made by the owner, and a key is a Dhru credential that spends the merchant's money. The owner decided on
2026-11-24 that every key is made by someone on the team: an Owner creates a key in the console, staff change its limits and revoke it, and a merchant
asks staff for a key instead of making one. The merchant's own creation had cost a second creation path with its own checks (the rank and the status read
again from the locked account row), a hold of its own (decision 046: no key while the password or the email address is one that staff set), a notice mail of
its own and two more write routes. The hold existed because a key outlives every later password change (decision 046).

**Decision.**

- **The three write routes of the merchant portal are retired**: `POST /client/api-keys`, `PATCH /client/api-keys/:id` and `DELETE /client/api-keys/:id`.
  They are rows of the read-only map, so they stay in the route manifest and are listed in `test/contract/retired.ts`; no contract, controller method or
  use case serves them, and a merchant session that calls one gets `404` like any path nothing serves. The console does not call them.
- **Staff routes stay as they are**: `GET /admin/clients/:id/api-keys` (`api_keys:read`), `POST /admin/clients/:id/api-keys` (`api_keys:create`, an Owner only,
  decision 046), `PATCH /admin/api-keys/:id` (`api_keys:update`, an Owner for a change that widens a key) and `DELETE /admin/api-keys/:id` (`api_keys:revoke`).
  `ApiKeyIssuer` now serves staff's creation alone; its lock order (the advisory lock `api-keys:<accountId>`, then the account row) is unchanged.
- **`MerchantApiKeyService` keeps `list`** and loses `create`, `update` and `revoke`, with the types and dependencies only they used.
- **`MachineCredentialHold` goes**: it only guarded the merchant's own creation. So do its two sentences, the `403 FORBIDDEN` they came with, and the reader of
  the two marks (`machineHoldOf`).
- **`MerchantLifecycleMails.portalApiKeyCreated` goes** with its sentence: nobody makes a key in the portal, so nobody is told of one. A key staff make still sends
  the security notice `merchant.security_notice` (kind `api_key_created`).

**Kept.**

- `GET /client/api-keys`: the merchant sees its own keys (prefix, allowed addresses, last use), read only.
- Keys that merchants made before this decision keep working until staff revoke them. Nothing in the database changes: no migration, and no key is revoked
  or rewritten. `api_keys.created_by` is null on those keys and the lists show `createdByStaff: false`.
- The columns `clients.password_set_by_staff` and `clients.email_set_by_staff`, and every writer of them (a staff temporary password, a staff change of an email
  address, the password from a mailed link, an Owner's details edit, the erasure of an account). Nothing reads them any more; they stay, unread, until the migration of the
  accounts model drops them.
- The event `merchant.portal_api_key_created`, registered with its shipped text (`IDENTITY_SHIPPED_TEXT_ONLY`): no code writes it now, but a notification row written
  before still reads and sends from its text.
- The limit of 10 live keys per account, the rank and status checks of staff's creation, `ApiKeyRevocation` (a rank change away from the merchant kind and an erasure revoke every
  live key), the cached view of a key and the Dhru endpoint.

**Consequences.** The merchant portal (the shop) stops showing "New key", "Rename" and "Revoke" and stops calling the three routes; it works against the backend before and
after the release. A merchant that needs a new key, a different list of addresses or a revoked key asks staff, who act in the console; a leaked key waits for staff, since the merchant has no
way to revoke it alone (`POST /admin/clients/:id/sessions/revoke` does not touch keys, and a change of password does not either).

**Retired routes.** `POST /client/api-keys`, `PATCH /client/api-keys/:id`, `DELETE /client/api-keys/:id`.
