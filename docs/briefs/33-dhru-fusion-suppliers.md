# Feature 33: real Dhru Fusion suppliers (order parameters as XML, the supplier's own main input)

Written by Fable 5.2 (lead), 2026-11-17, against backend `main` @ `7c51d7d`. Owner request (2026-11-17, after the first real
order was refused by the supplier): "start the work and the fixes". Backend only; no wire change the frontends must follow.

Read first: `CLAUDE.md`, `docs/briefs/_common.md`, `src/modules/suppliers/README.md`. No agent commits, runs git that changes
state, spawns agents, calls a real supplier, or touches the databases `gsm` and `gsm_storefront`.

## 1. What happened and what is true (each verified on 2026-11-17)

| # | Fact | Evidence |
|---|---|---|
| 1 | The owner's first real order (order 1, service 7, supplier 1, a Dhru Fusion site answering `apiversion: 2025.03`) stopped for review: `placeimeiorder` answered `Parameter 'ID' Required` twice although we sent `ID` | `supplier_api_logs` 616, 617 in `gsm` |
| 2 | The supplier reads `parameters` only as the **plain XML string** of the classic Dhru client: `getimeiorder` for a non-existent order answered `{"ID":"1","ERROR":[{"MESSAGE":"NoResultFound"}],"apiversion":"2025.03"}` for `<PARAMETERS><ID>1</ID></PARAMETERS>`, and `Parameter 'ID' Required` for base64 of that XML and for base64 of JSON | the lead's read-only probe; the classic class builds exactly that string (`dhrufusionapi.class.php`, `action()`: keys upper-case, `<KEY>value</KEY>`, no base64) |
| 3 | We always send base64 of JSON: `dhruRequestBody` (`src/modules/suppliers/domain/dhru-protocol.ts:53`). That is the form of the "Dhru API standards v6.1" script a third-party supplier implements (`json_decode(base64_decode($parameters))`), which decision 026 fixed for **our own** Dhru server. Calls without parameters (`accountinfo`, `imeiservicelist`) work in both, so the import never showed it | code; decision 026 |
| 4 | `suppliers.param_format` exists (`dhru_xml` or `json`, CHECK `suppliers_param_format_check`); every Dhru supplier gets `dhru_xml` (`PARAM_FORMATS` in `supplier-admin.service.ts`), and **nothing reads it** | `src/modules/suppliers/db/schema.ts:59-112`, grep |
| 5 | The classic service list describes the **main box** of an IMEI service as `CUSTOM: { allow, bulk, customname, custominfo, customlen, maxlength, regex, isalpha }`: with `allow: "1"` the buyer types what `customname` says (an ECID, a serial number) instead of an IMEI, and the value is sent in the `IMEI` parameter. `Requires.Custom` lists the *other* fields, sent in `CUSTOMFIELD` (base64 of a JSON object by `fieldname`) | the supplier's stored answers (`supplier_services.raw`); a real panel's API document (gsm-x-tool-api-standards README: "`CUSTOM`: the name of the main box, send its value in `IMEI`") |
| 6 | In `gsm`: 1158 supplier services, 359 with `CUSTOM.allow = "1"` (names `ECID`, `SN OR IMEI`, `SERIAL NUMBER`, `SN`, `LOCK CODE`, ...), 335 of them with no imported field; the owner's 1158 services (628 `imei`, 530 `server`) were made from them by the quick add. Our importer reads only `Requires.Custom` (`readServiceList`, `importedFields`) | read-only queries |
| 7 | Our `imei` type means a 15-digit IMEI with a Luhn digit everywhere (`isValidImei`, risk precheck, forms). `mainInputOf`: `imei` stores the IMEI; `server` and `remote` store the first required field by `sort` | `src/modules/orders/domain/{placement-rules,main-input}.ts` |
| 8 | The dispatcher sends `IMEI` only for an `imei` order and the custom fields by supplier key in `CUSTOMFIELD` | `supplier-dispatch.ts` `placeInput`, `supplier-driver.ts` `placeOrder` |

## 2. Decision 042 (the lead writes the file after the review)

- **A Dhru supplier is sent its parameters in the format its row says.** `dhru_xml` is the classic string
  `<PARAMETERS><ID>..</ID><IMEI>..</IMEI></PARAMETERS>`; `json` is base64 of a JSON object (the standards v6.1 form, what
  decision 026 describes and what our own Dhru server reads). A Dhru supplier keeps `dhru_xml` as its default. `CUSTOMFIELD`
  is base64 of a JSON object in both. No route sets the format yet (a later console control); nothing changes in the schema.
- **A supplier service whose main box is not an IMEI is a `server` service in our catalog** whose first required field is
  that box, with the supplier key `IMEI`. Our `imei` type keeps its meaning (a real IMEI), and every channel already draws
  and checks the fields of a `server` service, so no frontend changes. The dispatcher sends the value of a field whose
  supplier key is `IMEI` (any case) as the `IMEI` parameter, never inside `CUSTOMFIELD`.
- **Services made before this are adopted on the supplier's next sync**: an `imei` service whose only active link points at
  such a supplier service becomes a `server` service with that field, with one audit row; the sync says how many.
- **The supplier's own pattern (`CUSTOM.regex`) is never used** (added after the review): it is untrusted text that would run
  on every order check. It may be written for PHP and match nothing, or backtrack without end. The field's pattern comes from
  the supplier's lengths only; staff can type a pattern on the field.
- **A shop checkout opened before an adoption keeps the buyer's value** (added after the review): the order is placed with the
  typed value as the main box, as it would have gone before the sync.
- **A field the supplier requires is required here** (added on 2026-11-17 evening, from the owner's question and the owner's
  data: a Dhru Fusion site says `"required": "on"`, which the import did not read, so 635 of 637 fields were imported as
  optional). The import reads `on`; `radio` is a list of options; an `adminonly` field is left out. The sync repairs the
  services made before under the adoption's guards and never makes a field optional. `adopted` counts every service the
  sync brought in line with its supplier, once.
- Money and order rules do not change: no automatic re-send, the hold is kept, every call writes its log row.

## 3. The protocol (`src/modules/suppliers/domain/dhru-protocol.ts`, `application/supplier-driver.ts`, `supplier-client.ts`)

- `DhruRequestInput` gains `format: 'dhru_xml' | 'json'` (required: no default in the domain). `DriverContext` gains
  `paramFormat`; `SupplierClient` fills it from the supplier row (every caller's select and `CallableSupplier` carry
  `paramFormat`); the REST driver ignores it.
- New pure function `dhruParametersXml(parameters)`: `<PARAMETERS>` + one `<KEY>value</KEY>` per own key in insertion order
  + `</PARAMETERS>`; no XML declaration, no whitespace. Keys are upper-cased and must match `^[A-Z][A-Z0-9_]*$` (anything
  else throws: the keys come from our typed contracts). A value is a string, a number or a boolean (written as text);
  `null` and `undefined` are left out; any other type throws. In a value `&`, `<` and `>` become `&amp;`, `&lt;`, `&gt;`, and
  characters XML 1.0 forbids (U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, U+FFFE, U+FFFF, lone surrogates) are removed.
- `dhruRequestBody`: `dhru_xml` sets `parameters` to that string; `json` keeps today's base64 of JSON. The driver still turns
  `CUSTOMFIELD` into base64 of JSON before either. The body stays `application/x-www-form-urlencoded`.
- The call record's `request` stays the readable, redacted object and gains `format` (so support sees which form was sent).
  A refusal such as `{"ID":"1","ERROR":[{"MESSAGE":"NoResultFound"}]}` is read as today (`refused`, its message).
- The test support that plays a Dhru supplier reads both forms (a `parameters` that starts with `<` is the XML string) and
  can be told to answer `Parameter 'ID' Required` to the wrong one, as the real supplier does.

## 4. The supplier's main box (`src/modules/suppliers/domain/supplier-main-input.ts`, `import-plan.ts`, `imported-service.ts`)

- New pure function `supplierMainInput(raw)`: reads `raw.CUSTOM`. It answers `null` unless `CUSTOM` is an object, `allow` is
  `"1"`, `1` or `true`, and `customname` has text. A name that only says IMEI (after lower-casing and dropping everything
  but letters and digits: `imei`, `imeino`, `imeinumber`) is `null` too: that service takes a real IMEI. Otherwise it answers
  `{ label, minLength, maxLength }`: `label` is `customname` with its spaces collapsed, at most 120 characters;
  `maxLength` is `maxlength` when it is a whole number from 1 to 500, else `null`; `minLength` is `customlen` when it is a
  whole number from 1 to `maxLength`, else 1. `regex`, `isalpha`, `bulk` and `custominfo` are not used (the review found
  that a supplier's pattern can match nothing or hang the order check: see section 2).
- New pure function `importShape(row)` answers what the service is in our catalog: `{ type, fields }`. With a main input and
  an importable type of `imei`: type `server` and fields `[main, ...importedFields(customFields)]`, where `main` is
  `{ key, label, fieldType: 'text', options: [], required: true, supplierKey: 'IMEI', sort: 0, regex }`; `key` is the label in
  lower snake case (the rule `importedFields` uses, unique against the other keys); `regex` is `^.{min,max}$` built from
  the lengths when `maxLength` is not null, else `''`; the other fields follow with `sort` from 1.
  Otherwise: `importableType(row.type)` and `importedFields(row.customFields)` as today. A `server`, `remote` or `file`
  supplier service is never changed by `CUSTOM`.
- `ImportedField` gains `regex` (`''` for the fields of `Requires.Custom`); `ServiceImporter.create` stores it instead of the
  constant `''`. `createImportedService` uses `importShape`. The import preview and the quick add show and count the type
  `importShape` gives (find every reader of `importableType(row.type)` and decide with the lead's rule: the catalog type is
  `importShape(row).type`).

## 5. The dispatcher (`supplier-dispatch.ts` `placeInput`)

A value whose supplier key is `IMEI` (compared without case, after the link's `field_map`) is never put into `customFields`.
When the order has no IMEI of its own (`input` would be `null`), it becomes `input`. `orders.imei` already holds it for a
`server` service (`mainInputOf`), so the console and the bulk reply show it as the order's input.

**Which field is the supplier's main box** (one rule, used by the dispatcher and by the adoption's guard): a value's supplier
key is the link's `field_map[key]`, else the field's `supplierKey`, else the field's `key`; the field is the main box when
that resolves to `IMEI`, compared without case.

**A checkout opened before an adoption** (`customer-placement.ts`): when the request carries an IMEI and the service is no
longer `imei`, the value goes under the service's main-box field when that field has no value; `orders.imei` then holds it.

## 6. Adoption on sync (`SupplierSync.run`, catalog `ServiceImporter`)

- After the supplier's services are stored, in the same transaction: for every own service that (a) is not archived, (b) is
  of type `imei`, (c) has no field that is already a main box by the rule of section 5 (its supplier key, or its key when
  that is empty, or a value of the link's `field_map`), (d) has exactly one active link in all, and it points at a service
  of **this** supplier whose stored answer has a main input (section 4): adopt it. Order by service id. A `server` category
  that already exists under the same name is reused as it is; only a category created for the move copies the old one's
  switch and groups.
- `ServiceImporter.adoptMainInput(tx, { serviceId, field })` (the catalog owns its tables): the type becomes `server`; the
  category becomes the `server` category with the same name as the current one (created when missing, as `create` does);
  the field is inserted before the existing ones (their `sort` moves up by one; keys stay unique); nothing else of the
  service changes (price, cost, status, quantity, SLA, links, listing). Do **everything a staff edit of a service's category
  does for the shop and the search index** (read `PATCH /admin/services/:id`: the catalog price version, cache keys, the
  outbox event of the search index); if the product forbids changing a service's type, stop and report why instead of
  working around it.
- One audit row per adopted service (system actor, action `adopted the supplier's input`, entity as the service routes use,
  `before` `{ type, categoryId }`, `after` `{ type, categoryId, field: { key, label, supplierKey } }`).
- `SyncResult` gains `adopted: number` (the console ignores an extra key; its type is the console's later work). A second
  sync adopts nothing. A service with two active links, an archived one, one already of another type, or one whose staff
  already gave it an `IMEI` supplier key is left alone.

## 7. Tests (name every rule with no test in your report)

- Unit: `dhruParametersXml` (order, upper-case keys, numbers, escaping, removed characters, a bad key or an object throws);
  `dhruRequestBody` in both formats (the exact `parameters` text); `supplierMainInput` and `importShape` on entries shaped
  like the real ones (**write your own samples: no real service name, price or id from the owner's data in the repository,
  it is public**): ECID with lengths, `SN OR IMEI`, a name that only says IMEI, `allow: "0"`, a broken regex, a main input
  together with `Requires.Custom` fields, a `server` service with `CUSTOM`.
- Integration, against the test Dhru supplier: a `dhru_xml` supplier's `placeimeiorder` and `getimeiorder` carry the exact
  XML and the log row says `format`; a `json` supplier's carry base64 of JSON; the wrong form is refused with the supplier's
  message and the order stops for review exactly as before (no second send); an import and a quick add of a `CUSTOM` service
  create a `server` service with the main field first (regex from the lengths); an order for it (portal and store) sends the
  value as `<IMEI>` and nothing of it in `CUSTOMFIELD`; a sync adopts an `imei` service made before (type, category, field
  order, audit row, `adopted`), a second sync adopts none, and the four cases of section 6 are left alone; a service whose
  `CUSTOM` name only says IMEI stays `imei` and still refuses a bad Luhn digit.
- The existing supplier, order, quick-add and Dhru suites pass (the test supplier reads both forms).

## 8. Documents

`src/modules/suppliers/README.md` and `catalog/README.md` (the new functions and the adoption), the TSDoc of every touched
symbol, `docs/contract` only where a generated document changes (`bun run docs:openapi`, `contract:docs`, `routes:build`,
`coverage:build` as the checks ask). The lead writes decision 042 and the records.

## 9. Acceptance and the lead's steps

`bun run format`, then `bun run check` (the worktree's `.env.test`: `gsm_33_test`, Redis DB 11). Report: files, tests added
with counts, every decision the plan left open, anything not done. Then: an Opus review (the wire form, "no second send",
the adoption's guards and what it writes, the catalog boundary), the lead's read-only probe through the new driver against
the owner's supplier (`getimeiorder` for a non-existent order must answer `NoResultFound`), merge, and the owner syncs the
supplier and places a real order.

## 10. Out of scope (written down for later)

A console control and an API field for the parameter format; our own Dhru server reading the classic XML from a merchant's
client (decision 026 reads base64 of JSON only: check with the first merchant that connects a classic Dhru site);
`CUSTOM.regex` (untrusted: decision 042), `isalpha`, `custominfo` and `bulk`; showing the supplier's main box name on an
`imei` service without changing its type (a wire change in three frontends); two syncs of different suppliers creating the
same category at the same moment (one fails on the unique name and is repeated: the import has the same race).
