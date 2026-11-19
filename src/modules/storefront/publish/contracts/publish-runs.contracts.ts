// Route contracts of the bulk publish's draft (feature 31, decision 040, plan 31 sections 5.1 and 5.2; routes beyond the map,
// scripts/map-additions/31.mjs, spec B228): create a run, list the runs, show one and list its rows. The shared shapes (`PublishRun`,
// `PublishItem`, the scope) are exported for the contracts of the edit, apply, cancel and switch routes (publish-run-actions.contracts.ts). English only (decision 039).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../../common/contract';
import {
  PUBLISH_BLOCK_REASONS,
  PUBLISH_RUN_SOURCES,
  PUBLISH_RUN_STATUSES,
  PUBLISH_SWITCH_STATUSES,
} from '../../db/schema';
import { PUBLISH_ITEM_STATES, PUBLISH_PRICE_MODES, PUBLISH_ITEM_RESULTS } from '../../db/schema';
import { BRAND_KINDS } from '../domain/naming';
import { MAX_PUBLISH_ITEMS, PUBLISH_FLAGS } from '../domain/publish-item';

/** The most services the scope `services` takes. */
export const MAX_SCOPE_SERVICES = 500;

/** What a run covers, as staff send it and as the run stores it (plan 31 section 5.2). */
export const PublishScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('services'),
    serviceIds: z
      .array(zId)
      .min(1, 'Pick at least one service.')
      .max(MAX_SCOPE_SERVICES, `Pick at most ${MAX_SCOPE_SERVICES} services.`)
      .describe(`The rows staff ticked: 1 to ${MAX_SCOPE_SERVICES}, repeats dropped.`),
  }),
  z.strictObject({ kind: z.literal('category'), categoryId: zId }),
  z.strictObject({ kind: z.literal('supplier'), supplierId: zId }),
  z.strictObject({
    kind: z.literal('quickAddRun'),
    runId: zId.describe('The Quick add run whose services to publish.'),
  }),
  z.strictObject({
    kind: z.literal('run'),
    runId: zId.describe('An earlier publish run: a draft ("Check again") or the rest of a finished one.'),
  }),
  z.strictObject({ kind: z.literal('all') }),
]);

/** The counts of a run's rows, read live (plan 31 section 5.2). */
const RunCounts = z.object({
  ready: z.number().int().min(0),
  review: z.number().int().min(0),
  blocked: z.number().int().min(0),
  included: z.number().int().min(0),
  noRule: z.number().int().min(0).describe('Rows that wait for a pricing rule (flag `no_rule`).'),
  published: z.number().int().min(0),
  skipped: z.number().int().min(0),
  refused: z.number().int().min(0),
  pending: z.number().int().min(0).describe('Rows without a result.'),
});

/** A publish run as the console reads it. */
export const PublishRunSchema = z.object({
  id: zId,
  status: z
    .enum(PUBLISH_RUN_STATUSES)
    .describe('A `preparing`, `queued` or `running` run without a heartbeat for 5 minutes reads as `failed`.'),
  source: z.enum(PUBLISH_RUN_SOURCES),
  quickAddRunId: zId.nullable().describe('The Quick add run that asked for this one.'),
  scope: PublishScopeSchema,
  listed: z.boolean().describe('Whether apply switches the listings on.'),
  auto: z.boolean().describe('Applied by the system as soon as it is prepared (the Quick add hand-over).'),
  total: z.number().int().min(0),
  counts: RunCounts.describe(
    'The draft: ready + review + blocked = total. The run: published + skipped + refused + pending = total.',
  ),
  switch: z
    .object({
      status: z.enum(PUBLISH_SWITCH_STATUSES).nullable().describe('The run switch; `null` when never asked.'),
      listed: z.boolean().nullable(),
      switched: z.number().int().min(0),
      skipped: z.number().int().min(0),
      error: z.string().nullable(),
    })
    .describe('The last switch of what the run published.'),
  replacedBy: zId
    .nullable()
    .describe(
      'The run "Check again" made from this one (the newest, when an earlier one died before its preview was ready).',
    ),
  error: z.string().nullable(),
  requestedBy: zId.nullable(),
  requestedByName: z.string().nullable().describe('The name of the staff member, by a join.'),
  createdAt: zIsoDateTime,
  preparedAt: zIsoDateTime.nullable(),
  startedAt: zIsoDateTime.nullable(),
  finishedAt: zIsoDateTime.nullable(),
});

/** One service of a run: what was detected, what will be published, how it is priced and what happened. */
export const PublishItemSchema = z.object({
  id: zId,
  serviceId: zId,
  service: z.object({
    id: zId,
    name: z.string(),
    code: z.string(),
    type: z.enum(['imei', 'server', 'remote', 'file']),
    categoryName: z.string(),
  }),
  title: z.string().describe('What will be published; staff may edit it.'),
  slug: z.string(),
  brand: z.string(),
  carrier: z.string(),
  country: z.string().describe('ISO-2 country or empty.'),
  detected: z.object({
    title: z.string(),
    slug: z.string(),
    brand: z.string(),
    brandKind: z.enum(BRAND_KINDS).nullable(),
    carrier: z.string(),
    country: z.string(),
  }),
  edited: z.boolean(),
  cost: zMoney,
  floorPrice: zMoney,
  rule: z
    .object({ id: zId, label: z.string() })
    .nullable()
    .describe('The rule that prices the row; its name stays after it is deleted.'),
  rulePrice: zMoney.nullable(),
  priceMode: z.enum(PUBLISH_PRICE_MODES),
  existingPrice: zMoney.nullable().describe('The retail price the service had at the last evaluation (display only).'),
  replacesPrice: zMoney.nullable().describe('Set when staff chose the rule over this typed price.'),
  retailPrice: zMoney
    .nullable()
    .describe('The price apply would store: the typed one, the kept one or the rule price.'),
  marginPct: zDecimal
    .nullable()
    .describe('`(retailPrice - cost) / retailPrice x 100`, 4 decimals; `null` without a price.'),
  state: z.enum(PUBLISH_ITEM_STATES),
  blockedReason: z.enum(PUBLISH_BLOCK_REASONS).nullable(),
  flags: z.array(z.enum(PUBLISH_FLAGS)),
  included: z.boolean(),
  evaluatedAt: zIsoDateTime.nullable(),
  result: z.enum(PUBLISH_ITEM_RESULTS).nullable(),
  resultReason: z.string().nullable(),
  resultDetail: z.string().nullable(),
  listingId: zId.nullable(),
  publishedPrice: zMoney.nullable(),
  listingListed: z.boolean().nullable().describe('Whether that listing is on the shop now; `null` without a listing.'),
});

/** A run as an example of the contracts (the answers of the routes that return one). */
export const RUN_EXAMPLE = {
  id: 12,
  status: 'draft' as const,
  source: 'console' as const,
  quickAddRunId: null,
  scope: { kind: 'category' as const, categoryId: 4 },
  listed: true,
  auto: false,
  total: 42,
  counts: {
    ready: 30,
    review: 6,
    blocked: 6,
    included: 30,
    noRule: 4,
    published: 0,
    skipped: 0,
    refused: 0,
    pending: 42,
  },
  switch: { status: null, listed: null, switched: 0, skipped: 0, error: null },
  replacedBy: null,
  error: null,
  requestedBy: 3,
  requestedByName: 'Rami K.',
  createdAt: '2026-11-18T09:00:00.000Z',
  preparedAt: '2026-11-18T09:00:04.000Z',
  startedAt: null,
  finishedAt: null,
};

/** A row as an example of the contracts. */
export const ITEM_EXAMPLE = {
  id: 301,
  serviceId: 88,
  service: {
    id: 88,
    name: 'AT&T USA Premier Unlock Clean IMEI',
    code: 'IMEI-ATT-88',
    type: 'imei' as const,
    categoryName: 'Carrier unlock',
  },
  title: 'AT&T USA Premier Unlock',
  slug: 'att-usa-premier-unlock',
  brand: 'Apple',
  carrier: 'AT&T',
  country: 'US',
  detected: {
    title: 'AT&T USA Premier Unlock',
    slug: 'att-usa-premier-unlock',
    brand: 'Apple',
    brandKind: 'device' as const,
    carrier: 'AT&T',
    country: 'US',
  },
  edited: false,
  cost: '10.0000',
  floorPrice: '11.6600',
  rule: { id: 2, label: 'IMEI +30%' },
  rulePrice: '13.9900',
  priceMode: 'rule' as const,
  existingPrice: null,
  replacesPrice: null,
  retailPrice: '13.9900',
  marginPct: '28.5204',
  state: 'ready' as const,
  blockedReason: null,
  flags: [],
  included: true,
  evaluatedAt: '2026-11-18T09:00:04.000Z',
  result: null,
  resultReason: null,
  resultDetail: null,
  listingId: null,
  publishedPrice: null,
  listingListed: null,
};

/** The path parameters of the routes of one run. */
export const runParams = z.object({ id: zIdParam });

/** `POST /admin/publish-runs`: prepare a draft of services to publish. */
export const createPublishRun = defineRoute({
  key: 'POST /admin/publish-runs',
  summary: 'Prepare a publish run',
  description:
    'Starts a draft of the services of a scope to put on the shop: `services` (1 to 500 ids the staff member ticked), `category`, ' +
    '`supplier` (live services linked to a service of it), `quickAddRun` (the services that Quick add run created), `run` (an earlier ' +
    'publish run: a draft, which "Check again" replaces, or the rest of a finished one) or `all`. `listed` (default `true`; for the ' +
    "scope `run` the old run's) says whether apply switches the listings on. The rows of a run are the live services of the scope that " +
    'have no listing; with `services` a ticked service that has a listing is a row too (`blocked`, `already_listed`). Answers `202` with ' +
    'the run in `preparing`, `total` the services counted now; the worker names and evaluates every row and closes it as a `draft`. ' +
    'A preview changes nothing a visitor or a merchant can see. `422` on `scope`: `nothing_to_publish` (no service left to publish, also ' +
    `when every ticked service has a listing) and \`too_many\` (more than ${MAX_PUBLISH_ITEMS}); \`422\` with the code \`invalid\` on ` +
    '`scope.categoryId`, `scope.supplierId` or `scope.runId` for an unknown one. The scope `run` answers `409 CONFLICT` for a run that is ' +
    'still working, for one whose preview was never finished (its rows are partial), and for a draft that "Check again" replaced while ' +
    'the newer run is alive or was prepared. When the newer run died before its preview was ready, the same request ("Prepare again") ' +
    'copies the old draft again, and the draft links to the new run. "Check again" from a draft cancels that draft in the same ' +
    'transaction. audit: false for the draft itself (a draft is not a record of the shop; apply, cancel and the run switch are audited); ' +
    'the one audit row is the `cancelled publishing run` of the draft that "Check again" replaces.',
  tags: ['storefront-publish'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:create',
  audit: false,
  body: z.strictObject({ scope: PublishScopeSchema, listed: z.boolean().optional() }),
  success: { status: 202, schema: PublishRunSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'CONFLICT'],
  examples: {
    request: { scope: { kind: 'category', categoryId: 4 } },
    response: {
      ...RUN_EXAMPLE,
      status: 'preparing',
      counts: { ...RUN_EXAMPLE.counts, ready: 0, review: 0, blocked: 0, included: 0, noRule: 0, pending: 0 },
      preparedAt: null,
    },
  },
});

/** `GET /admin/publish-runs`: the history of the Publish tab. */
export const listPublishRuns = defineRoute({
  key: 'GET /admin/publish-runs',
  summary: 'List publish runs',
  description:
    'The runs, newest first by default. Filters: `status` and `source` (the stored values: a stalled run reads `failed` but is ' +
    'stored as it was) and `quickAddRunId` (the publish runs of a Quick add run: the automatic one it asked for, and one staff started with ' +
    'the scope `quickAddRun`). Sorts: `id` and `createdAt`. A `preparing`, `queued` ' +
    'or `running` run without a heartbeat for 5 minutes reads `failed` with an error that says to start again; a switch that stalled ' +
    'reads `failed` too. A read never writes.',
  tags: ['storefront-publish'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  query: listQuery({
    sorts: ['id', 'createdAt'],
    defaultSort: { field: 'id', order: 'desc' },
    filters: {
      status: { type: 'enum', values: PUBLISH_RUN_STATUSES },
      source: { type: 'enum', values: PUBLISH_RUN_SOURCES },
      quickAddRunId: { type: 'id', ops: ['eq'] },
    },
  }),
  success: { status: 200, schema: PublishRunSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [RUN_EXAMPLE] },
});

/** `GET /admin/publish-runs/:id`: one run. */
export const showPublishRun = defineRoute({
  key: 'GET /admin/publish-runs/:id',
  summary: 'Show a publish run',
  description:
    'The state, progress and counts of one run; the console polls it while the run is `preparing`, `queued` or `running`. A live run ' +
    'without a heartbeat for 5 minutes reads `failed` (`error` says to start again, or to start a new preview when it stalled while ' +
    'preparing); a stalled switch reads `switch.status = "failed"`. Reading never changes the row.',
  tags: ['storefront-publish'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  params: runParams,
  success: { status: 200, schema: PublishRunSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: RUN_EXAMPLE },
});

/** `GET /admin/publish-runs/:id/items`: the rows of a draft or of a finished run. */
export const listPublishItems = defineRoute({
  key: 'GET /admin/publish-runs/:id/items',
  summary: 'List the rows of a publish run',
  description:
    'One row per service of the run, with what was detected, what will be published, its price and its result. Filters: `state`, ' +
    '`included`, `result` (`pending` selects the rows without one), `flag` (the row has it), `brandKind` and `afterId` (the rows ' +
    'after an id: the "Save and next" of the row dialog). `q` is a contains over the title, the address, and the service\'s name and ' +
    'code. Sorts: `id` (default), `title` and `cost`.',
  tags: ['storefront-publish'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  params: runParams,
  query: listQuery({
    sorts: ['id', 'title', 'cost'],
    defaultSort: { field: 'id', order: 'asc' },
    filters: {
      state: { type: 'enum', values: PUBLISH_ITEM_STATES },
      included: { type: 'boolean' },
      result: { type: 'enum', values: [...PUBLISH_ITEM_RESULTS, 'pending'] },
      flag: { type: 'enum', values: PUBLISH_FLAGS, ops: ['eq'] },
      brandKind: { type: 'enum', values: BRAND_KINDS, ops: ['eq'] },
    },
    search: ['title', 'slug', 'service.name', 'service.code'],
    extra: { afterId: zIdParam.optional() },
  }),
  success: { status: 200, schema: PublishItemSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: [ITEM_EXAMPLE] },
});
