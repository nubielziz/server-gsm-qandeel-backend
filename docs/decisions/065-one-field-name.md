# 065: One Name per custom field and a main input flag

Status: accepted, 2026-11-24. Builds on decisions 026 (Dhru compatibility), 027 (database conventions), 035 (what goes beyond the map), 042
(real Dhru Fusion suppliers: the main box), 051 (field patterns) and 063. Spec entries B276 (the fields route), B277 (our Dhru-compatible
list and placement), B278 (the answers of an order) and B279 (the main-input field left out of the order forms). The console and the shop
record their own side of the change.

**Context.** A custom field of a service had two names that staff typed. The key (`service_fields.key`) was the name the order forms sent
their answers under, the name `orders.inputs` stored them under and the `fieldname` our Dhru-compatible list published. The supplier key
(`service_fields.supplier_key`) was what a supplier received in `CUSTOMFIELD`, and empty meant "the key". The console showed both as
columns. A saved key could be changed, which left the answers of older orders under a key no field had; two fields could share a supplier
name, so the later value overwrote the earlier one in `CUSTOMFIELD`; and the supplier's main box of decision 042 was a convention: a field
whose supplier key, or key when that was empty, said `IMEI` in any case travelled as the `IMEI` parameter. On an IMEI service such a
field also made the shop and the portal draw a second IMEI box, and the order screens could not show what a field had asked, because the
answers are stored under keys.

**Decision: one Name.** `service_fields.supplier_key` keeps its column name (the map is read-only) and becomes the field's **Name**: never
empty (`service_fields_supplier_key_check`), unique in its service without regard to letter case (`service_fields_name_uq` on
`(service_id, lower(supplier_key))`), and exactly what a supplier receives. On the admin wire it is `name`; `supplierKey` leaves the wire.
`label` stays: the text buyers read. Names that differ only in letter case (`Email`, `email`) are one name, everywhere this decision
compares Names.
- **What a supplier receives.** The dispatch sends each value under the link's `field_map[key]` when that has text, else under the Name
  (`supplierFieldName`, `src/common/dhru/main-input-key.ts`). The value of the main-input field travels as the `IMEI` parameter, never
  inside `CUSTOMFIELD`; an IMEI order's own IMEI comes first. A stored key that no field has any more (the field was deleted after the
  order) is sent under its own key, as before.
- **The supplier import** writes the Name as the supplier spells its field name, the key made from it, the label from the supplier's
  description (else the Name), and the flag on the main box (its Name is the box's own name); on a service that stays `imei`, the flag
  goes to the first field named IMEI in any letter case (`imeiNamedFieldIndex`, `src/common/field-names.ts`). Two supplier names that differ only in
  letter case cannot both be a Name: the later one gets ` 2` (` 3`, ...; `freeFieldName`, `src/common/field-names.ts`). The box's Name
  is never sent, so on a clash the box takes the number and the supplier's field keeps its name. The sync's repair of required fields
  matches the supplier's names against `supplierFieldName` and never touches the main-input field.

**Decision: the hidden key.** `service_fields.key` stays as a hidden identifier that nobody types and that never changes. The server makes
it from the Name when a field is created: lower snake case, at most 60 characters, `_2`, `_3` on a clash, `field` when nothing is left
(`fieldKeyBase` and `freeFieldKey`, the rule the import has had since decision 042). Order answers stay stored under it, the shop and the
portal forms keep sending answers by it, and no stored order is rewritten.

**Decision: the main input flag.** A new column `service_fields.is_main_input boolean not null default false` (a column beyond the map,
registered like `services.sort`) replaces the convention "supplier key `IMEI` means the main box". At most one field of a service has it
(the partial unique index `service_fields_main_input_uq`). No rule that sends or places an order reads the text `IMEI` of a field any more:
the helpers that did (`isMainInputKey`, `resolvedSupplierKey`, `MAIN_INPUT_SUPPLIER_KEY`) are deleted. A field that its supplier itself names
`IMEI` but that is not flagged is an ordinary field and travels in `CUSTOMFIELD` under that Name. The Name sets the flag in one case
only: on an IMEI service with no flagged field, the first field named IMEI in any letter case is the main input; the import and the fields
route both set the flag on it, so no form draws a second IMEI box.
- **On an IMEI service the flagged field is the IMEI itself.** Placement (the portal, the Dhru actions and the shop's checkout) judges its
  pattern and its `required` on the typed IMEI, never on a value sent under its key, reports its problems on the item's IMEI path (`imei`,
  `imeis.N`, the `IMEI` parameter of a Dhru call), where the forms show the IMEI's, not on `inputs.<key>`, and stores the typed IMEI under
  that key when the buyer sent the key. `GET /client/services/:id`, `GET /store/v1/services/:slug` and our Dhru list leave the field out, so no form draws a
  second IMEI box.
- **On another service** the flagged field's value is the order's main input towards the supplier, and `orders.imei` (`mainInputOf`)
  takes it first, then the rule of before (the first required field; the first field or the file name of a file service), so the order,
  its duplicate check (`block_open`) and the `IMEI` parameter name the same value. The supplier sync's adoption of
  decision 042 puts the box first with the flag set; a shop checkout opened before such an adoption and paid after it carries the buyer's
  IMEI onto the flagged field (`carriedImeiInputs`); the shop's bulk publish names a service with a flagged field by the IMEI rules.

**Decision: the fields route.** `PUT /admin/services/:id/fields` stays replace-all. A row may carry the `key` of a field the service has:
that is how a saved field is recognised, and it keeps its key for ever. A row without a key is a new field and the server makes its key (a
deleted field's key is not handed out again in the same save). An unknown or repeated key is `422` on `fields.N.key`; a Name an earlier
row already has, ignoring letter case, is `422` on `fields.N.name` (also when only the database's `lower()` sees the repeat); a second
main input is `422` on `fields.N.isMainInput`. `label` is optional: left out it keeps the saved label of an existing field, an empty
label stores the Name, and a new field without one gets the Name (so a console that shows only the Name never wipes an imported
description). `isMainInput` is optional: left out it keeps the saved value of an existing field and is `false` for a new one. The reads
(`GET /admin/services/:id` and the answer of the PUT) return `key`, `name`, `label`, `isMainInput` and the rest of the row. The audit
row of a save names each field before and after by key, Name, label, `required` and the main-input flag (the flag decides what travels as
the `IMEI` parameter). On an IMEI service a list that leaves no field flagged flags the first field named IMEI in any letter case.

**Decision: migration `0068_field_names`.** Hand-written data steps, then the rules drizzle-kit generated; every pending migration runs in
one transaction, so a failing step leaves the database as it was.
1. Add `is_main_input`; store every Name trimmed.
2. Flag the main input: per service, the first field by (`sort`, `id`) that the dispatch sent as the `IMEI` parameter until now (its
   supplier key, else its key, is `IMEI` in any case). Never more than one per service. This includes a hand-made field keyed `imei` with
   an empty supplier key, so an IMEI service never draws it as a second box. Then, on an IMEI service that has no flagged field, the field
   keyed exactly `imei` is flagged whatever its supplier key: the placement before this decision read that key as the IMEI.
3. A field with an empty Name gets its key as Name: that is what a supplier received for it until now.
4. The flagged field gets a real Name: its label when no other field of the service has that Name (ignoring case), else its key.
5. A Name repeated in a service (ignoring case): the first by (`sort`, `id`) keeps it and each later one gets ` 2`, ` 3`, ... (the first
   that is free), cut so the Name stays at most 120 characters. A main-input field is never the one that keeps it, because its Name is never
   sent.
6. The rules: `supplier_key` loses its default; the not-empty check, the unique index on `(service_id, lower(supplier_key))` and the partial
   unique index on the flag.

`service_fields.key` and `orders.inputs` are not touched. A second field of a service whose supplier key said `IMEI` keeps the Name `IMEI`
and becomes an ordinary field: its value now travels in `CUSTOMFIELD`, where before it was never sent.

**What staff see.** The console shows one Name per field: no Key column and no Supplier key column. The flagged field shows a "Main input"
badge beside its Name, and the actions of a row turn the flag on or off (on for one row turns it off for the others). The console sends
back the key of every saved field it keeps. The order screen shows the custom field answers of an order:
`GET /admin/orders/:id` adds `answers: [{ key, label, value }]`, the service's fields in form order that have a value under their label as
it is now, then any stored key that no field has any more under that key. The merchant's `GET /client/orders/:id` carries the same
`answers`; the list routes do not.

**What a merchant on our Dhru-compatible API sees and sends.** `imeiservicelist` lists each field in `Requires.Custom` with `fieldname` =
the Name and `description` = the label; an IMEI service's main-input field is not listed (the `IMEI` parameter carries it). In
`placeimeiorder` (and its bulk form) and `placefileorder`, a `CUSTOMFIELD` name is matched to a field by its Name exactly, else by its
key exactly, so a panel that kept the old `fieldname` (the key) still works, else by its Name trimmed and without regard to letter case
(a key sent as published is never taken for another field whose Name differs from it only in letter case; `inputsByFieldName` in the
orders module). One field sent twice (two spellings of its Name, or its Name and its key) is refused with `duplicate_field` on
`inputs.<later name>`, never overwritten in silence; a name that matches no field is `unknown_field`, as before. The order stores its
answers by key, whoever placed it.

**Consequences.**
- One migration (`0068_field_names`), shipped alone. No route is added or removed, so the route manifest, the slices and the coverage do
  not change; no job, queue, cache key or outbox event. The OpenAPI documents, the extracted console contract, the harvested fixtures and the
  contract pages are rebuilt once the console's side is merged.
- The admin wire breaks: the fields body needs `name`, so an older console cannot save fields. The backend and the console go out together,
  by the release below.
- A merchant panel that synchronises our service list sees `fieldname` change from our key to the Name; orders keep working (the key is
  still matched), but the panel may ask its owner to map the fields again. Merchants are told before the release.
- A renamed repeat (`Email 2`) reaches its supplier under the new name; before, its value overwrote the earlier field's in `CUSTOMFIELD`.
  The same holds for a name repeated in one supplier service's `Requires.Custom` at import.
- A deleted field's key can come back in a later save for a new field with the same base name (only one save avoids reuse); the `answers` of
  an older order would then show the new field's label.
- Tests: `test/unit/common/field-names.spec.ts`, `test/unit/common/dhru/main-input-key.spec.ts`,
  `test/unit/modules/catalog/domain/service-parts.spec.ts`, `test/unit/modules/orders/domain/field-inputs.spec.ts`, `order-answers.spec.ts`
  and `main-input.spec.ts` beside it, `test/unit/modules/suppliers/domain/import-plan.spec.ts`; the integration files
  `test/integration/catalog/field-names-migration.test.ts`, `dhru-field-names.test.ts` and `catalog-service-parts.test.ts`,
  `test/integration/orders/dhru-surface.test.ts`, `orders-read.test.ts`, `client-orders.test.ts` and
  `imei-field-pattern-placement.test.ts`, `test/integration/customers/checkout-imei-field-pattern.test.ts`,
  `test/integration/suppliers/dhru-fusion-suppliers.test.ts`, `test/integration/storefront/storefront-catalog.test.ts` and the constraint
  cases of `test/integration/infra/db-constraints.test.ts`.

**Release.** Migration `0068_field_names` changes what the code that runs before it would send: that code finds the supplier's main box
by the supplier key `IMEI`, which the migration replaces by a real Name, so it would send the orders of a server service without an
`IMEI` parameter, and its import would write a box without the flag. So the migration is released by hand with the worker and the API
stopped: hold the automatic deployer, stop the worker and the API, deploy (the migration runs), then start both. A failed start is repaired
forward, or by restoring the dump taken before the migration; the old image is never put back on the migrated data.

**Open.** (1) The field map of a supplier link (`service_supplier_links.field_map`) stays as it is: it is the place for a second supplier
that spells a field name differently from the Name. No screen writes one yet; when a service gets a second supplier whose field names
differ, staff need a way to fill it. (2) The import keeps a supplier's field name whole, while the fields route takes at most 120
characters: a service whose supplier sent a longer name cannot be saved by staff until the name is shortened.
