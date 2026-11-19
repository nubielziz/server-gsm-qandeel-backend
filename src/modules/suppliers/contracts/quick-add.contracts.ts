// Route contracts of the supplier quick add (feature 26, B214; routes beyond the map, scripts/map-additions/26.mjs): the supplier's
// service groups with counts, the start of a quick add and the state of a run. Shapes match the console's
// `src/features/suppliers/types/quickAdd.ts`.
import { z } from 'zod';
import { defineRoute, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import {
  QUICK_ADD_PUBLISH_MODES,
  SUPPLIER_IMPORT_RUN_STATUSES,
  SUPPLIER_IMPORT_SCOPES,
  SUPPLIER_IMPORT_SERVICE_STATUSES,
} from '../db/schema';
import { MAX_ITEM_FAILURES, MAX_QUICK_ADD_GROUPS } from '../domain/quick-add';

const id = z.object({ id: zIdParam });
const runParams = z.object({ id: zIdParam, runId: zIdParam });

/** One supplier group: the pair `(type, remoteGroup)` exactly as the supplier's services store it. */
const GroupKey = z.object({
  type: z.string().describe("The supplier's type name (`IMEI`, `SERVER`, ...), as stored."),
  remoteGroup: z.string().describe("The supplier's group name, as stored; may be empty."),
});

const Counts = z.object({
  total: z.number().int().describe('Every service in the scope: the sum of the four buckets below.'),
  addable: z
    .number()
    .int()
    .describe('Not in the console, available and of an importable type: what a quick add takes.'),
  imported: z.number().int().describe('Some service of ours is linked to it (an archived service counts).'),
  unavailable: z.number().int().describe('Not imported and no longer listed by the supplier.'),
  unsupported: z
    .number()
    .int()
    .describe('Not imported, available, but of a type other than imei, server, remote or file.'),
});

const RunFailure = z.object({
  supplierServiceId: zId,
  name: z.string(),
  reason: z.string().describe('The database constraint that refused it, or `unexpected error`.'),
});

/** A quick add run as the console reads it. */
const QuickAddRun = z.object({
  id: zId,
  supplierId: zId,
  scope: z.enum(SUPPLIER_IMPORT_SCOPES),
  groups: z.array(GroupKey).describe('The picked groups; `[]` for the scope `all`.'),
  serviceStatus: z.enum(SUPPLIER_IMPORT_SERVICE_STATUSES),
  publish: z
    .enum(QUICK_ADD_PUBLISH_MODES)
    .describe(
      'Whether the run also puts what it created on the shop when it ends: `none`, `listed` (switched on) or `unlisted` (prepared, switched off).',
    ),
  status: z
    .enum(SUPPLIER_IMPORT_RUN_STATUSES)
    .describe('A `queued` or `running` run without a heartbeat for 5 minutes reads as `failed`.'),
  total: z.number().int().describe('How many services the run set out to add.'),
  processed: z.number().int().describe('`created + skipped + failed`.'),
  created: z.number().int(),
  skipped: z
    .number()
    .int()
    .describe('Left out inside the run: already in the console, no longer available or of another type.'),
  failed: z.number().int(),
  categoriesCreated: z.number().int(),
  failures: z
    .array(RunFailure)
    .max(MAX_ITEM_FAILURES)
    .describe(`The first ${MAX_ITEM_FAILURES} services that could not be added.`),
  error: z.string().nullable(),
  requestedBy: zId.nullable(),
  createdAt: zIsoDateTime,
  startedAt: zIsoDateTime.nullable(),
  finishedAt: zIsoDateTime.nullable(),
});

const RUN_EXAMPLE = {
  id: 7,
  supplierId: 2,
  scope: 'groups' as const,
  groups: [{ type: 'IMEI', remoteGroup: 'Apple iPhone' }],
  serviceStatus: 'active' as const,
  publish: 'none' as const,
  status: 'running' as const,
  total: 80,
  processed: 30,
  created: 29,
  skipped: 1,
  failed: 0,
  categoriesCreated: 1,
  failures: [],
  error: null,
  requestedBy: 4,
  createdAt: '2026-11-11T09:00:00.000Z',
  startedAt: '2026-11-11T09:00:02.000Z',
  finishedAt: null,
};

/** `GET /admin/suppliers/:id/service-groups`. */
export const listServiceGroups = defineRoute({
  key: 'GET /admin/suppliers/:id/service-groups',
  summary: "List a supplier's service groups",
  description:
    "The supplier's synced services counted per group, where a group is the pair (`type`, `remoteGroup`) as stored. Each service is " +
    'counted once, in the first bucket that fits: `imported` (a service of ours is linked to it), `unavailable` (the supplier no ' +
    'longer lists it), `unsupported` (a type other than imei, server, remote or file), else `addable`; `total` is their sum. One row ' +
    'per group ordered by type then group name, not paged; `remoteGroup` may be empty (the import names that category `Imported`). ' +
    "`latestRun` is the supplier's newest quick add, or `null`.",
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:read',
  params: id,
  success: {
    status: 200,
    schema: z.object({
      groups: z.array(GroupKey.extend(Counts.shape)),
      totals: Counts,
      latestRun: QuickAddRun.nullable(),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: {
    response: {
      groups: [
        {
          type: 'IMEI',
          remoteGroup: 'Apple iPhone',
          total: 120,
          addable: 80,
          imported: 30,
          unavailable: 8,
          unsupported: 2,
        },
      ],
      totals: { total: 120, addable: 80, imported: 30, unavailable: 8, unsupported: 2 },
      latestRun: null,
    },
  },
});

const QuickAddPublishChoice = z
  .strictObject({
    listed: z
      .boolean()
      .describe('Switch what is published on (`true`), or leave it switched off for staff to review (`false`).'),
  })
  .describe(
    'Also put the services this run creates on the shop (feature 31). Needs the `storefront:publish` permission, services that start ' +
      '`active` and at least one active retail price rule.',
  );

const QuickAddBody = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('all'),
    serviceStatus: z.enum(SUPPLIER_IMPORT_SERVICE_STATUSES).optional(),
    publish: QuickAddPublishChoice.optional(),
  }),
  z.strictObject({
    scope: z.literal('groups'),
    groups: z
      .array(z.strictObject({ type: z.string().max(60), remoteGroup: z.string().max(300) }))
      .min(1, 'Pick at least one group.')
      .max(MAX_QUICK_ADD_GROUPS, `Pick at most ${MAX_QUICK_ADD_GROUPS} groups, or add all.`),
    serviceStatus: z.enum(SUPPLIER_IMPORT_SERVICE_STATUSES).optional(),
    publish: QuickAddPublishChoice.optional(),
  }),
]);

/** `POST /admin/suppliers/:id/quick-add`. */
export const startQuickAdd = defineRoute({
  key: 'POST /admin/suppliers/:id/quick-add',
  summary: "Quick add a supplier's services",
  description:
    "Adds the supplier's services to the catalog in the background, by whole group or all of them. Body `{ scope: 'all' }` or " +
    "`{ scope: 'groups', groups: [{ type, remoteGroup }] }` (1 to 500 groups, compared exactly with the stored text; exact repeats are " +
    'dropped), and `serviceStatus` (`active` by default, or `disabled` to add them switched off). The client never sends ids: the ' +
    'server takes only the candidates of the scope, the services that are not in the console yet, are still available and have an ' +
    "importable type, and counts the rest as left out. It only creates (the picker import's rules: category by type and group, " +
    'suggested price, fields, quantity rule); a service already in the console is never changed. Answers `202` with the run in ' +
    "`queued`; the worker adds the services in chunks and the run's `processed` moves. A supplier has one live run: a second start " +
    'answers `409 JOB_ALREADY_RUNNING` (unless the live run stalled: it is closed and a new one starts); a `disabled` supplier ' +
    'answers `409 SUPPLIER_DISABLED` (a paused one is accepted). A scope with no candidate answers `422` on `scope` with code ' +
    '`nothing_to_add` and creates no run. With `publish: { listed }` the run also puts what it creates on the shop when it ends: the ' +
    "services are handed to the bulk publish, which prepares a preview and publishes the ready rows at the retail pricing rules' prices " +
    '(the ones that need a person wait in Storefront, Publish). `publish` answers `403 FORBIDDEN` naming `storefront:publish` when the ' +
    'staff member lacks it, `422` on `publish` with code `needs_active` when `serviceStatus` is `disabled`, and code `no_rule` when no ' +
    'retail price rule is active. Writes the audit row `started quick add from`; the worker writes `quick added services from` when the ' +
    'run ends. The publish run is found with `GET /admin/publish-runs?quickAddRunId=<run id>`.',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:create',
  params: id,
  body: QuickAddBody,
  success: { status: 202, schema: QuickAddRun },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'SUPPLIER_DISABLED',
    'JOB_ALREADY_RUNNING',
  ],
  examples: {
    request: { scope: 'groups', groups: [{ type: 'IMEI', remoteGroup: 'Apple iPhone' }], serviceStatus: 'active' },
    response: {
      ...RUN_EXAMPLE,
      status: 'queued',
      processed: 0,
      created: 0,
      skipped: 0,
      categoriesCreated: 0,
      startedAt: null,
    },
  },
});

/** `GET /admin/suppliers/:id/quick-add/:runId`. */
export const showQuickAddRun = defineRoute({
  key: 'GET /admin/suppliers/:id/quick-add/:runId',
  summary: 'Show a quick add run',
  description:
    'The state and progress of one quick add of this supplier; the console polls it while the run is `queued` or `running`. A run of ' +
    'another supplier is `404`. A live run without a heartbeat for 5 minutes reads as `failed` with an error that says to start it ' +
    'again (reading never changes the row).',
  tags: ['suppliers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'suppliers:read',
  params: runParams,
  success: { status: 200, schema: QuickAddRun },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: RUN_EXAMPLE },
});
