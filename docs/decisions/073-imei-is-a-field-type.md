# 073: IMEI is a field type, and the service type imei forces nothing

Status: accepted, 2026-11-26 (the owner's order of that day). Builds on decisions 042 (real Dhru Fusion suppliers: the main box), 065 (one
Name per field and the main input flag), 070 (order forms draw only the custom fields) and 071 (a plain IMEI service always has an IMEI
field), and replaces the parts of them that made the service type `imei` force a 15-digit IMEI. The console and the shop record their own
side of the change.

**Context.** Since decision 070 an IMEI service's order form is its custom fields, and the IMEI is typed into the field flagged
`isMainInput`. But placement still forced an IMEI because the **service** was of type `imei`: the main-input field's value (or the `imei`
a request sent) had to be 15 digits with a valid Luhn digit, it was asked for even when the field was optional, and an IMEI service without
such a field could not be ordered at all. A supplier box that takes an ECID or a serial number on an IMEI service could only be served by
turning the service into a `server` service. The owner ordered: "do not make the server force an IMEI in services of type imei; just make
the IMEI input the default and give the user the freedom to do what he thinks is right".

**Decision: a fifth field type, `imei`.** A shared wire fact of the three repositories: custom fields gain the type `imei` beside
`text`, `number`, `select` and `textarea` (`SERVICE_FIELD_TYPES`, the check `service_fields_field_type_check`, every field read and write
of the admin, portal and shop routes). A field of type `imei` holds one IMEI, on any service type, main input or not: its value is read as
digits (spaces and dashes removed, `fieldValueOf`), must be 15 digits with a valid Luhn check digit, and is stored as those digits
(`normalizedInputs`). A problem is reported on `inputs.<key>` with the code `invalid_imei` ("This IMEI is not valid: it must be 15 digits
with a correct check digit."); the answer's error code stays `INVALID_IMEI` (422), with the other problems of the request after it.
`required` and the pattern work as on any field; the pattern judges the digits. Our Dhru list (`imeiservicelist`) has no IMEI field type,
so a field of type `imei` is listed as `fieldtype: "text"`.

**Decision: the service type forces nothing.** An IMEI service is placed like a server service: its custom fields, each judged by its own
type, Required tick and pattern (`inputProblems`), on every surface (the portal's `POST /client/orders`, Dhru's `placeimeiorder` and its
bulk form, the shop's `POST /store/v1/checkout-sessions` and the paid checkout's `CustomerOrderPlacement`). So an optional main input may
be left empty, a text main input takes letters (an ECID), and an IMEI service without fields is ordered with no input at all. Bridges for
the older callers (`bridgedImeiOf`, `src/modules/orders/domain/main-input.ts`):
- **The sent `imei`.** The request's `imei` (older shop pages, Dhru's `IMEI` parameter, each item of a bulk `imeis`), when it has text,
  is the value of the service's main-input field: it wins over a value under that field's key, is judged by **that field's** type,
  `required` and pattern, and its problems are reported on the item's IMEI path as before (`imei`, `imeis.N`, `IMEI`). It is stored under
  the field's key only when the request sent that key (as in decision 070), so an order sent as `imei` keeps no answer row for it.
- **No main-input field.** The sent `imei` is accepted as typed (trimmed) and stored as the order's main input, with no IMEI check.
- **Nothing sent.** The main-input field is judged on the value under its key, its problems on `inputs.<key>`; a missing value is refused
  only when the field is required (`required`, "<label> is required."). A Dhru caller cannot see that field (our list leaves the main-input
  field of an IMEI service out of `Requires.Custom`), so its problems stay on `IMEI`; a value a Dhru caller sends under the field's Name in
  `CUSTOMFIELD` counts like on a server service.
- **`orders.imei`** (`mainInputOf`) of an IMEI service that has a main-input field: that field's value, else the sent `imei`, else
  nothing; never another field (review of this decision): with an optional IMEI field left empty and a required ECID beside it, the order
  has no main input and the dispatch sends no `IMEI` parameter, as for a server service without one, so the ECID travels once, in
  `CUSTOMFIELD`. An IMEI service without a main-input field takes the sent `imei`, else the rule of a server service (the first required
  field). The duplicate check of `block_open` reads the same value.
- **Unchanged.** The request schemas still refuse an empty `imei` with `422` on `imei`; an `imei` sent for a non-IMEI service is still
  `422 not_applicable` on the portal and Dhru (the shop's checkout still ignores it); the supplier dispatch still sends the order's main input
  as the `IMEI` parameter (an IMEI order's `orders.imei`, whatever the field's type: an ECID travels as `IMEI`) and never puts the
  main-input field in `CUSTOMFIELD`; the carry of decision 042 (`carriedImeiInputs`) is unchanged.

**Decision: the shop's checkout.** The session keeps storing the main input of an IMEI service encrypted (`checkout_sessions.imei_enc`), so
its masked line (`imei`: all but the last four characters hidden) and the capture still read it; the capture passes it to
`CustomerOrderPlacement` as before, whose `mainInputOf` gives the same `orders.imei`. The blocklist is asked about every IMEI of the
checkout: the main input and the value of every field of type `imei` (main input or not), each read as digits whenever it is a valid
IMEI, whatever the type of the field the main input was typed into and whatever the service type (`blockableImeisOf`): a blocklisted IMEI
typed with spaces into a text main input, or into a second field of type `imei`, is refused. The capture's risk screening reads the
decrypted main input as before; the blocklist ignores a value that is not 15 digits.
- **The account block** (`POST /admin/clients/:id/block`, `CustomerBlockService`) adds, beside the main inputs of the account's shop
  orders and checkout sessions, the values they hold under fields of type `imei` (the service's fields as `StorefrontServices.fields`, the
  catalog's public read, lists them now). The values of the orders are read in `privacy-reads.repository.ts`, which already reads
  `orders` under its documented deviation (decision 016): the select only adds `service_id` and `inputs`; no new cross-module read.

**Decision: the IMEI input is the default.**
- The supplier import's field of a plain IMEI service (decision 071, `imeiInputField`) is of type `imei`. A supplier field named IMEI (any
  letter case) that the import flags as the main input of a service that stays `imei` becomes of type `imei` too when the supplier's type
  maps to `text` (as migration 0072 does to the stored ones); a list, a number or a text area keeps its type. The fields route's own
  flagging of a field named IMEI never changes a type: staff typed it.
- Creating an IMEI service by hand (`POST /admin/services` with type `imei`) also creates that field in the same transaction
  (`IMEI_DEFAULT_FIELD`, `src/modules/catalog/domain/service-parts.ts`): key `imei`, Name and label `IMEI`, type `imei`, required, the main
  input, `sort` 0, no pattern, audited like a field save (a second audit row `replaced custom fields of service`, before: no fields, after
  the `created service` row). A service of another type gets no field.
- The audit row of every field save (`auditedField`) names each field before and after by key, Name, label, **type, pattern**, `required`
  and the main-input flag: turning an `imei` field into `text`, or removing a pattern, removes a check and shows in the audit log.
- After that staff are free: `PUT /admin/services/:id/fields` accepts any list for an IMEI service (renamed, another type, optional, no main
  input, no fields at all). The convenience of decision 065 stays: a list that leaves no field flagged flags the first field named IMEI.
- The demo seed's IMEI fields are of type `imei`.

**Decision: migration `0072_imei_field_type`.** In the style of `0071`, made with `drizzle-kit generate` from the schema (the check change)
so `db:check` passes, then a data step by hand; registered in `drizzle/meta/_journal.json` with its snapshot.
1. `service_fields_field_type_check` is dropped (`IF EXISTS`) and added again with `imei`.
2. `field_type = 'imei'` for every field that is the main input of an `imei` service (archived ones included), is of type `text` and has
   the Name IMEI ignoring case (`lower(btrim(supplier_key)) = 'imei'`): the 277 fields `0071` made, the supplier fields named IMEI that the
   import or the fields route flagged, the demo seed's. Every other column, field, service and table is left alone.

Every statement can run twice and on an empty database. No cache step: no Redis key holds a service's fields (`docs/cache-keys.md`) and
the search documents hold none; the shop's service page answers `Cache-Control: public, max-age=30`, so a cached page may show `text` for
at most 30 seconds.

**What the release before sees for a few seconds.** The automatic deploy runs the migration and then starts the new API and worker; until
they replace the old ones, the old release reads fields of type `imei`, a type it does not know.
- Its response contracts list four types, so every read that answers the fields of an IMEI service with a converted field answers
  `500 RESPONSE_CONTRACT_VIOLATION` in that window: `GET /admin/services/:id` (and the answer of a fields save), `GET /client/services/:id`
  and `GET /store/v1/services/:slug` (a page the CDN already holds is still served). Its request contract refuses `imei` as a field type,
  so a console that sends it back gets `422` on `fields.N.fieldType` once, and the save works again after the start.
- Nothing is written wrong: the old placement reads an unknown type like `text` and still forces the IMEI of an IMEI service (the same
  orders as before the migration), the old Dhru list leaves the converted fields out (they are all main inputs of IMEI services), and the
  old worker never reads a field type for the dispatch. An import run by the old API in the window writes a `text` IMEI field, which the
  new release then judges as text (no IMEI check): staff set its type to `imei` (rare: the window is seconds).

This is accepted: the window is the seconds between the commit and the start, it only refuses reads (a reload after the start answers),
and no order, payment or field is stored wrong. To avoid it entirely, hold the automatic deployer and release with the API stopped while
the migration runs, as decision 065 did.

**What merchants on our Dhru API see.** `imeiservicelist` does not change for an IMEI service's main input (still left out of
`Requires.Custom`); any other field of type `imei` is listed as `text`. In `placeimeiorder` (and its bulk form) the `IMEI` parameter is
now the main-input field's value: on the 277 converted services and every new or imported one (type `imei`) it is checked as before (15
digits and Luhn, `INVALID_IMEI`); where staff made the main input a text field it takes letters; where it is optional it may be left out;
a service without a main-input field takes it as sent, unchecked. The message for a missing value is the field's ("IMEI is required.")
instead of "Enter the IMEI.".

**Consequences.**
- One migration; no route, table, queue, job, cache key, outbox event or permission is added or removed, so the route manifest, the slices
  and the coverage do not change. The OpenAPI documents are rebuilt (the field type enums, descriptions and examples). The console contract
  extract and the harvested fixtures are regenerated by the lead once the console's side is merged.
- The wire of every read and write of custom fields gains the value `imei` for `fieldType` (admin, portal, shop). Messages change: a missing
  main input says "<label> is required." (before "Enter the IMEI."), and the shop's `invalid_imei` says the portal's sentence (before
  "Enter a valid 15-digit IMEI.").
- An IMEI service whose staff remove the main-input field or make it optional takes orders without a checked IMEI: the owner's choice.
  One such service is live: the owner's own test IMEI service, whose main input staff already made a text area that is not required. From
  this release it accepts any text, or nothing, as its main input (before, the IMEI check still ran on it); the lead tells the owner.
- Our Dhru `placeimeiorderbulk` still places each item on its own: an item whose IMEI its field refuses gets its own `ERROR` (the
  message only; the refusal is `INVALID_IMEI` on `IMEI`), the others are placed. The portal's `imeis` bulk stays all or none, with the
  problem on `imeis.N`.
- Tests: `test/unit/modules/orders/domain/placement-rules.spec.ts` and `main-input.spec.ts`, `test/unit/modules/suppliers/domain/import-plan.spec.ts`;
  the integration files `test/integration/catalog/imei-field-type-migration.test.ts` (new), `imei-main-input-migration.test.ts` (now held
  before 0072), `catalog-services.test.ts` (the default field and the freedom), `catalog-seed.test.ts`,
  `test/integration/orders/imei-main-input-placement.test.ts` (an optional main input, a service with no fields, a text main input with
  letters on the portal and Dhru), `imei-field-pattern-placement.test.ts`, `client-orders-placement.test.ts`, `dhru-surface.test.ts`,
  `test/integration/customers/checkout-imei-main-input.test.ts` (the same at the checkout, and the blocklist with a text main input and
  a second field of type `imei`), `checkout-sessions.test.ts`, `account-privacy-admin.test.ts` (the block adds the value of a field of
  type `imei`), `test/integration/suppliers/dhru-fusion-suppliers.test.ts` and `dhru-fusion-store.test.ts` (the supplier gets letters as
  `IMEI` from the portal, Dhru and the shop; no `IMEI` when the optional IMEI field is empty), `catalog-service-parts.test.ts` (the type
  and the pattern in the audit row); in `imei-main-input-placement.test.ts` also the code and path of a Dhru refusal, `placeimeiorderbulk`
  and an optional text area main input.

**Release.** Console first, then the backend, then the shop. The console can show and offer the type `imei` before the backend has it:
until the backend is released a save with that type is refused (`422` on `fields.N.fieldType`) and no stored field has it, so nothing
breaks. The backend then converts the fields (the seconds above). Between the backend and the shop, the shop that runs receives
`fieldType: "imei"` for the main input of most IMEI services; the shop records how its older pages draw a type they do not know, and is
released right after the backend to keep that window short.
