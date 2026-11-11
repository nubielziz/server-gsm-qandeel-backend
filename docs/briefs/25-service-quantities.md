# Feature 25: Service quantities (staff set smallest, largest and packs; the supplier import copies the supplier's rule)

Plan by Fable 5.2 (planner), 2026-11-11, against backend `main` @ `4d2324c` and console `main` @ `ce3c152`. Owner request
(2026-11-11): a "Quantity" section in the console's service dialog, server checks with an audit record, and the supplier import
copies the supplier's quantities (the "optional" part is **in scope**; §2.6 says exactly how). Two slices, two Sonnet 5.5
implementers, in parallel: **B** backend (`../backend-25`, `feat/backend-25`, test database `gsm_25_test`, the Redis DB of the
worktree's `.env.test`) and **C** console (`../frontend-admin-25`, `feat/console-25`). Read first: `backend/CLAUDE.md`,
`docs/briefs/_common.md`, `_feature.md`; slice C also `frontend-admin/CLAUDE.md`. Paths are backend-relative; `FA/` = the
console worktree. The storefront is READ ONLY (§9). No agent commits, runs git that changes state, or spawns agents.

## 1. What exists and what is missing (verified in the code)

| # | Fact | Evidence |
|---|---|---|
| 1 | `services.min_qty`, `max_qty` (integer, default 1), `qty_options integer[]` (default `{}`); one check `services_qty_check` (`min_qty >= 1 and max_qty >= min_qty`) | `src/modules/catalog/db/schema.ts:255-257,292` |
| 2 | Placement: packs non-empty → only those quantities, min/max ignored; else `minQty..maxQty`; refusal `422` field `quantity` code `invalid_quantity`; a missing quantity is `service.minQty` on every channel | `orders/domain/placement-rules.ts:69-80`, `orders/application/order-placement.ts:142,313`, `customers/application/checkout-session.service.ts:136` |
| 3 | Price is per unit: total, hold, supplier cost and store net are unit x quantity; the quantity goes to the supplier as `QNT` | `order-placement.ts:236-239`, `storefront/domain/retail-quote.ts:58`, `suppliers/application/supplier-driver.ts:147` |
| 4 | Stock and "in stock" need the smallest order: the smallest pack, else `min_qty` | `catalog/domain/storefront-availability.ts:15`, `infra/storefront-services.repository.ts:85` |
| 5 | Merchant and store reads already send the rule: `GET /client/services[/:id]`, `GET /v1/services[/:id]`, Dhru `QNT/QNTOPTIONS/MINQNT/MAXQNT`, store detail `quantity { min, max, options }` | `merchant-catalog.contracts.ts:24-26`, `merchant-api-catalog.ts:230-233`, `storefront-catalog.service.ts:339-342` |
| 6 | **Gap:** `POST`/`PATCH /admin/services` take no quantity key, the admin rows do not send them, `ServiceAdminService` never writes them. Every service is 1/1/`{}` | `catalog/contracts/services.contracts.ts:17-68,198-272`, `application/service-admin.service.ts:179-219,308-327,383-399` |
| 7 | **Gap:** the import creates services without quantities | `catalog/application/service-importer.ts:67-81`, `suppliers/application/supplier-catalogue.service.ts:214-224` |
| 8 | **Correction to the hand-over facts:** the supplier side already keeps the quantity fields. Every sync writes the supplier's whole entry, as sent, to `supplier_services.raw` (jsonb), on insert and on update | `suppliers/domain/dhru-protocol.ts:139-151,231`, `infra/supplier-catalogue.repository.ts:143,160` |
| 9 | Only the Dhru driver lists services; the REST driver answers "unsupported". Decision 026 names the list's fields `QNT, QNTOPTIONS, MINQNT, MAXQNT` | `supplier-driver.ts:265-283`, `docs/decisions/026-dhru-compatibility.md:19-20` |
| 10 | **No server-side cache holds a catalog view.** The only catalog cache artefact is the version counter `gsm:{env}:cache:version:catalog`; `create` and `update` already bump it after every commit; the public store answers carry `Cache-Control: public, max-age=30` | `service-admin.service.ts:332,404`, `docs/cache-keys.md` ("catalog" counter), `storefront/README.md:57,259-263` |
| 11 | The map has the three columns and no body for the admin routes; the console's generated `ServiceRow` already has `minQty`, `maxQty`, `qtyOptions` | `docs/slices/catalog.json` (`services` columns), `FA/src/lib/api/schema.gen.ts:188-190` |
| 12 | Tests write shapes straight to the table that the new save rule would never produce (`[10, 20]` with min 1; `[10, 5, 20]`), to prove the readers are defensive | `test/integration/client-orders-placement.test.ts:161`, `storefront-availability.test.ts:104-108` |

## 2. Design

### 2.1 Wire (names = the columns in camelCase = the merchant reads = the console's `schema.gen.ts`)

| Key | Type and limits | `POST /admin/services` | `PATCH /admin/services/:id` | Rows (`GET` list, `GET /:id`, and the `POST`/`PATCH` answers) |
|---|---|---|---|---|
| `minQty` | integer 1 to 100000 | optional, default 1 | optional; left out = unchanged | always sent |
| `maxQty` | integer 1 to 100000 | optional, default 1 | optional; left out = unchanged | always sent |
| `qtyOptions` | array of at most 50 integers, each 1 to 100000, no repeats | optional, default `[]` | optional; left out = unchanged; `[]` clears the packs | always sent, ascending |

- Constants (exported): `MAX_QUANTITY = 100_000` (the order contracts' own limit: `client-orders.contracts.ts:101`,
  `v1-orders.contracts.ts:78`, `checkout.contracts.ts:47`, `dhru.contracts.ts:26`), `MAX_QTY_OPTIONS = 50`.
- Zod: `minQty`/`maxQty` = `z.number().int('Enter a whole number.').min(1, 'Enter 1 or more.').max(100_000, 'Use at most
  100000.')`; `qtyOptions` = `z.array(z.number()).max(50, 'Use at most 50 pack sizes.')`. The pack values are checked in the
  domain (below), so every pack problem is on the one field `qtyOptions` (the console shows it under one input).
- Response schema: the three keys are added to `ServiceRow` as `.optional()` with the text "Always sent; optional in the schema
  only until the console's types and fixtures carry it" (the `allowCancel` pattern: the harvested fixtures lack them today). The
  lead makes them required after the console merge (§6). `SERVICE_EXAMPLE` gains `minQty: 1, maxQty: 1, qtyOptions: []`; add a
  `PATCH` request example `{ qtyOptions: [5, 10, 25] }` to the description text, not a second example object.
- Clearing packs: `qtyOptions: []`. The service then sells the range `minQty..maxQty`: send both in the same request; when
  they are left out the stored ones stay (they are the former smallest and largest pack). Say this in the `PATCH` description.
- No new route, no new error code (`VALIDATION_FAILED` covers all), no map-addition row, no list filter or sort.

### 2.2 The rule (one pure function; the only writer of the three columns besides the import)

New `src/modules/catalog/domain/quantity-rule.ts` (+ `.spec.ts`):

```ts
export const MAX_QUANTITY = 100_000;
export const MAX_QTY_OPTIONS = 50;
export interface QuantityRule { readonly minQty: number; readonly maxQty: number; readonly qtyOptions: number[] }
export interface QuantityChange { readonly minQty?: number | undefined; readonly maxQty?: number | undefined; readonly qtyOptions?: readonly number[] | undefined }
export type QuantityOutcome = { ok: true; rule: QuantityRule } | { ok: false; errors: FieldError[] }; // FieldError: src/common/errors
/** The rule a service has after `change` is applied to `current`; every problem with its field, code and message. */
export function resolveQuantityRule(current: QuantityRule, change: QuantityChange): QuantityOutcome;
/** The problems of a complete rule (empty = it may be stored): used by the import and by tests. */
export function quantityRuleProblems(rule: QuantityRule): string[];
```

A service sells **one** of: a range (`qtyOptions` empty) or packs. **With packs the server derives `minQty` = the smallest
pack and `maxQty` = the largest pack and stores them**, so the default quantity (`minQty`, fact 2), the stock test (fact 4)
and Dhru's `MINQNT`/`MAXQNT` are always coherent with what placement accepts. Steps of `resolveQuantityRule`:

1. `packs` = `change.qtyOptions` when sent (checked: rules 3 to 5, then sorted ascending), else `current.qtyOptions`.
2. `packs` not empty → `min = packs[0]`, `max = packs.at(-1)`; a sent `minQty`/`maxQty` that differs is rule 6; an equal one
   is accepted. Result `{ min, max, packs }` (this also heals a stored row of fact 12 the next time staff save it).
3. `packs` empty → `min = change.minQty ?? current.minQty`, `max = change.maxQty ?? current.maxQty`; rules 1 and 2. Create
   has no special case: `current` is `{ 1, 1, [] }`, so `minQty: 5` alone is rule 2 (send `maxQty` too).

| # | Refused when | `field` | `code` | Message |
|---|---|---|---|---|
| 1 | no packs, `max < min`, `maxQty` was sent (or both) | `maxQty` | `below_min` | `The largest quantity cannot be below the smallest (<min>).` |
| 2 | no packs, `max < min`, only `minQty` was sent | `minQty` | `above_max` | `The smallest quantity cannot be above the largest (<max>).` |
| 3 | a pack is not a whole number from 1 to 100000 (first bad value) | `qtyOptions` | `invalid_pack` | `Pack sizes are whole numbers from 1 to 100000; <value> is not.` |
| 4 | a pack size appears twice (first repeat) | `qtyOptions` | `duplicate_pack` | `The pack size <value> is repeated.` |
| 5 | more than 50 packs (zod, before the domain) | `qtyOptions` | the pipeline's code | `Use at most 50 pack sizes.` |
| 6 | packs in force and a sent `minQty` (or `maxQty`) is not the smallest (largest) pack | `minQty` / `maxQty` | `packs_set` | `This service sells fixed packs, so its smallest quantity is the smallest pack (<n>). Clear the packs to set a range.` (`largest` twice for `maxQty`) |
| 7 | `minQty`/`maxQty` not whole, under 1 or over 100000 (zod) | the key | the pipeline's code | the zod texts of §2.1 |

All problems of one request are returned together (`422 VALIDATION_FAILED`, `errors[]`). Not rules: the service type (any
type may sell a quantity, as placement allows today), stock on hand, and the supplier's own limits (§2.6, last bullet).

### 2.3 Use cases (`application/service-admin.service.ts`)

- `ServiceView`, `toView`, `CreateServiceInput`, `UpdateServiceInput` and `snapshot()` gain the three keys.
- `create`: `resolveQuantityRule({ minQty: 1, maxQty: 1, qtyOptions: [] }, input)` before the insert; on `ok: false` throw
  `new AppError('VALIDATION_FAILED', { errors })`; write the three columns.
- `update`: only when at least one of the three keys is sent: `resolveQuantityRule(current, changes)` (`current` is the locked
  row) and write **all three** columns of the result. A request that sends none never touches or re-checks them.
- The controller is unchanged (it passes the body through).

### 2.4 Audit

No new audit action. `snapshot()` carries `minQty`, `maxQty`, `qtyOptions`, so the existing rows record them: `created
service` in `after`, `edited service` in `before` and `after` (who, when and both values, as for every other service field),
`archived`/`deleted service` in `before`. The import's row `imported services from` gains `createdWithQuantity` (how many
created services got a rule other than 1/1/`[]`) in `after`.

### 2.5 Caches and database

- **Caches: nothing to add.** Fact 10: no key stores a list or a service; every view that carries the rule (admin rows,
  `GET /client/services[/:id]`, `GET /v1/services[/:id]`, Dhru `imeiservicelist`, `GET /store/v1/services/:slug`, the checkout
  and placement checks) reads Postgres on every request. `create`/`update` already call `priceVersion.bumpAfterCommit(work)`
  unconditionally, and the import bumps when it created a service, so a list cached later through
  `CatalogPriceVersion.versioned` is covered. `docs/cache-keys.md`: no change (its "catalog" paragraph already says "a service
  create, change"). The browser may show a store page up to 30 s old (`max-age=30`); the order path re-checks the quantity.
- **Database: one new CHECK, no column.** In `services`' table config add

  ```ts
  check(
    'services_qty_limits_check',
    sql`${t.maxQty} <= 100000 and cardinality(${t.qtyOptions}) <= 50 and array_position(${t.qtyOptions}, null) is null and 1 <= all (${t.qtyOptions}) and 100000 >= all (${t.qtyOptions})`,
  ),
  ```
  then `bun run db:generate --name service_quantity_limits` (generated `drizzle/0029_service_quantity_limits.sql` + snapshot +
  journal; **the lead renumbers at merge**). It must only add this constraint. Existing rows are all 1/1/`{}`, so it validates
  at once. Deliberately **not** in the CHECK: sorted, unique, and "min/max equal the smallest/largest pack" (a CHECK cannot
  test uniqueness without a function, and fact 12's tests write such rows on purpose); the domain rule owns those, the readers
  stay defensive. `services_qty_check` is untouched. No `ADDITIONS` entry, no table count change.

### 2.6 Supplier import: the specified way

- **Which protocol carries a rule.** Dhru only (fact 9), in each service entry of `imeiservicelist`: `QNT` (`1` = the service
  takes a quantity, `0` = it does not), `MINQNT`, `MAXQNT`, `QNTOPTIONS` (pack sizes, comma separated). The REST driver has no
  list, so nothing to copy.
- **What the sync stores: nothing new, no migration.** Fact 8: `supplier_services.raw` already holds the four fields of every
  synced service and is refreshed by every sync; rows synced before this feature work without a new sync. Document the four
  fields on `ServiceEntry` in `contracts/supplier-calls.contracts.ts` (`Loose`, described, and in the example:
  `QNT: '0', MINQNT: '1', MAXQNT: '1', QNTOPTIONS: ''`). `readServiceList`, `RemoteService`, the upsert and `syncCounts` do
  not change.
- **Reading it.** New pure `src/modules/suppliers/domain/supplier-quantity.ts` (+ `.spec.ts`):
  `supplierQuantityRule(raw: Record<string, unknown>): QuantityRule` (type from the catalog's `index.ts`). It never fails and
  **always** returns a rule that `quantityRuleProblems` accepts, so a supplier rule can never be refused or block an import:
  1. text of a field = a string trimmed, a number as text, anything else `''`.
  2. `options` = `QNTOPTIONS` split on `,` `;` `|` or whitespace; keep tokens matching `^\d+$` with a value 1 to 100000; drop
     repeats; sort ascending; keep the 50 smallest.
  3. `min` = `MINQNT` when it matches `^\d+$` and is 1 to 100000, else 1. `max` = `MAXQNT` when it matches `^\d+$` and is at
     least 1, capped at 100000, else `min`; a `max` under `min` becomes `min`.
  4. `on` = `QNT` reads as the number 1 (or is `true`); when `QNT` is absent or empty: `options` not empty or `max > 1`. Any
     other `QNT` (0, `no`, ...) is off.
  5. off → `{ 1, 1, [] }`; on with options → `{ options[0], options.at(-1), options }`; on without → `{ min, max, [] }`.
  Everything it drops or caps makes our rule a **subset** of the supplier's (we never sell a quantity the supplier said it
  refuses); an unreadable rule falls back to one per order, which is today's behaviour.
- **Applied: only when the import creates a service.** `ImportedServiceInput` gains `readonly quantity: QuantityRule`;
  `SupplierCatalogueService.import` passes `supplierQuantityRule(item.row.raw)` for a `new` item; `ServiceImporter.create`
  throws a plain `Error` when `quantityRuleProblems(input.quantity)` is not empty (a programming error, never a user's) and
  inserts `minQty`, `maxQty`, `qtyOptions`. Count `createdWithQuantity` for the audit row (§2.4).
- **Never applied afterwards.** A `changed` item still only gets its cost (`setCost`), a `matching` item nothing, an archived
  linked service nothing; the price sync (scheduled or "Sync now") refreshes `raw` and never writes a service's quantity
  columns. Staff edits therefore always win, and a supplier that changes its rule changes nothing by itself.
- **Shown: in the import preview.** Each item of `POST /admin/suppliers/:id/import/preview` gains `minQty`, `maxQty`,
  `qtyOptions` (the supplier's rule as `supplierQuantityRule` reads it: for a `new` item, what the service will get) and
  `quantityDiffers: boolean` (`matching`/`changed` with a live linked service whose stored three values differ from it; `false`
  for `new` and for an archived link). `LinkedService` (`domain/import-plan.ts`) and `linkedServicesOf`
  (`infra/foreign-reads.repository.ts`) gain the service's three columns. All four keys `.optional()` + "Always sent" in the
  schema, as in §2.1. To follow a supplier's new rule staff edit the service; there is no "apply" action and no alert.
- **Ignored.** The answer of `POST .../import` (`{ created, updated, unchanged }`) and `GET /admin/suppliers/:id/services`
  do not change.
- **Sending an order's quantity to the supplier: unchanged** (`QNT: order.quantity`, fact 3). A rule staff set wider than the
  supplier's is not refused by us: the supplier refuses the order and the existing rejection path refunds it; the preview's
  `quantityDiffers` is the place staff see the difference.

## 3. Console (slice C; rules of `FA/CLAUDE.md`)

- **Types** (`FA/src/features/services/types/service.ts`): `Service` picks `'minQty' | 'maxQty' | 'qtyOptions'` from
  `ServiceRow` as well; `CreateServiceBody` gains optional `minQty?: number; maxQty?: number; qtyOptions?: number[]`
  (`UpdateServiceBody` inherits them). `FA/src/features/suppliers/types/index.ts`: `ImportPreviewItem` gains `minQty`,
  `maxQty`, `qtyOptions`, `quantityDiffers`. Update the JSDoc of `createService`/`updateService`.
- **Shared text** `FA/src/lib/format/quantity.ts` (exported from the index, with tests): `quantityText(rule)` → `'1'` for
  1/1/`[]`; `'5'` for a range with min = max; `'1–50'` for a range; `'Packs 5, 10, 25'` (more than 5 packs: the first 5, then
  ` +N`).
- **`ServiceFormDialog.tsx`** (New and Edit), a "Quantity" block after the SLA/price row, before `LinkedSuppliers`:
  - `RadioGroup` legend `Quantity`, name `quantityMode`, options: `single` "One per order" / "Every order is for 1 unit.";
    `range` "A range" / "The buyer chooses any whole quantity from the smallest to the largest."; `packs` "Fixed packs" /
    "The buyer chooses one of the pack sizes you list."
  - `range` shows two `TextField`s side by side: "Smallest" (`minQty`) and "Largest" (`maxQty`), `inputMode="numeric"`.
    `packs` shows one `TextField` "Pack sizes" (form field `qtyOptions`, a text), hint "Whole numbers separated by commas,
    for example 5, 10, 25." Under the block, always, muted: "The price is for one unit. An order costs the price times its
    quantity."
  - Defaults: New = `single`, Smallest `1`, Largest empty, packs empty. Edit: `packs` when `qtyOptions` is not empty (text =
    the values joined with `, `), `single` when 1/1, else `range` with the service's values.
  - Client checks (same texts as the server where one exists): Smallest and Largest `^\d+$`, 1 to 100000 ("Enter a whole
    number from 1 to 100000."); Largest under Smallest: "The largest quantity cannot be below the smallest (<min>)."; packs:
    none → "Enter at least one pack size."; a token that is not a whole number 1 to 100000 → "Pack sizes are whole numbers
    from 1 to 100000; <token> is not."; a repeat → "The pack size <n> is repeated."; over 50 → "Use at most 50 pack sizes."
  - Body. Create: `single` sends no quantity key; `range` sends `minQty`, `maxQty`; `packs` sends `qtyOptions` (sorted).
    Edit, only when the rule differs from the service's: `single` → `{ minQty: 1, maxQty: 1, qtyOptions: [] }`; `range` →
    `{ minQty, maxQty, qtyOptions: [] }`; `packs` → `{ qtyOptions }` only (the server derives min and max). "Nothing changed"
    still applies when no key differs.
  - Server errors: add `minQty`, `maxQty`, `qtyOptions` to `dialogSubmit`'s `fields` (the names equal the API's; no alias).
  - Keep the component under ~200 lines: put the block in `components/QuantityFields.tsx` and the pure parts (`modeOf`,
    `parsePacks`, `quantityBody`) in `lib/quantity.ts` (+ `lib/quantity.test.ts`).
- **`ServiceTable.tsx`**: no new column. In the "Service" cell, after the code, `Qty <quantityText>` in `text-xs text-ink3`,
  only when the text is not `'1'`.
- **`FA/src/features/suppliers/components/ImportPreview.tsx`**: a column "Quantity" after "What happens":
  `quantityText(item)`; when `item.quantityDiffers` a second line (`text-2xs text-ink3`): "The service keeps its own rule."
- **Mocks**: `MockService` gains `minQty`, `maxQty`, `qtyOptions` (seed and "blank" 1/1/`[]`); `toService` sends them;
  `serviceRoutes.ts` `applyFields` applies §2.2 with the same fields and messages (derive min/max from packs, sort);
  the suppliers mocks that build a service (`mocks/store.ts`, `mocks/catalogueRoutes.ts`) add the three keys, and the mock
  preview answers `minQty: 1, maxQty: 1, qtyOptions: [], quantityDiffers: false` (one seed item may carry a range to show
  the column). No route is added, so `mocks:live` and the route manifest do not change.
- `FA/docs/MISMATCHES.md`: one line under M10: the quantity keys of the service bodies follow backend B212.

## 4. Contract and docs

- Slice B: `bun run docs:openapi` (regenerated `docs/contract/openapi*.json`); `src/modules/catalog/README.md` (a "Quantity
  rule" paragraph next to "Merchant switches": keys, limits, the derive rule, clearing, the CHECK; `ServiceImporter` takes a
  rule) and `src/modules/suppliers/README.md` (the import copies the rule at creation only; the preview keys; the four Dhru
  fields read from `raw`). `test/contract/allowlist.ts`, `pending.ts`, `docs/cache-keys.md`, `docs/queues.md`: no change
  (shape parity reports the new response keys as `extra-field`, which never fails; the fixtures pass because the keys are
  optional in the schema).
- Lead, after **both** merges: `bun run contract:extract && bun run contract:harvest`; remove `.optional()` and the "only
  until" sentence from the seven response keys (shape parity's `required` rule asks for it once the console reads them);
  append B212 and B213 to `extra` in `docs/contract/lead-decisions.json` (positional: indexes 107 and 108);
  `bun run contract:docs && bun run docs:openapi && bun run check`.
- **B212 (proposal).** area `catalog`; route `POST /admin/services, PATCH /admin/services/:id, GET /admin/services, GET
  /admin/services/:id`; conflict: "The map gives `services` the columns min_qty, max_qty and qty_options but no body for the
  admin routes, and neither the console's assumed contract nor the backend's took or sent them, so every service sold exactly
  one per order."; decision: "Lead record (feature 25, owner request of 2026-11-11). The rows send, and POST and PATCH accept,
  minQty and maxQty (whole, 1 to 100000) and qtyOptions (at most 50 whole pack sizes from 1 to 100000, no repeats, stored
  ascending). A service sells a range or packs: with packs the server stores minQty as the smallest and maxQty as the largest
  pack, and refuses a sent minQty or maxQty that disagrees (422 packs_set); without packs maxQty under minQty is 422 on the key
  that was sent. PATCH changes only the keys sent; qtyOptions [] clears the packs. Pack problems are reported on the field
  qtyOptions. A CHECK (services_qty_limits_check) keeps the limits; order and uniqueness are the server rule's. The existing
  service audit rows carry the three values. No cache key: the catalog version already moves on every service write."; status
  `decided`.
- **B213 (proposal).** area `suppliers`; route `POST /admin/suppliers/:id/import, POST /admin/suppliers/:id/import/preview,
  SUPPLIER imeiservicelist`; conflict: "The import created every service as one per order although a Dhru supplier states QNT,
  MINQNT, MAXQNT and QNTOPTIONS."; decision: "Lead record (feature 25). The four fields are read from the synced entry
  (supplier_services.raw; no new column) and normalised to a rule the catalog accepts, always a subset of the supplier's
  (unreadable values fall back to one per order; at most the 50 smallest packs; 100000 at most). The rule is written only when
  the import creates a service; a later import, sync or supplier change never overwrites a service's quantities. The preview
  shows the supplier's rule per item and quantityDiffers for a linked service whose rule is another one. An order's quantity
  is sent to the supplier as before."; status `decided`.
- MISMATCHES: no frontend-versus-map disagreement to log (the names agree; the map has no rule for these keys). B212 and B213
  are the entries; `MISMATCHES.md` is regenerated from them.

## 5. Risks

| Area | Risk | Closure |
|---|---|---|
| Money | A quantity above 1 multiplies the hold and the supplier cost | already the placement's arithmetic (fact 3), covered by a new end-to-end test (§7); nothing in the ledger path changes |
| Integrity | Packs with a default quantity that is not a pack (fact 2) | the save rule stores `minQty` = the smallest pack; the import's reader does the same |
| Integrity | Staff edits lost to a sync or a second import | supplier values are written at creation only (§2.6) |
| Supplier | Our rule wider than the supplier's | not blocked; the supplier's refusal refunds as today; the preview shows the difference |
| Compatibility | Existing callers of the admin routes | all keys optional; a request without them behaves exactly as today (existing tests pass unchanged) |
| Contract | Required response keys before the console knows them | optional in the schema until the lead's post-merge step (§4) |
| Database | The CHECK refuses rows tests write on purpose | it only bounds values and length; fact 12's shapes still pass |

## 6. Slices (parallel; no shared file)

**B. Backend** (`../backend-25`). Create `src/modules/catalog/domain/quantity-rule.ts` (+ spec),
`src/modules/suppliers/domain/supplier-quantity.ts` (+ spec), `test/integration/service-quantities.test.ts`. Edit
`src/modules/catalog/db/schema.ts`, `contracts/services.contracts.ts`, `application/service-admin.service.ts`,
`application/service-importer.ts`, `index.ts` (export `MAX_QUANTITY`, `MAX_QTY_OPTIONS`, `resolveQuantityRule`,
`quantityRuleProblems`, type `QuantityRule`), `README.md`; `src/modules/suppliers/domain/import-plan.ts`,
`infra/foreign-reads.repository.ts`, `application/supplier-catalogue.service.ts`, `contracts/suppliers.contracts.ts`,
`contracts/supplier-calls.contracts.ts`, `README.md`; `test/support/suppliers.ts` (`FakeService` gains optional `qnt`,
`minQnt`, `maxQnt`, `qntOptions`, sent as `QNT`, `MINQNT`, `MAXQNT`, `QNTOPTIONS` only when set);
`test/integration/catalog-services.test.ts`, `suppliers-admin.test.ts`; generated `drizzle/0029_*` and
`docs/contract/openapi*.json`. Not touched: orders, customers, storefront, money, the sync, the drivers, the seed.
Acceptance: §2 as written; every existing test passes unchanged; `bun run format`, then `bun run check` green (heavy runs
through `bash scripts/with-slot.sh …`). Report: files by folder, the migration name, anything in §2 that the code forced to
differ.

**C. Console** (`../frontend-admin-25`). Create `src/lib/format/quantity.ts`, `src/features/services/lib/quantity.ts`
(+ test), `src/features/services/components/QuantityFields.tsx`. Edit `src/lib/format/index.ts` (+ its test file),
`src/features/services/types/service.ts`, `api/services.ts` (JSDoc), `components/ServiceFormDialog.tsx`,
`components/ServiceTable.tsx`, `mocks/types.ts`, `mocks/dto.ts`, `mocks/seed.ts`, `mocks/serviceRoutes.ts`,
`pages/ServiceDialogs.test.tsx`, `hooks/useServiceMutations.test.tsx` (the fixture service gains the keys);
`src/features/suppliers/types/index.ts`, `components/ImportPreview.tsx`, `mocks/store.ts`, `mocks/catalogueRoutes.ts`
(+ seed types when an item carries a rule), `api/suppliers.test.ts`; `docs/MISMATCHES.md`. Acceptance: `npm run typecheck`,
`npm run lint`, `VITE_API_MOCKS=false npm run build`, `npm test`, all green.

Order: B and C start together. The lead reviews and squash-merges B, then C, then runs §4's post-merge step, then §9.

## 7. Tests

| File | Covers |
|---|---|
| `catalog/domain/quantity-rule.spec.ts` (new) | each rule of §2.2 with its field, code and message; create from `{ 1, 1, [] }` (`minQty: 5` alone is rule 2); packs sorted and min/max derived; `[]` clears and keeps the stored min/max; an equal `minQty` with packs is accepted; several problems returned together; a stored `[10, 20]` with min 1 is healed by any quantity key; `quantityRuleProblems` on good and bad rules |
| `suppliers/domain/supplier-quantity.spec.ts` (new) | `QNT` 0, 1, `'1'`, `true`, absent; min/max as text and number; `MAXQNT` under `MINQNT`, over 100000, unreadable; options with spaces, repeats, zeros, text, more than 50; a property loop: for 200 random raw objects the result passes `quantityRuleProblems` |
| `test/integration/catalog-services.test.ts` (extend) | list, show, `POST` and `PATCH` answers carry the three keys; `POST` range, packs sent unsorted, defaults; each refusal of §2.2 (status, field, code); `PATCH` leaves them unchanged when not sent, changes one key, clears packs with `[]`; the `created service` and `edited service` audit rows hold the values before and after with the actor; the catalog version moved after the commit; a direct SQL write of a `0` pack, 51 packs or `max_qty` 100001 fails on `services_qty_limits_check`; `catalog:update` is still required |
| `test/integration/service-quantities.test.ts` (new) | after `PATCH` to 1..5: `GET /client/services`, `GET /v1/services/:id`, Dhru `imeiservicelist` (`QNT` `1`, `MINQNT`, `MAXQNT`) and `GET /store/v1/services/:slug` (`quantity`) show it on the next request; `POST /client/orders` quantity 3 → `201`, `totalPrice` = 3 x unit, one hold of that amount; quantity 6 → `422 invalid_quantity`; after `PATCH { qtyOptions: [10, 5] }`: no quantity → 5, quantity 7 → `422` naming `5, 10`; a store checkout session for a pack → net = unit x pack |
| `test/integration/suppliers-admin.test.ts` (extend) | a sync keeps the four fields in `raw`; the preview shows the rule of a new item and `quantityDiffers: false`; the import creates the service with the range, and with packs (min/max derived); garbage values import as 1/1/`[]`; after staff change the rule, a new sync with other supplier values and a second import leave the service's quantities untouched and the preview says `quantityDiffers: true`; the audit row has `createdWithQuantity`; a dispatched order still sends its quantity as `QNT` (existing test, unchanged) |
| Contract suite | OpenAPI examples validate; parity green with no allowlist entry |
| `FA` `lib/quantity.test.ts`, format test | `modeOf`, `parsePacks` (each message), `quantityBody` for create and edit in each mode, `quantityText` |
| `FA` `pages/ServiceDialogs.test.tsx` (extend) | New: range and packs send the right body, `single` sends none; Edit: starts in the service's mode, sends only on a change, "Nothing changed"; client messages; a server `422` on `qtyOptions` shows under "Pack sizes"; the table shows `Qty 1–50` |
| `FA` suppliers tests | the preview's "Quantity" column and the "keeps its own rule" line |

## 8. Decisions

Taken here (no owner input needed): the limits (100000, 50 packs); packs derive min and max; pack errors on one field; the
CHECK's scope; the supplier's rule read from `raw` with no new column; copy at creation only; the preview shows, nothing
alerts. Left open, **out of scope**, for the lead's report: a quantity hint on store **cards** (cards carry no quantity, §9);
printing the quantity on the receipt PDF if it is missing (§9); a console warning when a service's rule is wider than its
first supplier's.

## 9. Storefront note (the lead adds it after the merge; the site is not edited here)

`STOREFRONT-BACKEND-HANDOFF.md`: a status-table row and a section "Service quantities (feature 25, merged)" saying:
- No route, key or code changed for the site. What changes is the **data**: staff can now set a range or packs, so
  `quantity { min, max, options }` on `GET /store/v1/services/:slug` and `minQty`, `maxQty`, `qtyOptions` on
  `GET /client/services[/:id]` are no longer always 1/1/`[]`. Test the quantity control against a real range and real packs.
- With packs (`options` not empty), `min` is the smallest and `max` the largest pack; a request without `quantity` orders
  `min`. Without packs any whole quantity from `min` to `max` is accepted.
- Every `price` (cards and detail) is for **one unit**; cards carry no quantity. When `min > 1` the smallest purchase costs
  more than the card shows: label the price "per unit" (or show `price x min` on the detail page as "from"). Amounts for a
  chosen quantity: net = unit net x quantity, tax on that net; the exact figures are the checkout session's own.
- A refused quantity is `422 VALIDATION_FAILED` with `errors[] { field: 'quantity', code: 'invalid_quantity', message }`;
  the English message is "Choose one of the quantities this service sells: 5, 10, 25." (packs) or "Enter a quantity from 2
  to 50." (range). Build the localized text from `options` or `min`/`max`, keyed on the code.
- `in_stock` means the stock covers the **smallest** order; a larger quantity can still be delivered later ("on request").
- The session, the tracking page and the order lists already carry `quantity`. **Lead: check what the receipt PDF prints**
  (no quantity line was found in the receipt code on 2026-11-11); if it prints only the total, record that as a known gap.

`STOREFRONT-HANDOFF.md`: at §4 row 17 and the "Quantity:" line of the order rules, and at §5 rows 3 and 8, add "(since
feature 25 staff set these: STOREFRONT-BACKEND-HANDOFF.md, Service quantities)"; in §8 (traps) one line: "a card's price is
per unit; with `min > 1` or packs the smallest purchase is `price x min`".

## 10. Review against the code, and approval

Checked in the code: the `services` columns and check; `quantityProblem` and the three default-quantity sites; the totals;
`smallestOrder` and its SQL twin; the merchant, REST v1, Dhru and store readers; the admin contracts, `ServiceAdminService`
(`snapshot`, `toView`, both unconditional version bumps) and its controller; `ServiceImporter`; the sync, the upsert of
`raw`, `sentEntry`, both drivers, the import and its preview, `linkedServicesOf`; every `getOrLoad`/`versioned` call site
(none in the catalog or the storefront); the contract comparator's rules (`extra-field`, `required`, `fixture`) and the
allowlist (no entry for these routes); the tests of fact 12; the console's dialog, types, mocks, `dialogSubmit` and
`applyServerErrors` (a field error must name the form field exactly, hence one field for packs), the service table and the
import preview. Not verified: what the receipt PDF prints (§9), and that a real Dhru supplier sends `QNTOPTIONS` (decision
026 lists it; the reader works without it).

**Approved by Fable 5.2 (2026-11-11)**
