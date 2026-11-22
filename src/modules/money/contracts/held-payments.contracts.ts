// Route contract of closing a storefront payment held for staff (decision 048, a route beyond the map: scripts/map-additions/38.mjs):
// POST /admin/held-payments/:id/close. The console has no screen for it yet.
import { z } from 'zod';
import { defineRoute, zIdParam } from '../../../common/contract';

/** What staff did about a held payment: paid it back by hand, or found that no money was received. */
export const HELD_PAYMENT_OUTCOMES = ['returned', 'not_received'] as const;

/** One value of {@link HELD_PAYMENT_OUTCOMES}. */
export type HeldPaymentOutcome = (typeof HELD_PAYMENT_OUTCOMES)[number];

/** `POST /admin/held-payments/:id/close`. */
export const closeHeldPayment = defineRoute({
  key: 'POST /admin/held-payments/:id/close',
  summary: 'Close a storefront payment held for staff',
  description:
    'A storefront payment the gateway confirmed that could not pay its checkout is held for staff (decision 048): it has no order, and ' +
    'the money integrity check lists it until its money is back. `returned`: staff paid it back by hand (at the gateway or by transfer); ' +
    'a completed refund without an order records it, and a later confirmation of the payment changes nothing. `not_received`: the ' +
    'gateway holds no money for it; the payment becomes `failed` (a later real confirmation can still pay its checkout). ' +
    "`not_received` is accepted only when the gateway's record did not show money received for the payment when it was held (not paid, " +
    'could not be checked, or the record of another checkout); a payment whose record showed its money received (another amount or ' +
    'currency, no checkout, money refunded or disputed since) is `409 CONFLICT` ("The gateway\'s record shows this payment was received: ' +
    'send it back, then close it as returned."), and a payment held before this rule accepts both outcomes. `note` (10 to 500 ' +
    'characters) says what staff did. A payment that is not held, or whose money is being sent back or was sent back, is ' +
    '`409 CONFLICT`; an unknown id or a top-up is `404`. Audited.',
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'refunds:approve',
  params: z.object({ id: zIdParam }),
  body: z.object({
    outcome: z
      .enum(HELD_PAYMENT_OUTCOMES)
      .describe(
        '`returned`: staff paid it back by hand (at the gateway or by transfer). `not_received`: the gateway holds no money for it; ' +
          "refused (409) when the gateway's record showed the payment's money received.",
      ),
    note: z.string().trim().min(10).max(500).describe('What staff did, 10 to 500 characters.'),
  }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'CONFLICT', 'VALIDATION_FAILED'],
  examples: { request: { outcome: 'returned', note: 'Refunded in full from the gateway dashboard.' } },
});
