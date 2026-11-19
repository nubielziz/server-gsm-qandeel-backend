// Route contracts of the retail price rules (feature 31, decision 040, routes beyond the map, spec B229): list, create, change,
// soft delete, and the preview of what the follow pass would do once a change is saved (plan 31 section 5.3).
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { RETAIL_ROUNDINGS, RETAIL_RULE_SCOPES, SERVICE_TYPES } from '../db/schema';
import {
  RETAIL_RULE_MAX_AMOUNT,
  RETAIL_RULE_MAX_AUTO_FOLLOW,
  RETAIL_RULE_MAX_PERCENT,
  RULE_PREVIEW_LIMIT,
  RULE_PREVIEW_LINES,
} from '../domain/retail-rule';

/** A rule as the console reads it. */
const RuleRow = z.object({
  id: zId,
  scope: z.enum(RETAIL_RULE_SCOPES),
  serviceType: z.enum(SERVICE_TYPES).nullable().describe('The target of a `type` rule; `null` otherwise.'),
  categoryId: zId.nullable().describe('The target of a `category` rule; `null` otherwise.'),
  categoryName: z.string().nullable(),
  percent: zDecimal.describe('Percent units with four decimals: `"30.0000"` adds 30 % to the effective cost.'),
  fixed: zMoney.describe('An amount added after the percent.'),
  rounding: z.enum(RETAIL_ROUNDINGS).describe('Always upwards: the cent, the next 0.05 or 0.10, or the next `n.99`.'),
  roundFrom: zMoney.describe('The rounding style applies from this price on; under it the price is the cent.'),
  autoFollowPercent: z
    .number()
    .int()
    .min(0)
    .max(RETAIL_RULE_MAX_AUTO_FOLLOW)
    .describe('A cost move above this percent waits for staff instead of moving the price; 0 makes every move wait.'),
  isActive: z.boolean(),
  label: z.string().describe("The server's words for the rule, such as `IMEI +30%, ends in .99`."),
  following: z.number().int().min(0).describe('The services whose retail price this rule wrote last.'),
  updatedAt: zIsoDateTime,
});

const RULE_EXAMPLE = {
  id: 3,
  scope: 'type',
  serviceType: 'imei',
  categoryId: null,
  categoryName: null,
  percent: '30.0000',
  fixed: '0.0000',
  rounding: 'ends_99',
  roundFrom: '5.0000',
  autoFollowPercent: 25,
  isActive: true,
  label: 'IMEI +30%, ends in .99',
  following: 12,
  updatedAt: '2026-11-17T09:00:00.000Z',
} as const;

const RulePercentField = zDecimal
  .regex(/^\d{1,4}(\.\d{1,4})?$/, 'Enter a percent from 0 to 1000 with at most four decimals.')
  .refine((value) => new Decimal(value).lte(RETAIL_RULE_MAX_PERCENT), 'Enter a percent from 0 to 1000.');

const RuleAmountField = zMoney.refine(
  (value) => !value.startsWith('-') && new Decimal(value).lte(RETAIL_RULE_MAX_AMOUNT),
  'Enter an amount from 0 to 100000.',
);

const AutoFollowField = z
  .number()
  .int('Enter a whole number.')
  .min(0, 'Enter a whole number from 0 to 1000.')
  .max(RETAIL_RULE_MAX_AUTO_FOLLOW, 'Enter a whole number from 0 to 1000.');

/** The body of `POST /admin/retail-price-rules` (also `change.rule` of a preview of a create). */
const CreateRuleBody = z.strictObject({
  scope: z.enum(RETAIL_RULE_SCOPES, 'Choose what the rule covers.'),
  serviceType: z.enum(SERVICE_TYPES, 'Choose a service type.').nullable().optional(),
  categoryId: zId.nullable().optional(),
  percent: RulePercentField,
  fixed: RuleAmountField.optional().describe('Default `0.0000`.'),
  rounding: z.enum(RETAIL_ROUNDINGS, 'Choose a rounding.'),
  roundFrom: RuleAmountField.optional().describe('Default `5.0000`.'),
  autoFollowPercent: AutoFollowField.optional().describe('Default 25.'),
  isActive: z.boolean().optional().describe('Default true.'),
});

/** The body of `PATCH /admin/retail-price-rules/:id` (also `change.rule` of a preview of an update). */
const UpdateRuleBody = z
  .strictObject({
    percent: RulePercentField.optional(),
    fixed: RuleAmountField.optional(),
    rounding: z.enum(RETAIL_ROUNDINGS, 'Choose a rounding.').optional(),
    roundFrom: RuleAmountField.optional(),
    autoFollowPercent: AutoFollowField.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.');

const CREATE_EXAMPLE = { scope: 'type', serviceType: 'imei', percent: '30', rounding: 'ends_99' } as const;

/** `GET /admin/retail-price-rules`: the rules that are not deleted. */
export const listRetailPriceRules = defineRoute({
  key: 'GET /admin/retail-price-rules',
  summary: 'List retail price rules',
  description:
    'The rules that price the shop from the effective cost (decision 040): one general rule, one per service type and one per ' +
    'category at most; the most specific active rule prices a service. A deleted rule is not listed. Filters: `scope`, ' +
    '`isActive`. Sorts: `id`, `scope` (default: `global`, `type`, `category`, then `id`). `following` counts the services whose ' +
    'retail price the rule wrote last.',
  tags: ['retail-price-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:read',
  query: listQuery({
    sorts: ['id', 'scope'],
    defaultSort: [
      { field: 'scope', order: 'asc' },
      { field: 'id', order: 'asc' },
    ],
    filters: {
      scope: { type: 'enum', values: RETAIL_RULE_SCOPES, ops: ['eq', 'ne'] },
      isActive: { type: 'boolean' },
    },
  }),
  success: { status: 200, schema: RuleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [RULE_EXAMPLE] },
});

/** `POST /admin/retail-price-rules`: a new rule. */
export const createRetailPriceRule = defineRoute({
  key: 'POST /admin/retail-price-rules',
  summary: 'Create a retail price rule',
  description:
    'The price of a rule is `effective cost x (1 + percent / 100) + fixed`, never under the storefront floor, rounded up to the ' +
    'cent and, from `roundFrom` on, to the rounding style (always upwards). `global` has neither target, `type` names ' +
    '`serviceType`, `category` names `categoryId`; a target field that does not fit the scope is `422` with the code `invalid` ' +
    'on that field, an unknown category is `422` on `categoryId`. A second rule for the same target is `422` on `scope` with the ' +
    'code `duplicate` ("A rule for this already exists. Edit it instead."). Limits: `percent` 0 to 1000 (at most four ' +
    'decimals), `fixed` and `roundFrom` 0 to 100000, `autoFollowPercent` 0 to 1000 (whole). Audited (`created retail price ' +
    'rule`); following prices move within about two minutes.',
  tags: ['retail-price-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:create',
  body: CreateRuleBody,
  success: { status: 201, schema: RuleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: { request: CREATE_EXAMPLE, response: { ...RULE_EXAMPLE, following: 0 } },
});

/** `PATCH /admin/retail-price-rules/:id`: change the figures of a rule, or switch it off and on. */
export const updateRetailPriceRule = defineRoute({
  key: 'PATCH /admin/retail-price-rules/:id',
  summary: 'Change a retail price rule',
  description:
    'Any of `percent`, `fixed`, `rounding`, `roundFrom`, `autoFollowPercent`, `isActive`; at least one. The scope and the target ' +
    'never change (a key for them is `422`). A deleted rule is `404`. Limits as on create. Audited (`changed retail price ' +
    'rule`); a rule edit moves every following price it prices, whatever the size of the move, within about two minutes.',
  tags: ['retail-price-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:update',
  params: z.object({ id: zIdParam }),
  body: UpdateRuleBody,
  success: { status: 200, schema: RuleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: { percent: '35' },
    response: { ...RULE_EXAMPLE, percent: '35.0000', label: 'IMEI +35%, ends in .99' },
  },
});

/** `DELETE /admin/retail-price-rules/:id`: a soft delete. */
export const deleteRetailPriceRule = defineRoute({
  key: 'DELETE /admin/retail-price-rules/:id',
  summary: 'Delete a retail price rule',
  description:
    'Answers `204`. The rule keeps its row (switched off and marked deleted) so the history of prices keeps its name; it is gone ' +
    'from the list, `PATCH`, `DELETE` and the preview answer `404` for it, and its target is free for a new rule. Its following ' +
    'services move to the next rule by precedence at the next follow pass; with no rule left their prices stay. Audited ' +
    '(`deleted retail price rule`).',
  tags: ['retail-price-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:delete',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});

const PreviewLine = z.object({
  serviceId: zId,
  name: z.string(),
  code: z.string(),
  cost: zMoney.describe('The effective cost of now.'),
  floorPrice: zMoney.describe('The storefront floor of now.'),
  currentPrice: zMoney.describe('The stored retail price.'),
  newPrice: zMoney.nullable().describe('The price after the change; `null` when no rule would price the service.'),
  atFloor: z.boolean().describe('The new price was lifted to the floor.'),
});

const PreviewResult = z.object({
  following: z.number().int().min(0).describe('Services that follow rules and that this change can reach.'),
  changes: z.number().int().min(0).describe('Of those, the services whose price would change.'),
  raised: z.number().int().min(0),
  lowered: z.number().int().min(0),
  atFloor: z.number().int().min(0).describe('Services whose new price would be the floor (the rule gives less).'),
  noRule: z.number().int().min(0).describe('Services no rule would price after the change: their prices stay.'),
  lines: z.array(PreviewLine).describe(`The ${RULE_PREVIEW_LINES} largest changes, largest first.`),
  truncated: z
    .boolean()
    .describe(`True when more than ${RULE_PREVIEW_LIMIT} services were in reach: the figures cover the first by id.`),
});

/** `POST /admin/retail-price-rules/preview`: what saving a change would do to following prices. */
export const previewRetailPriceRule = defineRoute({
  key: 'POST /admin/retail-price-rules/preview',
  summary: 'Preview a retail price rule change',
  description:
    'What the follow pass would do once the change is saved: `{ change: { kind: "create", rule } | { kind: "update", id, rule } | ' +
    '{ kind: "delete", id } }`, where `rule` is the body of the create or the change. Only following prices move (a typed price ' +
    'is never touched); the new price is the rule price of the cost and floor of now (a cost that jumped past the limit since the ' +
    'price was set waits for staff at the pass). The same `422`s as the write it previews (fields under `change.rule`); an unknown ' +
    'or deleted rule is `404`. Not audited (`audit: false`): a calculation, nothing is stored.',
  tags: ['retail-price-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:read',
  audit: false,
  body: z.strictObject({
    change: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('create'), rule: CreateRuleBody }),
      z.strictObject({ kind: z.literal('update'), id: zId, rule: UpdateRuleBody }),
      z.strictObject({ kind: z.literal('delete'), id: zId }),
    ]),
  }),
  success: { status: 200, schema: PreviewResult },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: { change: { kind: 'update', id: 3, rule: { percent: '35' } } },
    response: {
      following: 12,
      changes: 1,
      raised: 1,
      lowered: 0,
      atFloor: 0,
      noRule: 0,
      lines: [
        {
          serviceId: 5,
          name: 'Samsung FRP Remove',
          code: 'IMP-1042',
          cost: '20.0000',
          floorPrice: '23.3200',
          currentPrice: '26.9900',
          newPrice: '27.9900',
          atFloor: false,
        },
      ],
      truncated: false,
    },
  },
});
