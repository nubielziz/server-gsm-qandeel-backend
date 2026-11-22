// Route contracts of the payment gateways (map domain E, stage 8, routes /admin/payment-gateways) and, beyond the map, the catalog of
// ready-made methods and the logo of a method (feature 32, spec B232). Shapes match the console's `PaymentGateway` and `CreateGatewayBody`
// (docs/contract/endpoints/money.md).
import { z } from 'zod';
import {
  defineRoute,
  listQuery,
  zDecimal,
  zId,
  zIdParam,
  zIsoDateTime,
  zMoney,
  zUploadedFile,
} from '../../../common/contract';
import { GATEWAY_AUDIENCES, TOPUP_METHODS } from '../db/schema';

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
  webhookSecretHint: z
    .string()
    .nullable()
    .optional()
    .describe(
      "`••••` and the last 4 characters of the stored webhook signing secret; null when none (the gateway's webhooks are then refused). Always sent.",
    ),
  secondaryWebhookSecretHint: z
    .string()
    .nullable()
    .optional()
    .describe(
      'The same for the second webhook secret (a second endpoint, or the new one while rotating); null when none. Always sent.',
    ),
  preset: z
    .string()
    .nullable()
    .describe(
      'The key of the ready-made method this one was made from (`GET /admin/payment-gateway-presets`); null for a custom method. It never changes. Always sent.',
    ),
  logoUrl: z
    .string()
    .nullable()
    .describe(
      'The public path of the logo staff uploaded (`/store/v1/media/<name>`); null when none, then a frontend shows the bundled logo of `preset`. Always sent.',
    ),
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
  webhookSecretHint: null,
  secondaryWebhookSecretHint: null,
  preset: null,
  logoUrl: null,
  volume30d: '4350.0000',
};

/** A ready-made payment method of the catalog (feature 32). */
export const GatewayPresetSchema = z.object({
  key: z.string().describe('The stable key a method remembers (`preset`); a frontend names its bundled logo by it.'),
  name: z.string(),
  kind: z
    .enum(['manual', 'automatic'])
    .describe('Manual: staff review each receipt. Automatic: a gateway confirms the payment (it needs a driver).'),
  available: z
    .boolean()
    .describe('False: shown as "Coming soon"; a create that names it is refused (422 on `preset`, `unavailable`).'),
  driver: z.string().describe('The driver name a method made from it must use.'),
  methodType: z.enum(TOPUP_METHODS).describe('The top-up method its payments carry.'),
  instructions: z
    .string()
    .describe(
      'A template of the transfer details with blanks (`________`) for staff to fill in; empty for an automatic one.',
    ),
});

const presetExample = {
  key: 'vodafone_cash',
  name: 'Vodafone Cash',
  kind: 'manual' as const,
  available: true,
  driver: 'vodafone_cash',
  methodType: 'bank' as const,
  instructions:
    'Send the amount to the Vodafone Cash number ________ and upload a screenshot of the transfer. Write your top-up number in the note.',
};

/** The body of `POST /admin/payment-gateways`: the console's `CreateGatewayBody` plus the optional webhook secrets. */
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
  preset: z
    .string()
    .trim()
    .nullable()
    .optional()
    .describe(
      'The key of a ready-made method (`GET /admin/payment-gateway-presets`) this one is made from. Leave it out (or `null`) for a custom method. ' +
        'Checked on create only: an unknown key is 422 on `preset` (`unknown`), a method that is not available yet is 422 on `preset` ' +
        '(`unavailable`), `isManual` that is not the preset kind is 422 on `isManual` (`preset_kind`), a `driver` that is not the preset driver ' +
        'is 422 on `driver` (`preset_driver`). Several methods may come from one preset.',
    ),
  secret: z.string().optional().describe('Write-only: the API credential of the gateway, stored encrypted.'),
  webhookSecret: z
    .string()
    .optional()
    .describe(
      'Write-only: the key the gateway signs its webhooks with, stored encrypted. A non-empty value replaces the first secret and keeps the second.',
    ),
  secondaryWebhookSecret: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .nullable()
    .optional()
    .describe(
      'Write-only: a second webhook signing secret (a second endpoint at the provider, or the new secret while rotating), stored ' +
        'encrypted; `null` removes it. Refused (422 on this field) when the gateway has no first secret and the request sends none.',
    ),
});

const VALIDATION =
  'Validation (422 with the field): a non-blank name, driver and code (lower-case letters, digits, `-` and `_`); a code that ' +
  'no other gateway uses; audience b2c, b2b or both; a fee of 0 to 100 percent; money fields of 0 or more (a maximum above ' +
  'zero is not below the minimum); whole `holdHours` from 0 to 720; `allowedGroupIds` that are existing client groups; a ' +
  '`secondaryWebhookSecret` of 1 to 500 characters, only next to a first webhook secret.';

/** `GET /admin/payment-gateways`. */
export const listGateways = defineRoute({
  key: 'GET /admin/payment-gateways',
  summary: 'Payment gateways',
  description:
    'The payment gateways with their fees, limits and merchant groups, never their secrets. `secretHint`, `webhookSecretHint` and ' +
    '`secondaryWebhookSecretHint` show that a credential is stored; `volume30d` is the money taken in the last 30 days.',
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
    'Adds a gateway. `secret` (the API credential), `webhookSecret` and `secondaryWebhookSecret` are write-only and stored encrypted. ' +
    "`preset` makes it a ready-made method of the catalog (its logo, kind and driver are the catalog entry's). " +
    `${VALIDATION} Audited. ` +
    'Only an owner may add an automatic method (`isManual` false) or send `secret`, `webhookSecret` or `secondaryWebhookSecret` (`403 FORBIDDEN`, after the validation above; decision 046).',
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

/** `GET /admin/payment-gateway-presets`. */
export const listGatewayPresets = defineRoute({
  key: 'GET /admin/payment-gateway-presets',
  summary: 'Ready-made payment methods',
  description:
    'The catalog of ready-made payment methods in its order (a plain array, no paging, no `x-total-count`): bank transfer, crypto ' +
    'transfer, Vodafone Cash, Fawry, InstaPay, Binance Pay, NOWPayments and Binance Pay (automatic). Each has the `key` a method remembers ' +
    'as its `preset`, the `driver` and `methodType` it stands for, and a template of the transfer details. An entry with `available: false` ' +
    'is shown as "Coming soon" and cannot be added yet. Nothing is stored: a method exists only once staff add it with ' +
    '`POST /admin/payment-gateways`.',
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:gateways',
  success: { status: 200, schema: z.array(GatewayPresetSchema) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
  examples: { response: [presetExample] },
});

/** `PATCH /admin/payment-gateways/:id`. */
export const updateGateway = defineRoute({
  key: 'PATCH /admin/payment-gateways/:id',
  summary: 'Change a payment gateway',
  description:
    'Changes the fields sent (the on/off switch sends `{ isActive }`). The code never changes (it is part of the webhook address): ' +
    'a different code is 422 on `code`. A non-empty `secret` or `webhookSecret` replaces the stored one; leaving it out keeps it. ' +
    '`secondaryWebhookSecret` sets the second webhook secret, `null` removes it, leaving it out keeps it. ' +
    'A `preset` in the body is ignored: the preset of a method never changes, and a method made from one keeps its kind and driver: ' +
    'a merged `isManual` that is not the preset kind is 422 on `isManual` (`preset_kind`), a merged `driver` that is not the preset driver is 422 on ' +
    '`driver` (`preset_driver`). A custom method may still change both. ' +
    `The merged gateway is validated as on create. ${VALIDATION} Audited. ` +
    "Only an owner may send `secret`, `webhookSecret` or `secondaryWebhookSecret` (a `null` for a method that has no second secret changes nothing and is open to the route's own permission), change `isManual` of a method that is automatic before or after the change (turning an automatic method manual included), or change the `driver` of such a method (`403 FORBIDDEN`, after the validation; decision 046). The other fields of an automatic method stay under the route's own permission.",
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:gateways',
  params: z.object({ id: zIdParam }),
  body: CreateGatewayBody.omit({ preset: true }).partial(),
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

/** `POST /admin/payment-gateways/:id/logo`: upload the logo of a payment method. */
export const uploadGatewayLogo = defineRoute({
  key: 'POST /admin/payment-gateways/:id/logo',
  summary: 'Upload the logo of a payment method',
  description:
    '`multipart/form-data` with one part named `file`: a JPEG, PNG or WebP picture, at most 2 MiB, 64 to 4096 pixels on each side ' +
    "(the checks of a service picture, with a logo's smaller minimum). The type is read from the content; the picture is cleaned before it is stored and stored once " +
    'under the SHA-256 of the cleaned bytes. It becomes the `logoUrl` of the method (replacing the previous one) and wins over the bundled ' +
    'logo of its `preset`. Refusals are `422` on `file` with the code: `empty`, `unsupported_type`, `corrupt`, `animated`, `too_small`, ' +
    '`too_large_dimensions`, `rotated`; more than 2 MiB is `413`. A JSON or form body has no file part, so it is `422` on `file`; a ' +
    'body of a type the API does not read is `415`. Audited (`uploaded logo for`).',
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:gateways',
  params: z.object({ id: zIdParam }),
  bodyType: 'multipart',
  body: z.object({ file: zUploadedFile }),
  success: { status: 200, schema: PaymentGatewaySchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'PAYLOAD_TOO_LARGE',
    'UNSUPPORTED_MEDIA_TYPE',
    'RATE_LIMITED',
    'UNAVAILABLE',
  ],
  examples: {
    response: {
      ...bank,
      logoUrl: '/store/v1/media/9f2b1c7a4d6e8f003a5b7c9d1e2f4a6b8c0d2e4f61728394a5b6c7d8e9f0a1b2.png',
    },
  },
});

/** `DELETE /admin/payment-gateways/:id/logo`: remove the uploaded logo of a payment method. */
export const removeGatewayLogo = defineRoute({
  key: 'DELETE /admin/payment-gateways/:id/logo',
  summary: 'Remove the logo of a payment method',
  description:
    'The method has no uploaded logo any more (`logoUrl` becomes `null`; a frontend shows the bundled logo of its `preset`, or an icon). ' +
    'The stored file is kept. Answers `204` also when there was no logo. Audited (`removed logo of`).',
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'payments:gateways',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});
