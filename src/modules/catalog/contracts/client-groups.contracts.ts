// Route contracts of the merchant groups (map domain B, routes /admin/client-groups, stage 4): list, show, create, change and
// delete. Shapes match the console's ClientGroup (docs/contract/endpoints/catalog.md, RESOLUTIONS catalog-5 and catalog-17).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { NonNegativeMoney, PercentField } from './shared';

/** A rank as the console reads it: its stored kind, what it gives (`rankKind`) and how many accounts hold it (`accountCount`). */
const GroupRow = z.object({
  id: zId,
  name: z.string(),
  kind: z.string().describe('The stored kind: `b2b` for merchant groups, `b2c_retail` for the one storefront group.'),
  rankKind: z
    .enum(['retail', 'merchant'])
    .describe('What the rank gives its accounts: `merchant` for `b2b`, `retail` for every other kind.'),
  discountPercent: zDecimal.describe('Percent off the base price, four decimals: `"4.0000"` is 4 %.'),
  isDefault: z.boolean().describe('New merchants join the default group; exactly one group is the default.'),
  depositLimit: zMoney.describe('The most a merchant of the group may add in one deposit; 0 = no per-deposit limit.'),
  overdraftAllowed: z.boolean().describe('Whether merchants of the group may have a credit limit above zero.'),
  sort: z.number().int(),
  createdAt: zIsoDateTime,
  accountCount: z
    .number()
    .int()
    .min(0)
    .describe(
      'Every account in the rank, whatever its status and kind of row (a guest row counts); the retail rank has a count too.',
    ),
});

const GROUP_EXAMPLE = {
  id: 2,
  name: 'Wholesale',
  kind: 'b2b',
  rankKind: 'merchant',
  discountPercent: '4.0000',
  isDefault: false,
  depositLimit: '20000.0000',
  overdraftAllowed: true,
  sort: 2,
  createdAt: '2025-09-01T09:30:00.000Z',
  accountCount: 7,
} as const;

/** The group name: trimmed, 1 to 80 characters. */
const GroupName = z.string().trim().min(1, 'Enter a group name.').max(80, 'Use at most 80 characters.');

const GroupFields = {
  discountPercent: PercentField,
  depositLimit: NonNegativeMoney,
  overdraftAllowed: z.boolean(),
  isDefault: z.boolean(),
};

/** `GET /admin/client-groups`: every rank, the storefront retail rank included. */
export const listClientGroups = defineRoute({
  key: 'GET /admin/client-groups',
  summary: 'List ranks',
  description:
    'Every rank with its kind (`kind` as stored, `rankKind` `merchant` or `retail`) and the number of accounts in it ' +
    '(`accountCount`, every account of the rank, guests included, the storefront retail rank, `kind: b2c_retail`, too). The console ' +
    'reads the whole list (`_end=200`) and counts tabs with `_start=0&_end=1`. Default order: `sort`.',
  tags: ['client-groups'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'groups:read',
  query: listQuery({
    sorts: ['sort', 'name', 'id', 'createdAt'],
    defaultSort: { field: 'sort', order: 'asc' },
    search: ['name'],
  }),
  success: { status: 200, schema: GroupRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [GROUP_EXAMPLE] },
});

/** `GET /admin/client-groups/:id`: one group. */
export const showClientGroup = defineRoute({
  key: 'GET /admin/client-groups/:id',
  summary: 'Show a rank',
  tags: ['client-groups'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'groups:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: GroupRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: GROUP_EXAMPLE },
});

/** `POST /admin/client-groups`: a new merchant group. */
export const createClientGroup = defineRoute({
  key: 'POST /admin/client-groups',
  summary: 'Create a rank',
  description:
    'The server makes the group a `b2b` group, so `rankKind` is `merchant` (the storefront retail group cannot be created), and puts it last in the order. ' +
    '`discountPercent` is plain decimal text from 0 to 100 with at most two decimals; `depositLimit` is `Money` of 0 or ' +
    'more, and 0 means no per-deposit limit. ' +
    '`isDefault: true` takes the default mark off the old default group in the same transaction. Fields left out are 0 or ' +
    'false. A name that another group already has (case-insensitive) is `422` on `name`.',
  tags: ['client-groups'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'groups:create',
  body: z.object({
    name: GroupName,
    discountPercent: GroupFields.discountPercent.optional(),
    depositLimit: GroupFields.depositLimit.optional(),
    overdraftAllowed: GroupFields.overdraftAllowed.optional(),
    isDefault: GroupFields.isDefault.optional(),
  }),
  success: { status: 201, schema: GroupRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      name: 'Wholesale',
      discountPercent: '4',
      depositLimit: '20000.0000',
      overdraftAllowed: true,
      isDefault: false,
    },
    response: { ...GROUP_EXAMPLE, accountCount: 0 },
  },
});

/** `PATCH /admin/client-groups/:id`: change some fields of a group. */
export const updateClientGroup = defineRoute({
  key: 'PATCH /admin/client-groups/:id',
  summary: 'Change a rank',
  description:
    'Only the keys sent change (the console sends a diff). A new discount prices the next order of the merchants in the group; ' +
    'open orders keep their `pricing_snapshot`. `isDefault: true` moves the default mark here; `isDefault: false` on the default ' +
    'group is `409 DEFAULT_GROUP_REQUIRED` (make another group the default instead), and the storefront group cannot be the ' +
    'default (`422` on `isDefault`). `overdraftAllowed: false` is `422` on `overdraftAllowed` while any merchant of the group ' +
    'has a credit limit above zero (user rule 2); `overdraftAllowed: true` on the storefront retail rank is `422` on ' +
    '`overdraftAllowed` (code `retail_no_credit`: the retail rank never allows credit). A duplicate name is `422` on `name`.',
  tags: ['client-groups'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'groups:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({
      name: GroupName.optional(),
      discountPercent: GroupFields.discountPercent.optional(),
      depositLimit: GroupFields.depositLimit.optional(),
      overdraftAllowed: GroupFields.overdraftAllowed.optional(),
      isDefault: GroupFields.isDefault.optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: GroupRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'DEFAULT_GROUP_REQUIRED'],
  examples: { request: { discountPercent: '5' }, response: { ...GROUP_EXAMPLE, discountPercent: '5.0000' } },
});

/** `DELETE /admin/client-groups/:id`: delete a rank that has no accounts. */
export const deleteClientGroup = defineRoute({
  key: 'DELETE /admin/client-groups/:id',
  summary: 'Delete a rank',
  description:
    'Refused with `409 GROUP_IN_USE` for the default group, the storefront retail group and a group that still has accounts ' +
    '(the detail says how many); the rank history of accounts never blocks it, because it keeps the names and kinds of both ranks ' +
    'without a foreign key. Otherwise, in one transaction: the group prices and the pricing rules of the group are deleted, ' +
    'its id is removed from the allowed groups of every service category, and the group is deleted. Orders keep their ' +
    'pricing snapshot, so no history is lost. One audit entry lists the removed pricing rule ids.',
  tags: ['client-groups'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'groups:delete',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'GROUP_IN_USE'],
});
