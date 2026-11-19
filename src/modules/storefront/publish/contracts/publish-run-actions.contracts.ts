// Route contracts of what staff do to a publish run (feature 31, decision 040, plan 31 sections 5.1 and 5.2; routes beyond the map,
// scripts/map-additions/31.mjs, spec B228): edit one row of a draft, change many rows, apply a run (with the resume), cancel it, and
// switch what it published. The shapes of a run and a row are those of publish-runs.contracts.ts. English only (decision 039).
import { z } from 'zod';
import { defineRoute, zId, zIdParam, zMoney } from '../../../../common/contract';
import { ListingCountryField, SlugField, oneLine } from '../../contracts/shared';
import { PUBLISH_ITEM_STATES } from '../../db/schema';
import { BRAND_KINDS } from '../domain/naming';
import { PUBLISH_FLAGS } from '../domain/publish-item';
import { ITEM_EXAMPLE, PublishItemSchema, PublishRunSchema, RUN_EXAMPLE, runParams } from './publish-runs.contracts';

/** The most rows a `bulk` change picks by id. */
export const MAX_BULK_ITEM_IDS = 500;

const itemParams = z.object({ id: zIdParam, itemId: zIdParam });

const FACT_LIMIT = 80;

/** The body of the row's `PATCH` (plan 31 section 5.2). */
const EditItemBody = z
  .strictObject({
    title: oneLine(200)
      .min(1, 'Enter the title customers see.')
      .optional()
      .describe('What the listing will be called.'),
    slug: SlugField.optional().describe('The address, or an empty text: make it from the title again.'),
    brand: oneLine(FACT_LIMIT).optional(),
    carrier: oneLine(FACT_LIMIT).optional(),
    country: ListingCountryField.optional().describe('Two letters, or empty.'),
    retailPrice: zMoney.optional().describe('A typed price: the row is priced `manual` with it.'),
    pricing: z
      .enum(['rule', 'keep'])
      .optional()
      .describe(
        '`rule`: the price of the rule (over the typed price the service has, when staff choose that); `keep`: keep the price the service has.',
      ),
    included: z.boolean().optional().describe('The tick: a row that is blocked cannot be ticked.'),
    reset: z.literal(true).optional().describe('Back to what the rules detected; it goes alone in the body.'),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.');

/** `PATCH /admin/publish-runs/:id/items/:itemId`: edit one row of a draft. */
export const editPublishItem = defineRoute({
  key: 'PATCH /admin/publish-runs/:id/items/:itemId',
  summary: 'Edit a row of a publish draft',
  description:
    'Changes one row of a draft and judges it again on the service as it is now (`200` with the row). Keys: `title` (1 to 200, one ' +
    'line), `slug` (an address, or an empty text to make it from the title again; an address that is not typed follows an edited title), ' +
    '`brand` and `carrier` (at most 80), `country` (two letters or empty), `retailPrice` (a typed price), `pricing` (`rule` or `keep`), ' +
    '`included` (the tick) and `reset` (back to what was detected, alone in the body). At least one key. A row that the new facts block ' +
    '(the service was disabled since, a typed price under a floor that rose) is stored `blocked` and unticked, with `200`. `403` ' +
    'naming `storefront:update` when the body carries `retailPrice` or `pricing`, or `reset` on a row that holds a typed price or a rule ' +
    'chosen over a typed price, and the role lacks it. `409` when the run is no longer ' +
    'a draft, or the service is gone. `422`: `retailPrice` `invalid` (zero or less) or `below_floor` ("Below the storefront floor of ' +
    '$X."); `slug` `invalid` or `duplicate` (a listing or another row holds it); `pricing` `invalid` (`keep` on a service with no ' +
    'retail price); `included` `blocked` (the row is blocked after the change: the sentence names the reason); `retailPrice` ' +
    'beside `pricing`, or `reset` beside anything, with the code `conflict`. One transaction takes the run row `FOR SHARE` and checks ' +
    'the `draft` under it, then the row `FOR UPDATE`, so an edit and an apply never interleave. audit: false: a draft is not a record ' +
    'of the shop; apply, cancel and the run switch are audited.',
  tags: ['storefront-publish'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:create',
  audit: false,
  params: itemParams,
  body: EditItemBody,
  success: { status: 200, schema: PublishItemSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'CONFLICT'],
  examples: {
    request: { title: 'AT&T USA Premier Unlock (Clean IMEI)', country: 'US' },
    response: { ...ITEM_EXAMPLE, title: 'AT&T USA Premier Unlock (Clean IMEI)', edited: true },
  },
});

/** The rows a `bulk` change picks: some by id, or every row a filter matches. */
const BulkSelect = z.union([
  z.strictObject({
    itemIds: z
      .array(zId)
      .min(1, 'Pick at least one row.')
      .max(MAX_BULK_ITEM_IDS, `Pick at most ${MAX_BULK_ITEM_IDS} rows.`),
  }),
  z.strictObject({
    filter: z
      .strictObject({
        state: z.enum(PUBLISH_ITEM_STATES).optional(),
        flag: z.enum(PUBLISH_FLAGS).optional(),
        brandKind: z.enum(BRAND_KINDS).optional(),
        included: z.boolean().optional(),
        q: z.string().trim().max(200).optional(),
      })
      .describe('Every row of the run that matches (the filters of the list of rows); no key: every row.'),
  }),
]);

/** What a `bulk` change sets. */
const BulkSet = z
  .strictObject({
    included: z.boolean().optional(),
    brand: oneLine(FACT_LIMIT).optional(),
    carrier: oneLine(FACT_LIMIT).optional(),
    country: ListingCountryField.optional(),
  })
  .refine((set) => Object.values(set).some((value) => value !== undefined), 'Set at least one field.');

/** `POST /admin/publish-runs/:id/items/bulk`: change many rows of a draft. */
export const bulkEditPublishItems = defineRoute({
  key: 'POST /admin/publish-runs/:id/items/bulk',
  summary: 'Change many rows of a publish draft',
  description:
    'Sets the tick (`included`) or the facts (`brand`, `carrier`, `country`) of the rows picked by `select`: `itemIds` (1 to 500) or ' +
    '`filter` (every row of the run that matches, over the whole run and not over one page). Answers how many rows changed and how ' +
    'many could not take `included: true` because they are blocked (`refused`). A fact is written for the rows whose value differs; ' +
    'the badges and the state of each row are worked out again, the row becomes edited, no price is read and no tick moves. One ' +
    'transaction takes the run row `FOR UPDATE` (one bulk at a time per run, and none during an apply) and checks the `draft` under ' +
    'it: `409` otherwise. `422` on `select.itemIds` with the code `invalid` when a row is not in this run. audit: false: a draft is not ' +
    'a record of the shop; apply, cancel and the run switch are audited.',
  tags: ['storefront-publish'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:create',
  audit: false,
  params: runParams,
  body: z.strictObject({ select: BulkSelect, set: BulkSet }),
  success: {
    status: 200,
    schema: z.object({
      changed: z.number().int().min(0).describe('Rows whose tick or facts were written.'),
      refused: z.number().int().min(0).describe('Rows that could not take `included: true` (blocked).'),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'CONFLICT'],
  examples: {
    request: { select: { filter: { flag: 'no_brand' } }, set: { brand: 'Samsung' } },
    response: { changed: 12, refused: 0 },
  },
});

/** `POST /admin/publish-runs/:id/apply`: publish the ticked rows, or continue a run that stopped. */
export const applyPublishRun = defineRoute({
  key: 'POST /admin/publish-runs/:id/apply',
  summary: 'Apply a publish run',
  description:
    'Starts publishing the ticked rows of a draft (`202`, the run is `queued`; a worker publishes one service per transaction). `listed` ' +
    "says whether the listings go on the shop (left out: the run's own choice). A run that `failed`, or that was `queued` or `running` " +
    'and stalled (five minutes without a heartbeat), whose draft was prepared, **resumes**: rows with a result stay, rows that failed ' +
    'unexpectedly are tried again, the rest continues, and a run switch that stalled is closed as `failed`. `422` on `included` with the ' +
    'code `nothing_included` when a draft has no ticked row. `409 JOB_ALREADY_RUNNING` when the run (or its switch) is being worked on. `409 CONFLICT` when the preview is still being ' +
    'prepared or was never finished (start a new one), or the run is finished. One transaction takes the run row `FOR UPDATE`, ' +
    'so a row in flight finishes first and an edit of the draft after it answers `409`. Audited (`started publishing to the storefront`).',
  tags: ['storefront-publish'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:publish',
  params: runParams,
  body: z.strictObject({ listed: z.boolean().optional() }),
  success: { status: 202, schema: PublishRunSchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'CONFLICT',
    'JOB_ALREADY_RUNNING',
  ],
  examples: {
    request: { listed: true },
    response: { ...RUN_EXAMPLE, status: 'queued', startedAt: null },
  },
});

/** `POST /admin/publish-runs/:id/cancel`: discard a preview, or stop a run. */
export const cancelPublishRun = defineRoute({
  key: 'POST /admin/publish-runs/:id/cancel',
  summary: 'Cancel a publish run',
  description:
    'Discards a preview, or stops a run that is publishing (`200`, the run is `cancelled`). Allowed while the run is `preparing`, `draft`, ' +
    '`queued` or `running`; anything else is `409 CONFLICT`. Stopping a run that is `queued` or `running` is a publishing decision: `403` ' +
    'naming `storefront:publish` when the role lacks it (a role that may only prepare previews can still discard one). The cancel waits ' +
    'for the row in flight and the worker stops before the next one; rows already published stay published and keep their result. The ' +
    'counts and `finishedAt` are written, and the catalog price version moves when a row was published. Audited (`cancelled publishing run`).',
  tags: ['storefront-publish'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:create',
  params: runParams,
  body: z.strictObject({}),
  success: { status: 200, schema: PublishRunSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'CONFLICT'],
  examples: {
    request: {},
    response: { ...RUN_EXAMPLE, status: 'cancelled', finishedAt: '2026-11-18T09:20:00.000Z' },
  },
});

/** `POST /admin/publish-runs/:id/listed`: take what a run published off the shop, or put it back. */
export const switchPublishRun = defineRoute({
  key: 'POST /admin/publish-runs/:id/listed',
  summary: 'Switch what a publish run published',
  description:
    'Takes every listing the run published off the shop (`listed: false`), or puts it back (`listed: true`); `202`, with `switch.status` ' +
    '`queued`, and a worker does it. Nothing is deleted and no price changes: a listing whose service was disabled meanwhile, or whose ' +
    'price was removed, is left as it is when switching on. Allowed for a `succeeded`, `failed` or `cancelled` run that published ' +
    'something, and again after a switch that is `done`, `failed` or stalled; a `queued` or `running` run that stalled is first closed ' +
    '`failed` by this request. `409 CONFLICT` when the run is not finished or published nothing; `409 JOB_ALREADY_RUNNING` when a switch is ' +
    'being worked on. Audited (`started switching publishing run`).',
  tags: ['storefront-publish'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:publish',
  params: runParams,
  body: z.strictObject({ listed: z.boolean() }),
  success: { status: 202, schema: PublishRunSchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'CONFLICT',
    'JOB_ALREADY_RUNNING',
  ],
  examples: {
    request: { listed: false },
    response: {
      ...RUN_EXAMPLE,
      status: 'succeeded',
      switch: { status: 'queued', listed: false, switched: 0, skipped: 0, error: null },
    },
  },
});
