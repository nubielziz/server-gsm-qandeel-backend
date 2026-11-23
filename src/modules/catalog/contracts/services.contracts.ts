// Route contracts of the services (map domain B, routes /admin/services, stage 4): list, show, create, change, delete and
// the replace-all custom fields and option lists. Shapes match the console's Service and ServiceDetail
// (docs/contract/endpoints/catalog.md, RESOLUTIONS catalog-1, -2, -3, -9, -11, -13 and -14). Decision 060 adds the Catalog page's
// facts of a row (attention reasons, shop price, shop page), its filters and the shop price sort: `attention`, `retailPrice` and
// `retailPriceSource` reach every reader and are required; the keys that depend on a permission stay optional for good. The merchant
// switches of feature 7a (`allowCancel`, `allowVerify`, `verifyWindowH`) are required since the console reads them (decision 063).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { MAX_QTY_OPTIONS, MAX_QUANTITY } from '../domain/quantity-rule';
import { ATTENTION_REASONS, SHOP_BLOCKS } from '../domain/service-attention';
import { SERVICE_FIELD_TYPES, SERVICE_OPTION_LISTS, SERVICE_TYPES } from '../db/schema';
import { NamedRef, NonNegativeMoney, PositiveMoney } from './shared';

/** The largest position a service may be given (the CHECK `services_sort_check`): the same bound as a shop page's. */
export const MAX_SERVICE_SORT = 1_000_000;

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
    'The effective cost (B117): the larger of the service cost and the cost of the first supplier link an order can use.',
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
    .describe('Whether a merchant may cancel an order of this service that was never sent. Sent to every reader.'),
  allowVerify: z
    .boolean()
    .describe('Whether a merchant may ask for the verification of a completed order. Sent to every reader.'),
  verifyWindowH: z
    .number()
    .int()
    .min(0)
    .max(MAX_VERIFY_WINDOW_H)
    .describe(
      'How many hours after completion the merchant may ask for verification; `0` means no window. Sent to every reader.',
    ),
  sort: z
    .number()
    .int()
    .min(0)
    .max(MAX_SERVICE_SORT)
    .optional()
    .describe(
      'The position staff gave the service among the services of its category (decision 063); `0` when never set. Merchants and ' +
        'API clients read services by category position, then this, then the name. Always sent; optional in the schema only because ' +
        "the console's `Service` type and its mock rows do not carry it yet (a required key would fail the harvested fixtures). Set " +
        'with `POST /admin/services/order`.',
    ),
  minQty: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUANTITY)
    .describe('The smallest quantity of one order; with `qtyOptions` the smallest pack.'),
  maxQty: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUANTITY)
    .describe('The largest quantity of one order; with `qtyOptions` the largest pack.'),
  qtyOptions: z
    .array(z.number().int().min(1).max(MAX_QUANTITY))
    .max(MAX_QTY_OPTIONS)
    .describe('Fixed pack sizes, ascending; empty means any whole quantity from `minQty` to `maxQty`.'),
  attention: z
    .array(z.enum(ATTENTION_REASONS))
    .describe(
      'Why the service needs staff attention (decision 060), in this order: `no_supplier` (an automatic service with no active ' +
        'supplier link), `below_floor` (the price is under the floor), `price_proposal` (a proposed shop price waits for staff), ' +
        '`publish_failed` (the last publish attempt was refused and the service has no shop page). Only enabled services have ' +
        'reasons; `[]` when none holds. `price_proposal` is left out without `pricing:read` and `publish_failed` without ' +
        '`storefront:read`. Sent to every reader.',
    ),
  retailPrice: zMoney
    .nullable()
    .describe('The shop price (the retail group price, net USD before VAT); `null` when unset. Sent to every reader.'),
  retailPriceSource: z
    .enum(['rule', 'manual'])
    .nullable()
    .describe(
      '`rule` when the shop price follows a retail price rule, `manual` when a person typed it, `null` without a price ' +
        '(decision 040). Sent to every reader.',
    ),
  retailPriceRule: z
    .object({ id: zId, label: z.string() })
    .nullable()
    .optional()
    .describe(
      'The rule a following shop price came from (its name stays after the rule is deleted); `null` otherwise. Left out ' +
        'without `pricing:read`.',
    ),
  retailPriceWaiting: z
    .boolean()
    .optional()
    .describe('A proposed change of the following shop price waits for staff. Left out without `pricing:read`.'),
  listingId: zId
    .nullable()
    .optional()
    .describe(
      'The shop page (listing) of the service, the id the listing routes take; `null` when it has none. Left out without ' +
        '`storefront:read`.',
    ),
  isListed: z
    .boolean()
    .optional()
    .describe(
      'The service has a shop page that is switched on (false with none, or one switched off). Left out without ' +
        '`storefront:read`.',
    ),
  shopBlocked: z
    .enum(SHOP_BLOCKS)
    .nullable()
    .optional()
    .describe(
      'Why the service cannot go on the shop, in the order the publish rule judges it: `service_disabled`, ' +
        '`category_inactive`, `b2b_only` (the category is not offered to the retail group), `not_orderable` (a file ' +
        'service); `null` when nothing blocks it. Left out without `storefront:read`.',
    ),
});

/** One custom field of a service (Dhru `Requires.Custom`). */
const FieldRow = z.object({
  key: z.string(),
  label: z.string(),
  fieldType: z.enum(SERVICE_FIELD_TYPES),
  required: z.boolean(),
  options: z.array(z.string()).describe('The choices of a `select` field.'),
  regex: z.string().describe('`""` when there is no pattern. A pattern is in the supported form of decision 051.'),
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
  publishFailure: z
    .object({
      runId: zId.describe('The publish run of the refused attempt (`GET /admin/publish-runs/:id`).'),
      reason: z
        .string()
        .describe(
          "The result reason of the attempt, as the run's items name it: a blocking reason such as `below_floor` or " +
            '`price_missing`, `cost_moved`, `service_gone` or `failed`.',
        ),
      detail: z.string().nullable().describe('The words staff read about the refusal; `null` when none.'),
      at: zIsoDateTime.describe('When the attempt finished.'),
    })
    .nullable()
    .optional()
    .describe(
      'Why the last publish attempt was refused, while `attention` holds `publish_failed` (decision 060); `null` ' +
        'otherwise. Left out without `storefront:read`.',
    ),
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
  sort: 0,
  minQty: 1,
  maxQty: 1,
  qtyOptions: [],
  attention: [],
  retailPrice: '25.9900',
  retailPriceSource: 'manual',
  retailPriceRule: null,
  retailPriceWaiting: false,
  listingId: 5,
  isListed: true,
  shopBlocked: null,
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
const QuantityBound = z
  .number()
  .int('Enter a whole number.')
  .min(1, 'Enter 1 or more.')
  .max(MAX_QUANTITY, `Use at most ${MAX_QUANTITY}.`);
const MinQty = QuantityBound.describe('The smallest quantity of one order (default `1`).');
const MaxQty = QuantityBound.describe('The largest quantity of one order (default `1`).');
const QtyOptions = z
  .array(z.number())
  .max(MAX_QTY_OPTIONS, `Use at most ${MAX_QTY_OPTIONS} pack sizes.`)
  .describe(
    `Fixed pack sizes: at most ${MAX_QTY_OPTIONS} whole numbers from 1 to ${MAX_QUANTITY}, no repeats; stored ascending. When ` +
      'set, `minQty` is the smallest and `maxQty` the largest pack (default `[]`).',
  );

/** `GET /admin/services`: the catalog with its worked-out figures. */
export const listServices = defineRoute({
  key: 'GET /admin/services',
  summary: 'List services',
  description:
    'Live services (archived ones are gone) with category, supplier chain and the figures worked out in SQL: `cost` is the ' +
    "effective cost, `floorPrice` = cost + `minProfit`, `marginPct` and `belowFloor`; with the Catalog page's facts of " +
    'decision 060 (`attention`, the shop price, the shop page). Filters: `type`, `status`, `categoryId`, `belowFloor`, ' +
    '`needsAttention` (any reason of `attention` the caller may see), `hasSupplier` (an active supplier link), `supplierId` ' +
    "(the primary supplier: the first active link by priority, the row's `supplier`), `isListed` and `notOnShop` (an " +
    'enabled service that is not listed and that nothing blocks, `shopBlocked` null); they combine. `isListed` and ' +
    '`notOnShop` need `storefront:read`: `403 FORBIDDEN` without it, before anything is read. `q` is a case-insensitive ' +
    'contains over name, code and category name. Sorts: name (default), type, cost, basePrice, retailPrice (a service without ' +
    'a shop price last) and `sort`, the order merchants see: the category position, then the service `sort` (decision 063), then ' +
    'the name, in the direction asked for.',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:read',
  query: listQuery({
    sorts: ['name', 'type', 'cost', 'basePrice', 'retailPrice', 'sort', 'id'],
    defaultSort: { field: 'name', order: 'asc' },
    filters: {
      type: { type: 'enum', values: SERVICE_TYPES, ops: ['eq', 'ne'] },
      status: { type: 'enum', values: ['active', 'disabled'], ops: ['eq', 'ne'] },
      categoryId: { type: 'id', ops: ['eq'] },
      belowFloor: { type: 'boolean' },
      needsAttention: { type: 'boolean' },
      hasSupplier: { type: 'boolean' },
      supplierId: { type: 'id', ops: ['eq'] },
      isListed: { type: 'boolean' },
      notOnShop: { type: 'boolean' },
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
    'The list row plus the complete custom `fields` (in order), the option lists in `options` and the `groupPrices`, and, ' +
    'with `storefront:read`, `publishFailure` (decision 060). The replace-all dialogs start from this read.',
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
      publishFailure: null,
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
    "merchant's cancel and verification of this service's orders; all three start off. The optional `minQty`, `maxQty` (whole, 1 " +
    'to 100000) and `qtyOptions` (at most 50 whole pack sizes, no repeats) say what one order may buy; they start at 1, 1 and ' +
    'none. A service sells a range or packs: with `qtyOptions` the server stores `minQty` as the smallest and `maxQty` as the ' +
    'largest pack and refuses a different one sent (`422` `packs_set`); without packs a `maxQty` under `minQty` is `422` ' +
    '`below_min` on `maxQty` (`above_max` on `minQty` when only `minQty` was sent). Every pack problem (`invalid_pack`, ' +
    '`duplicate_pack`) is on `qtyOptions`. The values are in the audit row `created service`.',
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
    minQty: MinQty.optional(),
    maxQty: MaxQty.optional(),
    qtyOptions: QtyOptions.optional(),
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
    response: {
      ...SERVICE_EXAMPLE,
      cost: '0.0000',
      marginPct: '100.0000',
      floorPrice: '0.0200',
      minProfit: '0.0200',
      supplier: null,
      attention: ['no_supplier'],
      retailPrice: null,
      retailPriceSource: null,
      listingId: null,
      isListed: false,
    },
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
    "`verifyWindowH` (0 to 720 hours, `0` = no window) set what a merchant may do with this service's orders. `minQty`, " +
    '`maxQty` and `qtyOptions` set what one order may buy; a key left out keeps its stored value, and when any of them is sent ' +
    'the whole rule is checked again (the same refusals as on create: `below_min`, `above_max`, `invalid_pack`, ' +
    '`duplicate_pack`, `packs_set`, all `422`). Packs are stored ascending and set `minQty` and `maxQty` to the smallest and ' +
    'largest pack. `qtyOptions: []` clears the packs; the service then sells the range `minQty..maxQty`, so send both in the ' +
    'same request (left out, the stored ones, the former smallest and largest pack, stay). Example body: `{ "qtyOptions": [5, ' +
    '10, 25] }`. The audit row `edited service` holds the three values before and after. ' +
    'Sending `basePrice` or `minProfit` also needs `pricing:update` (`403 FORBIDDEN`, decision 046).',
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
      minQty: MinQty.optional(),
      maxQty: MaxQty.optional(),
      qtyOptions: QtyOptions.optional(),
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
    'repeated, an empty label, an unknown field type or a pattern outside the supported form (decision 051: literals, classes, the escapes ' +
    '`\\d \\w \\s` and their capitals, groups that neither repeat nor nest, counts up to 500, `^` and `$` at the ends, and a bound on the work ' +
    'of a 500-character value) is `422` on `fields.N.<name>`. An unknown or archived service is `404`.',
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
