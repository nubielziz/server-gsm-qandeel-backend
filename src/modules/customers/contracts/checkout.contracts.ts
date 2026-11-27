// Route contracts of the storefront checkout (map domain I, stage 14): open a session, read it, record consents. Paying is feature 16.
// The console has no screen for them (the storefront is another frontend): the shapes follow ALIGNMENT § 7 and RULES customers 6
// (amounts are USD with the locked rate and currency) and are written up in the module README.
import { z } from 'zod';
import { defineRoute, zDecimal, zId, zIsoDateTime, zMoney } from '../../../common/contract';
import { SERVICE_TYPES } from '../../catalog';
import { MAX_INPUT_LENGTH, MAX_RAW_INPUT_LENGTH } from '../../orders';
import { zCountryCode, zCurrencyCode } from '../../storefront';
import { CHECKOUT_SESSION_STATUSES, CONSENT_PURPOSES } from '../db/schema';

const AmountsSchema = z.object({ net: zMoney, tax: zMoney, gross: zMoney.describe('`net` plus `tax`.') });

const UtmSchema = z
  .object({
    source: z.string().trim().max(100).optional(),
    medium: z.string().trim().max(100).optional(),
    campaign: z.string().trim().max(100).optional(),
    term: z.string().trim().max(100).optional(),
    content: z.string().trim().max(100).optional(),
  })
  .describe('Where the buyer came from.');

const OpenBody = z.object({
  serviceId: zId.describe('The service page the buyer is on (`id` of `GET /store/v1/services`).'),
  email: z
    .string()
    .trim()
    .max(254, 'Too long.')
    .pipe(z.email('Enter a valid email address.'))
    .transform((value) => value.toLowerCase())
    .describe(
      'Where the receipt and the tracking link go; signed out, the email names the guest record of the buyer (never the login account of that email).',
    ),
  country: zCountryCode.describe(
    "The buyer's country: the tax of its window is locked on the session. While the shop has a tax window in force, it must be a country that has one (the `taxRates` of `GET /store/v1/config`).",
  ),
  region: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe(
      "The buyer's region, for the countries that tax by region: while the `country` has a regional window in force (a `taxRates` row of `GET /store/v1/config` with a `region`), it must be one of those regions, in any case.",
    ),
  currency: zCurrencyCode
    .optional()
    .describe('The currency to pay in (one `GET /store/v1/config` lists). Default: USD.'),
  quantity: z.number().int().min(1).max(100_000).optional().describe("Defaults to the service's minimum."),
  imei: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'The main input of an IMEI service, from older shop pages: the value of its main-input field (it wins over a value sent under ' +
        "that field's key; a service without such a field takes it as sent). The shop now types it into the field (`inputs`).",
    ),
  inputs: z
    .record(z.string().min(1).max(60), z.string().max(MAX_RAW_INPUT_LENGTH))
    .optional()
    .describe(
      "The values of the service's order fields by field key (`GET /store/v1/services/:slug`), each judged by its field's type, " +
        "required tick and pattern and stored in its type's form (an `imei` as digits, an `imei_bulk` list one IMEI per line; " +
        `decisions 073 and 076). At most ${MAX_RAW_INPUT_LENGTH} characters as sent; the stored form at most ${MAX_INPUT_LENGTH} ` +
        '(`too_long` on `inputs.<key>`; an `imei_bulk` list of more than 30 IMEIs is `too_many_imeis` first).',
    ),
  utm: UtmSchema.optional(),
});

/** The session as the buyer reads it, when it opens and later. */
export const CheckoutSessionSchema = z.object({
  token: z.string().describe('The capability token of this checkout: the whole credential of its routes.'),
  status: z
    .enum(CHECKOUT_SESSION_STATUSES)
    .describe('`open` until paid; `expired` once `expiresAt` has passed unpaid.'),
  expiresAt: zIsoDateTime,
  createdAt: zIsoDateTime,
  service: z.object({ id: zId, name: z.string(), type: z.enum(SERVICE_TYPES), deliveryTime: z.string() }),
  quantity: z.number().int().min(1),
  imei: z
    .string()
    .nullable()
    .describe(
      'The main input of an IMEI service (usually its IMEI) with all but its last four characters hidden; a list of IMEIs (a main ' +
        'input of type `imei_bulk`, decision 076) shows its first IMEI so, then ` +N more` for the others (`•••••••••••0861 +2 more`; a ' +
        'one-item list reads like one IMEI). null for another service or none.',
    ),
  email: z.string().describe("The buyer's address with most of it hidden."),
  country: z.string().nullable().describe('The country the tax was locked for.'),
  currency: z.string().describe('The currency the buyer pays in.'),
  fxRate: zDecimal.describe('Units of the currency per 1 USD, locked on the session (8 decimals).'),
  taxRate: zDecimal.describe('The locked tax rate in percent.'),
  amounts: z.object({
    usd: AmountsSchema.describe('What the session stores, in USD.'),
    display: AmountsSchema.describe("The same in the buyer's currency: the gross is what is charged."),
  }),
  consent: z.object({
    required: z.array(z.enum(CONSENT_PURPOSES)).describe('What must be granted before payment.'),
    granted: z.array(z.enum(CONSENT_PURPOSES)).describe('What is granted now (the latest record of each purpose).'),
    complete: z.boolean(),
  }),
  paymentMethods: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      supports3ds: z.boolean(),
      preset: z
        .string()
        .nullable()
        .describe('The key of the ready-made method it was made from; null for a custom method (feature 32).'),
      logoUrl: z
        .string()
        .nullable()
        .describe(
          'The public path of the logo staff uploaded; null when none, then show the bundled logo of `preset` (feature 32).',
        ),
    }),
  ),
  balancePayable: z
    .boolean()
    .describe(
      'Feature 21: true when the store balance is switched on and this checkout was opened by a signed-in retail account, so ' +
        '`POST /store/v1/checkout-sessions/:token/balance-payment` may pay it (with that account signed in). Never the balance itself: ' +
        'read it from `GET /store/v1/me/wallet`.',
    ),
  trackingToken: z
    .string()
    .nullable()
    .describe(
      'The tracking token of the order this payment created (`GET /store/v1/orders/:token`); null until the checkout is paid. The holder of the ' +
        'checkout token is the buyer, so the shop can send them to their order without an account.',
    ),
});

const SESSION_EXAMPLE = {
  token: 'Zk3b0jY8mQe1xVn7hT2cLw',
  status: 'open',
  expiresAt: '2026-11-07T12:30:00.000Z',
  createdAt: '2026-11-07T12:00:00.000Z',
  service: { id: 1, name: 'iCloud Clean / Lost Check', type: 'imei', deliveryTime: '2 minutes' },
  quantity: 1,
  imei: '•••••••••••0004',
  email: 'sa•••@mail.example',
  country: 'GB',
  currency: 'GBP',
  fxRate: '0.80185000',
  taxRate: '20.0000',
  amounts: {
    usd: { net: '3.9900', tax: '0.8000', gross: '4.7900' },
    display: { net: '3.2000', tax: '0.6400', gross: '3.8400' },
  },
  consent: { required: ['terms', 'privacy', 'withdrawal_waiver'], granted: [], complete: false },
  paymentMethods: [{ code: 'card', name: 'Card gateway', supports3ds: true, preset: null, logoUrl: null }],
  balancePayable: false,
  trackingToken: null,
} as const;

const TOKEN_PARAMS = z.object({ token: z.string().min(16).max(128).describe('The checkout token.') });

/** `POST /store/v1/checkout-sessions`. */
export const openCheckoutSession = defineRoute({
  key: 'POST /store/v1/checkout-sessions',
  summary: 'Open a checkout',
  description:
    "Starts a purchase, as a guest or as a signed-in retail account: the session locks the retail price, the tax rate of the buyer's " +
    "`country` and the exchange rate of `currency` for 30 minutes. A guest's email makes (or finds) the guest record of that email: it " +
    'never attaches to the login account of the email, whatever its rank. A request that ' +
    'carries the cookie of a signed-in account (and its `X-CSRF-Token`, else `403 CSRF_FAILED` and nothing is written) opens the ' +
    'checkout as that account instead: ' +
    '`email` must be the email of the account in any case (else `422` on `email`: "Use the email of your account, or sign out to ' +
    'check out as a guest."), the `guestCheckout` switch does not apply and the session belongs to the signed-in account. A signed-in ' +
    'merchant rank is refused (`403 RANK_NOT_ALLOWED`, "Your account orders from its price list.") and nothing is written. A request ' +
    'without a usable account session is a guest. The order fields come in `inputs`, each judged by its own type, required tick and ' +
    'pattern (decision 073: the service type `imei` forces nothing); a field of type `imei` holds one IMEI (spaces and dashes removed, ' +
    '15 digits, Luhn; else `422 INVALID_IMEI` with `invalid_imei` on `inputs.<key>`). Decision 076: a field of type `imei_bulk` holds 1 ' +
    'to 30 IMEIs, still one order at one price (a bad line is `422 INVALID_IMEI`), and the other check types answer `422 ' +
    'VALIDATION_FAILED` with `invalid_<type>` on `inputs.<key>`. On an IMEI service the main input may also come ' +
    'as `imei` (older shop pages; it is the value of the main-input field, wins over a value under its key and is reported on `imei`; ' +
    'a service without such a field takes it as sent). A blocklisted IMEI is refused whenever the main input, a field of type `imei` or a ' +
    'line of a field of type `imei_bulk` reads as a valid IMEI. An account or ' +
    'guest record that may not act is refused (`403 ' +
    'ACCOUNT_SUSPENDED`), and so is a guest whose email belongs to a login account that is suspended, blocked or erased, with the same ' +
    'answer as a blocklist hit and no guest record made; when the shop requires an account (`guestCheckout` off) a guest gets `401 UNAUTHORIZED`. A service the ' +
    'shop cannot sell is `422` on `serviceId`. While the shop has a tax window in force for any country, a `country` without one is ' +
    '`422` on `country` (code `unsupported`, "Choose a country."), the refusal of the customer profile; a shop with no tax window in ' +
    'force accepts any country without tax. While the `country` has a regional tax window in force, `region` must name a region that ' +
    'has one (any case), else `422` on `region` (code `unsupported`, "Choose a region."); the national window alone does not apply then. ' +
    'An email that staff blocked for guest checkouts is refused to a guest like any blocked email ' +
    '(`403 ACCOUNT_SUSPENDED`) and accepted for its signed-in account (decision 050). ' +
    'The answer carries the session token: the whole credential of the next two routes. ' +
    'Paying comes later. Needs the anti-bot token (`X-Turnstile-Token`). The answer holds the token, so it is never cached. ' +
    '`currency` must be on offer in `GET /store/v1/config` (`422` on `currency` otherwise).',
  tags: ['checkout'],
  surface: 'store',
  access: 'public',
  turnstile: true,
  body: OpenBody,
  success: { status: 201, schema: CheckoutSessionSchema },
  errors: ['VALIDATION_FAILED', 'INVALID_IMEI', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED', 'RANK_NOT_ALLOWED'],
  examples: {
    request: {
      serviceId: 1,
      email: 'sam@mail.example',
      country: 'GB',
      currency: 'GBP',
      inputs: { imei: '353890110000004' },
    },
    response: SESSION_EXAMPLE,
  },
});

/** `GET /store/v1/checkout-sessions/:token`. */
export const showCheckoutSession = defineRoute({
  key: 'GET /store/v1/checkout-sessions/:token',
  summary: 'Show a checkout',
  description:
    "The session by its token: status (an unpaid session past its expiry reads `expired`), the locked amounts in USD and in the buyer's " +
    'currency, where the consents stand and the payment methods on offer. The IMEI and the email are masked. An unknown, malformed or ' +
    'wrong token is `404`. Never cached.',
  tags: ['checkout'],
  surface: 'store',
  access: 'checkout-token',
  params: TOKEN_PARAMS,
  success: { status: 200, schema: CheckoutSessionSchema },
  errors: ['NOT_FOUND'],
  examples: { response: SESSION_EXAMPLE },
});

const ConsentBody = z.object({
  consents: z
    .array(z.object({ purpose: z.enum(CONSENT_PURPOSES), granted: z.boolean() }))
    .min(1, 'Send at least one consent.')
    .max(CONSENT_PURPOSES.length)
    .describe(
      'One entry per purpose. `granted: false` records a refusal or a withdrawal (a new row, nothing is overwritten).',
    ),
});

/** `POST /store/v1/checkout-sessions/:token/consents`. */
export const recordCheckoutConsents = defineRoute({
  key: 'POST /store/v1/checkout-sessions/:token/consents',
  summary: 'Record the consents of a checkout',
  description:
    'Writes proof of what the buyer agreed to: for each purpose (`terms`, `privacy`, `refund_policy`, `withdrawal_waiver`, `marketing`) ' +
    'one record with the version of the current legal document (`terms`, `privacy` and `refund_policy` have one; the waiver and ' +
    "marketing do not), the time and the buyer's IP. A repeat of the latest record changes nothing. The records belong to the account of " +
    'the checkout: the signed-in account that opened it, or the guest record of its email. When that is an account with a login, `marketing` ' +
    "is not recorded and is left out of `records`: only the account's own page changes it. " +
    "The exception is the account holder: a request that also carries the cookie and `X-CSRF-Token` of that account's signed-in " +
    "session records `marketing` too, and the account's marketing choice (`marketingOptIn`) follows the answer; an account session " +
    'without its CSRF header is `403 CSRF_FAILED` and a merchant-rank session `403 RANK_NOT_ALLOWED`, and nothing is written. ' +
    '`422` when a purpose has no published document or a purpose is listed twice; `409 INVALID_TRANSITION` when the session is ' +
    'paid or expired. The answer says whether the session now has every required consent. The token in the path is the credential.',
  tags: ['checkout'],
  surface: 'store',
  access: 'checkout-token',
  params: TOKEN_PARAMS,
  body: ConsentBody,
  success: {
    status: 201,
    schema: z.object({
      records: z.array(
        z.object({
          purpose: z.enum(CONSENT_PURPOSES),
          granted: z.boolean(),
          document: z.object({ type: z.string(), version: z.string() }).nullable(),
          recordedAt: zIsoDateTime,
        }),
      ),
      consent: CheckoutSessionSchema.shape.consent,
    }),
  },
  errors: ['NOT_FOUND', 'VALIDATION_FAILED', 'INVALID_TRANSITION', 'CSRF_FAILED', 'RANK_NOT_ALLOWED'],
  examples: {
    request: {
      consents: [
        { purpose: 'terms', granted: true },
        { purpose: 'privacy', granted: true },
        { purpose: 'withdrawal_waiver', granted: true },
      ],
    },
    response: {
      records: [
        {
          purpose: 'terms',
          granted: true,
          document: { type: 'terms', version: '3.2' },
          recordedAt: '2026-11-07T12:01:00.000Z',
        },
        {
          purpose: 'privacy',
          granted: true,
          document: { type: 'privacy', version: '2.1' },
          recordedAt: '2026-11-07T12:01:00.000Z',
        },
        { purpose: 'withdrawal_waiver', granted: true, document: null, recordedAt: '2026-11-07T12:01:00.000Z' },
      ],
      consent: {
        required: ['terms', 'privacy', 'withdrawal_waiver'],
        granted: ['terms', 'privacy', 'withdrawal_waiver'],
        complete: true,
      },
    },
  },
});
