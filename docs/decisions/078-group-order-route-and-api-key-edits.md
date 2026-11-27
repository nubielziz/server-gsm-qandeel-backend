# 078: one call to reorder the groups; an API key's name and expiry can be changed; a key can be made without a name

Status: accepted, 2026-11-28 (the owner's order of 2026-11-27). Builds on decisions 035 (routes beyond the map), 038 (search signals), 046 (the Owner rule
on keys), 063 (the stored order of services), 064 (one account type) and 067 (keys are made by staff). No migration, no table, no queue, no job, no cache
key, no outbox event.

**Context.** The console's Group view will reorder the groups (the service categories) by dragging. Until now it could only send one
`PATCH /admin/service-categories/:id` per moved group: many requests, no all-or-none, and one audit entry per group. The owner also wants an API key made
with one click and then fully editable. The owner's ruling: "key permissions" means **which IP addresses may use the key and for what period it is valid**;
there is no other permission list.

## Part 1: `POST /admin/service-categories/order`

A route beyond the map (`scripts/map-additions/78-group-order.mjs`, spec `B-TBD group-order`, stage 78, `successStatus` 200), a mirror of
`POST /admin/services/order` (decision 063).

- **Request** `{ items: [{ id, sort }] }`: 1 to 500 items, `sort` a whole number from 0 to 1000000, the same messages as the services route. **Answer**
  `{ updated }`: the number of categories whose position changed (a category already at its position is neither written nor counted). Permission:
  `catalog:update`, the one `PATCH /admin/service-categories/:id` needs. The PATCH stays.
- **All or none, in one transaction.** The categories are locked `FOR UPDATE` in id order (`lockCategoryPositions`; two saves of the same groups run
  one after the other, never mixed, and never deadlock), every problem is judged first, then the positions that differ are written in one statement
  (`writeCategoryPositions`). A category listed twice (`duplicate`, on the later item) or unknown (`unknown`) is `422` on `items.N.id`, all problems
  together, and nothing is saved. A category has no archived state (only `is_active`, which an order does not look at), so "unknown" is the only
  missing-row case; an inactive category can be placed.
- **Side effects: what a `PATCH` with only `sort` does, once for the whole call.** The PATCH locks the row, moves the catalog price version after the
  commit, writes the `catalog.category_changed` event and one `edited category` audit row. The order route:
  - moves the **catalog price version once** after the commit, and only when a position changed (the merchant catalog, the price list and the Dhru
    list read the category position, decision 063, so a cached list is stale);
  - writes **one audit entry** for the call: action `changed the order of`, entity `category`, label `3 categories`, `before` and `after` each
    `{ categories, changed, sorts }` where `sorts` maps `Name (#id)` to the old and the new position of the categories that moved (the first 200; the
    counts are always complete). It is written also when nothing moved, like the services route. The id is in the key because a category name is only
    unique within its type;
  - writes **no `catalog.category_changed` event**. Decision 038 asks for a signal when an *indexed fact* changes. A search document holds the
    category's id and name (`category_id`, `category`) and the search never reads a category's position, so a move changes nothing the index holds.
    The PATCH writes the event whatever it changed, and the event makes the search re-read every service of the category: one per moved group on a
    drag of twenty groups would re-index most of the catalog for nothing. (If the index ever holds a position, this call must write one event per moved
    category: `CatalogSignals.categoryChanged`, same transaction.)
- **Who follows the position:** the merchant catalog, the price export and the Dhru service list, as before (decision 063); nothing else changes.

## Part 2: API keys

- **`PATCH /admin/api-keys/:id`** also takes `name` (the creation's rule: trimmed, 1 to 60 characters) and `expiresAt` (an ISO time in the future, or
  `null` to remove the expiry), beside `rateLimitPerMin` and `allowedIps`. At least one of the four is required (`null` counts as sent). A time that is
  not in the future is `422` on `expiresAt` (`in_the_past`), together with the other field problems. Same permission (`api_keys:update`) as before.
- **The Owner rule (decisions 046 and 067) covers the period too.** `classifyKeyChange` judges the expiry like the list and the limit: **no expiry or
  a later one widens** the key, so only an Owner may do it (`403 FORBIDDEN`, the same text, judged on the locked row before anything is written); a
  **first expiry on a key that never expired, or an earlier one, narrows** it and stays under `api_keys:update`; the same time changes nothing. A
  widening part makes the whole change a widening. **A new name changes no reach**: any staff member who may update may rename a key, and the merchant is
  not mailed (the security notice goes out for a changed address list, limit or expiry, as before for the first two).
- **A revoked key stays revoked.** `409 ALREADY_REVOKED` for every field, as the route answers today for the limit and the list.
- **An expired key may get a later expiry (or none) and works again.** That is a widening, so an Owner's, and the cached view of the key is dropped after
  the commit like any change. It brings a key back to life, so it counts against the **ten live keys** of the account: the update takes the account's
  advisory lock `api-keys:<accountId>` **before** the key row (the creation's order: that lock, then the rows it writes; the rank change and the erasure
  take the account row and revoke keys without that lock, so no cycle forms), counts the live keys and answers `422` on `expiresAt` ("This merchant
  already has 10 active keys; revoke one first.") when the account holds ten. Only a request that sends `expiresAt` takes that lock; renaming an expired
  key, or changing its limit, leaves it expired. A key of an account that left the merchant rank is revoked and so cannot be brought back.
- **The audit row** keeps the action `changed limits of API key of` (the console and the existing entries read that text); its `before` and `after` now
  carry `name`, `rateLimitPerMin`, `allowedIps` and `expiresAt` (an ISO time or `null`) beside `keyId` and `prefix`: what changed is the difference
  between the two. Never the key or its hash.
- **`POST /admin/clients/:id/api-keys`: `name` is optional.** Left out, the server names the key `API key <n>`, n the smallest whole number from 1 that no key of
  that account (revoked and expired ones included) already carries in that exact form (`nextDefaultKeyName`: `API key 01`, `api key 2`, `API key 2 `
  and `API key 2b` hold no number). The name is chosen inside the creation's transaction, after the advisory lock `api-keys:<accountId>` and the account
  row lock, so two creations at the same moment never take the same number; a refused creation (ten live keys, an inactive account) writes nothing. A name
  that is sent is judged as before (a blank one is `422` on `name`), and the answer, the list and the audit row carry the final name. Everything else is
  as today (an Owner only, the limit of ten live keys, the notice mail, `no-store`).
- **`GET /client/api-keys` and the other reads do not change shape.**

## Consequences

- One new route (the 78 map-additions row), one request key more on `POST` and two on `PATCH` of the API keys. The route manifest and the module slices are
  rebuilt; the OpenAPI document, the console extract, the contract documents, the coverage report and the harvested fixtures are the lead's to regenerate at
  merge.
- `ApiKeyAdminService.update` takes a `UpdateApiKeyInput` (`name`, `rateLimitPerMin`, `allowedIps`, `expiresAt`); `ApiKeyAdminService.create` has an
  optional `name`; the repository gains `clientIdOfKey` and `keyNamesStartingWith`, and `updateKey` the `expiresAt` column.
- Tests: `test/integration/catalog/catalog-category-order.test.ts` (the save, all or none, the one audit entry, the one version move, no search signal, the
  refusals, the permission, the lists that follow), `test/integration/identity/api-keys-admin.test.ts` (a key without a name, the rename, the expiry
  and the Owner rule, the revival and its limit, the revoked key), `test/unit/modules/identity/domain/api-key-input.spec.ts` (`classifyKeyChange` with an
  expiry, `nextDefaultKeyName`).

**Open.** (1) The audit action of a key edit still reads "changed limits of"; a rename alone is audited under it. A separate action text would be a
console-visible change. (2) The console's `PATCH` form for a key and its create dialog (name optional, expiry and name editable) are the console's own change.
