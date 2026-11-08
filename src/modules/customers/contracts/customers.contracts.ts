// Route contracts of the admin customers (map domain I, stage 14): list, detail, create and edit. Shapes follow the console's
// `Customer` and `CustomerDetail` (src/features/customers/types) and docs/contract/endpoints/customers.md.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { CUSTOMER_STATUSES, RISK_LEVELS } from '../db/schema';
import {
  CountryField,
  CustomerStatusWire,
  EmailField,
  LocaleField,
  NameField,
  NotesField,
  PasswordModeField,
  PhoneField,
  RiskLevelWire,
} from './shared';

/**
 * One customer as the list, the create answer and the edit answer send it.
 *
 * Why: the console's `Customer`: the `customers` columns with the words narrowed, the two list aggregates, and the currency
 * as the id of the `currencies` row with its code next to it (RESOLUTIONS b2c-1, B148). `phone` is `''` when none.
 */
export const CustomerSchema = z.object({
  id: zId,
  email: z.string(),
  emailVerifiedAt: zIsoDateTime.nullable(),
  name: z.string(),
  phone: z.string(),
  country: z.string(),
  locale: z.string(),
  currency: zId.nullable().describe('The id of the currency the customer pays in; null when none (B148).'),
  currencyCode: z.string().nullable().optional().describe('The ISO code of that currency; null when none.'),
  hasAccount: z.boolean(),
  createdBy: zId.nullable().describe('The staff member who added the customer; null for self-signup or checkout.'),
  marketingOptIn: z.boolean(),
  riskLevel: RiskLevelWire,
  status: CustomerStatusWire,
  suspendedAt: zIsoDateTime.nullable(),
  suspendedReason: z.string().nullable(),
  suspendedBy: zId.nullable(),
  internalNotes: z.string(),
  lastLoginAt: zIsoDateTime.nullable(),
  firstOrderAt: zIsoDateTime.nullable(),
  totalSpent: zMoney.describe('USD, gross including VAT of the orders that were not rejected.'),
  anonymizedAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
  ordersCount: z.number().int().describe('Every order of the customer, whatever its status.'),
  lastOrderAt: zIsoDateTime.nullable(),
});

/** One line of the consent evidence of the customer's latest order. */
const ConsentRecordSchema = z.object({
  purpose: z.string(),
  document: z.string().nullable(),
  at: zIsoDateTime,
  ip: z.string(),
});

/** The detail: the list row plus the figures, the sign-in side, the latest consent evidence and the risk summary. */
export const CustomerDetailSchema = CustomerSchema.extend({
  stats: z.object({
    orders: z.number().int(),
    spent: zMoney,
    lastOrderAt: zIsoDateTime.nullable(),
    refunds: z.number().int(),
    tickets: z.number().int(),
    disputes: z.number().int(),
  }),
  account: z
    .object({
      emailVerified: z.boolean(),
      mustChangePassword: z.boolean(),
      passwordChangedAt: zIsoDateTime.nullable(),
      resetSentAt: zIsoDateTime.nullable(),
      activeSessions: z.number().int(),
      lastIp: z.string().nullable(),
    })
    .nullable()
    .describe('Null for a guest.'),
  latestConsents: z
    .object({ orderId: zId, records: z.array(ConsentRecordSchema) })
    .nullable()
    .describe('Null for a customer without orders.'),
  risk: z.object({
    highestScore: z.number().int().nullable(),
    signals: z.array(z.object({ text: z.string(), orderId: zId })),
  }),
});

const sample = {
  id: 14,
  email: 'daniel.whitmore@example.com',
  emailVerifiedAt: '2026-10-12T09:30:00.000Z',
  name: 'Daniel Whitmore',
  phone: '+447700900123',
  country: 'GB',
  locale: 'en',
  currency: 2,
  currencyCode: 'GBP',
  hasAccount: true,
  createdBy: null,
  marketingOptIn: true,
  riskLevel: 'low',
  status: 'active',
  suspendedAt: null,
  suspendedReason: null,
  suspendedBy: null,
  internalNotes: '',
  lastLoginAt: '2026-11-02T18:04:00.000Z',
  firstOrderAt: '2026-10-12T09:41:00.000Z',
  totalSpent: '48.9000',
  anonymizedAt: null,
  createdAt: '2026-10-12T09:30:00.000Z',
  ordersCount: 3,
  lastOrderAt: '2026-10-30T14:20:00.000Z',
} as const;

const detailSample = {
  ...sample,
  stats: { orders: 3, spent: '48.9000', lastOrderAt: '2026-10-30T14:20:00.000Z', refunds: 0, tickets: 1, disputes: 0 },
  account: {
    emailVerified: true,
    mustChangePassword: false,
    passwordChangedAt: '2026-10-12T09:35:00.000Z',
    resetSentAt: null,
    activeSessions: 1,
    lastIp: '203.0.113.24',
  },
  latestConsents: {
    orderId: 4021,
    records: [
      { purpose: 'terms', document: 'Terms of service v3.2', at: '2026-10-30T14:19:19.000Z', ip: '203.0.113.24' },
      { purpose: 'withdrawal_waiver', document: null, at: '2026-10-30T14:19:22.000Z', ip: '203.0.113.24' },
    ],
  },
  risk: { highestScore: 12, signals: [{ text: 'New device', orderId: 4021 }] },
} as const;

/** `GET /admin/customers`. */
export const listCustomers = defineRoute({
  key: 'GET /admin/customers',
  summary: 'Storefront customers',
  description:
    'Customers of the storefront (guests and accounts). Filters: `status` and `riskLevel` (repeat the key for IN), `country`, ' +
    '`hasAccount`. `q` searches name and email. Sort by `name`, `country`, `hasAccount`, `ordersCount`, `totalSpent` (default, ' +
    'highest first), `lastOrderAt`, `riskLevel` (low, medium, high) or `status`. `ordersCount` and `lastOrderAt` are worked ' +
    'out from the customer’s orders.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:read',
  query: listQuery({
    sorts: ['name', 'country', 'hasAccount', 'ordersCount', 'totalSpent', 'lastOrderAt', 'riskLevel', 'status'],
    defaultSort: { field: 'totalSpent', order: 'desc' },
    filters: {
      status: { type: 'enum', values: CUSTOMER_STATUSES },
      riskLevel: { type: 'enum', values: RISK_LEVELS },
      country: { type: 'string', ops: ['eq'] },
      hasAccount: { type: 'boolean' },
    },
    search: ['name', 'email'],
  }),
  success: { status: 200, schema: CustomerSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [sample] },
});

/** `GET /admin/customers/:id`. */
export const getCustomer = defineRoute({
  key: 'GET /admin/customers/:id',
  summary: 'One customer with the detail figures',
  description:
    'The list row plus `stats`, `account` (null for a guest), `latestConsents` (the consent evidence of the latest order, null ' +
    'without orders) and `risk` (the highest score and the signals of the customer’s orders, newest first, at most 20).',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: CustomerDetailSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: detailSample },
});

/** `POST /admin/customers`. */
export const createCustomer = defineRoute({
  key: 'POST /admin/customers',
  summary: 'Add a customer with an account',
  description:
    'Creates a customer with an account. `password.mode` `reset_link` emails a one-hour, single-use invitation to choose a ' +
    'password; `temporary_password` makes a 14-character password that the answer shows once (`Cache-Control: no-store`) and ' +
    'the customer must change at the first sign-in. `409 EMAIL_TAKEN` when another customer, guest or account, has the email; ' +
    '`422` on `email` when it is on the blocklist. `country` must be one the storefront sells to (it has a current tax rate), else ' +
    "`422` on `country`. The currency is the country's storefront currency, else USD. Audited without any password.",
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:create',
  body: z.object({
    name: NameField,
    email: EmailField,
    country: CountryField,
    locale: LocaleField,
    phone: PhoneField.optional(),
    password: z.object({ mode: PasswordModeField }),
  }),
  success: { status: 201, schema: CustomerSchema.extend({ temporaryPassword: z.string().optional() }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'EMAIL_TAKEN'],
  examples: {
    request: {
      name: 'Daniel Whitmore',
      email: 'daniel.whitmore@example.com',
      country: 'GB',
      locale: 'en',
      phone: '+447700900123',
      password: { mode: 'reset_link' },
    },
    response: { ...sample, hasAccount: true, emailVerifiedAt: null, ordersCount: 0, totalSpent: '0.0000' },
  },
});

/** `PATCH /admin/customers/:id`. */
export const updateCustomer = defineRoute({
  key: 'PATCH /admin/customers/:id',
  summary: 'Edit a customer',
  description:
    'Changes the fields sent: `name`, `email`, `country`, `locale`, `phone`, `internalNotes` (at most 300 characters). A ' +
    'different email clears `emailVerifiedAt` and voids every link already sent to the customer (they went to the old address); for an account it also sends a new verification email. A country change ' +
    'derives the currency again (storefront currency of the country, else USD); a new country with no current tax rate is `422` on ' +
    '`country`. `409 ANONYMIZED` for an anonymized customer, `409 EMAIL_TAKEN`, `422` on `email` for a ' +
    'blocklisted address. Audited with the old and new values.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:update',
  params: z.object({ id: zIdParam }),
  body: z.object({
    name: NameField.optional(),
    email: EmailField.optional(),
    country: CountryField.optional(),
    locale: LocaleField.optional(),
    phone: PhoneField.optional(),
    internalNotes: NotesField.optional(),
  }),
  success: { status: 200, schema: CustomerSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'ANONYMIZED', 'EMAIL_TAKEN', 'VALIDATION_FAILED'],
  examples: { request: { phone: '+447700900124', internalNotes: 'Prefers email.' }, response: sample },
});
