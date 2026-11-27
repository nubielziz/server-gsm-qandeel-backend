// Route contracts of the service categories (map domain B, routes /admin/service-categories, stage 4): list, show, create,
// change and delete. Shapes match the console's ServiceCategory (docs/contract/endpoints/catalog.md, RESOLUTIONS catalog-6,
// catalog-10 and catalog-13). English only (decision 039, B224): a category has one name, `name`.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam } from '../../../common/contract';
import { SERVICE_TYPES } from '../db/schema';
import { MAX_ORDER_ITEMS } from './service-grid.contracts';

/** The four Dhru service types, as the console's `ServiceType`. */
const ServiceTypeField = z.enum(SERVICE_TYPES);

/** A category as the console reads it. */
const CategoryRow = z.object({
  id: zId,
  name: z.string(),
  type: ServiceTypeField,
  allowedGroupIds: z.array(zId).describe('The merchant groups that can see the category; empty means every group.'),
  sort: z.number().int().min(0),
  isActive: z.boolean(),
  serviceCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Live services in the category (archived ones are not counted).'),
});

const CATEGORY_EXAMPLE = {
  id: 4,
  name: 'Carrier unlock',
  type: 'imei',
  allowedGroupIds: [],
  sort: 4,
  isActive: true,
  serviceCount: 8,
} as const;

/** The category name: trimmed, 1 to 80 characters. */
const CategoryName = z.string().trim().min(1, 'Enter a name.').max(80, 'Use at most 80 characters.');
const GroupIds = z.array(zId).max(200, 'Choose at most 200 groups.');
/** The largest position a category may be given (the same bound as a service's position, decision 063). */
const MAX_CATEGORY_SORT = 1_000_000;
const SortField = z
  .number()
  .int('Enter a whole number.')
  .min(0, 'Enter a whole number, 0 or more.')
  .max(MAX_CATEGORY_SORT);

/** `GET /admin/service-categories`: every category with its live service count. */
export const listCategories = defineRoute({
  key: 'GET /admin/service-categories',
  summary: 'List service categories',
  description:
    'Categories (the Dhru GROUPNAME) with `serviceCount`, the live services in each. The console reads the whole list ' +
    '(`_end=200`). Default order: `sort`.',
  tags: ['service-categories'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:read',
  query: listQuery({
    sorts: ['sort', 'name', 'id'],
    defaultSort: { field: 'sort', order: 'asc' },
    search: ['name'],
  }),
  success: { status: 200, schema: CategoryRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [CATEGORY_EXAMPLE] },
});

/** `GET /admin/service-categories/:id`: one category. */
export const showCategory = defineRoute({
  key: 'GET /admin/service-categories/:id',
  summary: 'Show a service category',
  tags: ['service-categories'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: CategoryRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: CATEGORY_EXAMPLE },
});

/** `POST /admin/service-categories`: a new category. */
export const createCategory = defineRoute({
  key: 'POST /admin/service-categories',
  summary: 'Create a service category',
  description:
    'A name is unique within its type, ignoring case and surrounding spaces: a repeat is `422` on `name` (also when two ' +
    'requests race). Unknown group ids are `422` on `allowedGroupIds`. Fields left out: `allowedGroupIds` empty, `sort` last, ' +
    '`isActive` true.',
  tags: ['service-categories'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:create',
  body: z.object({
    name: CategoryName,
    type: ServiceTypeField,
    allowedGroupIds: GroupIds.optional(),
    sort: SortField.optional(),
    isActive: z.boolean().optional(),
  }),
  success: { status: 201, schema: CategoryRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      name: 'Carrier unlock',
      type: 'imei',
      allowedGroupIds: [],
      sort: 4,
      isActive: true,
    },
    response: { ...CATEGORY_EXAMPLE, serviceCount: 0 },
  },
});

/** `PATCH /admin/service-categories/:id`: change some fields of a category. */
export const updateCategory = defineRoute({
  key: 'PATCH /admin/service-categories/:id',
  summary: 'Change a service category',
  description:
    'Only the keys sent change. The name stays unique within the type (the new type too when only the type changes). A type ' +
    'change is `422` on `type` while live services are in the category: they must move first (archived services follow ' +
    'the change).',
  tags: ['service-categories'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({
      name: CategoryName.optional(),
      type: ServiceTypeField.optional(),
      allowedGroupIds: GroupIds.optional(),
      sort: SortField.optional(),
      isActive: z.boolean().optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: CategoryRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { isActive: false }, response: { ...CATEGORY_EXAMPLE, isActive: false } },
});

/** `POST /admin/service-categories/order`: store the order of categories (the console's Group view). */
export const orderCategories = defineRoute({
  key: 'POST /admin/service-categories/order',
  summary: 'Set the order of service categories',
  description:
    'Sets the position (`sort`) of 1 to ' +
    String(MAX_ORDER_ITEMS) +
    ' categories (the groups of the console) in one transaction: either every position is saved or none is. It does what `PATCH ' +
    '/admin/service-categories/:id` does when only `sort` is sent, once for the whole call: the same permission, the cached merchant ' +
    'price lists start over once, and one audit entry (`changed the order of`, entity `category`) names the categories that moved ' +
    'with their old and new positions (the first 200). A position is a whole number from 0 to ' +
    String(MAX_CATEGORY_SORT) +
    '; merchants and API clients read categories by this number, then the id. A category already at its position is left alone. ' +
    'A category that is listed twice or is unknown is `422` on `items.N.id` (N the later of two equal ids; every problem comes ' +
    'back together) and nothing is saved. The answer says how many categories changed. The categories are locked in id order, so ' +
    "two saves never interleave. The search index is not told: it holds a category's name and id, never its position (decision 078).",
  tags: ['service-categories'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:update',
  body: z.object({
    items: z
      .array(
        z.object({
          id: zId,
          sort: z
            .number()
            .int('Enter a whole number.')
            .min(0, 'Enter 0 or more.')
            .max(MAX_CATEGORY_SORT, `Use at most ${MAX_CATEGORY_SORT}.`),
        }),
      )
      .min(1, 'Send at least one category.')
      .max(MAX_ORDER_ITEMS, `Send at most ${MAX_ORDER_ITEMS} categories at a time.`),
  }),
  success: {
    status: 200,
    schema: z.object({ updated: z.number().int().min(0).describe('How many categories changed position.') }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      items: [
        { id: 4, sort: 1 },
        { id: 5, sort: 2 },
      ],
    },
    response: { updated: 2 },
  },
});

/** `DELETE /admin/service-categories/:id`: delete a category no service uses. */
export const deleteCategory = defineRoute({
  key: 'DELETE /admin/service-categories/:id',
  summary: 'Delete a service category',
  description:
    'Deleted only when no service row, live or archived, belongs to it; its category pricing rules are deleted in the same ' +
    'transaction. Live services: `409 CATEGORY_IN_USE` ("move them to another category first"). Only archived services left: ' +
    '`409 CATEGORY_IN_USE` too, with the advice to turn the category off instead.',
  tags: ['service-categories'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:delete',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'CATEGORY_IN_USE'],
});
