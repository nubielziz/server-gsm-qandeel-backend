# 041: Ready-made payment methods with logos

Status: accepted, 2026-11-17 (feature 32, planned by Fable 5.2, built in three slices by Sonnet 5.5 with two Opus reviews and
one fix round each, merged by the lead; plan `docs/briefs/32-payment-method-presets.md`). Builds on decisions 027 (migrations),
035 (routes beyond the map) and 039 (English only). Spec entry B232, console mismatch M266. The number 040 is kept for the
parked plan of feature 31 (bulk publish).

**Context.** A payment method is a row of `payment_gateways` that staff type by hand: a code, a driver name, fees, limits and,
for a manual method, the transfer instructions. On 2026-11-17 the owner asked for the methods the shop really uses to be ready
to switch on, each with its logo, in the shop, the console and the backend: bank transfer, crypto transfer, Vodafone Cash,
Fawry, InstaPay, Binance Pay, NOWPayments and Binance Pay through its merchant API; and anyone with a method of their own must
still be able to add it. Three rulings of the owner the same day: the six manual transfers are built now and the two automatic
ones are listed as "Coming soon" until their connection is built; a manual method tops up a balance only, as before; the logos
are taken from official sources and each source is written down, and a custom method gets a logo that staff upload.

**Decision.**
- **A catalog of ready-made payment methods lives in code** (`src/modules/money/domain/gateway-presets.ts`, `GATEWAY_PRESETS`):
  a key, a name, manual or automatic, whether it can be added yet, the driver name, the top-up method it stands for and a
  template of the transfer details with blanks for the account. Staff add a method from the catalog in one step and fill in
  their own account details. Nothing is inserted into a database by a migration, so every environment starts with no method and
  the same catalog (`GET /admin/payment-gateway-presets`).
- **A method remembers the preset it came from** (`payment_gateways.preset`, a CHECK over the catalog's keys). The preset names
  the logo: each frontend ships the logo files of the catalog, keyed by the preset key. Several methods may come from one preset
  (two bank accounts).
- **A method made from a preset stays what the preset says.** Create refuses an unknown or unavailable preset and a kind or
  driver that is not the preset's (`422` `preset` `unknown` / `unavailable`, `isManual` `preset_kind`, `driver` `preset_driver`);
  a change never moves the preset, and it refuses a kind or driver that is not the preset's with the same two codes. Everything
  else (name, fees, limits, instructions, groups, the switch) stays free. Without this a Vodafone Cash row turned into an
  automatic card gateway would show the Vodafone Cash logo on a card payment.
- **A custom method** (no preset) is added as before and may carry a logo that staff upload (`payment_gateways.logo_file_id`, a
  public picture checked by its bytes as a service picture is, but from 64 pixels on each side, and served at `/store/v1/media/<name>`; `POST` / `DELETE /admin/payment-gateways/:id/logo`).
  An uploaded logo also wins over a preset's. A reader shows, in this order: the uploaded logo, the bundled logo of the preset,
  a plain icon.
- **Money rules do not change.** A manual method tops up a merchant wallet or a store balance through the existing review; the
  ledger, fees, limits, crediting and the checkout are untouched, and a shop order is still paid by an automatic gateway or from
  the store balance. The two automatic entries (NOWPayments, Binance Pay through its merchant API) are in the catalog as **not
  available**: they are shown as "Coming soon" and cannot be added until a driver exists (a later feature writes it, with its own
  plan and money review, and flips the flag).
- **Logos are trademarks of their owners**, used only to name the way of paying. Each bundled file's source and terms are
  written down (the website's `docs/LOGOS.md`, the console's `docs/LOGOS.md`).

**Consequences.**
- Migration `0040_payment_method_presets` is additive (two nullable columns, a CHECK, a foreign key with `ON DELETE SET NULL`
  and its index); the old code runs on the new schema.
- The gateway row of the admin routes, the two top-up method lists (`GET /client/payment-methods`,
  `GET /store/v1/me/wallet/top-up-methods`) and the `paymentMethods` of the shop's config and of a checkout session gain
  `preset: string | null` and `logoUrl: string | null`.
- The file cleanup (`deleteUnreferencedFiles`) knows the new reference, so an uploaded logo is never collected.
- A new ready-made method is one entry in `GATEWAY_PRESETS`, one value in the CHECK (a migration) and one logo file per frontend.
- Known and unchanged: `GET /client/payment-methods` lists an automatic method whose driver has no code (it never looked at the
  driver), and a top-up through it answers `GATEWAY_ERROR`. The catalog cannot create such a row (an unavailable preset is
  refused); only a custom row typed by staff can. The drivers of the two automatic entries will close this for them.

**Out of scope.** The drivers of NOWPayments and Binance Pay's merchant API; PayTabs, PayPal and FawryPay's online gateway
(discussed with the owner on 2026-11-17, not ordered); paying a shop order directly by a manual transfer; new words in the
top-up method vocabulary.
