// Route contract of paying a storefront checkout (map domain I, stage 16): POST /store/v1/checkout-sessions/:token/pay. The console has no screen
// for it (the storefront is another frontend): the shape follows ALIGNMENT § 7 (`Idempotency-Key` required) and is written up in the module README.
import { z } from 'zod';
import { defineRoute, zId, zMoney } from '../../../common/contract';

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
    'INVALID_TRANSITION` (so is a page that opened after its payment was already closed), a suspended or blocked customer `403 ACCOUNT_SUSPENDED`, a method that is off or does not take the amount `422` ' +
    'on `gateway`, a gateway that cannot open its page `502 GATEWAY_ERROR`. `Idempotency-Key` is required. The token in the path is the credential.',
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
      .describe('Where the gateway sends the buyer back to after the hosted page (the shop).'),
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
      paymentUrl: z.string().describe("The gateway's hosted page: send the buyer there."),
    }),
  },
  errors: [
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'INVALID_TRANSITION',
    'ACCOUNT_SUSPENDED',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
    'GATEWAY_ERROR',
  ],
  examples: {
    request: { gateway: 'card', returnUrl: 'https://shop.example/checkout/return' },
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
