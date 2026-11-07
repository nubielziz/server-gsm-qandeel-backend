// Route contracts of the services (map domain B, routes /admin/services, stage 4): list, show, create, change, delete and
// the replace-all custom fields and option lists. Shapes match the console's Service and ServiceDetail
// (docs/contract/endpoints/catalog.md, RESOLUTIONS catalog-1, -2, -3, -9, -11, -13 and -14).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zMoney } from '../../../common/contract';
import { SERVICE_FIELD_TYPES, SERVICE_OPTION_LISTS, SERVICE_TYPES } from '../db/schema';
import { NamedRef, NonNegativeMoney, PositiveMoney } from './shared';

/** The longest verification window a service may offer: 30 days. */
const MAX_VERIFY_WINDOW_H = 720;

const ServiceTypeField = z.enum(SERVICE_TYPES);
const StatusField = z.enum(['active', 'disabled']);
const ExecutionModeField = z.enum(['auto', 'manual']);

/** A service as the console reads it, with the figures worked out in SQL (catalog-1). */
const ServiceRow = z.object({
  id: zId,
  name: z.string(),
  code: z.string(),
  type: ServiceTypeField,
  status: StatusField,
  executionMode: ExecutionModeField.describe(
    '`auto` goes through a supplier, `manual` to staff (`services.fulfillment`).',
  ),
  categoryId: zId,
  category: NamedRef.nullable(),
  basePrice: zMoney,
  cost: zMoney.describe(
    'The effective cost (B117): the larger of the service cost and the first active supplier link cost.',
  ),
  costChangedFrom: zMoney
    .nullable()
    .describe('The previous effective cost when it rose since the price was set; else null.'),
  minProfit: zMoney.describe(
    'The service minimum profit, or the default policy `max(6 % of cost, 0.02)` when it has none.',
  ),
  floorPrice: zMoney.describe('cost + minProfit.'),
  marginPct: zDecimal.describe('(basePrice - cost) / basePrice x 100, four decimals.'),
  belowFloor: z.boolean(),
  slaMinutes: z.number().int().min(1),
  supplier: NamedRef.nullable().describe('The first active supplier link by priority.'),
  fallbackSupplier: NamedRef.nullable().describe('The second active supplier link by priority.'),
  allowCancel: z
    .boolean()
    .optional()
    .describe(
      'Whether a merchant may cancel an order of this service that was never sent. Always sent; optional in the schema only ' +
        'because the console does not read it yet.',
    ),
  allowVerify: z
    .boolean()
    .optional()
    .describe(
      'Whether a merchant may ask for the verification of a completed order. Always sent; optional in the schema only ' +
        'because the console does not read it yet.',
    ),
  verifyWindowH: z
    .number()
    .int()
    .min(0)
    .max(MAX_VERIFY_WINDOW_H)
    .optional()
    .describe(
      'How many hours after completion the merchant may ask for verification; `0` means no window. Always sent; optional in ' +
        'the schema only because the console does not read it yet.',
    ),
});

/** One custom field of a service (Dhru `Requires.Custom`). */
const FieldRow = z.object({
  key: z.string(),
  label: z.string(),
  fieldType: z.enum(SERVICE_FIELD_TYPES),
  required: z.boolean(),
  options: z.array(z.string()).describe('The choices of a `select` field.'),
  regex: z.string().describe('`""` when there is no pattern.'),
  supplierKey: z.string().describe('The field name the supplier expects; `""` when none.'),
});

/** One entry of a model, network or MEP list. */
const OptionRow = z.object({
  list: z.enum(SERVICE_OPTION_LISTS),
  value: z.string(),
  label: z.string(),
  supplierValue: z.string(),
});

const ServiceDetailRow = ServiceRow.extend({
  fields: z.array(FieldRow),
  options: z.array(OptionRow),
  groupPrices: z.array(z.object({ groupId: zId, price: zMoney })),
});

const SERVICE_EXAMPLE = {
  id: 5,
  name: 'AT&T USA Unlock',
  code: 'IMEI-ATT-USA',
  type: 'imei',
  status: 'active',
  executionMode: 'auto',
  categoryId: 4,
  category: { id: 4, name: 'Carrier unlock' },
  basePrice: '17.2800',
  cost: '13.5000',
  costChangedFrom: null,
  minProfit: '0.8100',
  floorPrice: '14.3100',
  marginPct: '21.8750',
  belowFloor: false,
  slaMinutes: 1440,
  supplier: { id: 3, name: 'DHRU Pro' },
  fallbackSupplier: null,
  allowCancel: false,
  allowVerify: false,
  verifyWindowH: 0,
} as const;
const FIELD_EXAMPLE = {
  key: 'imei',
  label: 'IMEI',
  fieldType: 'text',
  required: true,
  options: [],
  regex: '^[0-9]{15}$',
  supplierKey: 'IMEI',
} as const;
const OPTION_EXAMPLE = { list: 'model', value: 'iphone15', label: 'iPhone 15', supplierValue: '' } as const;

const ServiceName = z.string().trim().min(1, 'Enter a name.').max(120, 'Use at most 120 characters.');
const ServiceCode = z.string().trim().min(1, 'Enter a code.').max(40, 'Use at most 40 characters.');
const SlaMinutes = z.number().int('Enter whole minutes.').min(1, 'Enter minutes, 1 or more.').max(2_147_483_647);
const AllowCancel = z
  .boolean()
  .describe('Lets a merchant cancel an order of this service that was never sent (default `false`).');
const AllowVerify = z
  .boolean()
  .describe('Lets a merchant ask for the verification of a completed order (default `false`).');
const VerifyWindowH = z
  .number()
  .int('Enter whole hours.')
  .min(0, 'Enter 0 or more hours.')
  .max(MAX_VERIFY_WINDOW_H, `Use at most ${MAX_VERIFY_WINDOW_H} hours.`)
  .describe('Hours after completion in which a merchant may ask for verification; `0` means no window (default `0`).');

/** `GET /admin/services`: the catalog with its worked-out figures. */
export const listServices = defineRoute({
  key: 'GET /admin/services',
  summary: 'List services',
  description:
    'Live services (archived ones are gone) with category, supplier chain and the figures worked out in SQL: `cost` is the ' +
    'effective cost, `floorPrice` = cost + `minProfit`, `marginPct` and `belowFloor`. Filters: `type`, `status`, ' +
    '`categoryId`, `belowFloor`; they combine. `q` is a case-insensitive contains over name, code and category name. ' +
    'Sorts: name (default), type, cost, basePrice.',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:read',
  query: listQuery({
    sorts: ['name', 'type', 'cost', 'basePrice', 'id'],
    defaultSort: { field: 'name', order: 'asc' },
    filters: {
      type: { type: 'enum', values: SERVICE_TYPES, ops: ['eq', 'ne'] },
      status: { type: 'enum', values: ['active', 'disabled'], ops: ['eq', 'ne'] },
      categoryId: { type: 'id', ops: ['eq'] },
      belowFloor: { type: 'boolean' },
    },
    search: ['name', 'code', 'category.name'],
  }),
  success: { status: 200, schema: ServiceRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [SERVICE_EXAMPLE] },
});

/** `GET /admin/services/:id`: one service with its parts. */
export const showService = defineRoute({
  key: 'GET /admin/services/:id',
  summary: 'Show a service',
  description:
    'The list row plus the complete custom `fields` (in order), the option lists in `options` and the `groupPrices`. The ' +
    'replace-all dialogs start from this read.',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: ServiceDetailRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: {
    response: {
      ...SERVICE_EXAMPLE,
      fields: [FIELD_EXAMPLE],
      options: [OPTION_EXAMPLE],
      groupPrices: [{ groupId: 3, price: '15.9000' }],
    },
  },
});

/** `POST /admin/services`: a new service. */
export const createService = defineRoute({
  key: 'POST /admin/services',
  summary: 'Create a service',
  description:
    'Starts `active`, `auto`, with a fixed price mode, the `block_open` duplicate rule, no minimum profit of its own and a cost ' +
    'of 0 until a supplier is linked or imported. The type must be the type of the category: `422` on `categoryId` ' +
    'otherwise. A code that another live service has (ignoring case) is `409 CODE_TAKEN` on `code`. `basePrice` must be above ' +
    'zero. The optional `allowCancel`, `allowVerify` and `verifyWindowH` (0 to 720 hours, `0` = no window) switch on the ' +
    "merchant's cancel and verification of this service's orders; all three start off.",
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:create',
  body: z.object({
    name: ServiceName,
    code: ServiceCode,
    categoryId: zId,
    type: ServiceTypeField,
    slaMinutes: SlaMinutes,
    basePrice: PositiveMoney,
    allowCancel: AllowCancel.optional(),
    allowVerify: AllowVerify.optional(),
    verifyWindowH: VerifyWindowH.optional(),
  }),
  success: { status: 201, schema: ServiceRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'CODE_TAKEN'],
  examples: {
    request: {
      name: 'AT&T USA Unlock',
      code: 'IMEI-ATT-USA',
      categoryId: 4,
      type: 'imei',
      slaMinutes: 1440,
      basePrice: '17.2800',
    },
    response: { ...SERVICE_EXAMPLE, cost: '0.0000', marginPct: '100.0000', floorPrice: '0.0200', minProfit: '0.0200' },
  },
});

/** `PATCH /admin/services/:id`: change some fields of a service. */
export const updateService = defineRoute({
  key: 'PATCH /admin/services/:id',
  summary: 'Change a service',
  description:
    'Only the keys sent change. Saving `basePrice` clears `costChangedFrom`; a `minProfit`-only change does not; `minProfit: ' +
    'null` goes back to the default policy. A `basePrice` under the floor (effective cost plus the minimum profit being ' +
    'saved) or not above zero is `422` on `basePrice`. The category and type must agree (`422` on `categoryId`, or on `type` ' +
    'when only the type was sent). A code another live service has is `409 CODE_TAKEN`. `allowCancel`, `allowVerify` and ' +
    "`verifyWindowH` (0 to 720 hours, `0` = no window) set what a merchant may do with this service's orders.",
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({
      name: ServiceName.optional(),
      code: ServiceCode.optional(),
      categoryId: zId.optional(),
      type: ServiceTypeField.optional(),
      slaMinutes: SlaMinutes.optional(),
      basePrice: PositiveMoney.optional(),
      minProfit: NonNegativeMoney.nullable().optional(),
      status: StatusField.optional(),
      executionMode: ExecutionModeField.optional(),
      allowCancel: AllowCancel.optional(),
      allowVerify: AllowVerify.optional(),
      verifyWindowH: VerifyWindowH.optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: ServiceRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'CODE_TAKEN'],
  examples: { request: { basePrice: '18.0000' }, response: { ...SERVICE_EXAMPLE, basePrice: '18.0000' } },
});

/** `DELETE /admin/services/:id`: archive or delete a service. */
export const deleteService = defineRoute({
  key: 'DELETE /admin/services/:id',
  summary: 'Delete a service',
  description:
    'Answers `204` in both cases. A service that anything refers to (orders, supplier links, storefront listings, inventory ' +
    'codes, checkout sessions, help articles, IMEI checks) is archived: disabled, hidden from every list and reader, its ' +
    'service pricing rules switched off, its history kept, its code freed. Any other service is deleted with its fields, ' +
    'options, prices and its service pricing rules. There is no restore route. The audit action is `archived service` or ' +
    '`deleted service`.',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:delete',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});

/** `PUT /admin/services/:id/fields`: replace the custom fields. */
export const replaceServiceFields = defineRoute({
  key: 'PUT /admin/services/:id/fields',
  summary: 'Replace the custom fields of a service',
  description:
    'The whole list in order (the index is the sort order); a field left out is deleted. One transaction. A key that is empty or ' +
    'repeated, an empty label, an unknown field type or a pattern that does not compile is `422` on `fields.N.<name>`. An ' +
    'unknown or archived service is `404`.',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:update',
  params: z.object({ id: zIdParam }),
  body: z.object({
    fields: z
      .array(
        z.object({
          key: z.string().trim().min(1, 'Enter a key.').max(60, 'Use at most 60 characters.'),
          label: z.string().trim().min(1, 'Enter a label.').max(120, 'Use at most 120 characters.'),
          fieldType: z.enum(SERVICE_FIELD_TYPES, 'Choose a type.'),
          required: z.boolean(),
          options: z.array(z.string().trim().min(1).max(200)).max(500),
          regex: z.string().max(500, 'Use at most 500 characters.'),
          supplierKey: z.string().trim().max(120, 'Use at most 120 characters.'),
        }),
      )
      .max(100, 'A service can have at most 100 custom fields.'),
  }),
  success: { status: 200, schema: z.array(FieldRow) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { fields: [FIELD_EXAMPLE] }, response: [FIELD_EXAMPLE] },
});

/** `PUT /admin/services/:id/options`: replace the model, network and MEP lists. */
export const replaceServiceOptions = defineRoute({
  key: 'PUT /admin/services/:id/options',
  summary: 'Replace the option lists of a service',
  description:
    'All three lists together (`model`, `network`, `mep`); an entry left out is deleted. One transaction; a list can hold ' +
    'hundreds of entries. An unknown list or an empty value is `422` on `options.N.list` or `options.N.value`; a value ' +
    'repeated within one list (after trimming) is `422` on `options.N.value` with N the later one. An unknown or archived ' +
    'service is `404`.',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:update',
  params: z.object({ id: zIdParam }),
  body: z.object({
    options: z
      .array(
        z.object({
          list: z.enum(SERVICE_OPTION_LISTS, 'Unknown list.'),
          value: z.string().trim().min(1, 'Enter a value.').max(200, 'Use at most 200 characters.'),
          label: z.string().trim().max(200, 'Use at most 200 characters.'),
          supplierValue: z.string().trim().max(200, 'Use at most 200 characters.'),
        }),
      )
      .max(5_000, 'Use at most 5000 options.'),
  }),
  success: { status: 200, schema: z.array(OptionRow) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { options: [OPTION_EXAMPLE] }, response: [OPTION_EXAMPLE] },
});
