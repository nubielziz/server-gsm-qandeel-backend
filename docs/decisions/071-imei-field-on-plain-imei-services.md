# 071: A plain IMEI service always has an IMEI field

Status: accepted, 2026-11-26 (the owner's order of that day). Builds on decisions 042 (real Dhru Fusion suppliers: the main box), 065 (one
Name per field and the main input flag) and 070 (order forms draw only the custom fields), and replaces the part of decision 070 that gave
production no migration.

**Context.** Since decision 070 the order forms of the shop and the merchant portal draw only a service's custom fields, and an IMEI
service's IMEI is typed into the field flagged `isMainInput`. Decision 070 left production without such a field: staff were to add it by
hand. But the supplier import never makes one. A Dhru service list describes the main box of an IMEI service in `CUSTOM` only when the box
asks for something other than an IMEI (an ECID, a serial number; decision 042 makes such a service a `server` service with the box first).
For a plain IMEI service the IMEI is the `IMEI` parameter of every `placeimeiorder`, a part of the protocol rather than a field, so the
supplier never lists it in `Requires.Custom`, and the import created the service with no field the IMEI could be typed into. In production
only one of the 278 IMEI services had a flagged field: the new forms cannot order the others. The owner ordered that every plain IMEI service gets the
field, the imported ones and the ones already stored.

**Decision: the import.** `importShape` (`src/modules/suppliers/domain/import-plan.ts`), which the import, its preview and the quick add
read, gives a supplier service that stays `imei` a first field when none of the supplier's fields is named IMEI (in any letter case):
Name and label `IMEI`, key by the usual rule (`imei`, `imei_2` on a clash with a key of the supplier's fields), required text, no
pattern and no options, `isMainInput` set, `sort` 0; the supplier's fields follow with their `sort` moved up by one
(`imeiInputField`). A supplier field named IMEI is still flagged instead (`imeiNamedFieldIndex`, decision 065), so a service never has
two IMEI boxes. A service whose supplier gives it a main box (`supplierMainInput` not `null`) still becomes a `server` service with that
box first, and `server`, `remote` and `file` services are imported as before. The field has no pattern because the backend checks the
IMEI itself (15 digits and the Luhn digit, `INVALID_IMEI`).

**What the field changes elsewhere: nothing new.** Every reader already treats the flagged field of an IMEI service as its IMEI.
- The dispatch sends the order's IMEI as the `IMEI` parameter and keeps the value of the main-input field out of `CUSTOMFIELD` (decision
  065); the order stores the normalised IMEI under the field's key (decision 070).
- Placement reads the IMEI from `imei` when a request sends it (older shop pages, Dhru's `IMEI` parameter), else from the field; the field
  being required asks for nothing more than the IMEI the order needs anyway.
- The supplier sync's repair of required fields (`fieldsToRequire`) never lists the main-input field.
- Our Dhru list (`imeiservicelist`) leaves the main-input field of an IMEI service out of `Requires.Custom`: a merchant on our Dhru API sees
  no new field.
- The shop's service page (`GET /store/v1/services/:slug`) and the portal's (`GET /client/services/:id`) list the field with
  `isMainInput: true` (decision 070), so the forms draw one IMEI box.

**Decision: the sync's adoption.** Until now an `imei` service was adopted (made a `server` service with its supplier's box first,
decision 042) only when none of its fields was flagged. Every IMEI service now has a flagged field, so adoption would never happen again.
New rule (`adoptable` in `supplier-sync.ts`): an `imei` service whose supplier service has a main box is adoptable, under the same
guards as before (live, its only active link points at this supplier). When the service has a main-input field, that field **becomes** the
box in full (`adoptedBox`, `ServiceImporter.adoptMainInput` with `replaces`): it keeps its id and its key; its Name, label, type (`text`),
options (none), pattern and `required` become what `mainInputField` makes (the Name checked against the other fields only, ` 2`, ` 3` on
a clash), so a flagged field that was a number or a list does not refuse the ECID or serial number the supplier takes; it moves first and
the other fields keep their order behind it. A second flagged field is never inserted (the partial unique index allows one).
A service without a main-input field gets the box inserted first, as before. The audit row `adopted the supplier's input` stays and also
names, in `before.field`, the field that became the box (`key`, `name`, `label`). Because the key stays, a shop checkout opened with
the IMEI typed into the field and paid after the adoption carries its value straight into the box. It also means that the answers of the
shop and portal orders placed before the adoption, stored under the reused key, show under the box's new label (for example `ECID` beside
an IMEI); `orders.imei` still holds the value those orders were placed with, and the dispatch of an IMEI order still sends that IMEI. Everything else of the adoption is
unchanged (the `server` category of the same name, the search event, the catalog price version, price, cost, status and links stay).

**Decision: migration `0071_imei_main_input_field`.** Hand-written data steps, additive (no table, column, index or check changes), in the
style of `0068_field_names` and `0069_shop_content_trimmed`, registered in `drizzle/meta/_journal.json` with its snapshot by
`drizzle-kit generate --custom`. Every statement can run twice and on an empty database. For every service of type `imei`, whatever its
status (archived ones included), that has no field flagged `is_main_input`:
1. When it has a field whose Name is IMEI in any letter case, the first such field by (`sort`, `id`) is flagged; nothing is inserted.
2. Otherwise one statement moves the `sort` of its fields up by one and inserts the field: key `imei` (the first of `imei`, `imei_2`,
   `imei_3`, ... the service does not use), Name `IMEI`, label `IMEI`, type `text`, required, empty pattern, no options,
   `is_main_input` true, `sort` 0. A data-modifying `WITH` makes the move and the insert one statement, so neither can happen without the
   other.

A service that already has a flagged field, a service of another type, `orders.inputs` and every other table are never touched.

**Caches.** No Redis key holds a service's fields (`docs/cache-keys.md`): the shop's and the portal's service pages and our Dhru list read
Postgres on every request, and the search documents hold no field, so the migration needs no cache step and no version to move (the
catalog version is for prices, and nothing that holds fields reads it). The only copy that can lag is HTTP: the shop's service page answers
`Cache-Control: public, max-age=30`, so a browser or the CDN may show a page without the field for at most 30 seconds after the commit; the
portal's page is `private, no-store`.

**Consequences.**
- No route, table, queue, job, cache key, outbox event or permission is added; the wire of every route stays as it is. The descriptions of
  `POST /admin/suppliers/:id/import` and `POST /admin/suppliers/:id/sync` say what changed and the OpenAPI documents are rebuilt.
- The console shows the new field like any other, with its "Main input" badge, and staff may change its label or pattern. An order stored
  before the migration keeps its answers as they were (no answer under the new key); one placed after it with the IMEI typed into the field
  has an `IMEI` row in its `answers` (decision 065).
- On the first supplier sync after the release, an IMEI service whose supplier service has a main box and that the old rule left alone
  because it had a flagged field is adopted: its flagged field becomes the box. The guards of decision 042 still hold, so a service with two
  active links or an archived one is not adopted.
- An import run by the old API in the seconds between the migration and the new start would make a plain IMEI service without the field;
  staff add it on the service's fields (a field named IMEI on an IMEI service is flagged by the fields route, decision 065).
- The demo seed already gives every demo IMEI service the field `imei` (decision 070); the seed runs after the migrations on an empty
  database, so the migration finds nothing to do there.
- Tests: `test/unit/modules/suppliers/domain/import-plan.spec.ts` (`importShape`, `imeiInputField`, `adoptedBox`, `fieldsToRequire`),
  `test/unit/modules/suppliers/application/supplier-sync.spec.ts` (`adoptable`), `test/integration/catalog/imei-main-input-migration.test.ts`
  (new), `test/integration/suppliers/dhru-fusion-suppliers.test.ts` (the import and quick add of a plain IMEI service, the portal's field list,
  the dispatch of an IMEI typed into the field, both adoption paths), `test/integration/suppliers/dhru-fusion-store.test.ts` (the shop's page,
  a paid shop order, a checkout carried across an adoption that reused the field) and `test/integration/suppliers/supplier-quick-add.test.ts`.

**Release.** Backend only; the console and the shop need no change. The migration is additive and safe under the automatic deploy: the API
and worker of the release before already take the flagged field of an IMEI service as its IMEI (decision 070), the shop released with
decision 070 draws it, and the old sync's adoption only skips the services that now have the field (which the new one adopts on its next
sync).
