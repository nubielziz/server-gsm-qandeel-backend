// Route contracts of the supplier connections (map domain C, routes /admin/suppliers*, stage 6): list, show, create, change, delete,
// test the connection, sync, the supplier's own services and the import. Shapes match the console's `src/features/suppliers/types`
// (docs/contract/endpoints/suppliers.md and the resolutions orders-suppliers-3 to -10, -13, -16, -20, catalog-9).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { SUPPLIER_DRIVERS, SUPPLIER_STATUSES } from '../db/schema';

const id = z.object({ id: zIdParam });

/** The switch of a supplier. */
const Status = z.enum(SUPPLIER_STATUSES);

/** A supplier as the suppliers page reads it. */
const SupplierRow = z.object({
  id: zId,
  name: z.string(),
  driver: z.string().describe('`dhru` or `rest`.'),
  baseUrl: z.string(),
  username: z.string(),
  currency: z.string(),
  creditRate: zDecimal.describe('Base-currency value of one supplier credit, as stored: 8 decimals (`1.00000000`).'),
  status: Status,
  apiKeyHint: z.string().nullable().describe('The first 5 characters of the saved key; the key itself is never sent.'),
  balance: zMoney.describe('Our prepaid balance at the supplier, in its own currency.'),
  balanceCheckedAt: zIsoDateTime.nullable(),
  lowBalanceAlert: zMoney,
  maxConcurrency: z.number().int(),
  rateLimitPerMin: z.number().int(),
  timeoutMs: z.number().int(),
  createdAt: zIsoDateTime,
  health: z.enum(['up', 'degraded', 'down']).describe('A supplier with no checks and no calls yet reads `up`.'),
  successRate1h: z.number().nullable().describe('Percent of calls that worked in the last hour; `null` without calls.'),
  successRate24h: z.number().nullable(),
  p50Ms: z.number().int().nullable().describe('Median time of the calls of the last 24 hours.'),
  p95Ms: z.number().int().nullable(),
  openOrders: z.number().int().describe('Open orders (`pending`, `processing`) sent to this supplier.'),
  reviewOrders: z.number().int().describe('Of those, the ones that need attention.'),
  lowBalance: z.boolean(),
  runwayDays: z
    .number()
    .nullable()
    .describe('Days the balance lasts at the 7-day spending rate; `null` when nothing was spent.'),
});

const ChainStep = z.object({
  priority: z.number().int(),
  supplierId: zId,
  supplierName: z.string(),
  supplierServiceId: zId,
  supplierServiceName: z.string(),
});

/** The detail: the row plus the 24-hour history and the services linked to the supplier. */
const SupplierDetail = SupplierRow.extend({
  history: z.array(z.object({ at: zIsoDateTime, successRate: z.number(), medianMs: z.number().int() })),
  links: z.array(
    z.object({
      serviceId: zId,
      serviceName: z.string(),
      serviceCode: z.string().nullable(),
      serviceStatus: z.string(),
      supplierServiceId: zId,
      supplierServiceName: z.string(),
      priority: z.number().int(),
      cost: zMoney.describe('What the supplier charges: `credit x credit_rate`, in USD.'),
      slaMinutes: z.number().int().nullable(),
      chain: z.array(ChainStep),
    }),
  ),
});

const SUPPLIER_EXAMPLE = {
  id: 2,
  name: 'Gulf Server Hub',
  driver: 'dhru',
  baseUrl: 'https://gulfserverhub.example',
  username: 'gsm-supply',
  currency: 'USD',
  creditRate: '1.00000000',
  status: 'active',
  apiKeyHint: 'gsh_l',
  balance: '1240.5000',
  balanceCheckedAt: '2026-11-07T08:30:00.000Z',
  lowBalanceAlert: '150.0000',
  maxConcurrency: 5,
  rateLimitPerMin: 60,
  timeoutMs: 15000,
  createdAt: '2026-07-10T09:00:00.000Z',
  health: 'up',
  successRate1h: 99.1,
  successRate24h: 98.4,
  p50Ms: 820,
  p95Ms: 2400,
  openOrders: 6,
  reviewOrders: 0,
  lowBalance: false,
  runwayDays: 12.4,
} as const;

const DETAIL_EXAMPLE = {
  ...SUPPLIER_EXAMPLE,
  history: [{ at: '2026-11-07T07:00:00.000Z', successRate: 99.1, medianMs: 800 }],
  links: [
    {
      serviceId: 17,
      serviceName: 'SRV Chimera Tool 1M',
      serviceCode: 'SRV-CHM-1M',
      serviceStatus: 'active',
      supplierServiceId: 91,
      supplierServiceName: 'Chimera 1 month',
      priority: 1,
      cost: '19.8000',
      slaMinutes: 30,
      chain: [
        {
          priority: 1,
          supplierId: 2,
          supplierName: 'Gulf Server Hub',
          supplierServiceId: 91,
          supplierServiceName: 'Chimera 1 month',
        },
      ],
    },
  ],
} as const;

const Name = z.string().trim().min(2, 'Use at least 2 characters.').max(120, 'Use at most 120 characters.');
const BaseUrl = z
  .string()
  .trim()
  .max(500, 'Use at most 500 characters.')
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
    } catch {
      return false;
    }
  }, 'Enter a web address that starts with http:// or https://.');
const Driver = z
  .string()
  .refine((value) => (SUPPLIER_DRIVERS as readonly string[]).includes(value), 'Use dhru or rest.');
const Username = z.string().trim().max(120, 'Use at most 120 characters.');
const ApiKey = z.string().trim().min(1, 'Enter the API key.').max(500, 'Use at most 500 characters.');
const Currency = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code in capitals.');
const LowBalanceAlert = zMoney.refine((value) => !value.startsWith('-'), 'Use zero or more.');
const MaxConcurrency = z.number().int('Enter a whole number.').min(1, 'Use 1 to 100.').max(100, 'Use 1 to 100.');
const RateLimit = z.number().int('Enter a whole number.').min(1, 'Use 1 to 10000.').max(10000, 'Use 1 to 10000.');
const TimeoutMs = z
  .number()
  .int('Enter a whole number.')
  .min(1000, 'Use 1000 to 120000.')
  .max(120000, 'Use 1000 to 120000.');

/** `GET /admin/suppliers`. */
export const listSuppliers = defineRoute({
  key: 'GET /admin/suppliers',
  summary: 'List suppliers',
  description:
    'Suppliers with their health figures (from the call log and the periodic checks), open and review order counts and the ' +
    'balance verdict. The key is never sent (`apiKeyHint` only). `health` is `up`, `degraded` or `down`: the shared computation ' +
    'gives `ok`, `degraded`, `down` or `unknown` and `ok` and `unknown` read `up` here (orders-suppliers-5). `creditRate` has 8 ' +
    'decimals. `runwayDays` is `(balance x credit_rate) / (7-day supplier cost / 7)`, rounded to 1 decimal; `lowBalance` is balance ' +
    'below `lowBalanceAlert` or a runway under 2 days (orders-suppliers-7). The console reads `_start=0&_end=200`.',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:read',
  query: listQuery({
    sorts: ['id', 'name', 'status', 'createdAt'],
    defaultSort: { field: 'id', order: 'asc' },
    filters: { status: { type: 'enum', values: SUPPLIER_STATUSES } },
    search: ['name', 'baseUrl', 'driver'],
  }),
  success: { status: 200, schema: SupplierRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [SUPPLIER_EXAMPLE] },
});

/** `GET /admin/suppliers/:id`. */
export const showSupplier = defineRoute({
  key: 'GET /admin/suppliers/:id',
  summary: 'Show a supplier',
  description:
    'The list row plus `history` (24 hourly points, oldest first; an hour without calls has no point) and `links`: the services ' +
    "linked to this supplier with `cost = credit x credit_rate` (orders-suppliers-13) and each service's whole chain.",
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:read',
  params: id,
  success: { status: 200, schema: SupplierDetail },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: DETAIL_EXAMPLE },
});

/** `POST /admin/suppliers`. */
export const createSupplier = defineRoute({
  key: 'POST /admin/suppliers',
  summary: 'Add a supplier',
  description:
    'Saves a supplier. The key is stored encrypted (AES-GCM with a key id) and `apiKeyHint` is its first 5 characters. Left out: ' +
    '`lowBalanceAlert` 150, `maxConcurrency` 5, `rateLimitPerMin` 60, `timeoutMs` 15000. `driver` is `dhru` or `rest` (`rest` cannot ' +
    'be called yet); the parameter format follows from it. A name already used (ignoring case) is `422` on `name`.',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:create',
  body: z.object({
    name: Name,
    driver: Driver,
    baseUrl: BaseUrl,
    username: Username,
    apiKey: ApiKey,
    currency: Currency,
    lowBalanceAlert: LowBalanceAlert.optional(),
    maxConcurrency: MaxConcurrency.optional(),
    rateLimitPerMin: RateLimit.optional(),
    timeoutMs: TimeoutMs.optional(),
  }),
  success: { status: 201, schema: SupplierDetail },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      name: 'Gulf Server Hub',
      driver: 'dhru',
      baseUrl: 'https://gulfserverhub.example',
      username: 'gsm-supply',
      apiKey: 'gsh_live_123456',
      currency: 'USD',
    },
    response: {
      ...DETAIL_EXAMPLE,
      balance: '0.0000',
      balanceCheckedAt: null,
      history: [],
      links: [],
      runwayDays: null,
    },
  },
});

/** `PATCH /admin/suppliers/:id`. */
export const updateSupplier = defineRoute({
  key: 'PATCH /admin/suppliers/:id',
  summary: 'Change a supplier',
  description:
    'Only the keys sent change. `apiKey` replaces the key (and its hint); an omitted key keeps both. `status` switches the supplier: ' +
    '`paused` and `disabled` stop new orders (routing skips it and goes to the next link) and leave the open orders as they are.',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:update',
  params: id,
  body: z
    .object({
      name: Name.optional(),
      driver: Driver.optional(),
      baseUrl: BaseUrl.optional(),
      username: Username.optional(),
      apiKey: ApiKey.optional(),
      currency: Currency.optional(),
      lowBalanceAlert: LowBalanceAlert.optional(),
      maxConcurrency: MaxConcurrency.optional(),
      rateLimitPerMin: RateLimit.optional(),
      timeoutMs: TimeoutMs.optional(),
      status: Status.optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: SupplierDetail },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { status: 'paused' }, response: { ...DETAIL_EXAMPLE, status: 'paused' } },
});

/** `DELETE /admin/suppliers/:id`. */
export const deleteSupplier = defineRoute({
  key: 'DELETE /admin/suppliers/:id',
  summary: 'Delete a supplier',
  description:
    'Refused with `409 SUPPLIER_IN_USE` when any order references the supplier (open orders: "it has N open orders", else "it has order ' +
    'history"), a service link points at one of its services, a call log row belongs to an order, or an IMEI check used it. Otherwise ' +
    'the log rows of its tests and syncs go with it: a supplier that was only tested or synced is deleted (`204`). Disable it to stop a ' +
    'supplier that has history.',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:delete',
  params: id,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'SUPPLIER_IN_USE'],
});

/** `POST /admin/suppliers/:id/test`. */
export const testSupplier = defineRoute({
  key: 'POST /admin/suppliers/:id/test',
  summary: 'Test the connection to a supplier',
  description:
    'Calls `accountinfo` (logged with no order) and, when it works, saves the balance and its time. A failure on the supplier side ' +
    '(refused key, timeout, an error answer) is still `200` with `ok: false` and a readable `message`; problems are only for our ' +
    'side (`404`, `403`).',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:update',
  params: id,
  success: {
    status: 200,
    schema: z.object({
      ok: z.boolean(),
      message: z.string(),
      httpStatus: z.number().int().nullable(),
      durationMs: z.number().int().nullable(),
      accountName: z.string().nullable().optional(),
      balance: zMoney.nullable().optional(),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
  examples: {
    response: {
      ok: true,
      message: 'Connected: balance 1240.50 USD',
      httpStatus: 200,
      durationMs: 412,
      accountName: 'ops@gsm.example',
      balance: '1240.5000',
    },
  },
});

/** `POST /admin/suppliers/:id/sync`. */
export const syncSupplier = defineRoute({
  key: 'POST /admin/suppliers/:id/sync',
  summary: 'Sync a supplier now',
  description:
    'Runs the supplier-sync job (the worker calls `imeiservicelist` and `accountinfo`) and answers its counts. The API waits up to ' +
    '`timeoutMs` + 5 s: a supplier failure is `409 SUPPLIER_UNAVAILABLE`; a wait that runs out while the job goes on is `504 ' +
    'SUPPLIER_TIMEOUT`. A paused supplier may sync; a disabled one is `409 SUPPLIER_DISABLED`. The sync updates `supplier_services` ' +
    '(a changed credit sets `price_changed_at`; a service no longer listed becomes unavailable), recomputes the effective cost of every ' +
    'linked service and moves the catalog price version.',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:update',
  params: id,
  success: {
    status: 200,
    schema: z.object({
      services: z.number().int(),
      added: z.number().int(),
      changed: z.number().int(),
      removed: z.number().int(),
      balance: zMoney,
      balanceCheckedAt: zIsoDateTime,
    }),
  },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'SUPPLIER_DISABLED',
    'SUPPLIER_UNAVAILABLE',
    'SUPPLIER_TIMEOUT',
  ],
  examples: {
    response: {
      services: 142,
      added: 3,
      changed: 5,
      removed: 0,
      balance: '1240.5000',
      balanceCheckedAt: '2026-11-07T08:30:00.000Z',
    },
  },
});

/** A synced supplier service as the catalogue tab reads it. */
const SupplierServiceRow = z.object({
  id: zId,
  supplierId: zId,
  remoteId: z.string(),
  remoteGroup: z.string(),
  type: z.string(),
  name: z.string(),
  credit: zMoney.describe("The price in the supplier's credits."),
  time: z.string().describe("The supplier's delivery time text."),
  isAvailable: z.boolean().describe('False once a sync no longer sees the service.'),
  lastSeenAt: zIsoDateTime.nullable(),
  priceChangedAt: zIsoDateTime.nullable(),
  imported: z.boolean().describe('Some service of ours is linked to it.'),
  linkedServiceId: zId.nullable().describe('The linked service with the lowest id.'),
});

/** `GET /admin/suppliers/:id/services`. */
export const listSupplierServices = defineRoute({
  key: 'GET /admin/suppliers/:id/services',
  summary: 'List the services of a supplier',
  description:
    "The synced copy of the supplier's services. Filter `imported=false` for the ones nobody has linked yet.",
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:read',
  params: id,
  query: listQuery({
    sorts: ['name', 'credit', 'lastSeenAt', 'id'],
    defaultSort: { field: 'name', order: 'asc' },
    filters: { imported: { type: 'boolean' } },
    search: ['name', 'remoteGroup', 'remoteId'],
  }),
  success: { status: 200, schema: SupplierServiceRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    response: [
      {
        id: 91,
        supplierId: 2,
        remoteId: '4411',
        remoteGroup: 'Server tools',
        type: 'SERVER',
        name: 'Chimera 1 month',
        credit: '19.8000',
        time: 'Instant',
        isAvailable: true,
        lastSeenAt: '2026-11-07T08:30:00.000Z',
        priceChangedAt: null,
        imported: true,
        linkedServiceId: 17,
      },
    ],
  },
});

const ImportBody = z.object({
  supplierServiceIds: z
    .array(zId)
    .min(1, 'Pick at least one service.')
    .max(500, 'Pick at most 500 services at a time.'),
});

/** `POST /admin/suppliers/:id/import/preview`. */
export const previewImport = defineRoute({
  key: 'POST /admin/suppliers/:id/import/preview',
  summary: 'Preview an import',
  description:
    'For each picked service of this supplier: `new` (no service links it), `matching` (linked, and the service cost equals ' +
    "`credit x credit_rate`) or `changed` (linked, the cost differs: `previousCost` is the service's current cost). `suggestedPrice` " +
    '(new and changed) is the cost plus the default minimum profit. Changes nothing, so it writes no audit row.',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:create',
  audit: false,
  params: id,
  body: ImportBody,
  success: {
    status: 200,
    schema: z.object({
      items: z.array(
        z.object({
          supplierServiceId: zId,
          name: z.string(),
          type: z.string(),
          state: z.enum(['new', 'matching', 'changed']),
          serviceId: zId.nullable(),
          serviceName: z.string().nullable(),
          cost: zMoney,
          previousCost: zMoney.nullable(),
          suggestedPrice: zMoney.nullable(),
        }),
      ),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: { supplierServiceIds: [91] },
    response: {
      items: [
        {
          supplierServiceId: 91,
          name: 'Chimera 1 month',
          type: 'SERVER',
          state: 'changed',
          serviceId: 17,
          serviceName: 'SRV Chimera Tool 1M',
          cost: '19.8000',
          previousCost: '17.0000',
          suggestedPrice: '20.9900',
        },
      ],
    },
  },
});

/** `POST /admin/suppliers/:id/import`. */
export const importServices = defineRoute({
  key: 'POST /admin/suppliers/:id/import',
  summary: 'Import supplier services',
  description:
    "A new item becomes a service: type from the supplier's type (`imei`, `server`, `remote` or `file`, else `422` on " +
    "`supplierServiceIds` naming it and nothing is imported), the category found or created from the supplier's group (`Imported` " +
    "when empty), automatic fulfilment, code `IMP-<id>` (`-2`, `-3` on a collision), the SLA read from the supplier's time text (the " +
    "setting `catalog.importDefaultSlaMinutes`, default 1440, when it cannot be read), the suggested price, the supplier's custom " +
    "fields and a link of priority 1. A changed item updates the linked service's cost and recomputes its effective cost (price " +
    'untouched; an archived service counts as unchanged). Ids of another supplier are ignored.',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:create',
  params: id,
  body: ImportBody,
  success: {
    status: 200,
    schema: z.object({ created: z.number().int(), updated: z.number().int(), unchanged: z.number().int() }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { supplierServiceIds: [91, 92] }, response: { created: 1, updated: 1, unchanged: 0 } },
});
