# Feature 32: ready-made payment methods with logos (and a logo for a custom one)

Written by Fable 5.2 (lead and planner), 2026-11-17, against backend `main` @ `91dc5a6`, console `main` @ `b9d8ded`, website
`main` @ `9d373d6`. Owner request (2026-11-17): have these payment methods ready to switch on, each with its logo, shown in the
shop, the console and the backend: **bank transfer, crypto transfer, Vodafone Cash, Fawry, InstaPay, Binance Pay, NOWPayments,
Auto Binance Pay**; and anyone with a method of their own can still add it. The owner's three decisions (asked the same day):
(1) the six manual transfers are built now; **NOWPayments and Auto Binance Pay are listed with their logo as "Coming soon"**
until their connection is built as a later feature; (2) a manual method tops up a balance only, as today (a shop order is paid
by an automatic gateway or from the store balance: nothing changes in the order engine); (3) the lead fetches the logos from
official sources and writes each source down; a custom method gets a logo that staff upload.

Read first: `backend/CLAUDE.md`, `docs/briefs/_common.md`; console slice also `frontend-admin/CLAUDE.md`; website slice
`storefront/CLAUDE.md` and the Next 16.4 guides in `node_modules/next/dist/docs/`. Paths are backend-relative; `FA/` = the
console worktree, `SF/` = the website worktree. No agent commits, runs git that changes state, spawns agents, or touches the
databases `gsm` and `gsm_storefront`.

## 1. What exists (verified in the code on 2026-11-17)

| # | Fact | Evidence |
|---|---|---|
| 1 | A payment method is a row of `payment_gateways` (code, driver, name, audience `b2b`/`b2c`/`both`, fees, limits, `is_manual`, `instructions`, `hold_hours`, `is_active`). Staff manage them with five routes under `/admin/payment-gateways`, permission `payments:gateways`. The create body is a `z.object` (unknown keys are stripped) | `money/db/schema.ts` (`paymentGateways`), `money/contracts/gateways.contracts.ts:89,133-235` |
| 2 | A **manual** method needs no code: the payer sees `instructions`, uploads a receipt, staff approve. Its driver name is free text; `topupMethodOf(driver, isManual)` maps it to the top-up vocabulary (`bank`, `card`, `usdt`, `wise`) and an unknown manual driver is `bank`. Code behind a driver exists only for `card`/`stripe` and `crypto`/`usdt` (`driverFor`), and every reader checks `isManual` before asking for a driver | `money/domain/gateway-rules.ts:120-149`, `money/infra/gateway-drivers/drivers.ts` |
| 3 | Who is offered what: a merchant's top-up (`GET /client/payment-methods`) and a customer's balance top-up (`GET /store/v1/me/wallet/top-up-methods`) list manual methods (and automatic ones with a driver); the shop checkout (`paymentMethods` of `GET /store/v1/config` and of a checkout session) lists **only** automatic gateways with a driver. Both top-up lists answer the same `PaymentMethodSchema` built by `paymentMethodToWire` | `money/application/billing-wire.ts:196-216`, `customer-top-ups.ts:73-74`, `storefront-money.ts:153-172`, `money/contracts/customer-topups.contracts.ts:61-90` |
| 4 | Public pictures already exist: `PublicImages.store(db, { bytes, filename, staffId })` checks and cleans a JPEG, PNG or WebP (at most 2 MiB), stores it once under its SHA-256 and answers `{ fileId, name }`; it is served at `/store/v1/media/<name>`. The listing picture routes (`POST`/`DELETE /admin/service-listings/:id/image`) are the model: multipart part `file`, the `422` codes on `file`, an audit row either way | `platform/files/public-images.ts`, `storefront/application/listing-admin.service.ts:392-450`, `storefront/controllers/listings.controller.ts` |
| 5 | `payment_gateways` is a map table: a new column is listed in `ADDITIONS` of `test/schema/structure.test.ts`; a foreign key needs its own index; an upper-case array exported from a schema file must be the value list of a CHECK | `test/schema/structure.test.ts` |
| 6 | The owner's database `gsm` holds **no** payment method today; the demo database holds five (card, crypto, bank, wise, a manual `cliq-e2e`) | read-only query, 2026-11-17 |
| 7 | Console: the methods live in Settings, `FA/src/features/settings/components/{PaymentsTab,PaymentDialogs,GatewayDialog}.tsx`, API `api/gateways.ts`, types `types/gateways.ts`, mocks `mocks/gatewayRoutes.ts`. The listing picture field (`FA/src/features/storefront/components/ListingImageField.tsx`) is the upload pattern | grep of 2026-11-17 |
| 8 | Website: a customer picks a method in `SF/components/wallet/top-up-form.tsx` (page `app/en/account/wallet/add-funds`), a merchant in `SF/components/merchant/top-up-form.tsx` (page `app/en/(portal)/merchant/wallet/top-up`); the checkout lists automatic methods in `SF/components/checkout/session-view.tsx`. Brand pictures are files under `SF/public/images/` whose sources are written in `SF/docs/LOGOS.md`; a missing file shows a plain fallback; UI icons come from `lucide-react` | grep of 2026-11-17; `SF/CLAUDE.md` |
| 9 | Next numbers on `main`: migration **0040**, spec entry **B232**, `scripts/map-additions/32.mjs`, console mismatch **M266**, decision **041** (040 is named by the parked plan of feature 31, whose branch also holds migrations 0040 and 0041: it renumbers when it resumes) | `drizzle/meta/_journal.json`, `docs/contract/lead-decisions.json`, `PROGRESS.md` |

## 2. Decision 041 (text for `docs/decisions/041-payment-method-presets.md`; the lead writes the file)

- **A catalog of ready-made payment methods lives in code** (`money/domain/gateway-presets.ts`): a key, a name, manual or
  automatic, whether it can be added yet, the driver name and the top-up method it stands for, and a template of the transfer
  details. Staff add a method from the catalog in one step and fill in their own account details; nothing is inserted into a
  database by a migration, so every environment starts with no method and the same catalog.
- **A method remembers the preset it came from** (`payment_gateways.preset`). The preset names the logo: each frontend ships the
  logo files of the catalog, keyed by the preset key. **A custom method** (no preset) may carry a logo that staff upload
  (`payment_gateways.logo_file_id`, a public picture); an uploaded logo also wins over a preset's.
- **Money rules do not change.** A manual method tops up a merchant wallet or a store balance through the existing review; the
  ledger, fees, limits, crediting and the checkout are untouched. The two automatic entries (NOWPayments, Binance Pay through
  its merchant API) are in the catalog as **not available**: they are shown as "Coming soon" and cannot be added until a driver
  exists (a later feature writes it and flips the flag).
- Logos are trademarks of their owners, used to name the way of paying; each file's source and terms are written down
  (`SF/docs/LOGOS.md`, the console's `docs/LOGOS.md`).

## 3. The catalog (exact; `GATEWAY_PRESETS`, in this order)

| key | name | kind | available | driver | top-up method | logo file |
|---|---|---|---|---|---|---|
| `bank_transfer` | Bank transfer | manual | yes | `bank_transfer` | `bank` | none (a bank icon) |
| `crypto_transfer` | Crypto transfer | manual | yes | `crypto_transfer` | `usdt` | none (a coin icon) |
| `vodafone_cash` | Vodafone Cash | manual | yes | `vodafone_cash` | `bank` | `vodafone_cash.png` |
| `fawry_transfer` | Fawry | manual | yes | `fawry_transfer` | `bank` | `fawry_transfer.png` |
| `instapay` | InstaPay | manual | yes | `instapay` | `bank` | `instapay.png` |
| `binance_pay` | Binance Pay | manual | yes | `binance_pay` | `usdt` | `binance_pay.png` |
| `nowpayments` | NOWPayments | automatic | **no** | `nowpayments` | `usdt` | `nowpayments.png` |
| `binance_pay_auto` | Binance Pay (automatic) | automatic | **no** | `binance_pay_auto` | `usdt` | `binance_pay.png` |

`METHOD_BY_NAME` of `gateway-rules.ts` gains the four `usdt` drivers above; the `bank` ones already fall to `bank` as manual
methods. None of these names is in `DRIVERS`, so `driverFor` answers `undefined` for all of them. The instruction templates are
plain English sentences with a blank for the account, for example Vodafone Cash: `Send the amount to the Vodafone Cash number
________ and upload a screenshot of the transfer. Write your top-up number in the note.`; bank transfer: `Bank: ________,
account name: ________, IBAN: ________. Write your top-up number as the reference and upload the receipt.`; crypto transfer:
`Send USDT on the ________ network to the address ________ and upload a screenshot with the transaction hash.`; Fawry, InstaPay
and Binance Pay (Pay ID) in the same form. The implementer writes all six in that style; an automatic preset has none.

## 4. Data (migration `0040_payment_method_presets`, additive)

`payment_gateways` gains `preset text NULL` with CHECK `payment_gateways_preset_check` (`preset IS NULL OR preset IN (<the
eight keys>)`, the exported list `GATEWAY_PRESET_KEYS`) and `logo_file_id bigint NULL REFERENCES files(id) ON DELETE SET NULL`
with the index `payment_gateways_logo_file_id_idx`. Both go into `ADDITIONS` of the structure test. Generated by
`bun run db:generate`; the old code runs on the new schema (additive).

## 5. The wire (exact)

- **New, beyond the map (`scripts/map-additions/32.mjs`, spec B232, permission `payments:gateways`, module `money`):**
  - `GET /admin/payment-gateway-presets` -> `200`, the array of the catalog in its order (the shape of a small fixed list,
    as `GET /admin/permissions` answers): `{ key, name, kind: 'manual' | 'automatic', available: boolean, driver, methodType:
    'bank' | 'card' | 'usdt' | 'wise', instructions }`.
  - `POST /admin/payment-gateways/:id/logo` (multipart, one part `file`; the checks, sizes and `422` codes of the listing
    picture, `413` over 2 MiB) -> `200`, the gateway row. `DELETE /admin/payment-gateways/:id/logo` -> `204` (also when there
    was none). Each writes an audit row (`uploaded logo for` / `removed logo of`, the entity type and label the gateway routes
    use). `404` for an unknown gateway.
- **Changed:**
  - `POST /admin/payment-gateways` takes an optional `preset`. With it: the key must be known (`422` `preset` `unknown`) and
    available (`422` `preset` `unavailable`), `isManual` must be the preset's kind (`422` `isManual` `preset_kind`) and
    `driver` the preset's driver (`422` `driver` `preset_driver`). `PATCH` does not change a preset (the key is stripped).
    Several methods may come from one preset (two bank accounts).
  - The gateway row of the five admin routes gains `preset: string | null` and `logoUrl: string | null` (the uploaded logo's
    public path `/store/v1/media/<name>`, `null` when none).
  - `PaymentMethodSchema` (`GET /client/payment-methods`, `GET /store/v1/me/wallet/top-up-methods`) and the items of
    `paymentMethods` (`GET /store/v1/config`, the checkout session) gain the same two keys.
- No new error code, queue, job or cache key. A reader shows, in this order: `logoUrl`, else the bundled logo of `preset`,
  else a generic icon by `methodType` (bank or coin) or by kind.

## 6. Console (slice C; `FA/src/features/settings`)

- API `listGatewayPresets()`, `uploadGatewayLogo(id, body)`, `removeGatewayLogo(id)` (each with `@route` and "backend addition,
  B232"), types with the two new keys and `preset` in the create body, mocks for the three routes (the catalog as fixed data;
  the logo routes play the server's refusals), hooks.
- `PaymentsTab`: a section **"Ready-made methods"** above the table: one card per catalog entry with its logo, name and a
  Manual or Automatic tag. An available one has **Add**, which opens `GatewayDialog` filled from the preset (name, a free code
  made from the key, the driver, manual, the instructions template) for staff to complete; an unavailable one shows
  **Coming soon** and cannot be added. A method already made from a preset is counted on its card ("1 added"). The table shows
  each method's logo beside its name.
- `GatewayDialog` (edit mode): a **Logo** field like the listing picture field (upload, replace, remove, the server's refusal
  under it). A custom method (no preset) is added as today with **Add custom method**.
- Bundled logos: `FA/src/assets/payment-logos/<file>` (the files of section 3; the lead adds them) through one component
  `PaymentMethodLogo` (the order of section 5; a missing file falls back to the icon). `docs/LOGOS.md`, `docs/MISMATCHES.md`
  (M266), `docs/ASSUMED_CONTRACTS.md`, the settings `HANDOFF.md`.
- Tests: the gallery (add from a preset sends `preset`, the dialog is prefilled, coming soon cannot be added), the logo field,
  the table logo, the API functions. Acceptance: the four console commands.

## 7. Website (slice S)

- `npm run gen:api` against the backend branch's `docs/contract/openapi.json`; types in `lib/api/types.ts`.
- One component `components/ui/payment-method-logo.tsx` (the order of section 5; an `<img>` with the method's name as its
  alternative text; a missing bundled file shows the icon: `Landmark` for a bank transfer, a coin icon for crypto, a card icon
  for a card) used in the customer's `components/wallet/top-up-form.tsx`, the merchant's `components/merchant/top-up-form.tsx`
  and the checkout's `components/checkout/session-view.tsx`.
- Bundled logos: `SF/public/images/payments/<file>` (the lead adds them and their lines in `docs/LOGOS.md`); the list of
  existing files is read the way the brand logos are (no file read while rendering).
- No URL, text or behaviour changes besides the logo. Unit tests for the component and the two forms; the e2e specs that name
  a method keep passing (the lead runs the affected specs and the full e2e). Acceptance: `npm run typecheck && npm run lint &&
  npm run test`.

## 8. Backend (slice B; module `money`)

`db/schema.ts` (the two columns, `GATEWAY_PRESET_KEYS`), `domain/gateway-presets.ts` (+ spec: the catalog, `presetOf(key)`,
`presetProblems(input)`), `domain/gateway-rules.ts` (`METHOD_BY_NAME`), `contracts/gateways.contracts.ts` (the catalog route,
the two logo routes, `preset` in the create body, the two keys in the row), `contracts/billing-portal.contracts.ts` and
`customer-topups.contracts.ts` (`PaymentMethodSchema`), the storefront config and checkout method item, `application/payment-gateway.service.ts`
(create with a preset; `uploadLogo`, `removeLogo` through `PublicImages`, audited), `billing-wire.ts`, `storefront-money.ts`,
`controllers/gateways.controller.ts`, `infra/gateway.repository.ts`, the module's `README.md`, `scripts/map-additions/32.mjs`,
`scripts/module-map.mjs` if needed, `test/schema/structure.test.ts`, the generated documents (`routes:build`, `contract:docs`,
`docs:openapi`, `coverage:build`), seeds unchanged.
Tests: `gateway-presets.spec.ts`; `test/integration/payment-gateway-presets.test.ts` (the catalog route and its permission;
create from each available preset; the four `422`s; two methods from one preset; a preset is not changed by `PATCH`; logo
upload, replace and remove with their audit rows and `422`/`413`/`404`; the two keys on the admin row, on
`/client/payment-methods`, on `/store/v1/me/wallet/top-up-methods` and on the config's `paymentMethods`; a merchant top-up
through a Vodafone Cash method still credits by the existing review, method `bank`, and one through Binance Pay reads `usdt`).
The existing gateway, billing, top-up and webhook suites pass unchanged. Acceptance: `bun run format`, then `bun run check`
(the shape parity against the console's `main` only reports the two keys the console does not declare yet).

## 9. Slices, reviews, the lead's steps

Three slices, one agent each (Sonnet), at the same time, each in its own worktree: **B** `../backend-32` (`gsm_32_test`, Redis
DB 11), **C** `../frontend-admin-32`, **S** `../storefront-32`. Reviews (Opus): the backend (the upload, the permissions, the
`422`s, "money rules do not change"), then the two frontends together against section 5. The lead: fetches the five logo files
(official sources, written down), the paired check (`FRONTEND_DIR=../frontend-admin-32`; the website's `gen:api` and check),
migrates `gsm_storefront` then `gsm` (additive), merges backend, console, website (one commit each), runs the checks on the
mains and the website's e2e, writes decision 041 and the records, and tries the flow by hand on the isolated API (add Vodafone
Cash from the gallery, top up a store balance with it, approve it). **Nothing is added to the owner's `gsm` by the lead**: the
owner adds each method with their own account details.

## 10. Out of scope

The drivers of NOWPayments and Binance Pay's merchant API (a later feature: each needs its own plan and money review); PayTabs,
PayPal and FawryPay's online gateway (discussed with the owner on 2026-11-17, not ordered); paying a shop order directly by a
manual transfer; new words in the top-up method vocabulary; a logo for the catalog entries chosen by staff (a custom logo
overrides it per method, which is enough).
