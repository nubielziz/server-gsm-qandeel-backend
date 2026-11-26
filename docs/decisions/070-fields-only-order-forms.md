# 070: Order forms draw only the custom fields

Status: accepted, 2026-11-26 (the owner's ruling of that day). Builds on decisions 065 (one Name per field and the main input flag) and 051
(field patterns). The shop records its own side of the change.

**Context.** Since decision 065 the field flagged `isMainInput` is the IMEI itself on an IMEI service, and the forms of the shop and of the
merchant portal drew a built-in IMEI box (and, on the portal, a bulk IMEI list) of their own: `GET /client/services/:id` and
`GET /store/v1/services/:slug` left the flagged field out so that no form drew a second IMEI box, and placement judged the field's pattern
on the IMEI sent as `imei` and reported its problems on the IMEI's path. The owner ruled that the forms draw only the service's custom
fields: an IMEI service's IMEI is typed into the field flagged as the main input, like any other answer. The check of the IMEI (15 digits
and the Luhn check digit) stays in the backend. No migration, and a field list without a main input stays allowed: the owner takes
responsibility for the IMEI services that have no main-input field (the new forms cannot order them).

**Decision: the reads list every field.** `GET /client/services/:id` and `GET /store/v1/services/:slug` stop leaving out the main-input
field of an IMEI service, and every field item gains `isMainInput: boolean`. The portal's list (`GET /client/services`, `?ids=` included)
carries no fields and does not change. Our Dhru list (`imeiservicelist`) does not change either: the Dhru protocol carries the IMEI in its
own `IMEI` parameter, so the main-input field of an IMEI service stays out of `Requires.Custom`.

**Decision: where the IMEI is read.** On an IMEI service, the portal's `POST /client/orders` and the shop's
`POST /store/v1/checkout-sessions` read the IMEI from `imei` when the request sends it (older shop pages still do), otherwise from the
value sent under the main-input field's key in `inputs` (`typedImeiOf`, `src/modules/orders/domain/main-input.ts`). The request schemas
are kept: an empty or blank `imei` is refused with `422` on `imei` before placement runs, so a sent `imei` always has text and never falls
back to the field (`typedImeiOf` trims and treats a blank `imei` as missing, which matters only for Dhru's `IMEI` parameter and internal
callers). Both are normalised (spaces and dashes removed) and checked the same way, and `INVALID_IMEI` stays the error.
- **Where problems are reported.** When the IMEI came from the field, every problem about it is reported on `inputs.<key>`, where the form
  draws the box: a missing IMEI (`required`, "Enter the IMEI.", also when the field itself is optional), a bad one (`invalid_imei`, with
  `INVALID_IMEI`) and the field's pattern (`invalid_format`). When it came as `imei`, the paths stay as before (`imei`, `imeis.N`).
- **Both sent:** `imei` wins, as before; the value under the field's key never stands in for it and is replaced by it when stored.
- **Neither sent:** with a main-input field, the IMEI is missing on `inputs.<key>`; without one, the request is refused as before on
  `imei` (the portal: `required`; the checkout: `INVALID_IMEI`).
- **Dhru** (`placeimeiorder` and its bulk form) reads only its `IMEI` parameter, as before: its list does not show the main-input field,
  so a Dhru order never reads the IMEI from `CUSTOMFIELD`, and its problems stay on `IMEI`.
- **What is stored does not change.** `orders.imei` (and the checkout session's encrypted IMEI) holds the normalised IMEI, and the
  normalised IMEI is stored under the field's key in `inputs` when the request sent that key. An order whose IMEI was typed into the
  field is therefore the same row as one sent as `imei` with the field's key: the duplicate check of `block_open`, the blocklist match of
  the checkout and the risk screening read the same IMEI, and the dispatch sends it as the `IMEI` parameter and keeps the field out of
  `CUSTOMFIELD` (decision 065). A non-IMEI service is unchanged.
- **Bulk.** `imeis` on `POST /client/orders` stays accepted in this release (older shop pages, and the order of the two deploys); the
  shop no longer sends it. Dhru's bulk is unchanged.

**Consequences.**
- No migration, route, job, queue, cache key or outbox event. The OpenAPI documents are rebuilt (two response fields, descriptions and
  examples).
- The wire of the two reads changes: an older shop page now also draws the main-input field beside its own IMEI box (see the release).
- An order sent as `imei` without the field's key stores no value under that key, so its `answers` (decision 065) have no IMEI row, as
  before; an order whose IMEI was typed into the field has one.
- **Demo data only.** The demo seed (`scripts/seed/catalog.ts`) gives every demo IMEI service the main-input field `imei` (Name `IMEI`,
  label `IMEI`, text, required, no pattern, first in the form), so the demo shop and portal can order them; the Z3X field stays as it was.
  Production gets no migration, by the owner's ruling: staff add the main-input field to its IMEI services. (Replaced by decision 071: the
  import gives every plain IMEI service the field and migration `0071_imei_main_input_field` gives it to the stored ones.)
- Tests: `test/unit/modules/orders/domain/main-input.spec.ts`; the integration files `test/integration/orders/imei-main-input-placement.test.ts`
  (with the bulk list beside the field's key and an idempotency replay of a field-only order) and
  `test/integration/customers/checkout-imei-main-input.test.ts` (new), `test/integration/orders/imei-field-pattern-placement.test.ts`,
  `test/integration/catalog/client-catalog.test.ts`, `test/integration/storefront/storefront-catalog.test.ts`,
  `test/integration/suppliers/dhru-fusion-suppliers.test.ts` (the dispatch of an IMEI typed into the field), and the seed tests
  `test/integration/catalog/catalog-seed.test.ts` and `test/integration/storefront/storefront-seed.test.ts`.

**Release.** The backend first, then the shop right after it. The backend accepts what the shop that runs today sends: its pages still
send `imei` (and `imeis`), which keep working and win over the field. But between the two deploys an old shop page draws its own IMEI box
and, because the reads now list it, the main-input field as well, and its own client check enforces that field like any other (`required`,
and the pattern on the raw text): the buyer has to type the IMEI twice. So the shop is released right after the backend, to keep that window
short. The new shop draws only the fields and sends the IMEI under the main-input field's key. `imeis` can be retired in a later release,
once no shop page sends it.
