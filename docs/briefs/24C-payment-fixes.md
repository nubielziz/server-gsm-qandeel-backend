# Feature 24C: Payment provider fixes (ROADMAP phase 4; D3 §6 and §5.7; D6 §7, D-6)

Plan by Fable 5.2 (planner), 2026-11-10, against backend `main` @ `bd32229` **plus the approved plan of feature 21**
(`docs/briefs/21-customer-wallet.md`). Implementer: one Sonnet 5.5, slices A to E. Worktrees (LEAD-DECISIONS §1): backend
`../backend-24c` on `feat/backend-24c`, console `../frontend-admin-24c` on `feat/console-24c`, test database
`gsm_24c_test`, Redis DB 8. **Start only after feature 21 is merged**: 21 owns `payment-webhook.service.ts` and the dispute
code and changes both (customer top-ups, top-up disputes); this feature builds on the merged files and must not undo any of
it. No new route, no migration. Read first: `backend/CLAUDE.md`, `docs/briefs/_common.md` (its frontend-cwd and Serena
lines are stale), `_feature.md`, `CONTRIBUTING.md`, `src/modules/money/README.md`, decisions 019 (secrets), 023 (outbound
HTTP), 024 (ledger); for slice E `frontend-admin/CLAUDE.md`. Paths are backend-relative; `FA/` = the console worktree.

Rules (LEAD-DECISIONS §7): work only in the two worktrees; never run `docker compose`, `db:migrate`, `db:seed`,
`src/main.ts` or `scripts/ci.sh` there; no git command that changes state; no agents; never call a real gateway (tests use
the repo's fake gateway helpers). Targeted tests while developing, `bun run check` once at the end in the foreground.
**This is money code: Fable reviews it again after implementation, before the lead merges.**

## 1. What exists and what is missing

All in `src/modules/money` unless noted. The `card` driver (`infra/gateway-drivers/card-driver.ts`) speaks the Stripe
Checkout protocol and serves gateways whose `driver` is `card` or `stripe` (`drivers.ts`).

| # | Requirement | Status | Evidence (verified in the code) |
|---|---|---|---|
| 1 | Console field for the webhook secret, and a "stored" hint | missing in the console; half in the API | The API takes a write-only `webhookSecret` on create and edit (`contracts/gateways.contracts.ts:72-94`; `application/payment-gateway.service.ts:175,253`) and stores it encrypted (`webhook_secret_enc`, `gateway-credentials.ts`). The row has `secretHint` only (`gateways.contracts.ts:36-40`). The console form has one `secret` field (`FA/src/features/settings/components/GatewayFields.tsx:137-142`, `GatewayDialog.tsx:30,51,75`, `types/gateways.ts:17,41`) |
| 2 | Each Stripe endpoint signs with its own secret; a gateway stores one | missing | `PaymentWebhookVerifier.resolve` verifies with the single `credentials.webhookSecret` (`application/payment-webhook-verifier.ts:42-55`) for both `POST /webhooks/payments/:gateway` and `POST /webhooks/disputes/:gateway`. `PaymentWebhookService.handle` dispatches refund events and payment events only (`payment-webhook.service.ts:71-84`); a dispute event sent to the payments URL is acknowledged and dropped |
| 3 | Refund results | wrong | `parseRefund` accepts only `refund.succeeded` and `refund.failed` (`card-driver.ts:186-204`). Stripe: "Stripe doesn't send a `refund.succeeded` event… receive `refund.updated` and check for `status` set to `succeeded`"; a failure is `refund.failed` (docs through Context7 `/websites/stripe`). A refund whose synchronous answer was `pending` (`jobs/refund-sender.ts:81`, `card-driver.ts:170-177`) stays `processing` forever. `RefundSettlement.settle` moves only a `processing` refund (`application/refund-settlement.ts:59-62`) |
| 4 | Card brand, last 4, fingerprint, 3DS, wallet type | wrong object | `detailsOf(session)` reads `payment_method_details` from the Checkout Session (`card-driver.ts:44-56,116`); that field is on the Charge. So `event.details` is always undefined against the real gateway: the brand line is empty (`domain/b2c-money.ts:169-185`), the fingerprint passed to risk is null (`customers/application/checkout-capture.service.ts:109-119`), Apple Pay and Google Pay are never `wallet`, and 21's `card_fingerprint` on top-ups stays null |
| 5 | Minor units | wrong for 0- and 3-decimal currencies | In: `fromMinorUnits` multiplies by `0.01` whatever the currency (`card-driver.ts:36-41`; used for `amount_total`, dispute `amount` and `fee`). Out: `request.amount.mul(100).toWire().split('.')[0]` truncates and assumes 2 decimals (`:121` checkout, `:161` refund). A 3.500 JOD checkout is sent as `350` (0.350 JOD) and read back as 3.50, so `storefrontMismatch` and `confirmationMismatch` see equal amounts: **the customer pays a tenth** and nothing notices. JPY would be charged ×100 |
| 6 | Wrong shapes in fixtures | exists | `test/support/b2c.ts:236-246` (details on the session), `:312-324` (`refund.succeeded` default), `infra/gateway-drivers/gateway-drivers.spec.ts` (~:100), `test/integration/b2c-refunds.test.ts` (~:573), `test/scenarios/b2c-refund.e2e.test.ts` (~:159): the suite passes against wrong code |
| 7 | Crypto driver | off, stays off | `crypto-driver.ts` needs `apiBase`, which no admin route sets; custom protocol; Jordanian law (ROADMAP). Documented, not changed |

## 2. Design

### 2.1 Decisions

1. **Secrets (item 2): both mechanisms, each small.** (a) A gateway stores up to **two** webhook secrets and a delivery is
   accepted when either verifies: this covers two Stripe endpoints (payments and disputes) and rotation without downtime.
   (b) The payments endpoint also handles dispute events, so **one** Stripe endpoint with one secret is enough and a
   dispute event sent to the "wrong" URL is never silently dropped. Why both: (b) alone leaves rotation unsolved and the
   map's two URLs half-working; (a) alone still loses chargebacks when the owner registers one endpoint for all events.
2. **Card details (item 4):** the driver reads them from the PaymentIntent with its latest Charge, **before** the capture
   transaction. If the read fails the payment is still captured (the money arrived), marked "details unavailable": a
   storefront payment gets a risk signal, a top-up goes to staff review instead of automatic credit.
3. **Amounts (item 5):** one per-currency exponent table for the Stripe protocol, used in both directions; outgoing
   amounts are rounded half-up to what the gateway can charge, never truncated; a charge that had to be rounded is logged,
   and the existing exact mismatch guards then hold it for staff (never hide a difference).
4. All five items are built whatever the owner decides in D-6 (keep Stripe or a local driver): items 1 and 5 are needed
   for any webhook gateway; 2 to 4 are what makes the only automatic card driver correct.

### 2.2 Item 5 first: amounts (`infra/gateway-drivers/stripe-amounts.ts`, new, pure, with a spec)

```ts
export const STRIPE_ZERO_DECIMAL = ['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','VND','VUV','XAF','XOF','XPF'] as const;
export const STRIPE_THREE_DECIMAL = ['BHD','JOD','KWD','OMR','TND'] as const;
/** Two-decimal on the wire but only whole units may be charged (Stripe "special cases"). */
export const STRIPE_WHOLE_UNITS = ['ISK','UGX'] as const;
export function exponentOf(currency: string): 0 | 2 | 3;                       // default 2; case-insensitive
/** The integer the API takes, rounded half-up to the gateway's step; `exact` is false when rounding changed the amount. */
export function toMinor(amount: Money, currency: string): { minor: string; exact: boolean };
/** The 4-decimal amount of an integer in minor units; `null` for anything that is not a safe non-negative integer or has no currency. */
export function fromMinor(minor: unknown, currency: string | null | undefined): string | null;
```
Steps: zero-decimal = 1 unit; two-decimal = 0.01; three-decimal = 0.010 (Stripe requires the last digit of a three-decimal
amount to be 0: `toMinor(Money.of('3.505'), 'JOD')` → `3510`, not exact); `ISK`, `UGX` = whole units sent ×100. Confirm
the three lists against `docs.stripe.com/currencies` (Context7 `/websites/stripe`) when writing the file and cite the page
in the header. Use `Money`/decimal arithmetic only (decision 011: no floats).

`card-driver.ts`: `createCheckout` sends `toMinor(request.amount, request.currency).minor`; `refund` the same with
`request.currency`; when `exact` is false, log a warning (invoice or refund id, currency, asked, charged; no personal
data). `parse` reads `fromMinor(session.amount_total, session.currency)`; `parseDispute` reads `amount` and `fee` with
`dispute.currency`. `fromMinorUnits` is deleted. Nothing else changes in the mismatch guards: they compare the amount the
gateway reports with the amount the payment or invoice was opened for, exactly.

### 2.3 Item 3: refund events (`card-driver.ts`, `application/refund-settlement.ts`)

`parseRefund` maps, with `refund = data.object`:

| Event | `refund.status` | Result |
|---|---|---|
| `refund.updated` (also `charge.refund.updated`, the older name of the same object) | `succeeded` | `succeeded` |
| same | `failed`, `canceled` | `failed` (`failure_reason`, or `canceled`) |
| same | `pending`, `requires_action`, anything else | ignored (`undefined`) |
| `refund.failed` | any | `failed` |
| `refund.created`, `charge.refunded`, `refund.succeeded` | — | ignored (the synchronous answer of the refund call already covers a created refund; Stripe never sends `refund.succeeded`) |

`RefundSettlement`: unchanged rule (only a `processing` refund moves). One addition for Stripe's documented late failure
(a refund that first reports `succeeded` and fails later): when a `failed` event names a refund that is already
`completed`, write a durable trace instead of dropping it: append to `refunds.note` (guarded update, once per gateway
refund id) "The gateway reported on <ISO time> that this refund failed after it was completed: <reason>. Refund the
customer another way." and log at error. No ledger posting is undone automatically (staff decide; recorded in §8). Fix the
comment at `refund-settlement.ts:2`.

### 2.4 Item 4: card details (`driver.ts`, `card-driver.ts`, `payment-webhook.service.ts`)

- `driver.ts`: `PaymentDetails` gains `unavailable?: boolean`. `PaymentGatewayDriver` gains the optional method
  `paymentDetails?(calls: GatewayCalls, credentials: GatewayCredentials, reference: string): Promise<PaymentDetails | undefined>`.
- `card-driver.ts`: `paymentDetails` calls `GET <apiBase>/v1/payment_intents/<reference>?expand[]=latest_charge` (bearer
  key, a 3-second timeout through `gatewayCall`) only for a reference starting `pi_`, and reads
  `latest_charge.payment_method_details.card`: `brand` (the wallet type when `card.wallet.type` is set, else `card.brand`),
  `last4`, `fingerprint`, `wallet` (`card.wallet.type`), `threeDs` = `card.three_d_secure.result` is `authenticated` or
  `attempt_acknowledged`. No card object → `undefined`. `parse` stops reading details from the session (`detailsOf(session)`
  is removed; `details` stays unset in the parsed event).
- `PaymentWebhookService.handle` (21's merged version): for a `confirmed` event of a driver that has `paymentDetails`, read
  the details **before any transaction** (inject `OutboundHttp`, the gateway HTTP policy and `GatewayCredentialsVault` the
  way `jobs/refund-sender.ts` does) and continue with `event = { ...event, details }`. Any error or timeout →
  `details = { unavailable: true }`, a warning log and a counter `gateway_card_details_unavailable_total{gateway}`.
  Never throw: the webhook must still record the payment.
  - Storefront branch (unchanged code path): `captures.capture(tx, { payment, gateway, event })`.
    `customers/application/checkout-capture.service.ts` passes `cardDetailsMissing: event.details?.unavailable === true`
    to `RiskScreening.assess`; `risk/application/risk-screening.ts` (`ScreeningInput.cardDetailsMissing?: boolean`) and
    `risk/domain/risk-scoring.ts` add the signal "Card details unavailable from the gateway" with
    `SIGNAL_POINTS.cardDetailsMissing = 10` (if 10 alone would cross the default hold threshold of `risk-rules`, use the
    largest value that does not: the signal informs, it must not hold by itself).
  - Top-up branch (merchant and, after 21, customer invoices): 21 already writes `card_fingerprint` from
    `event.details`; add: `details.unavailable` on a `card` method → `reviewRequired: true`, `autoCreditAt: null`,
    `reviewNote` "Card details could not be read from the gateway." (joined to a mismatch note when both apply).
- Brand line and method: `paymentFacts` already takes `details`; with real details Apple Pay and Google Pay become `wallet`.

### 2.5 Item 2: secrets and routing

- `application/gateway-credentials.ts`: `webhook_secret_enc` holds either a legacy plain secret or a JSON array of one or
  two strings (same column, same AAD, **no migration**). `read()` returns `webhookSecrets: readonly string[]` (legacy text
  → one entry; `webhookSecret` stays as the first entry for existing callers). `sealWebhookSecrets(list)` writes the array
  (one entry is written as an array too). A value that decrypts but is neither form is treated as a single secret.
- `application/payment-webhook-verifier.ts`: for a driver whose `signingKey` is `webhook_secret`, try each stored secret
  in order; the first that verifies wins; when none does, rethrow the first refusal (`WEBHOOK_SIGNATURE_INVALID`). No
  secret at all: today's answer. The 5-minute window and the event-id replay filter are untouched.
- `PaymentWebhookService.handle`: after the refund dispatch and before `driver.parse`, `if (driver.parseDispute?.(body))
  return this.disputes.handle(gatewayCode, body)` (inject 21's `DisputeWebhookService`; it is idempotent per gateway
  dispute id, so the same event arriving on both URLs is recorded once). `POST /webhooks/disputes/:gateway` stays as it is.
- Admin API (`contracts/gateways.contracts.ts`, `application/payment-gateway.service.ts`, `domain/gateway-rules.ts`): §3.

### 2.6 Fixtures and docs

Fix the five fixture places of row 6 to real shapes: details on `latest_charge.payment_method_details` served by the fake
gateway's `GET /v1/payment_intents/:id` (with a switch to make it fail or time out), refund results as `refund.updated`
with a `status`, amounts built with `toMinor`. Update `src/modules/money/README.md` (webhook setup: one endpoint with all
events is enough, two secrets, rotation steps; the amounts table; refund events; the crypto driver is off and why),
`docs/contract/endpoints` through `bun run contract:docs`, and `docs/queues.md` only if the refund job text mentions
`refund.succeeded`.

## 3. Database and API

No migration, no new route, no map-addition row, no new error code, permission or audit word.

**`GET /admin/payment-gateways`, `GET /:id`, `POST`, `PATCH /:id`** (existing permissions and CSRF; additive):

| Change | Field | Rule |
|---|---|---|
| response | `webhookSecretHint: string \| null` | `••••` + last 4 of the first stored webhook secret; `null` when none. Optional in the schema, always sent |
| response | `secondaryWebhookSecretHint: string \| null` | the same for the second |
| request (`POST`, `PATCH`) | `webhookSecret?: string` (exists) | write-only; replaces the **first** secret and keeps the second |
| request (`POST`, `PATCH`) | `secondaryWebhookSecret?: string \| null` | write-only; a string sets the second secret (trimmed, 1 to 500 characters), `null` removes it; refused with `422` on `secondaryWebhookSecret` when the gateway has no first secret and none is sent |

Audit: the existing phrase of a gateway change; "secret changed" is true when any of the three secrets was sent; values
are never recorded. Rotation as staff do it: put the new Stripe secret in "second", roll the endpoint at Stripe, then save
the new one as the first and remove the second.

**`POST /webhooks/payments/:gateway`**: same contract; it now also handles dispute events (answer `{ received: true }`,
`duplicate` as the dispute handler says) and accepts a delivery signed with either stored secret.
**`POST /webhooks/disputes/:gateway`**: same contract; either secret.

Regenerate `bun run docs:openapi` and `bun run contract:docs`.

## 4. Admin console (`FA/`, slice E; fetch through `src/lib/api`, components ≤ ~200 lines, mocks updated)

- `src/features/settings/types/gateways.ts`: gateway type gains `webhookSecretHint?: string | null`,
  `secondaryWebhookSecretHint?: string | null`; create and update bodies gain `webhookSecret?: string`,
  `secondaryWebhookSecret?: string | null`.
- `components/GatewayFields.tsx`: under the API secret, for a gateway that is not manual: "Webhook signing secret"
  (password input; hint "Stored (••••abcd). Write-only: type a new one to replace it, or leave empty to keep it." or "None
  stored: the gateway's confirmations are refused until one is set.") and "Second webhook secret (optional)" with the
  help text "For a second endpoint or while rotating the secret." and a "Remove" control when one is stored. Show the
  webhook path to register at the provider: `/webhooks/payments/<code>` (text to copy). If the file passes ~200 lines,
  move the three secret fields into `GatewaySecretFields.tsx`.
- `components/GatewayDialog.tsx`: add the two fields to the form state; send `webhookSecret` only when typed,
  `secondaryWebhookSecret` when typed or `null` when removed (same pattern as `secret`, `:51,:75`).
- Mocks (`mocks/` of the settings feature: gateway dto and routes): store the two secrets, answer the hints, the `422`.
  Tests beside the dialog and fields. Feature `HANDOFF.md`: the new assumed contract fields.
- After the console merge the backend lead runs `contract:extract && contract:docs` (no new route, so no extraction record).

## 5. Risks and how the design closes them

| Area | Risk | Closure |
|---|---|---|
| Financial | Under- or overcharge by a power of ten | one exponent table, both directions, spec with every listed currency and JOD 3.500 → `3500` → `3.5000`; the mismatch guards stay exact, so any remaining difference holds the payment |
| Financial | Rounding hides a difference between shown and charged | rounding is logged and never fed into the comparison; the guards hold the payment for staff. Prevention is configuration (§8, decision 2) |
| Financial | A refund marked completed fails later at the gateway | a durable note on the refund and an error log; no silent loss; staff refund another way |
| Financial | A dispute event is processed twice (both URLs) or not at all (one URL) | the dispute handler is idempotent per gateway dispute id; the payments endpoint now dispatches it |
| Financial | The webhook answers slowly or fails because the details call hangs | the call is outside the transaction with a 3 s timeout and never throws; capture proceeds without details |
| Financial | A capture without details skips the card blocklist | storefront: a risk signal; top-up: staff review instead of automatic credit |
| Security | A second secret widens what is accepted | at most two, both staff-set and encrypted (decision 019); every acceptance still needs a valid signature inside the time window and passes the replay filter |
| Security | Secrets leak through the API, logs or audit | hints only (last 4); write-only fields; audit records "changed" only; the details call logs no card data beyond brand and last 4 |
| Security | The details call is aimed at an internal address | it goes through `gatewayCall` with the gateway HTTP policy (decision 023), like every driver call |
| Concurrency | Two deliveries of one confirmation both read details | reads are idempotent; the payment row lock and the unique gateway transaction id still make one capture |
| Compatibility | Existing gateways with one stored secret | read as a one-entry list; nothing to migrate; `webhookSecret` keeps its meaning |
| Compatibility | Feature 21's webhook and dispute changes are undone | this plan only adds: one pre-transaction read, one dispatch line, one review rule; 21's tests must pass unchanged |
| Performance | One extra gateway call per confirmed payment | bounded by the timeout; duplicates are dropped earlier by the replay filter |

## 6. Slices (in order; each ends with its targeted tests green)

**A. Amounts (small, first: it is the live money bug).** Create `infra/gateway-drivers/stripe-amounts.ts` (+ spec); edit
`card-driver.ts`; fix the amount helpers of `test/support/b2c.ts`. Acceptance: the cases of §7; a JOD checkout of 3.500 is
sent as `3500` and confirmed as `3.5000`.

**B. Refund events (small).** `card-driver.ts` (`parseRefund`), `application/refund-settlement.ts`, the refund fixtures
and tests. Acceptance: a `pending` refund completes on `refund.updated` + `succeeded`; fails on `refund.failed` or
`failed`/`canceled`; `pending` changes nothing; a late failure leaves the note.

**C. Card details (medium).** `driver.ts`, `card-driver.ts`, `application/payment-webhook.service.ts`,
`customers/application/checkout-capture.service.ts` (one argument), `risk/application/risk-screening.ts`,
`risk/domain/risk-scoring.ts` (+ spec), the fake gateway in `test/support/b2c.ts`. Acceptance: brand, last 4, fingerprint,
3DS and wallet reach the payment row and risk; a failed read still captures, with the signal or the review flag.

**D. Secrets and routing (medium).** `application/gateway-credentials.ts`, `payment-webhook-verifier.ts`,
`payment-webhook.service.ts` (dispute dispatch), `contracts/gateways.contracts.ts`, `payment-gateway.service.ts`,
`domain/gateway-rules.ts`, README. Acceptance: §3; a delivery signed with either secret passes, with neither fails; a
dispute event on the payments URL is recorded once.

**E. Console (small, in `../frontend-admin-24c`).** §4. Acceptance: both secrets can be set, replaced and (the second)
removed; hints show; `npm run typecheck && npm run lint && npm run build && npm test` green.

Finish (backend): `bun run docs:openapi`, `bun run contract:docs`, `bun run format`, `bun run check` (foreground).
Report: files by folder, the spec decisions of §8, anything in 21's merged code that differs from this plan's assumptions.

## 7. Tests

| File | Covers |
|---|---|
| `infra/gateway-drivers/stripe-amounts.spec.ts` (new) | `exponentOf` for every listed currency and a default; `toMinor`: USD 10.99 → `1099`, 10.995 → `1100` not exact, JPY 500 → `500`, JOD 3.500 → `3500` exact, 3.505 → `3510` not exact, ISK 5 → `500`, 5.4 → `500` not exact; `fromMinor` round trips; negative, fractional, unsafe and non-number inputs → `null` |
| `infra/gateway-drivers/gateway-drivers.spec.ts` (fix and extend) | checkout and refund forms carry the right minor units per currency; `parse` reads `amount_total` with the session currency and no details; `parseRefund` table of §2.3; `parseDispute` amounts in JOD and JPY; `paymentDetails`: card, Apple Pay wallet, 3DS results, a non-`pi_` reference, no charge |
| `test/integration/b2c-payments.test.ts` (or the existing capture test; extend) | a JOD and a JPY checkout end to end with the fake gateway: the order is created at the right amount; a confirmation with a tenth of the amount is a mismatch and holds; details from the PaymentIntent land on the payment row and in the risk assessment; the details call failing or timing out still captures with the signal "Card details unavailable from the gateway" |
| `test/integration/billing-topups.test.ts` (or the existing top-up webhook test; extend) | a card top-up stores the fingerprint; unavailable details → `review_required`, no auto credit, the note |
| `test/integration/b2c-refunds.test.ts`, `test/scenarios/b2c-refund.e2e.test.ts` (fix) | refund results through `refund.updated`; `pending` ignored; late failure note; an old send attempt's failure still ignored |
| `test/integration/payment-webhook-secrets.test.ts` (new) | legacy single secret still verifies; first or second secret verifies on both URLs; neither → `400 WEBHOOK_SIGNATURE_INVALID`; replacing the first keeps the second; `null` removes the second; `422` without a first; hints in list and show; audit row without values |
| `test/integration/b2c-disputes.test.ts` (extend; plus 21's top-up dispute test) | a `charge.dispute.created` and `.closed` sent to `/webhooks/payments/:gateway` are handled exactly as on the disputes URL; the same event on both URLs records one dispute |
| `src/modules/risk/domain/risk-scoring.spec.ts` (extend) | the new signal and its points; alone it does not hold |
| Feature 21's suites | pass unchanged |
| Console | fields, hints, changed-only body, remove, the server's `422` under the field, mocks |

## 8. Decisions

Owner decisions:
1. **D-6 stays open** (keep Stripe through a foreign entity, or build a local gateway driver). Nothing here depends on it;
   a local driver would reuse the secret list, the amounts discipline and the details hook.
2. **Default taken:** currencies the gateway charges in steps coarser than the shop shows (the three-decimal ones: JOD,
   KWD, BHD, OMR, TND) should be configured with 2 display decimals in `currencies`, so shown and charged amounts are
   always equal; otherwise an odd last digit is rounded at the gateway and the payment is held for staff. The owner sets
   this in the console's currencies page; no code forces it.
3. **Default taken:** a top-up whose card details cannot be read waits for staff review instead of crediting itself.
4. The crypto driver stays off (no admin field sets its address; licence question).

Spec decisions for the lead's B-entries: (a) Stripe-protocol amounts use a per-currency exponent table in both
directions, rounding half-up, never truncating; (b) refund results come from `refund.updated` by status and
`refund.failed`; `refund.succeeded` is not an event; a late failure of a completed refund is noted on the refund, not
reversed; (c) card details are read from the PaymentIntent's latest Charge before capture; unavailable details add a risk
signal (storefront) or force review (top-up); (d) a gateway keeps up to two webhook secrets in the existing encrypted
column; `webhookSecretHint`, `secondaryWebhookSecretHint`, `secondaryWebhookSecret` on the gateway wire; (e) the payments
webhook also handles dispute events.

Out of scope, recorded: gateway health checks (B168); a payment mismatch settled by hand that skips `gateway_clearing`
(PROGRESS known gap); automatic handling of a late refund failure (re-open and re-send); passing the card's country and
funding type to risk (the inputs exist, `cardCountry`, `prepaidCard`, but turning them on changes who gets held: an owner
decision); dispute fees (the driver reads `dispute.fee`; Stripe reports fees in `balance_transactions`: check when a real
account exists); an admin field for `apiBase`; manual gateways in the checkout list (D3 §5.3).

## 9. Storefront handoff

None for the wire: no store or client route changes. Visible effects: a card payment's receipt and order show the real
card brand and last 4 (and "Apple Pay"/"Google Pay" as a wallet payment); prices in three-decimal currencies are charged
correctly. If the shop lists JOD, expect two display decimals (decision 2).

## 10. Review against the code, and approval

Checked in the code: every line of `card-driver.ts`; the driver interface in `driver.ts` and `driverFor`;
`PaymentWebhookService.handle` and `handleStorefront`; `PaymentWebhookVerifier`; `GatewayCredentialsVault`;
`gateways.contracts.ts` and the secret handling of `payment-gateway.service.ts` (`hasWebhookSecret`, `secretHintOf`);
`RefundSettlement.settle` and the refund job's driver call; `DisputeWebhookService.handle`; `storefrontMismatch`,
`confirmationMismatch`, `paymentFacts`; the capture's risk call and the risk scoring inputs; the wrong fixtures; the
console's gateway types, dialog and fields; and the parts of the approved plan 21 that touch these files (§5.6.5 webhook
branch and `card_fingerprint`, §5.6.9 top-up disputes, its "Out" list naming exactly these five defects). Stripe
behaviour was checked through Context7 (`/websites/stripe`): no `refund.succeeded` event, `refund.updated` with
`status`, `refund.failed`, a refund that starts `succeeded` and fails later, zero-decimal and special-case currencies
(`docs.stripe.com/currencies`). Not re-read there and to confirm when writing the code: the exact zero- and three-decimal
lists and the last-digit rule (the table in §2.2 follows D3 §6.5 and Stripe's currencies page), and the Charge's
`payment_method_details.card` field names.

Depends on unmerged work: the line numbers and helper names inside `payment-webhook.service.ts` and
`dispute-webhook.service.ts` will be 21's; follow the merged code. No lead decision conflicts with the design.

**Approved by Fable 5.2**
