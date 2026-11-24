// Route contracts of the accounts of the staff console (map domain A, routes /admin/clients): the one list of every rank, the counts, the
// detail, make an account and edit it. Merchants, shop customers and guests are one kind of row (decision 064); the row is
// `AccountRowSchema`. The security tools, the rank change, block, privacy and the wallet routes under /admin/clients/:id have their own
// contracts in the modules that own them.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zMoney } from '../../../common/contract';
import { CLIENT_STATUSES } from '../db/schema';
import { ACCOUNT_RANK_KINDS, ACCOUNT_ROW_EXAMPLE, AccountRowSchema } from './account-row';
import { CountryField, EmailField, NameField } from './shared';

/** The answer of `POST /admin/clients`: the new account, and the temporary password once when staff chose that mode. */
const CreatedAccountSchema = AccountRowSchema.extend({ temporaryPassword: z.string().optional() });

/** The numbers of the chips and the header sentence of the Accounts page. */
const AccountCountsSchema = z.object({
  all: z.number().int().min(0),
  retail: z.number().int().min(0),
  merchant: z.number().int().min(0),
  guests: z.number().int().min(0),
  active: z.number().int().min(0),
  suspended: z.number().int().min(0),
  blocked: z.number().int().min(0),
  anonymized: z.number().int().min(0),
  invitationPending: z.number().int().min(0),
});

/** `GET /admin/clients`: every account, whatever its rank. */
export const listClients = defineRoute({
  key: 'GET /admin/clients',
  summary: 'List accounts',
  description:
    'Every account of any rank and status, guests included (one table, decision 064): without `rankKind` the list holds them all. ' +
    'Each row names its rank (`rank.kind` is `retail` or `merchant`), whether it has a login (`hasAccount`: false is a guest), ' +
    'whether an invitation waits for its first password (`invitationPending`), and the count and date of its orders (`ordersCount`, ' +
    '`lastOrderAt`, both doors, any status). `wallet` and `stats` are sent only to staff who hold `wallet:read`, and so is the sort ' +
    '`balance` (`403 FORBIDDEN` without it). Filters: `id`, `status` (repeat the key for several), `rankId`, `rankKind`, ' +
    '`hasAccount`, `country` and `invitationPending`. `q` is a case-insensitive contains over name, email, company and username. ' +
    'Default order: name.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:read',
  query: listQuery({
    sorts: ['name', 'createdAt', 'id', 'status', 'country', 'rank', 'ordersCount', 'lastOrderAt', 'balance'],
    defaultSort: { field: 'name', order: 'asc' },
    filters: {
      id: { type: 'id', ops: ['eq'] },
      status: { type: 'enum', values: CLIENT_STATUSES, ops: ['eq', 'ne'] },
      rankId: { type: 'id', ops: ['eq'] },
      rankKind: { type: 'enum', values: ACCOUNT_RANK_KINDS, ops: ['eq'] },
      hasAccount: { type: 'boolean' },
      country: { type: 'string', ops: ['eq'] },
      invitationPending: { type: 'boolean' },
    },
    search: ['name', 'email', 'company', 'username'],
  }),
  success: { status: 200, schema: AccountRowSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [ACCOUNT_ROW_EXAMPLE] },
});

/** `GET /admin/clients/counts`: the numbers of the Accounts page in one aggregate. */
export const countClients = defineRoute({
  key: 'GET /admin/clients/counts',
  summary: 'Count accounts',
  description:
    'One aggregate over every account, independent of any filter and never cached: `all`, `retail` and `merchant` (by rank kind; ' +
    'guests are retail), `guests` (no login), one number per status, and `invitationPending` (a login, no password yet, an active status).',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:read',
  success: { status: 200, schema: AccountCountsSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
  examples: {
    response: {
      all: 150,
      retail: 128,
      merchant: 22,
      guests: 31,
      active: 140,
      suspended: 6,
      blocked: 3,
      anonymized: 1,
      invitationPending: 4,
    },
  },
});

/** `GET /admin/clients/:id`: one account. */
export const showClient = defineRoute({
  key: 'GET /admin/clients/:id',
  summary: 'Show an account',
  description:
    'The row of the list for any rank and any status (a guest, a suspended and an anonymized account too). `security` is null for a guest.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: AccountRowSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: ACCOUNT_ROW_EXAMPLE },
});

/** `POST /admin/clients`: make an account. */
export const createClient = defineRoute({
  key: 'POST /admin/clients',
  summary: 'Make an account',
  description:
    'Makes an active account with a login. An omitted `groupId` is the retail rank; a merchant rank needs an Owner and also gets a ' +
    'generated Dhru username and its wallet and hold accounts. `creditLimit` and `company` are for merchant ranks only (`422` on a ' +
    'retail rank), and a credit limit above zero needs a rank that allows credit. `password.mode` is `reset_link` (the default: a one-hour ' +
    'link is mailed) or `temporary_password` (needs `clients:security`; the password is returned once in `temporaryPassword` and the ' +
    'answer is never cached). `409 EMAIL_TAKEN` when a login has the email; a guest that holds it is named with the field error code ' +
    '`guest`. A blocklisted email is `422` on `email`.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:create',
  body: z.object({
    name: NameField,
    email: EmailField,
    country: CountryField,
    phone: z.string().trim().max(40, 'Use at most 40 characters.').optional(),
    company: z.string().trim().max(160, 'Use at most 160 characters.').optional(),
    groupId: zId.optional(),
    creditLimit: zMoney.optional(),
    password: z.object({ mode: z.enum(['reset_link', 'temporary_password']) }).default({ mode: 'reset_link' }),
  }),
  success: { status: 201, schema: CreatedAccountSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'EMAIL_TAKEN'],
  examples: {
    request: {
      name: 'Zain Mobile Hub',
      email: 'ops@zainmobilehub.example',
      country: 'JO',
      company: 'Zain Mobile Hub',
      groupId: 3,
      creditLimit: '2000.0000',
      password: { mode: 'reset_link' },
    },
    response: {
      ...ACCOUNT_ROW_EXAMPLE,
      emailVerifiedAt: null,
      invitationPending: true,
      lastLoginAt: null,
      ordersCount: 0,
      lastOrderAt: null,
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
      stats: { orders: 0, spend: '0.0000', profit: '0.0000', margin: null, successRate: null, lastOrderAt: null },
    },
  },
});

/** `PATCH /admin/clients/:id`: change the status or the details of an account. */
export const updateClient = defineRoute({
  key: 'PATCH /admin/clients/:id',
  summary: 'Change an account',
  description:
    'One kind of change per call: a status or details (a mix is `422` on the first key of the second kind). `status` is `active` ' +
    '(reactivate a suspended account) or `suspended` (with a `reason` of 3 to 140 characters); any other change is ' +
    '`409 INVALID_TRANSITION`, and `blocked` and `anonymized` have their own routes (`422` on `status`). Details are `name`, ' +
    '`company`, `phone`, `country`, `email`, `address`, `taxId` and `internalNotes` (several at once; a value equal to the stored ' +
    'one is not a change). A `groupId` is refused with `422` (field `groupId`, code `use_rank_route`): the rank changes through ' +
    '`POST /admin/clients/:id/rank`. Suspending, reactivating and changing the email of an account with a login also need ' +
    '`clients:security`; reactivating a merchant-rank account that was suspended because it was never approved needs the Owner ' +
    '(`403 FORBIDDEN`). A guest cannot take an email that another guest or an account with a login uses (`409 EMAIL_TAKEN`, code ' +
    '`taken`). Any write on an anonymized account is `409 ANONYMIZED`.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({
      status: z.enum(['active', 'suspended']).optional(),
      reason: z.string().trim().max(500).optional(),
      groupId: zId.optional(),
      name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use at most 120 characters.').optional(),
      company: z.string().trim().max(160, 'Use at most 160 characters.').optional(),
      phone: z.string().trim().max(40, 'Use at most 40 characters.').optional(),
      country: CountryField.optional(),
      email: EmailField.optional(),
      address: z.string().trim().max(300, 'Use at most 300 characters.').optional(),
      taxId: z.string().trim().max(40, 'Use at most 40 characters.').optional(),
      internalNotes: z.string().trim().max(2000, 'Use at most 2000 characters.').optional(),
    })
    .refine(
      (body) => Object.entries(body).some(([key, value]) => key !== 'reason' && value !== undefined),
      'Send a status or details.',
    ),
  success: { status: 200, schema: AccountRowSchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'INVALID_TRANSITION',
    'EMAIL_TAKEN',
    'ANONYMIZED',
    'RATE_LIMITED',
  ],
  examples: { request: { status: 'active' }, response: ACCOUNT_ROW_EXAMPLE },
});
