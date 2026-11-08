// Route contracts of the storefront customer's account (map domain I, stage 14, routes /store/v1/me): the details, the language,
// currency and marketing choices, and the customer's own orders. The storefront is another frontend: the shapes are the specs
// of docs/contract/MISMATCHES.md (feature 14b) and ALIGNMENT § 7.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIsoDateTime, zMoney } from '../../../common/contract';
import { ORDER_STATUSES } from '../../orders';
import { LocaleField } from './shared';

/** The customer's own account. */
export const StoreMeSchema = z.object({
  id: zId,
  email: z.string(),
  emailVerifiedAt: zIsoDateTime.nullable(),
  name: z.string(),
  phone: z.string(),
  country: z.string(),
  locale: z.string(),
  currency: z
    .string()
    .nullable()
    .describe('The ISO code of the currency prices are shown in; null when none is chosen.'),
  marketingOptIn: z.boolean(),
  hasPassword: z.boolean().describe('True once the customer has chosen a password.'),
  createdAt: zIsoDateTime,
});

/** An example account for the docs. */
export const STORE_ME_EXAMPLE = {
  id: 14,
  email: 'daniel.whitmore@example.com',
  emailVerifiedAt: '2026-10-12T09:30:00.000Z',
  name: 'Daniel Whitmore',
  phone: '',
  country: 'GB',
  locale: 'en',
  currency: 'GBP',
  marketingOptIn: true,
  hasPassword: true,
  createdAt: '2026-10-12T09:30:00.000Z',
} as const;

/** One of the customer's own orders, as the account page lists it. */
export const StoreOrderSchema = z.object({
  id: zId,
  status: z.enum(ORDER_STATUSES),
  service: z.object({ id: zId, name: z.string() }),
  imei: z.string().describe('The main input the customer gave; empty once it was erased.'),
  quantity: z.number().int(),
  totalPrice: zMoney.describe('USD, before VAT.'),
  taxAmount: zMoney.describe('VAT of the order.'),
  currency: z.string().describe('The ISO code of the currency the customer paid in.'),
  trackingToken: z
    .string()
    .nullable()
    .describe('The token of the order’s tracking page; null for an order without one.'),
  createdAt: zIsoDateTime,
  completedAt: zIsoDateTime.nullable(),
});

/** `GET /store/v1/me`. */
export const getMe = defineRoute({
  key: 'GET /store/v1/me',
  summary: 'My account',
  description:
    'The signed-in customer’s details, language, currency and marketing choice. Full sessions only. Never cached; repeats the ' +
    'CSRF token in `X-CSRF-Token` (the first call after every reload).',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  success: { status: 200, schema: StoreMeSchema },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'],
  examples: { response: STORE_ME_EXAMPLE },
});

/** `PATCH /store/v1/me`. */
export const updateMe = defineRoute({
  key: 'PATCH /store/v1/me',
  summary: 'Change language, currency and marketing consent',
  description:
    'Changes the fields sent. `currency` is the code of a currency the store shows (`422` on `currency` otherwise). A changed ' +
    '`marketingOptIn` writes a consent record with the request address and time (a withdrawn consent is a new record).',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  body: z.object({
    locale: LocaleField.optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, 'Choose a currency.')
      .toUpperCase()
      .optional(),
    marketingOptIn: z.boolean().optional(),
  }),
  success: { status: 200, schema: StoreMeSchema },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED', 'IP_NOT_ALLOWED'],
  examples: { request: { locale: 'ar', currency: 'GBP', marketingOptIn: false }, response: STORE_ME_EXAMPLE },
});

/** `GET /store/v1/me/orders`. */
export const listMyOrders = defineRoute({
  key: 'GET /store/v1/me/orders',
  summary: 'My orders and their status',
  description:
    'The signed-in customer’s own orders, newest first. Never another customer’s. Filter by `status` (repeat the key for IN); sort ' +
    'by `createdAt` (default) or `totalPrice`.',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  query: listQuery({
    sorts: ['createdAt', 'totalPrice'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: { status: { type: 'enum', values: ORDER_STATUSES } },
  }),
  success: { status: 200, schema: StoreOrderSchema },
  errors: ['VALIDATION_FAILED', 'UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'IP_NOT_ALLOWED'],
  examples: {
    response: [
      {
        id: 4021,
        status: 'completed',
        service: { id: 7, name: 'Vodafone UK iPhone Unlock' },
        imei: '353890110012345',
        quantity: 1,
        totalPrice: '13.7500',
        taxAmount: '2.7500',
        currency: 'GBP',
        trackingToken: 'Tq8Zr3LmV1xN7cHk2YwB5dFa9PsJ4uE6',
        createdAt: '2026-10-30T14:20:00.000Z',
        completedAt: '2026-10-30T14:31:00.000Z',
      },
    ],
  },
});
