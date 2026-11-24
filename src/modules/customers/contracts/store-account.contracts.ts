// Route contracts of the retail account's own area (map domain I, stage 14, routes /store/v1/me): the details, currency and marketing
// choices, and the account's own shop orders. The shop is another frontend: the shapes are the specs of docs/contract/MISMATCHES.md
// (feature 14b) and ALIGNMENT § 7. The details are `AccountMe`, the shape both `me` routes share (decision 064).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIsoDateTime, zMoney } from '../../../common/contract';
import { ORDER_STATUSES } from '../../orders';
import { CountryField, NameField, PhoneField } from './shared';

/**
 * The retail account's own account, as `AccountMe`.
 *
 * Why: `GET /client/auth/me` and `GET /store/v1/me` answer the same keys for every rank (decision 064), so the shop reads one shape from
 * either family. The identity module declares the same keys for the merchant route (`AccountMeShape`); a unit test keeps the two key sets
 * equal. `username` and `company` are empty text for a retail account, never `null`.
 */
export const StoreMeSchema = z.object({
  id: zId,
  name: z.string(),
  email: z.string(),
  status: z.enum(['active', 'suspended', 'blocked', 'anonymized']),
  rank: z.object({
    id: zId,
    name: z.string(),
    kind: z.enum(['retail', 'merchant']),
    discountPercent: zDecimal,
  }),
  hasPassword: z
    .boolean()
    .describe('True once the account has a password; false for an account that signs in by link.'),
  mustChangePassword: z.boolean(),
  twofaEnabled: z.boolean(),
  currency: z
    .string()
    .nullable()
    .describe('The ISO code of the currency prices are shown in; null when none is chosen.'),
  marketingOptIn: z.boolean(),
  company: z.string(),
  username: z.string().describe('The Dhru username of a merchant rank; empty for a retail account.'),
  phone: z.string(),
  country: z.string(),
  address: z.string(),
  taxId: z.string(),
  emailVerifiedAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});

/** An example account of the retail rank for the docs. */
export const STORE_ME_EXAMPLE = {
  id: 114,
  name: 'Daniel Whitmore',
  email: 'daniel.whitmore@example.com',
  status: 'active',
  rank: { id: 4, name: 'Storefront retail', kind: 'retail', discountPercent: '0.0000' },
  hasPassword: true,
  mustChangePassword: false,
  twofaEnabled: false,
  currency: 'GBP',
  marketingOptIn: true,
  company: '',
  username: '',
  phone: '',
  country: 'GB',
  address: '',
  taxId: '',
  emailVerifiedAt: '2026-10-12T09:30:00.000Z',
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
    'The signed-in retail account as `AccountMe`: its details, rank, currency and marketing choice, with the same keys as ' +
    '`GET /client/auth/me`. Full sessions only; a merchant rank is `403 RANK_NOT_ALLOWED` (it reads its own account on the `/client` ' +
    'family). Never cached; repeats the CSRF token in `X-CSRF-Token` (the first call after every reload).',
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
  summary: 'Change name, phone, country, currency and marketing consent',
  description:
    'Changes the fields sent; `{}` changes nothing. `name` (2 to 120 characters), `phone` (up to 40; an empty string clears it) and ' +
    "`country` (ISO-2) are the customer's own details, with the staff edit's rules: a **changed** country must be one the shop sells " +
    'to, i.e. with a current tax rate (`422` on `country` otherwise; offer the countries of `GET /store/v1/config` `taxRates`), and it ' +
    "resets `currency` to the country's default unless the same request sends `currency`. A country equal to the stored one is never " +
    'checked. The email cannot be changed here. `currency` is the code of a currency the store shows (`422` on `currency` otherwise). A ' +
    'changed `marketingOptIn` writes a consent record with the request address and time (a withdrawn consent is a new record).',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  body: z.object({
    name: NameField.optional(),
    phone: PhoneField.optional(),
    country: CountryField.optional(),
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
  examples: {
    request: {
      name: 'Daniel Whitmore',
      phone: '+44 7700 900123',
      country: 'GB',
      currency: 'GBP',
      marketingOptIn: false,
    },
    response: STORE_ME_EXAMPLE,
  },
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
