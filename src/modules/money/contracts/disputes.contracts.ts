// Route contracts of the card disputes for staff (map domain E, stage 16, routes /admin/disputes*) and the dispute webhook. Shapes match the
// console's `Dispute` (src/features/refunds/types; docs/contract/endpoints/money.md, RESOLUTIONS money-5, ANSWERS refunds Q5 to Q8).
import { z } from 'zod';
import {
  defineRoute,
  listQuery,
  zDecimal,
  zId,
  zIdParam,
  zIsoDateTime,
  zJsonObject,
  zMoney,
} from '../../../common/contract';
import { DISPUTE_STATUSES } from '../db/schema';
import { EVIDENCE_KEYS, MAX_EVIDENCE_NOTE_LENGTH } from '../domain/dispute-rules';

const NamedRef = z.object({ id: zId, name: z.string() });

/** The six lines of the evidence pack. */
const EvidenceItem = z.object({
  key: z.enum(EVIDENCE_KEYS),
  title: z.string(),
  body: z.string(),
  ok: z.boolean().describe('Whether the line supports our case.'),
});

/** One dispute; only the single read carries `evidence` and `strength`. */
export const DisputeSchema = z.object({
  id: zId,
  orderId: zId,
  amount: zMoney.describe('The disputed amount (USD).'),
  fee: zMoney.describe("This dispute's fee from the gateway (USD)."),
  reasonCode: z.string(),
  note: z.string().nullable().describe("The bank's reason in a sentence, derived from the reason code."),
  status: z.enum(DISPUTE_STATUSES),
  currency: z.string().describe("The customer's currency, for display."),
  fx: zDecimal.describe('The rate the order was priced with, for display.'),
  customer: NamedRef.nullable(),
  evidenceDueAt: zIsoDateTime,
  submittedAt: zIsoDateTime.nullable(),
  resolvedAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
  strength: z
    .enum(['strong', 'fair', 'weak'])
    .nullable()
    .optional()
    .describe('How strong the case looks; the single read only.'),
  evidence: z.array(EvidenceItem).optional().describe('The pack the server built; the single read only.'),
});

const DISPUTE_EXAMPLE = {
  id: 2005,
  orderId: 20467,
  amount: '14.9900',
  fee: '15.0000',
  reasonCode: 'fraudulent',
  note: 'The cardholder says they did not make this payment.',
  status: 'needs_response' as const,
  currency: 'GBP',
  fx: '0.79000000',
  customer: { id: 31, name: 'Jack Turner' },
  evidenceDueAt: '2026-11-14T00:00:00.000Z',
  submittedAt: null,
  resolvedAt: null,
  createdAt: '2026-11-07T09:00:00.000Z',
};

/** `GET /admin/disputes`. */
export const listDisputes = defineRoute({
  key: 'GET /admin/disputes',
  summary: 'Card disputes',
  description:
    'Disputes (chargebacks) with their evidence deadline, without the evidence pack. Sorted by `evidenceDueAt` ascending (the default) ' +
    'the disputes that still need an answer come first, soonest deadline first, then the others by deadline. `q` searches the id, the ' +
    'reason code and the customer name and email.',
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'disputes:read',
  query: listQuery({
    sorts: ['id', 'amount', 'evidenceDueAt', 'status'],
    defaultSort: { field: 'evidenceDueAt', order: 'asc' },
    filters: { status: { type: 'enum', values: DISPUTE_STATUSES } },
    search: ['disputeId', 'reasonCode', 'customer.name', 'customer.email'],
  }),
  success: { status: 200, schema: DisputeSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [DISPUTE_EXAMPLE] },
});

/** `GET /admin/disputes/:id`. */
export const getDispute = defineRoute({
  key: 'GET /admin/disputes/:id',
  summary: 'One dispute with its evidence pack',
  description:
    'The row plus `evidence` (six lines: payment, 3-D Secure, delivery, consents, history, contact) and `strength` (`strong` from 8 ' +
    'points, `fair` from 5; the lines weigh 1, 3, 3, 2, 1, 1 when they support the case), built from the order, the payment, the ' +
    "consent records, the customer's other orders and their support tickets.",
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'disputes:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: DisputeSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    response: {
      ...DISPUTE_EXAMPLE,
      strength: 'strong' as const,
      evidence: [
        {
          key: 'payment' as const,
          title: 'Payment record',
          body: 'Visa •••• 4242, $14.99 captured 2026-11-05.',
          ok: true,
        },
      ],
    },
  },
});

/** `POST /admin/disputes/:id/evidence`. */
export const submitDisputeEvidence = defineRoute({
  key: 'POST /admin/disputes/:id/evidence',
  summary: 'Submit the evidence of a dispute',
  description:
    'Submits the chosen lines of the pack and an optional note before the deadline: the text is sent to the gateway first (`502 ' +
    'GATEWAY_ERROR` when it cannot be, and nothing changes), then the lines are rendered to a PDF kept with the dispute ' +
    '(`evidence_file_ids`) and the dispute becomes `under_review` with `submittedAt`. ' +
    '`409 DISPUTE_NOT_OPEN` when it no longer waits for evidence, `409 EVIDENCE_DEADLINE_PASSED` after the deadline, `422` for no ' +
    'items, an item that is not in the pack (field `items`) or a note over 1000 characters (field `note`).',
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'disputes:manage',
  params: z.object({ id: zIdParam }),
  body: z.object({
    items: z.array(z.string().min(1).max(40)).max(20),
    note: z
      .string()
      .max(MAX_EVIDENCE_NOTE_LENGTH + 1000)
      .optional(),
  }),
  success: { status: 200, schema: DisputeSchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'DISPUTE_NOT_OPEN',
    'EVIDENCE_DEADLINE_PASSED',
    'VALIDATION_FAILED',
    'GATEWAY_ERROR',
  ],
  examples: {
    request: { items: ['payment', 'three_ds', 'delivery'], note: 'The result was delivered to the cardholder.' },
    response: { ...DISPUTE_EXAMPLE, status: 'under_review' as const, submittedAt: '2026-11-08T10:00:00.000Z' },
  },
});

/** `POST /admin/disputes/:id/accept`. */
export const acceptDispute = defineRoute({
  key: 'POST /admin/disputes/:id/accept',
  summary: 'Accept the loss of a dispute',
  description:
    'Accepts the loss: the dispute is `lost` with `resolvedAt`, the payment `chargeback`, and one `b2c_chargeback` journal posts the ' +
    'amount and the dispute fee (Dr chargeback_loss, Cr gateway_clearing, key `dispute:<id>:chargeback`), kept in `disputes.ledger_tx_id` ' +
    'so a later `lost` event from the gateway posts nothing again. The customer is not blocked (M115). `409 DISPUTE_NOT_OPEN` when it ' +
    'no longer waits for evidence.',
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'disputes:manage',
  params: z.object({ id: zIdParam }),
  body: z.object({}),
  success: { status: 200, schema: DisputeSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'DISPUTE_NOT_OPEN', 'VALIDATION_FAILED'],
  examples: {
    request: {},
    response: { ...DISPUTE_EXAMPLE, status: 'lost' as const, resolvedAt: '2026-11-08T10:00:00.000Z' },
  },
});

/** `POST /webhooks/disputes/:gateway`. */
export const disputeWebhook = defineRoute({
  key: 'POST /webhooks/disputes/:gateway',
  summary: 'Dispute event from a gateway',
  description:
    "A payment gateway reports a dispute. The delivery must carry the gateway's signature (the scheme of its driver), a signed time within " +
    '5 minutes of now and an event id not seen before; otherwise `400 WEBHOOK_SIGNATURE_INVALID`. `dispute.created` records the ' +
    'dispute once (the gateway id is unique per payment) with its evidence deadline and marks the payment `disputed` and the order ' +
    'timeline; a dispute won returns the payment to `captured` (or `partial_refund`/`refunded` when refunds completed); a dispute lost ' +
    'posts the chargeback journal once and marks the payment `chargeback`. A repeat of an event answers `200` and changes nothing; events ' +
    'the shop does not use are acknowledged with `200`.',
  tags: ['webhooks'],
  surface: 'hooks',
  access: 'gateway-signature',
  params: z.object({ gateway: z.string() }),
  body: zJsonObject,
  success: { status: 200, schema: z.object({ received: z.literal(true), duplicate: z.boolean().optional() }) },
  errors: ['WEBHOOK_SIGNATURE_INVALID', 'VALIDATION_FAILED'],
  examples: {
    request: {
      id: 'evt_d1',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_1',
          payment_intent: 'pi_1',
          amount: 1499,
          currency: 'gbp',
          fee: 1500,
          reason: 'fraudulent',
          evidence_details: { due_by: 1794000000 },
        },
      },
    },
    response: { received: true },
  },
});
