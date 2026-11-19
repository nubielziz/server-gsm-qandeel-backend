// Route contracts of the price changes (feature 31, decision 040, routes beyond the map, spec B230): what the follow pass did or proposes,
// and staff's answer to a proposal (plan 31 section 5.4).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIsoDateTime, zMoney } from '../../../common/contract';
import { RETAIL_CHANGE_KINDS, RETAIL_CHANGE_REASONS, RETAIL_CHANGE_RESOLUTIONS } from '../db/schema';

/** The most proposals one request answers. */
export const MAX_RESOLVE_IDS = 200;

/** A price change as the console reads it. */
const ChangeRow = z.object({
  id: zId,
  service: z.object({ id: zId, name: z.string(), code: z.string() }),
  kind: z
    .enum(RETAIL_CHANGE_KINDS)
    .describe(
      '`followed` (the price moved by itself), `proposed` (it waits for staff), `detached` (it stopped following).',
    ),
  reason: z.enum(RETAIL_CHANGE_REASONS),
  oldPrice: zMoney.describe('The stored price before the move; for a detached price, the price the rule wrote last.'),
  newPrice: zMoney.nullable().describe('The price written or proposed; `null` for `no_cost` and for `detached`.'),
  oldCost: zMoney.describe('The effective cost the old price was worked out from.'),
  newCost: zMoney.describe('The effective cost of the pass.'),
  rule: z
    .object({ id: zId, label: z.string() })
    .nullable()
    .describe('The rule that prices the service (also one deleted since); `null` when its category was deleted.'),
  waiting: z.boolean().describe('A proposal nobody resolved.'),
  resolution: z.enum(RETAIL_CHANGE_RESOLUTIONS).nullable(),
  resolvedAt: zIsoDateTime.nullable(),
  resolvedBy: zId.nullable().describe('The staff member who resolved it; `null` when the system closed it.'),
  createdAt: zIsoDateTime,
});

const CHANGE_EXAMPLE = {
  id: 41,
  service: { id: 5, name: 'Samsung FRP Remove', code: 'IMP-1042' },
  kind: 'proposed',
  reason: 'cost_jump',
  oldPrice: '26.9900',
  newPrice: '39.9900',
  oldCost: '20.0000',
  newCost: '30.0000',
  rule: { id: 3, label: 'IMEI +30%, ends in .99' },
  waiting: true,
  resolution: null,
  resolvedAt: null,
  resolvedBy: null,
  createdAt: '2026-11-18T09:01:00.000Z',
} as const;

/** `GET /admin/retail-price-changes`: what the follow pass did or proposes. */
export const listRetailPriceChanges = defineRoute({
  key: 'GET /admin/retail-price-changes',
  summary: 'List retail price changes',
  description:
    'Every price a rule moved by itself (`followed`), every move that waits for staff (`proposed`) and every price found changed ' +
    'another way (`detached`). Filters: `kind`, `waiting` (the count of the Retail pricing tab is this list with `waiting=true`, read ' +
    'from `x-total-count`), `serviceId`. Sorts: `id` (the default, newest first), `createdAt`.',
  tags: ['retail-price-changes'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:read',
  query: listQuery({
    sorts: ['id', 'createdAt'],
    defaultSort: [{ field: 'id', order: 'desc' }],
    filters: {
      kind: { type: 'enum', values: RETAIL_CHANGE_KINDS, ops: ['eq', 'ne'] },
      waiting: { type: 'boolean' },
      serviceId: { type: 'id', ops: ['eq'] },
    },
  }),
  success: { status: 200, schema: ChangeRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [CHANGE_EXAMPLE] },
});

const ResolveIds = z
  .array(zId)
  .min(1, 'Choose at least one price change.')
  .max(MAX_RESOLVE_IDS, `Choose at most ${MAX_RESOLVE_IDS} price changes.`);

/** The sentence of a `seen` list that does not match `ids`. */
const SEEN_MESSAGE = 'Send the price you saw for each price change, once.';

/** True when `seen` names every id of `ids` exactly once, and no other (`ids` may repeat one). */
const namesEveryIdOnce = (ids: readonly number[], seen: readonly { readonly id: number }[]): boolean => {
  const wanted = new Set(ids);
  const named = new Set(seen.map((row) => row.id));
  return seen.length === named.size && named.size === wanted.size && [...named].every((id) => wanted.has(id));
};

const ApplyBody = z
  .strictObject({
    action: z.literal('apply'),
    ids: ResolveIds,
    seen: z
      .array(
        z.strictObject({
          id: zId,
          newPrice: zMoney.nullable().describe('The `newPrice` the list showed for this id, exactly as it was sent.'),
        }),
        SEEN_MESSAGE,
      )
      .max(MAX_RESOLVE_IDS, SEEN_MESSAGE)
      .describe('What the person approved: one entry for every id of `ids`.'),
  })
  .superRefine(({ ids, seen }, ctx) => {
    if (!namesEveryIdOnce(ids, seen)) ctx.addIssue({ code: 'custom', path: ['seen'], message: SEEN_MESSAGE });
  });

/** `POST /admin/retail-price-changes/resolve`: staff's answer to proposals. */
export const resolveRetailPriceChanges = defineRoute({
  key: 'POST /admin/retail-price-changes/resolve',
  summary: 'Resolve retail price proposals',
  description:
    `One to ${MAX_RESOLVE_IDS} proposals, each in its own transaction. \`apply\` sends \`seen\`, the \`newPrice\` the list showed for ` +
    "every id, and writes the rule price of now only when that figure is still the proposal's and the rule still gives it, whatever " +
    'the size of the move. `keep` takes no `seen`: it keeps the current price, which then is a typed one and no longer follows a rule. ' +
    'An id is `skipped` with `not_waiting` (no proposal waits under it), `no_rule` (no active rule covers the service), `no_cost` (the ' +
    'service has no cost, or one too large to price, so a rule cannot price it) or `changed` (the figure is not the one sent: the ' +
    'proposal shows the figure of now, nothing was written, and staff approve again). Each resolved proposal is audited (`approved ' +
    'retail price of`, `kept retail price of`); a request that resolves nothing still writes one summary audit row.',
  tags: ['retail-price-changes'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:update',
  body: z.discriminatedUnion(
    'action',
    [ApplyBody, z.strictObject({ action: z.literal('keep'), ids: ResolveIds })],
    'Choose apply or keep.',
  ),
  success: {
    status: 200,
    schema: z.object({
      applied: z.number().int().min(0),
      kept: z.number().int().min(0),
      skipped: z.array(
        z.object({
          id: zId,
          reason: z.string().describe('`not_waiting`, `no_rule`, `no_cost` or `changed`.'),
        }),
      ),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      ids: [41, 42],
      action: 'apply',
      seen: [
        { id: 41, newPrice: '39.9900' },
        { id: 42, newPrice: '18.9900' },
      ],
    },
    response: { applied: 1, kept: 0, skipped: [{ id: 42, reason: 'changed' }] },
  },
});
