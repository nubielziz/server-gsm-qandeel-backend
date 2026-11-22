// Route contract of the incoming payment confirmation (map domain E, stage 8, route POST /webhooks/payments/:gateway). The
// signature, the 5-minute window and the event-id replay filter are the guard's (P2.5c); the body is the gateway's own.
import { z } from 'zod';
import { defineRoute, zJsonObject } from '../../../common/contract';

/** `POST /webhooks/payments/:gateway`. */
export const paymentWebhook = defineRoute({
  key: 'POST /webhooks/payments/:gateway',
  summary: 'Payment confirmation from a gateway',
  description:
    "A payment gateway confirms a top-up. The delivery must carry the gateway's signature (the scheme of its driver), a signed time " +
    'within 5 minutes of now and an event id not seen before; otherwise `400 WEBHOOK_SIGNATURE_INVALID`. A confirmed payment of an open ' +
    'invoice is recorded once (the gateway reference is unique): the payment waits `payments.auto_credit_delay_minutes` ' +
    '(at least the gateway hold hours), then a job asks the gateway again and credits the wallet. A repeat of the same event answers ' +
    '`200` and changes nothing. Events billing does not use are acknowledged with `200`. A gateway may keep two webhook secrets: a ' +
    'delivery signed with either passes. Refund results (`refund.updated` with a final status, `refund.failed`) settle the storefront ' +
    'refund they name, and dispute events are handled exactly as on `POST /webhooks/disputes/:gateway` (one provider endpoint with ' +
    'every event is enough; the same dispute on both URLs is recorded once). ' +
    "For a storefront payment (`PAY-<id>`) the gateway's own record is read before the order is created: when it cannot be read the " +
    'answer is `502 GATEWAY_ERROR` and the gateway delivers the event again (once the event is 24 hours old the payment is held for ' +
    'staff instead); a payment the record does not show as paid, or shows for another amount or currency, and a confirmation that does ' +
    'not state its amount or currency, is held for staff: nothing is created, and money that arrived is sent back in full automatically ' +
    "when the gateway can refund. A payment made more than 30 minutes after the checkout's price lock ended is refunded at once, or " +
    'waits in the risk queue when the method cannot refund. A confirmation of a top-up invoice that is paid or void is recorded for ' +
    'staff review and never credited. A dispute event for a payment or a dispute not recorded yet is `503 UNAVAILABLE`, so the ' +
    'gateway delivers it again (decision 048).',
  tags: ['webhooks'],
  surface: 'hooks',
  access: 'gateway-signature',
  params: z.object({ gateway: z.string() }),
  body: zJsonObject,
  success: { status: 200, schema: z.object({ received: z.literal(true), duplicate: z.boolean().optional() }) },
  errors: ['WEBHOOK_SIGNATURE_INVALID', 'VALIDATION_FAILED', 'GATEWAY_ERROR', 'UNAVAILABLE'],
  examples: {
    request: {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: { id: 'cs_1', payment_status: 'paid', client_reference_id: 'INV-2026-0312', payment_intent: 'pi_1' },
      },
    },
    response: { received: true },
  },
});
