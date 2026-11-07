// Route contracts of the payment gateways (map domain E, stage 8, routes /admin/payment-gateways). Shapes match the console's
// `PaymentGateway` and `CreateGatewayBody` (docs/contract/endpoints/money.md).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { GATEWAY_AUDIENCES } from '../db/schema';

/** A payment gateway as the console shows it: never the secret, only a hint that one is stored. */
export const PaymentGatewaySchema = z.object({
  id: zId,
  code: z
    .string()
    .describe('The lower-case code; it is the `:gateway` of `/webhooks/payments/:gateway` and never changes.'),
  driver: z.string().describe('The code that talks to the gateway: `card`, `crypto`, `bank`, `wise`, or any name.'),
  name: z.string(),
  audience: z
    .enum(GATEWAY_AUDIENCES)
    .describe('Who may pay with it: storefront customers (b2c), merchants (b2b) or both.'),
  feePercent: zDecimal.describe('The percent fee, 4 decimals.'),
  feeFixed: zMoney.describe('The fixed fee added to the percent.'),
  minAmount: zMoney.describe('The smallest payment; `0.0000` = no minimum.'),
  maxAmount: zMoney.describe('The largest payment; `0.0000` = no maximum.'),
  allowedGroupIds: z.array(zId).describe('The merchant groups that may use it; empty = every group.'),
  supportsRefunds: z.boolean(),
  supports3ds: z.boolean(),
  isManual: z
    .boolean()
    .describe('True when staff review each payment (bank, Wise); false when the gateway confirms it.'),
  instructions: z.string().describe('What a merchant sees for a manual gateway (the transfer details).'),
  holdHours: z
    .number()
    .int()
    .describe('Automatic gateway: hours a confirmed payment waits instead of 10 minutes. Manual: the review window.'),
  isActive: z.boolean(),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime.optional().describe('When the row last changed; always sent.'),
  secretHint: z
    .string()
    .nullable()
    .optional()
    .describe('`••••` and the last 4 characters of the stored API credential; null when none. Never the secret.'),
  volume30d: zMoney
    .nullable()
    .optional()
    .describe(
      'Money taken through the gateway in the last 30 days, in USD (payments captured, not pending, failed or rejected).',
    ),
});

const bank = {
  id: 3,
  code: 'bank',
  driver: 'bank',
  name: 'Bank transfer',
  audience: 'b2b' as const,
  feePercent: '0.0000',
  feeFixed: '0.0000',
  minAmount: '50.0000',
  maxAmount: '50000.0000',
  allowedGroupIds: [2, 3],
  supportsRefunds: false,
  supports3ds: false,
  isManual: true,
  instructions: 'IBAN JO94 CBJO 0010 0000 0000 0131 000302, reference: your merchant email',
  holdHours: 24,
  isActive: true,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  secretHint: null,
  volume30d: '4350.0000',
};

/** The body of `POST /admin/payment-gateways`: the console's `CreateGatewayBody` plus the optional `webhookSecret`. */
const CreateGatewayBody = z.object({
  code: z.string().trim(),
  driver: z.string().trim(),
  name: z.string().trim(),
  audience: z.enum(GATEWAY_AUDIENCES),
  feePercent: z.string().trim(),
  feeFixed: z.string().trim(),
  minAmount: z.string().trim(),
  maxAmount: z.string().trim(),
  allowedGroupIds: z.array(zId),
  supportsRefunds: z.boolean(),
  supports3ds: z.boolean(),
  isManual: z.boolean(),
  instructions: z.string(),
  holdHours: z.number(),
  isActive: z.boolean(),
  secret: z.string().optional().describe('Write-only: the API credential of the gateway, stored encrypted.'),
  webhookSecret: z
    .string()
    .optional()
    .describe('Write-only: the key the gateway signs its webhooks with, stored encrypted.'),
});

const VALIDATION =
  'Validation (422 with the field): a non-blank name, driver and code (lower-case letters, digits, `-` and `_`); a code that ' +
  'no other gateway uses; audience b2c, b2b or both; a fee of 0 to 100 percent; money fields of 0 or more (a maximum above ' +
  'zero is not below the minimum); whole `holdHours` from 0 to 720; `allowedGroupIds` that are existing client groups.';

/** `GET /admin/payment-gateways`. */
export const listGateways = defineRoute({
  key: 'GET /admin/payment-gateways',
  summary: 'Payment gateways',
  description:
    'The payment gateways with their fees, limits and merchant groups, never their secrets. `secretHint` shows that a credential ' +
    'is stored; `volume30d` is the money taken in the last 30 days.',
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:gateways',
  query: listQuery({
    sorts: ['name', 'code', 'audience', 'createdAt'],
    defaultSort: { field: 'name', order: 'asc' },
    filters: {
      audience: { type: 'enum', values: GATEWAY_AUDIENCES, ops: ['eq'] },
      isActive: { type: 'boolean', ops: ['eq'] },
    },
    search: ['name', 'code', 'driver'],
  }),
  success: { status: 200, schema: PaymentGatewaySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [bank] },
});

/** `GET /admin/payment-gateways/:id`. */
export const getGateway = defineRoute({
  key: 'GET /admin/payment-gateways/:id',
  summary: 'One payment gateway',
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:gateways',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: PaymentGatewaySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: bank },
});

/** `POST /admin/payment-gateways`. */
export const createGateway = defineRoute({
  key: 'POST /admin/payment-gateways',
  summary: 'Add a payment gateway',
  description:
    'Adds a gateway. `secret` (the API credential) and `webhookSecret` are write-only and stored encrypted. ' +
    `${VALIDATION} Audited.`,
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:gateways',
  body: CreateGatewayBody,
  success: { status: 201, schema: PaymentGatewaySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      code: 'bank',
      driver: 'bank',
      name: 'Bank transfer',
      audience: 'b2b',
      feePercent: '0',
      feeFixed: '0',
      minAmount: '50',
      maxAmount: '50000',
      allowedGroupIds: [2, 3],
      supportsRefunds: false,
      supports3ds: false,
      isManual: true,
      instructions: bank.instructions,
      holdHours: 24,
      isActive: true,
    },
    response: bank,
  },
});

/** `PATCH /admin/payment-gateways/:id`. */
export const updateGateway = defineRoute({
  key: 'PATCH /admin/payment-gateways/:id',
  summary: 'Change a payment gateway',
  description:
    'Changes the fields sent (the on/off switch sends `{ isActive }`). The code never changes (it is part of the webhook address): ' +
    'a different code is 422 on `code`. A non-empty `secret` or `webhookSecret` replaces the stored one; leaving it out keeps it. ' +
    `The merged gateway is validated as on create. ${VALIDATION} Audited.`,
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:gateways',
  params: z.object({ id: zIdParam }),
  body: CreateGatewayBody.partial(),
  success: { status: 200, schema: PaymentGatewaySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { isActive: false }, response: { ...bank, isActive: false } },
});

/** `DELETE /admin/payment-gateways/:id`. */
export const deleteGateway = defineRoute({
  key: 'DELETE /admin/payment-gateways/:id',
  summary: 'Delete a payment gateway',
  description:
    'Deletes a gateway nobody has paid through. A gateway with any payment or invoice is `409 GATEWAY_IN_USE`: turn it off instead. Audited.',
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:gateways',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'GATEWAY_IN_USE', 'VALIDATION_FAILED'],
});
