// Route contracts of merchant management (map domain A, routes /admin/clients, stage 2): list, show, create by invitation,
// approve, suspend, reactivate and move to another group. Shapes match the console's Client (docs/contract/endpoints/identity.md).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { MerchantCountry } from './merchant-auth.contracts';
import { EmailField, NameField, PersonRef } from './shared';

/** Wallet figures; only for staff who hold `wallet:read`. */
const Wallet = z.object({ balance: zMoney, reserved: zMoney, creditLimit: zMoney, available: zMoney });

/** The last 30 days of orders; only for staff who hold `wallet:read`. */
const Stats = z.object({
  orders: z.number().int().min(0),
  spend: zMoney,
  profit: zMoney,
  margin: zDecimal.nullable(),
  successRate: z.number().nullable(),
  lastOrderAt: zIsoDateTime.nullable(),
});

/** How the merchant signs in and what staff can still do about it (feature 20). */
const Security = z.object({
  hasPassword: z.boolean(),
  mustChangePassword: z.boolean(),
  passwordChangedAt: zIsoDateTime.nullable(),
  twofaEnabled: z.boolean(),
  lastLoginAt: zIsoDateTime.nullable(),
  lastLoginIp: z.string().nullable(),
  activeSessions: z.number().int().min(0),
  linkSentAt: zIsoDateTime.nullable(),
  verificationSentAt: zIsoDateTime.nullable(),
});

/** Why, when and by whom the merchant was suspended (feature 20). */
const Suspension = z.object({ at: zIsoDateTime.nullable(), reason: z.string().nullable(), by: PersonRef.nullable() });

/**
 * A merchant as the console reads it. Never carries a password hash, TOTP data, Telegram chat id or preferences.
 *
 * The keys of feature 20 (`address` to `suspension`) are optional in the schema, because the console's recorded fixtures are
 * validated against it, and always sent by the server.
 */
const ClientRow = z.object({
  id: zId,
  createdAt: zIsoDateTime,
  name: z.string(),
  email: z.string(),
  country: z.string(),
  username: z.string(),
  company: z.string(),
  phone: z.string(),
  groupId: zId,
  referralCode: z.string(),
  emailVerifiedAt: zIsoDateTime.nullable(),
  status: z.enum(['active', 'suspended', 'pending']),
  kycStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
  group: z.object({ id: zId, name: z.string(), discountPercent: zDecimal }).nullable(),
  referredBy: PersonRef.nullable(),
  address: z.string().optional(),
  taxId: z.string().optional(),
  internalNotes: z.string().optional(),
  telegramLinked: z.boolean().optional(),
  security: Security.optional(),
  suspension: Suspension.nullable().optional(),
  wallet: Wallet.optional(),
  stats: Stats.optional(),
});

const CLIENT_EXAMPLE = {
  id: 1,
  createdAt: '2025-09-01T09:30:00.000Z',
  name: 'Zain Mobile Hub',
  email: 'ops@zainmobilehub.example',
  country: 'JO',
  username: 'zain-mobile-hub',
  company: 'Zain Mobile Hub',
  phone: '',
  groupId: 3,
  referralCode: 'GSM0001',
  emailVerifiedAt: '2025-09-01T10:30:00.000Z',
  status: 'active',
  kycStatus: 'approved',
  group: { id: 3, name: 'VIP', discountPercent: '8.0000' },
  referredBy: null,
  address: 'Abdali Boulevard, Amman',
  taxId: 'JO-1234567',
  internalNotes: 'Pays by bank transfer on Sundays.',
  telegramLinked: false,
  security: {
    hasPassword: true,
    mustChangePassword: false,
    passwordChangedAt: '2025-09-01T10:35:00.000Z',
    twofaEnabled: true,
    lastLoginAt: '2026-11-01T09:30:00.000Z',
    lastLoginIp: '203.0.113.24',
    activeSessions: 2,
    linkSentAt: null,
    verificationSentAt: null,
  },
  suspension: null,
  wallet: { balance: '1480.0000', reserved: '0.0000', creditLimit: '2000.0000', available: '3480.0000' },
} as const;

/** `GET /admin/clients`: the merchants. */
export const listClients = defineRoute({
  key: 'GET /admin/clients',
  summary: 'List merchants',
  description:
    'Merchants of any status with their group and referrer. `wallet` and `stats` are sent only to staff who hold ' +
    '`wallet:read` (MISMATCHES B26). `q` is a case-insensitive contains over name, email, company, username and country. ' +
    'Default order: name.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:read',
  query: listQuery({
    sorts: ['name', 'status', 'createdAt', 'id'],
    defaultSort: { field: 'name', order: 'asc' },
    filters: {
      id: { type: 'id', ops: ['eq'] },
      status: { type: 'enum', values: ['active', 'suspended', 'pending'], ops: ['eq', 'ne'] },
      groupId: { type: 'id', ops: ['eq'] },
    },
    search: ['name', 'email', 'company', 'username', 'country'],
  }),
  success: { status: 200, schema: ClientRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [CLIENT_EXAMPLE] },
});

/** `GET /admin/clients/:id`: one merchant. */
export const showClient = defineRoute({
  key: 'GET /admin/clients/:id',
  summary: 'Show a merchant',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: ClientRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: CLIENT_EXAMPLE },
});

/** `POST /admin/clients`: invite a new merchant. */
export const createClient = defineRoute({
  key: 'POST /admin/clients',
  summary: 'Invite a merchant',
  description:
    'Creates the merchant as `pending` with a generated Dhru username and referral code, opens its wallet and hold accounts ' +
    'in the same transaction (`MerchantAccounts.open`, with the credit limit), issues a one-hour invite token (hash only) ' +
    'and writes the outbox event `merchant.invited` (ids only). The merchant sets a password with ' +
    '`POST /client/auth/password/reset`; staff approve with `PATCH /admin/clients/:id`. A credit limit above zero needs a ' +
    'group that allows credit (user rule 2): `422` on `creditLimit` otherwise. `groupId` defaults to the default group. ' +
    'A `creditLimit` above zero also needs `wallet:credit_limit`, and a `groupId` other than the default group needs `groups:update` ' +
    '(`403 FORBIDDEN`, after the validation and before anything is written; decision 046).',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:create',
  body: z.object({
    name: NameField,
    email: EmailField,
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'Use a two-letter country code like JO.'),
    groupId: zId.optional(),
    creditLimit: zMoney.optional(),
    invite: z.literal(true),
  }),
  success: { status: 201, schema: ClientRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'EMAIL_TAKEN'],
  examples: {
    request: {
      name: 'Zain Mobile Hub',
      email: 'ops@zainmobilehub.example',
      country: 'JO',
      groupId: 3,
      creditLimit: '2000.0000',
      invite: true,
    },
    response: {
      ...CLIENT_EXAMPLE,
      status: 'pending',
      kycStatus: 'none',
      emailVerifiedAt: null,
      security: {
        hasPassword: false,
        mustChangePassword: false,
        passwordChangedAt: null,
        twofaEnabled: false,
        lastLoginAt: null,
        lastLoginIp: null,
        activeSessions: 0,
        linkSentAt: '2026-11-01T09:30:00.000Z',
        verificationSentAt: null,
      },
    },
  },
});

/** `PATCH /admin/clients/:id`: approve, suspend, reactivate, move to another group, or edit the details. */
export const updateClient = defineRoute({
  key: 'PATCH /admin/clients/:id',
  summary: 'Change a merchant',
  description:
    'One kind of change per call: a status, a group or details (a mix is `422` on the first key of the second kind). ' +
    '`status`: `active` from `pending` (approve) or `suspended` (reactivate); `suspended` from `active` or `pending` ' +
    '(declining an application) with a `reason` of 3 to 140 characters; any other change is `409 INVALID_TRANSITION`. A suspension ' +
    "ends the merchant's sessions, cancels every open link and refuses new orders; open orders keep processing and the wallet is " +
    'untouched; the staff reason stays internal. Approval, suspension and reactivation email the merchant. `groupId` moves the ' +
    'merchant (never to the storefront retail group, and not to a group without credit while the credit limit is above zero: ' +
    '`422` on `groupId`); it prices new orders only. Details (`name`, `company`, `phone`, `country`, `email`, `address`, ' +
    '`taxId`, `internalNotes`; several at once, a value equal to the stored one is not a change): changing the `email` cancels ' +
    'every open link, clears `emailVerifiedAt` and emails a new verification link (or the invitation while the merchant has no ' +
    'password) to the new address; the merchant stays signed in (`409 EMAIL_TAKEN` for an address in use, `429` after five ' +
    'email changes of one merchant in an hour). ' +
    'Besides `clients:update`: suspending, declining and reactivating also need `clients:security`; a group move needs `groups:update` (`403 FORBIDDEN`, decision 046).',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({
      status: z.enum(['active', 'suspended', 'pending']).optional(),
      reason: z.string().trim().max(500).optional(),
      groupId: zId.optional(),
      name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use at most 120 characters.').optional(),
      company: z.string().trim().max(160, 'Use at most 160 characters.').optional(),
      phone: z.string().trim().max(40, 'Use at most 40 characters.').optional(),
      country: MerchantCountry.optional(),
      email: EmailField.optional(),
      address: z.string().trim().max(300, 'Use at most 300 characters.').optional(),
      taxId: z.string().trim().max(40, 'Use at most 40 characters.').optional(),
      internalNotes: z.string().trim().max(2000, 'Use at most 2000 characters.').optional(),
    })
    .refine(
      (body) => Object.entries(body).some(([key, value]) => key !== 'reason' && value !== undefined),
      'Send a status, a group or details.',
    ),
  success: { status: 200, schema: ClientRow },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'INVALID_TRANSITION',
    'EMAIL_TAKEN',
    'RATE_LIMITED',
  ],
  examples: { request: { status: 'active' }, response: CLIENT_EXAMPLE },
});
