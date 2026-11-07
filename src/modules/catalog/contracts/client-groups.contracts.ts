// Route contracts of the merchant groups (map domain B, routes /admin/client-groups, stage 4): list, show, create, change and
// delete. Shapes match the console's ClientGroup (docs/contract/endpoints/catalog.md, RESOLUTIONS catalog-5 and catalog-17).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { NonNegativeMoney, PercentField } from './shared';

/** A group as the console reads it. `merchantCount` is left out for the storefront retail group (no merchants join it). */
const GroupRow = z.object({
  id: zId,
  name: z.string(),
  kind: z.string().describe('`b2b` for merchant groups, `b2c_retail` for the one storefront group.'),
  discountPercent: zDecimal.describe('Percent off the base price, four decimals: `"4.0000"` is 4 %.'),
  isDefault: z.boolean().describe('New merchants join the default group; exactly one group is the default.'),
  earnThreshold: zMoney.describe(
    'USD of completed-order spend that promotes a merchant into this group; 0 = never a target.',
  ),
  depositLimit: zMoney.describe('The most a merchant of the group may add in one deposit; 0 = no per-deposit limit.'),
  overdraftAllowed: z.boolean().describe('Whether merchants of the group may have a credit limit above zero.'),
  sort: z.number().int(),
  createdAt: zIsoDateTime,
  merchantCount: z.number().int().min(0).optional(),
});

const GROUP_EXAMPLE = {
  id: 2,
  name: 'Wholesale',
  kind: 'b2b',
  discountPercent: '4.0000',
  isDefault: false,
  earnThreshold: '5000.0000',
  depositLimit: '20000.0000',
  overdraftAllowed: true,
  sort: 2,
  createdAt: '2025-09-01T09:30:00.000Z',
  merchantCount: 7,
} as const;

/** The group name: trimmed, 1 to 80 characters. */
const GroupName = z.string().trim().min(1, 'Enter a group name.').max(80, 'Use at most 80 characters.');

const GroupFields = {
  discountPercent: PercentField,
  earnThreshold: NonNegativeMoney,
  depositLimit: NonNegativeMoney,
  overdraftAllowed: z.boolean(),
  isDefault: z.boolean(),
};

/** `GET /admin/client-groups`: every group, the storefront retail group included. */
export const listClientGroups = defineRoute({
  key: 'GET /admin/client-groups',
  summary: 'List merchant groups',
  description:
    'Merchant groups with the number of merchants in each (`merchantCount`; left out for the storefront retail group, ' +
    '`kind: b2c_retail`, which is always included). The console reads the whole list (`_end=200`) and counts tabs with ' +
    '`_start=0&_end=1`. Default order: `sort`.',
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
  summary: 'Show a merchant group',
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
  summary: 'Create a merchant group',
  description:
    'The server makes the group a `b2b` group (the storefront retail group cannot be created) and puts it last in the order. ' +
    '`discountPercent` is plain decimal text from 0 to 100 with at most two decimals; the money fields are `Money` of 0 or ' +
    'more. A group with `earnThreshold` 0 is never a promotion target; `depositLimit` 0 means no per-deposit limit. ' +
    '`isDefault: true` takes the default mark off the old default group in the same transaction. Fields left out are 0 or ' +
    'false. A name that another group already has (case-insensitive) is `422` on `name`.',
  tags: ['client-groups'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'groups:create',
  body: z.object({
    name: GroupName,
    discountPercent: GroupFields.discountPercent.optional(),
    earnThreshold: GroupFields.earnThreshold.optional(),
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
      earnThreshold: '5000.0000',
      depositLimit: '20000.0000',
      overdraftAllowed: true,
      isDefault: false,
    },
    response: { ...GROUP_EXAMPLE, merchantCount: 0 },
  },
});

/** `PATCH /admin/client-groups/:id`: change some fields of a group. */
export const updateClientGroup = defineRoute({
  key: 'PATCH /admin/client-groups/:id',
  summary: 'Change a merchant group',
  description:
    'Only the keys sent change (the console sends a diff). A new discount prices the next order of the merchants in the group; ' +
    'open orders keep their `pricing_snapshot`. `isDefault: true` moves the default mark here; `isDefault: false` on the default ' +
    'group is `409 DEFAULT_GROUP_REQUIRED` (make another group the default instead), and the storefront group cannot be the ' +
    'default (`422` on `isDefault`). `overdraftAllowed: false` is `422` on `overdraftAllowed` while any merchant of the group ' +
    'has a credit limit above zero (user rule 2). A duplicate name is `422` on `name`.',
  tags: ['client-groups'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'groups:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({
      name: GroupName.optional(),
      discountPercent: GroupFields.discountPercent.optional(),
      earnThreshold: GroupFields.earnThreshold.optional(),
      depositLimit: GroupFields.depositLimit.optional(),
      overdraftAllowed: GroupFields.overdraftAllowed.optional(),
      isDefault: GroupFields.isDefault.optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: GroupRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'DEFAULT_GROUP_REQUIRED'],
  examples: { request: { discountPercent: '5' }, response: { ...GROUP_EXAMPLE, discountPercent: '5.0000' } },
});

/** `DELETE /admin/client-groups/:id`: delete a group that has no merchants. */
export const deleteClientGroup = defineRoute({
  key: 'DELETE /admin/client-groups/:id',
  summary: 'Delete a merchant group',
  description:
    'Refused with `409 GROUP_IN_USE` for the default group, the storefront retail group and a group that still has merchants ' +
    '(the detail says how many). Otherwise, in one transaction: the group prices and the pricing rules of the group are deleted, ' +
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
