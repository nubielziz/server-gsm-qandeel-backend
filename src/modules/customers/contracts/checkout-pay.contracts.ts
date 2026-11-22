// Route contract of paying a storefront checkout (map domain I, stage 16): POST /store/v1/checkout-sessions/:token/pay. The console has no screen
// for it (the storefront is another frontend): the shape follows ALIGNMENT § 7 (`Idempotency-Key` required) and is written up in the module README.
import { z } from 'zod';
import { defineRoute, zId, zMoney, zSignedMoney } from '../../../common/contract';

const IdempotencyHeaders = z.object({
  'idempotency-key': z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[\x21-\x7e]+$/, 'Use printable characters without spaces.')
    .describe(
      'Required. A retry with the same key and the same body answers the same payment and page (also after it was captured: its status ' +
        'says so); another body with the key is `409 IDEMPOTENCY_KEY_REUSED`, a call still opening its page `409 IDEMPOTENCY_IN_PROGRESS`.',
    ),
});

/** `POST /store/v1/checkout-sessions/:token/pay`. */
export const payCheckoutSession = defineRoute({
  key: 'POST /store/v1/checkout-sessions/:token/pay',
  summary: 'Start paying a checkout',
  description:
    'Starts the payment of an open checkout with one of the methods `GET /store/v1/checkout-sessions/:token` lists (`gateway` is its `code`): the ' +
    "gateway opens a hosted page for the session's locked gross in the buyer's currency (3-D Secure for a card when the shop asks for it, a " +
    'wallet or a crypto address on the same page) and the answer carries its address. **No order exists yet**: the order is created, the money ' +
    "booked and the service delivered only when the gateway's signed confirmation arrives (`POST /webhooks/payments/:gateway`), in one " +
    'transaction. The checkout needs every required consent first (`422` on `consent`); a paid or expired checkout is `409 ' +
    'INVALID_TRANSITION` (so is a page that opened after its payment was already closed, and so is a checkout whose service the shop no longer sells at all: switched off, unlisted or without a retail price; a changed price is not a reason, the locked price holds), a suspended or blocked customer `403 ACCOUNT_SUSPENDED`, a method that is off or does not take the amount `422` ' +
    'on `gateway`, a gateway that cannot open its page `502 GATEWAY_ERROR`. `Idempotency-Key` is required. The token in the path is the credential. ' +
    'A checkout keeps at most 3 payment pages open (`429 RATE_LIMITED` for another; a page that failed, was paid or is held frees its ' +
    'place); an amount the method cannot charge exactly is `422` on `gateway` (`not_chargeable`); a `returnUrl` that is not an address of ' +
    "this shop is `422` on `returnUrl` (`not_shop`). The confirmation creates the order only once the gateway's own record says the " +
    'payment succeeded for this amount and currency; a payment made more than 30 minutes after the price lock ended is not used at the ' +
    'old price (decision 048).',
  tags: ['checkout'],
  surface: 'store',
  access: 'checkout-token',
  params: z.object({ token: z.string().min(16).max(128).describe('The checkout token.') }),
  headers: IdempotencyHeaders,
  body: z.object({
    gateway: z.string().trim().min(1).max(40).describe('The `code` of a payment method of the checkout.'),
    returnUrl: z
      .url({ protocol: /^https?$/, error: 'Enter an http or https address.' })
      .max(500)
      .describe(
        'Where the gateway sends the buyer back to: an address of this shop (the origin of STORE_BASE_URL or PORTAL_BASE_URL, or one ' +
          'of SHOP_ORIGINS), else 422 on returnUrl (not_shop).',
      ),
  }),
  success: {
    status: 201,
    schema: z.object({
      payment: z.object({
        id: zId,
        reference: z.string().describe('The reference the gateway holds (`PAY-<id>`).'),
        status: z
          .string()
          .describe('`pending` until the gateway confirms; a replay after the capture says `captured`.'),
        method: z.enum(['card', 'wallet', 'crypto']),
        currency: z.string(),
        amount: zMoney.describe("What is charged: the gross in the buyer's currency."),
      }),
      gateway: z.object({ code: z.string(), name: z.string(), supports3ds: z.boolean() }),
      paymentUrl: z
        .string()
        .describe(
          "The gateway's hosted page, always an https address: send the buyer there. A card page closes 30 minutes after the " +
            "checkout's price lock ends.",
        ),
    }),
  },
  errors: [
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'INVALID_TRANSITION',
    'ACCOUNT_SUSPENDED',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
    'RATE_LIMITED',
    'GATEWAY_ERROR',
  ],
  examples: {
    request: { gateway: 'card', returnUrl: 'http://localhost:5175/en/checkout/return' },
    response: {
      payment: {
        id: 9001,
        reference: 'PAY-9001',
        status: 'pending',
        method: 'card',
        currency: 'GBP',
        amount: '3.8400',
      },
      gateway: { code: 'card', name: 'Card gateway', supports3ds: true },
      paymentUrl: 'https://pay.example/c/cs_9001',
    },
  },
});

/** `POST /store/v1/checkout-sessions/:token/balance-payment` (feature 21, a route beyond the map: `scripts/map-additions/21.mjs`). */
export const payCheckoutFromBalance = defineRoute({
  key: 'POST /store/v1/checkout-sessions/:token/balance-payment',
  summary: 'Pay a checkout from the store balance',
  description:
    "Pays an open checkout from the signed-in customer's store balance (USD) and creates the order **at once**, in one transaction: no " +
    'gateway, no webhook, no polling. Besides the checkout token in the path, the request needs the customer session cookie and its ' +
    '`X-CSRF-Token`: `401 UNAUTHORIZED` means "sign in to pay from the balance" (not an ended checkout). The checkout must belong to that ' +
    'customer **and** have been opened while signed in (`balancePayable` on the checkout), else `403 FORBIDDEN`. A paid, expired or no-longer-sold ' +
    'checkout is `409 INVALID_TRANSITION`, a suspended customer `403 ACCOUNT_SUSPENDED`, missing consents `422` on `consent`, a balance ' +
    'below the gross `402 INSUFFICIENT_FUNDS`, a balance on hold `409 WALLET_FROZEN`, the store balance switched off `409 WALLET_DISABLED`. ' +
    '`Idempotency-Key` is required: a retry with the same key answers the same payment and order (header `idempotency-replayed: true`, the ' +
    'wallet as it is now); a key a `/pay` call already used on this checkout is `409 IDEMPOTENCY_KEY_REUSED`. The ledger posts Dr customer ' +
    'wallet / Cr customer funds / Cr VAT payable (VAT at spend, at the rate the checkout locked).',
  tags: ['checkout'],
  surface: 'store',
  access: 'checkout-token',
  params: z.object({ token: z.string().min(16).max(128).describe('The checkout token.') }),
  headers: IdempotencyHeaders,
  success: {
    status: 201,
    schema: z.object({
      payment: z.object({
        id: zId,
        reference: z.string().describe('`PAY-<id>`.'),
        status: z
          .string()
          .describe('`captured`; a replay says what refunds made of it since (`refunded`, `partial_refund`).'),
        method: z.enum(['balance']),
        currency: z.string().describe("The checkout's currency."),
        amount: zMoney.describe("The gross in the checkout's currency, as the checkout showed it."),
        amountUsd: zMoney.describe('The gross in USD: what left the store balance.'),
      }),
      order: z.object({
        id: zId,
        trackingToken: z.string().describe('The public tracking token of the new order.'),
      }),
      wallet: z.object({
        balance: zSignedMoney.describe('The store balance after the payment (USD).'),
        available: zMoney.describe('What can be spent now: `0.0000` while on hold or switched off.'),
      }),
    }),
  },
  errors: [
    'NOT_FOUND',
    'UNAUTHORIZED',
    'CSRF_FAILED',
    'FORBIDDEN',
    'VALIDATION_FAILED',
    'INVALID_TRANSITION',
    'ACCOUNT_SUSPENDED',
    'INSUFFICIENT_FUNDS',
    'WALLET_FROZEN',
    'WALLET_DISABLED',
    'IDEMPOTENCY_KEY_REUSED',
  ],
  examples: {
    response: {
      payment: {
        id: 9002,
        reference: 'PAY-9002',
        status: 'captured',
        method: 'balance',
        currency: 'GBP',
        amount: '3.8400',
        amountUsd: '4.8000',
      },
      order: { id: 70012, trackingToken: 'q8Zr2LwT5mKx9PvA' },
      wallet: { balance: '45.2000', available: '45.2000' },
    },
  },
});
