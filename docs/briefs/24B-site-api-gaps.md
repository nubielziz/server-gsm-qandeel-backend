# Feature 24B: Site API gaps (Idempotency-Key on portal orders, customer self-edit of name, phone and country)

Plan by Fable 5.2 (planner), 2026-11-10, against backend `main` @ `bd32229`. Implementer: one Sonnet 5.5, slices A then B.
Worktree `../backend-24b` on `feat/backend-24b`, test database `gsm_24b_test`, Redis DB 7 (LEAD-DECISIONS §1). No console
work, no new route, no W0 dependency: it may branch from `main` at once. Read first: `backend/CLAUDE.md`,
`docs/briefs/_common.md` (its frontend-cwd and Serena lines are stale), `_feature.md`, `CONTRIBUTING.md`. Paths are
backend-relative. The storefront (`../storefront`) is READ ONLY; its needs are §9.

Rules (LEAD-DECISIONS §7): work only in the worktree; never run `docker compose`, `db:migrate`, `db:seed`, `src/main.ts` or
`scripts/ci.sh` there; never touch :3000, :3100, the `gsm` or `gsm_storefront` databases; no git command that changes state;
no agents. Targeted tests while developing, heavy runs through `bash scripts/with-slot.sh …`, `bun run check` once at the end.

## 1. What exists and what is missing

| # | Requirement | Status | Evidence (verified in the code) |
|---|---|---|---|
| 1 | A double click on "Place order" must not create two orders | missing | `placeClientOrder` has no `headers` (`src/modules/orders/contracts/client-orders.contracts.ts:112-140`); `ClientOrdersService.place` runs the placement and reads the views after the commit (`application/client-orders.service.ts:52-75`); handoff §8.3 trap 7 |
| 1a | The REST v1 mechanism to reuse | exists | `IdempotencyStore.run(tx, { clientId, key, scope, requestHash }, work)` (`application/idempotency-store.ts:74-115`): advisory transaction lock per merchant and key (`infra/idempotency.repository.ts:19-22`), stored answer in the placement's own transaction, same key and body replays, other body or scope is `409 IDEMPOTENCY_KEY_REUSED`, a running one `409 IDEMPOTENCY_IN_PROGRESS`, exact 7-day window with lazy forgetting, daily purge by `created_at` whatever the scope (`idempotency.repository.ts:125-140`). Used by `ApiOrdersService.place` (`api-orders.service.ts:126-136`); the controller adds `idempotency-replayed: true` (`controllers/v1-orders.controller.ts:35`). Header schema `IdempotencyHeaders` is a private constant of `contracts/v1-orders.contracts.ts:85-98` |
| 1b | Scopes | partial | `IDEMPOTENCY_SCOPES = ['order', 'bulk']` with a CHECK (`db/schema.ts:273,309`; `drizzle/0009_idempotency_keys.sql`); keys are unique per `(client_id, key)` across scopes. The v1 `order` answer is a bare order, the portal answer is `{ orders: [...] }`, so the portal needs its own scope |
| 1c | Wiring | exists | `ClientOrdersService` and `IdempotencyStore` are providers of the same module (`orders-admin.module.ts:51,53`); `Idempotency-Key` is already a CORS-allowed header (`docs/contract/ALIGNMENT.md:140`) |
| 2 | A customer edits name, phone and country | missing | `PATCH /store/v1/me` takes `locale`, `currency`, `marketingOptIn` (`src/modules/customers/contracts/store-account.contracts.ts:85-94`; `application/customer-account.service.ts:63-100`) |
| 2a | The staff rules to share | exists, private | `CustomerAdminService.update` (`application/customer-admin.service.ts:211-262`): "changed" is judged against the locked row; a **changed** country needs a current tax rate (`assertCountryAccepted` → `hasCurrentTaxRate`, `422` on `country`) and re-derives the currency (`currencyFor`: the country's storefront currency when active and shown, else USD); `changesOf` (`:333-375`) collects columns and audit values. Field schemas `NameField` (2 to 120, spaces tidied), `PhoneField` (≤ 40, `''` = none), `CountryField` (ISO-2, upper case) are shared already (`contracts/shared.ts:29-61`) |

Not affected: the tax of a purchase comes from the checkout request's own `country` (`checkout-session.service.ts:120,150`),
never from the profile, so a profile country change cannot change what a session charges.

## 2. Design

### 2.1 Idempotency-Key on `POST /client/orders` (orders module)

- **Scope.** Add `'portal'` to `IDEMPOTENCY_SCOPES`. A key a merchant used on REST v1 and sends again on the portal (or the
  reverse) is then `409 IDEMPOTENCY_KEY_REUSED` by the store's existing scope comparison, and a portal replay can never return a
  v1-shaped body.
- **Header.** Move `IdempotencyHeaders` to a new `src/modules/orders/contracts/idempotency-headers.ts` (exported; same
  schema and text, optional, 1 to 255 printable characters without spaces); `v1-orders.contracts.ts` imports it.
- **Use case.** `ClientOrdersService.place(clientId, input, source = 'portal', key?: string)` returns
  `{ orders: MerchantOrderView[]; replayed: boolean }` and becomes **one transaction** that also reads the answer (today the
  views are read after the commit; reading them inside the transaction gives the same rows and lets the answer be stored):

  ```ts
  return this.db.runInTransaction(async ({ tx }) => {
    const work = async () => {
      const placed = await this.placement.place(tx, { clientId, source, serviceId, quantity, items, fileId, actor });
      const rows = await Promise.all(placed.map((o) => findOrderRow(tx, { kind: 'merchant', clientId }, o.id)));
      return { status: 201, body: { orders: rows.map((row) => toMerchantOrder(row!, now)) } as unknown as JsonObject };
    };
    if (key === undefined) return unwrap(await work(), false);
    const hash = this.idempotency.hashOf('portal', input);            // the validated body, canonical key order
    return unwrap(await this.idempotency.run(tx, { clientId, key, scope: 'portal', requestHash: hash }, work));
  });
  ```
  The placement call is unchanged: `idempotencyKey` is **not** passed to `OrderPlacement` (a bulk of IMEIs makes several
  orders, and `orders.idempotency_key` is unique per merchant; the `idempotency_keys` row alone guards the portal).
- **Controller.** `@ContractHeaders() headers: HeadersOf<typeof placeClientOrder>` (no key in the decorator), pass
  `headers['idempotency-key']`, set `idempotency-replayed: true` on a replay (as v1 does), answer `{ orders }`.
- **Semantics (identical to v1, restate them in the contract description).** Same key and same body: the stored `201` body is
  sent again and nothing is placed or held. Same key, another body: `409 IDEMPOTENCY_KEY_REUSED`. Same key still running:
  `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1`. A refused request (`402`, `409 DUPLICATE_ORDER`, `422`, …) stores
  nothing: the key may be sent again. The answer is kept 7 days from the first request. A replay is the snapshot of the first
  answer (the orders may have moved on since). Without the header the route behaves exactly as today.
- No audit row (merchant routes write none, B121). No cache, no outbox change, no job change (the daily `idempotency_purge`
  already deletes rows of every scope).

### 2.2 Customer self-edit (customers module)

- **Shared rule (extract, do not copy).**
  - New `src/modules/customers/domain/profile-edit.ts` (pure, with a spec):
    `profileChanges(customer, input: { name?, phone?, country? }, derivedCurrency: string | null | undefined):
    { columns: Partial<Customer>; before: Record<string, unknown>; after: Record<string, unknown> }`: the `name`, `country`
    (with `currency = derivedCurrency ?? null`) and `phone` branches of today's `changesOf`, byte for byte.
    `changesOf` in `customer-admin.service.ts` calls it and keeps its own `email`, `locale` and `internalNotes` branches, so the
    audit values of the staff edit do not change.
  - New `src/modules/customers/application/customer-profile-rules.ts` (`@Injectable() CustomerProfileRules`, provided next
    to `CustomerAdminService` and `CustomerAccountService`): `currencyFor(db, country)` and
    `assertCountryAccepted(db, country, now)` moved out of `CustomerAdminService` unchanged (same `422` on `country`,
    "Choose a country."); the admin service calls them.
- **Contract.** `updateMe` body gains `name: NameField.optional()`, `phone: PhoneField.optional()`,
  `country: CountryField.optional()`; the summary and description say so; errors unchanged (`VALIDATION_FAILED` covers the
  new refusals). The answer stays `StoreMeSchema` (it already carries `name`, `phone`, `country`).
- **Use case** `CustomerAccountService.updateMe` (one transaction, the customer row locked as today):
  1. `currency` sent: validated as today (before the transaction).
  2. Inside, against the locked row: a **changed** country → `assertCountryAccepted(tx, country, now)`; a country equal to the
     stored one is never checked (same rule as staff: a form that re-sends it must not fail when its tax rate ended).
  3. Currency: an explicit `currency` in the same request wins; otherwise a changed country re-derives it with
     `currencyFor` (the staff rule); otherwise it is untouched.
  4. Write only the changed columns (plus `updatedAt` from the clock); the consent record logic is unchanged.
- **Email is not editable** here (owner decision D-12 is open): the field is not in the body.
- No audit row (a customer's own action writes none today), no notification, no cache.

## 3. Database and API

**Migration** (one, generated; the lead renumbers at merge): `bun run db:generate --name idempotency_portal_scope` after the
schema edit. It must only drop and re-create `idempotency_keys_scope_check` with `('order', 'bulk', 'portal')`; no data
change. No `ADDITIONS` entry (no column), no table count change.

| Route | Change (additive) | Access, CSRF, limits | Request | Answer | Errors added |
|---|---|---|---|---|---|
| `POST /client/orders` | optional header `Idempotency-Key` | merchant session (pending refused as today), CSRF, no Turnstile, no new limiter | header: 1 to 255 chars `[\x21-\x7e]`; body unchanged | `201 { orders: MerchantOrder[] }`; a replay adds response header `idempotency-replayed: true` | `IDEMPOTENCY_KEY_REUSED` (409), `IDEMPOTENCY_IN_PROGRESS` (409, `Retry-After`) |
| `PATCH /store/v1/me` | body gains `name?: string` (2 to 120), `phone?: string` (≤ 40, `''` clears), `country?: string` (ISO-2) | customer session (full), CSRF, no Turnstile | all fields optional; `{}` still valid | `200 StoreMe` | none (`422` on `name`, `phone`, `country`) |

No map-addition row (both routes are map rows; the map's `idempotencyKey` flag is informational and not compared). Both
codes exist in the catalog. Regenerate `docs/contract/openapi*.json` (`bun run docs:openapi`) and the contract docs
(`bun run contract:docs`); the keys and `operationId`s do not change. `docs/contract/ALIGNMENT.md` § 7: add one line that the
portal order route accepts the header.

## 4. Admin console

None. `PATCH /admin/customers/:id` keeps its contract and audit values (the refactor is internal).

## 5. Risks and how the design closes them

| Area | Risk | Closure |
|---|---|---|
| Financial | Two requests with one key both hold the wallet | the advisory lock is taken before anything else in the placement transaction; the loser gets `409 IDEMPOTENCY_IN_PROGRESS` or, after the winner committed, the replay; the stored answer and the orders commit together (test with parallel requests: one hold, one set of orders) |
| Financial | A replay after a refusal hides a real failure | refusals are never stored; only a `201` is |
| Integrity | A v1 key replayed on the portal returns the wrong shape | separate scope → `409` |
| Integrity | Reading the views inside the transaction changes the answer | same rows, same `toMerchantOrder`, same clock value; the existing placement tests must stay green untouched |
| Concurrency | Lock held during a slow placement | unchanged from v1: the lock is a transaction-level try-lock, never a wait |
| Compatibility | Callers without the header | unchanged path; `ClientOrdersService.place` gains a trailing optional parameter and a wrapped result: its only caller is the portal controller (`api-orders.service.ts` uses `cancel` and `verify` only) |
| Compatibility | Staff edit of a customer changes behaviour | the extracted functions are moved, not rewritten; `test/integration/customers-admin.test.ts` must pass without edits |
| Security | A customer sets a country the shop does not sell to, or changes another account | the tax-rate check; the id comes from the session principal only |
| Privacy | Name and phone are personal data | already covered by the export and anonymize paths (same columns); nothing new is logged |
| Performance | none | one indexed lookup and one insert per keyed placement; one extra read on a country change |

## 6. Slices

**A. Portal order idempotency (small).** Edit `src/modules/orders/db/schema.ts`; generate `drizzle/0020_idempotency_portal_scope.sql`
(+ snapshot, journal); create `src/modules/orders/contracts/idempotency-headers.ts`; edit `contracts/v1-orders.contracts.ts`
(import), `contracts/client-orders.contracts.ts` (headers, errors, description), `application/client-orders.service.ts`,
`controllers/client-orders.controller.ts`, `src/modules/orders/README.md`, `docs/contract/ALIGNMENT.md`.
Acceptance: the semantics of §2.1; REST v1 idempotency tests and the existing portal placement tests pass unchanged;
`bun run db:check` green.

**B. Customer self-edit (small).** Create `src/modules/customers/domain/profile-edit.ts` (+ `.spec.ts`),
`application/customer-profile-rules.ts`; edit `application/customer-admin.service.ts` (delegate), the module file that
provides both services (add the provider), `contracts/store-account.contracts.ts`, `application/customer-account.service.ts`
(+ `UpdateMeInput`), `src/modules/customers/README.md`.
Acceptance: the rules of §2.2; the admin edit answers and audits exactly as before.

Finish: `bun run docs:openapi`, `bun run contract:docs`, `bun run format`, `bun run check` (foreground). Report: files by
folder, the spec decisions of §8, the migration name.

## 7. Tests

| File | Covers |
|---|---|
| `test/integration/client-orders-idempotency.test.ts` (new) | same key + same body: second answer equals the first, `idempotency-replayed: true`, one order row, one ledger hold; a bulk of IMEIs replays all of them; another body → `409 IDEMPOTENCY_KEY_REUSED`; two parallel requests with one key → exactly one placement (the other `409 IDEMPOTENCY_IN_PROGRESS` or a replay), wallet held once; a key first used on `POST /v1/orders` → `409` on the portal and the reverse; a refused request (`402`) stores nothing and the same key places after a top-up; no header → two requests place two orders (different inputs); after 7 days (`TestClock.advance`) the key places again; malformed header (space, 256 chars) → `422`; CSRF and pending-merchant refusals unchanged |
| `test/integration/rest-v1-idempotency.test.ts`, `client-orders-placement.test.ts`, `idempotency-purge.test.ts` | must pass unchanged; add to the purge test one `portal` row older than the window that is deleted |
| `src/modules/customers/domain/profile-edit.spec.ts` (new) | each field changed, unchanged, cleared phone; country sets the derived currency; before/after values equal today's audit values |
| `test/integration/store-account.test.ts` (extend) | set name, phone, country; `''` phone clears; name of 1 character and a 3-letter country → `422` with the field; a country with no current tax rate → `422` on `country`; the stored country re-sent after its rate ended → `200`; a country change re-derives the currency; `country` + `currency` together keeps the explicit currency; `{}` → `200` unchanged; another customer's row never changes; no `audit_logs` row; CSRF refusal unchanged |
| `test/integration/customers-admin.test.ts` | passes unchanged (refactor proof) |
| Contract suite | OpenAPI examples validate; route parity unchanged |

## 8. Decisions

Owner decisions taken with defaults: none new. Kept open and **out of scope** (recorded for the lead's final report):
- **Email change by the customer** (D6 D-12): not built; the owner decides whether it is allowed and whether the new address
  must be verified first.
- **Tracking link in order mails** (D6 #8, D-13): waits for feature 21 (`money/application/storefront-mails.ts` is 21's).
- **Data-export delivery** to the customer (D6 #9, D-11): waits for the owner's channel decision.
- **Orderable model/network/MEP options** (D6 #11, D-16): waits for the owner (do suppliers need them?).

Spec decisions for the lead's B-entries: (a) `POST /client/orders` accepts an optional `Idempotency-Key` with REST v1's
semantics under a new store scope `portal` (schema: the scope CHECK widens); the key is not written to
`orders.idempotency_key`; (b) the portal placement reads its answer inside the placement transaction; (c)
`PATCH /store/v1/me` accepts `name`, `phone`, `country` with the staff edit's rules; a country change re-derives the currency
unless the request sends one; no audit row for a customer's own edit.

File overlap check with the approved plans: plan 21 edits in customers only `application/checkout-session.service.ts`,
`checkout-capture.service.ts`, `checkout-balance-pay.service.ts` (new), `customer-privacy.service.ts`, `checkout.module.ts`
and `db/schema.ts` (grep of `docs/briefs/21-customer-wallet.md`); none is a file of this plan. Plan 22 adds
`orders/application/order-sales-counts.ts` and one line in `orders/index.ts`; this plan does not touch `index.ts`. The only
shared artefacts are the next migration number and the generated documents (the lead resolves both).

## 9. Storefront handoff

- `POST /client/orders`: send `Idempotency-Key: <uuid>` generated **once per form submission** (keep it while the same
  submission is retried; make a new one when the merchant changes the form). A replay answers `201` with the same body and
  the response header `idempotency-replayed: true` (read it through the proxy; cross-origin it is not an exposed header).
  `409 IDEMPOTENCY_IN_PROGRESS`: retry after `Retry-After`. `409 IDEMPOTENCY_KEY_REUSED`: a programming error (a key reused
  for another body). A replayed body is the first answer: refetch the order for its current status. Handoff trap 7 is closed.
- `PATCH /store/v1/me` now also takes `name` (2 to 120), `phone` (up to 40, `''` clears) and `country` (ISO-2; `422` on
  `country` when the shop has no tax rate for it: offer the countries of `GET /store/v1/config` `taxRates`). A country change
  resets `currency` to the country's default unless the same request sends `currency`. Email cannot be changed yet.
- Regenerate `lib/api/schema.gen.ts` after the merge.

## 10. Review against the code, and approval

Checked in the code: `IdempotencyStore` (lock, lazy forgetting, scope and hash comparison, stored row), its repository and
migration `0009`, both v1 placement paths and the v1 controller's replay header, `ClientOrdersService.place` and its single
caller, the module that provides both classes, `OrderPlacement`'s `idempotencyKey` handling (`order-placement.ts:244`: only
for a single order), the purge queries (no scope filter), `updateMe`, `CustomerAdminService.update`, `changesOf`,
`assertCountryAccepted`, `currencyFor`, the shared field schemas, the checkout's own country, and plan 21's customers files.

Correction to D6 §6 row 3: it is right that a new scope is needed, and the reason is the answer shape, not only tidiness.
No lead decision conflicts with the design.

**Approved by Fable 5.2**
