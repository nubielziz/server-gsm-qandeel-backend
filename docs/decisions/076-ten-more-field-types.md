# 076: Ten more field types

Status: accepted, 2026-11-27 (the owner's order of that day: "I want to add new type checks in the custom field"). Builds on decision 073
(IMEI is a field type) and repeats what it did for the type `imei` for ten more types. The console and the shop record their own side.

**Context.** Since decision 073 staff choose the type of a custom field and the server judges the value by it, but only `imei` checks
anything beyond a number or a list choice. Suppliers ask for other device identifiers (an IMEISV, a serial number, an ICCID, an EID, a
MEID, an ECID, a MAC address, a Mi lock code, a box serial number) and for lists of IMEIs; today staff can only make those `text` fields
with a pattern.

**Decision: fifteen field types.** A shared wire fact of the three repositories (the console and the shop copy this list):
`SERVICE_FIELD_TYPES` is, in this order, `text`, `number`, `select`, `textarea`, `imei`, `imei_bulk`, `imeisv`, `serial`, `iccid`, `eid`,
`meid`, `ecid`, `mac_address`, `mi_lock_code`, `box_sn`. Each value is trimmed, read into its stored form, then judged:

| type | stored form | valid when | code | message |
|---|---|---|---|---|
| imei (unchanged) | spaces and dashes removed | 15 digits, Luhn | invalid_imei | "This IMEI is not valid: it must be 15 digits with a correct check digit." |
| imei_bulk | split on line breaks, commas and semicolons; empty items dropped; in each item spaces and dashes removed; items joined with "\n" | 1 to 30 items; every item 15 digits with a valid Luhn digit; no item twice | invalid_imei / too_many_imeis / duplicate_imei | "Line N is not a valid IMEI: each line must be 15 digits with a correct check digit." / "Enter at most 30 IMEIs." / "Line N repeats an IMEI of this list." |
| imeisv | spaces and dashes removed | exactly 16 digits | invalid_imeisv | "This IMEISV is not valid: it must be 16 digits." |
| serial | spaces removed, upper-cased | 5 to 30 characters, letters A-Z and digits only | invalid_serial | "This serial number is not valid: 5 to 30 letters and digits." |
| iccid | spaces and dashes removed | 18 to 22 digits, starting with 89 | invalid_iccid | "This ICCID is not valid: 18 to 22 digits, starting with 89." |
| eid | spaces and dashes removed | exactly 32 digits | invalid_eid | "This EID is not valid: it must be 32 digits." |
| meid | spaces and dashes removed, upper-cased | 14 or 15 hexadecimal characters, or 18 digits | invalid_meid | "This MEID is not valid: 14 hexadecimal characters (0-9, A-F), or 18 digits." |
| ecid | spaces removed, upper-cased except a leading "0x", stored as "0x" | optional "0x" then 8 to 16 hexadecimal characters; or 8 to 20 digits | invalid_ecid | "This ECID is not valid: 8 to 16 hexadecimal characters, or up to 20 digits." |
| mac_address | the 12 hexadecimal characters, upper-cased, written AA:BB:CC:DD:EE:FF | 12 hexadecimal characters, alone or separated by ":", "-" (pairs) or "." (groups of four) | invalid_mac_address | "This MAC address is not valid: 12 hexadecimal characters, like AA:BB:CC:DD:EE:FF." |
| mi_lock_code | as typed (trimmed) | 6 to 64 characters: letters, digits and dashes | invalid_mi_lock_code | "This Mi lock code is not valid: 6 to 64 letters, digits and dashes." |
| box_sn | spaces removed, upper-cased | 4 to 32 characters: letters, digits and dashes | invalid_box_sn | "This box serial number is not valid: 4 to 32 letters, digits and dashes." |

`text`, `number`, `select` and `textarea` are judged trimmed and stored as sent, as before.

- **One table.** `FIELD_TYPE_RULES` (`src/modules/orders/domain/placement-rules.ts`) has one row per type and drives reading
  (`fieldValueOf`, `normalizedInputs`), judging (`inputProblems`) and the IMEIs a value holds (`fieldImeisOf`); no service has code of its
  own for a type. A unit test holds its rows equal to `SERVICE_FIELD_TYPES`. `isValidImei` and `normalizeImei` are kept and reused.
- **Every surface.** The portal's `POST /client/orders`, Dhru's `placeimeiorder` (its `IMEI` parameter and `CUSTOMFIELD`) and its bulk
  form, the shop's `POST /store/v1/checkout-sessions` and the paid checkout's `CustomerOrderPlacement` all call these functions.
- **Order of the checks.** Required, then (`imei_bulk` only) the count, then the 500-character cap on the stored form (30 IMEIs joined
  are 479 characters), then the type, then the pattern, which judges the stored form. A list is counted before it is measured: 31 or more
  IMEIs answer `too_many_imeis` ("Enter at most 30 IMEIs."), never `too_long` (the row's `countProblem` of `FIELD_TYPE_RULES`); every
  other type meets the cap first, so a 600-character text is still `too_long`. Only the first problem of a field is reported; for
  `imei_bulk` the count comes first, then the lines in order (N counts the kept items from 1). A value with no item at all (`,;`) is
  refused as line 1 (`invalid_imei`).
- **The cap is on the stored form; a request may send 2000 characters as typed.** 30 valid IMEIs joined by CRLF or by `, ` (508
  characters), or with spaces and dashes inside each IMEI (569 or more), are longer than 500 as typed but 479 stored. So the request
  schemas that capped a custom field value at 500 before the server read it, the portal's `POST /client/orders` (`inputs`) and the
  shop's `POST /store/v1/checkout-sessions` (`inputs`), take up to `MAX_RAW_INPUT_LENGTH` (2000) characters per value, and
  `inputProblems` keeps the 500-character cap (`MAX_INPUT_LENGTH`) on the stored form of every type. Dhru's `CUSTOMFIELD` and `IMEI`
  have no cap of their own (the Dhru body limit bounds them), so nothing changes there. Checked between the schema and `inputProblems`:
  request bodies are never logged (decision 012: the access log has no body); the idempotency key of the portal hashes the canonical body
  with a keyed hash (any length) and stores the answer, not the body; the checkout encrypts only the main input (`imei_enc`, AES-GCM of
  any length, a `text` column) and keeps the other inputs as `jsonb`; the masked line is below. One thing follows from the wider cap and
  is accepted: a value of a type without a reader (`text`, `number`, `select`, `textarea`) is judged trimmed but stored as sent, so its
  stored copy may now carry up to 2000 characters, white space around at most 500 judged ones, as Dhru's `CUSTOMFIELD` already allowed.
  The shop keeps its own check and still sends a list in its stored form (its decision 009).
- **The answer's code.** A problem `invalid_imei` answers `INVALID_IMEI` (422), also from a line of an `imei_bulk` list; every other code
  (`too_many_imeis`, `duplicate_imei`, `invalid_imeisv`, ...) answers the ordinary `VALIDATION_FAILED` (422) with the field error on
  `inputs.<key>` (or the bridged path: `imei`, `imeis.N`, Dhru's `IMEI`). No error code is added to the catalogue.

**Decision: an `imei_bulk` list is one order at one price.** It is a check type: the list is the value of one field of one order. It does
NOT place one order per IMEI; the portal's `imeis` (one order per item) and Dhru's `placeimeiorderbulk` are unrelated and unchanged. As
the main input of an IMEI service its joined list is `orders.imei` (`mainInputOf`), like any main-input value. What that path does with
it (checked for this decision):
- `orders.imei` and `checkout_sessions.imei_enc` are `text` columns: no length limit.
- The checkout's masked line (`imei` of the session, `maskImei`) of a list is short: the mask of its FIRST IMEI followed by ` +N more`,
  N the other items (`•••••••••••0861 +2 more`; a one-item list reads like one IMEI), instead of up to 475 bullets and four digits. The
  shop lets that line wrap on a phone. The tracking page (`maskInput` of the orders module) still hides all but the last four characters
  of the whole list: long, but valid.
- The duplicate rule `block_open` hashes the whole list (spaces removed, lower case): the same list again is `409 DUPLICATE_ORDER` (see
  **Accepted limits**).
- The supplier dispatch sends `orders.imei` as the `IMEI` parameter: the list with line feeds (allowed in the classic XML form and in
  JSON). Whether a supplier's box takes a list is the supplier's matter: staff link an `imei_bulk` service only to a supplier service that
  takes one. The stored call log keeps the last four characters of `IMEI`, as before.
- The request schemas cap a sent `imei` at 64 characters (portal and shop), so an older caller that sends a list as `imei` sends at most
  four IMEIs; the order forms send the list under the field's key (2000 characters as typed, above). Dhru's `IMEI` has no cap of its own:
  a list of more than 30 IMEIs there is `too_many_imeis`, and 30 or fewer are at most 479 characters stored.
- **The payment reads every IMEI of a list.** The card capture (`CheckoutCaptureService`) and the balance payment
  (`CheckoutBalancePayService`) decrypt the main input and ask the risk screening about it again; for a main input whose field is of type
  `imei_bulk` (the service's fields read from the catalog's `StorefrontServices.fields`) they also hand it every IMEI of the list
  (`mainInputImeisOf`, which reads the main input exactly as `blockableImeisOf` did at the open, with `fieldImeisOf`), as
  `ScreeningInput.imeis`, and the risk module's `Blocklist.match` probes each one beside `imei`. So an IMEI blocklisted after the checkout
  was opened is caught at payment, and a list whose second IMEI is on the blocklist is stopped the way one blocklisted IMEI is (`block`:
  placed held and refunded at once). The customers module reads no risk table and the risk module no catalog or customers table. Other
  fields of type `imei` or `imei_bulk` that are not the main input are asked at the open only, as before.
- The console's order row is the console's matter (it shows `imei` as text).

**Decision: the blocklist reads each line.** The shop's checkout (`blockableImeisOf`, `checkout-session.service.ts`) asks the blocklist
about the main input, the value of every field of type `imei` and each line of every field of type `imei_bulk`. The account block
(`CustomerBlockService`) adds each line of the main inputs of the account's shop orders and sessions (the stored form of a list main input)
and of their fields of type `imei_bulk`, beside the fields of type `imei`. The anonymization of B50 masks a list of IMEIs line by line in
the stored inputs (`scrubInputs`); a main input that is a list is erased, as any main input that is not one IMEI.

**Accepted limits** (noted by the review of 2026-11-27, kept as they are):
- The duplicate rule `block_open` compares the whole stored value of the main input, so two lists that only share an IMEI are not
  duplicates (one IMEI can be in two open orders when it is in two different lists).
- The console's bulk reply matches one main input per order (a pasted line is one order's main input), so it cannot match an order whose
  main input is a list; staff answer such an order on its own page.

**Decision: our Dhru list.** `imeiservicelist` (`DHRU_FIELD_TYPES`, `merchant-api-catalog.ts`) names an `imei_bulk` field `textarea` (one
IMEI per line) and every other new type `text`. The main-input field of an IMEI service stays out of `Requires.Custom`.

**Decision: reads and writes.** Every read and write of custom fields answers and accepts the new values: the admin routes and the portal's
catalog derive their enums from `SERVICE_FIELD_TYPES` (with one description of what each type checks, `FIELD_TYPE_DESCRIPTION`), and the
shop's public service page now derives from it too (the catalog exports the list). The audit row of a field save already names the type.
The supplier import never makes the new types; migration 0072's rule is not repeated: no stored field changes type.

**Decision: migration `0073_more_field_types`.** Made with `bun run db:generate` from the schema: `service_fields_field_type_check` is
dropped and added again with the fifteen values, drizzle-kit's two statements kept word for word (the tooling test of the expand
migration compares them), a comment header above them; registered in `drizzle/meta/_journal.json` with its snapshot. No data step, no cache
step (no Redis key or search document holds a service's fields).

**Release.** Console first, then the backend, then the shop. The console can offer the new types before the backend has them: until the
backend is released a save with one is refused (`422` on `fields.N.fieldType`) and no stored field has one, so nothing breaks. The
backend's migration only widens the check, and no stored field has a new type until staff save one through the new API, so the release
before it never reads one. Until the shop is released, an older shop page receives a `fieldType` it does not know for a service whose
staff chose a new type and draws it as the shop records in its decision 008; the server judges the value by its type whatever the page
drew. Release the shop right after the backend to keep that window short.

**Consequences.**
- One migration; no route, table, queue, job, cache key, outbox event, error code or permission is added, so the route manifest, the slices
  and the coverage do not change. The OpenAPI documents are rebuilt (the enums and descriptions); the console contract extract and the
  harvested fixtures are regenerated by the lead.
- Tests: `test/unit/modules/orders/domain/placement-rules.spec.ts` (one table of samples per type, the stored forms, the first-problem rule of
  `imei_bulk`, `normalizedInputs`, `fieldImeisOf`, the table equal to `SERVICE_FIELD_TYPES`),
  `test/unit/modules/customers/domain/customer-privacy.spec.ts` (a list masked line by line); the integration files
  `test/integration/catalog/field-types.test.ts` (the save of every type, the admin and portal reads, the check, the Dhru list),
  `test/integration/orders/field-types-placement.test.ts` (a portal order with a field of each type, good and bad; an `imei_bulk` main input
  as one order, its limits and the duplicate rule; Dhru's `IMEI` and `CUSTOMFIELD`), `test/integration/customers/checkout-imei-main-input.test.ts`
  (an `imei_bulk` main input at the checkout, the blocklist on any line, the shop's page with every type) and
  `account-privacy-admin.test.ts` (the block adds each line).
- Tests of the review fixes: the count before the cap, the stored-form cap of every type and 30 IMEIs typed with CRLF, `, ` or dashes
  (`placement-rules.spec.ts`; through the portal, Dhru and the checkout in `field-types-placement.test.ts` and
  `checkout-imei-main-input.test.ts`, with a value over 2000 characters refused by the schema); the short masked line
  (`test/unit/modules/customers/domain/checkout.spec.ts`, `checkout-imei-main-input.test.ts`); the IMEIs of the payment
  (`test/unit/modules/customers/domain/checkout-imeis.spec.ts`, and `test/integration/customers/checkout-imei-list-payment.test.ts`: a
  list whose second IMEI is blocklisted after the open is stopped like one blocklisted IMEI, by card and from the balance).
