// Route contracts of the pricing rules (map domain B, routes /admin/pricing-rules, stage 4): list, show, create, change and
// delete. Shapes match the console's PricingRule (docs/contract/endpoints/catalog.md, RESOLUTIONS catalog-4, B19).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { PRICING_ROUNDINGS, PRICING_RULE_KINDS, PRICING_SCOPES } from '../db/schema';
import { NamedRef, NonNegativeMoney, RulePercent } from './shared';

/** A rule as the console reads it, with the names of its target and group. */
const RuleRow = z.object({
  id: zId,
  scope: z.enum(PRICING_SCOPES),
  targetId: zId.nullable().describe('The category or service id by `scope`; `null` for a global rule.'),
  target: NamedRef.nullable(),
  groupId: zId.nullable().describe('`null` applies to every merchant group.'),
  group: NamedRef.nullable(),
  kind: z.enum(PRICING_RULE_KINDS).describe('`margin` adds, `discount` and `promo` subtract.'),
  percent: zDecimal.describe('Percent units, four decimals: `"2.0000"` is 2 %. Never negative.'),
  fixed: zMoney.describe('An amount added (margin) or taken off (discount, promo). Never negative.'),
  rounding: z.enum(PRICING_ROUNDINGS),
  minProfit: zMoney.describe('The minimum profit this rule asks for; `0.0000` asks for none.'),
  priority: z.number().int().min(0).describe('Lower wins within a scope.'),
  isActive: z.boolean(),
  startsAt: zIsoDateTime.nullable(),
  endsAt: zIsoDateTime.nullable(),
});

const RULE_EXAMPLE = {
  id: 1,
  scope: 'category',
  targetId: 4,
  target: { id: 4, name: 'Carrier unlock' },
  groupId: null,
  group: null,
  kind: 'discount',
  percent: '2.0000',
  fixed: '0.0000',
  rounding: 'none',
  minProfit: '0.0000',
  priority: 100,
  isActive: true,
  startsAt: null,
  endsAt: null,
} as const;

const Priority = z.number().int('Enter a whole number.').min(0, 'Enter a whole number, 0 or more.').max(1_000_000);

const RuleFields = {
  scope: z.enum(PRICING_SCOPES, 'Choose what the rule covers.'),
  targetId: zId.nullable(),
  groupId: zId.nullable(),
  kind: z.enum(PRICING_RULE_KINDS, 'Choose a type.'),
  percent: RulePercent,
  fixed: NonNegativeMoney,
  rounding: z.enum(PRICING_ROUNDINGS, 'Choose a rounding.'),
  minProfit: NonNegativeMoney,
  priority: Priority,
  startsAt: zIsoDateTime.nullable(),
  endsAt: zIsoDateTime.nullable(),
};

const RULE_REQUEST_EXAMPLE = {
  scope: 'category',
  targetId: 4,
  groupId: null,
  kind: 'discount',
  percent: '2.0000',
  fixed: '0.0000',
  rounding: 'none',
  minProfit: '0.0000',
  priority: 100,
  startsAt: null,
  endsAt: null,
} as const;

/** `GET /admin/pricing-rules`: the rules. */
export const listPricingRules = defineRoute({
  key: 'GET /admin/pricing-rules',
  summary: 'List pricing rules',
  description:
    'Margin, discount and promo rules with the name of the target and the group. The console reads the whole list ' +
    '(`_end=200`, sorted by `priority`). Filters: `scope`, `kind`, `isActive`. `q` searches the target name and the kind.',
  tags: ['pricing-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:read',
  query: listQuery({
    sorts: ['priority', 'id', 'scope', 'kind'],
    defaultSort: { field: 'priority', order: 'asc' },
    filters: {
      scope: { type: 'enum', values: PRICING_SCOPES, ops: ['eq', 'ne'] },
      kind: { type: 'enum', values: PRICING_RULE_KINDS, ops: ['eq', 'ne'] },
      isActive: { type: 'boolean' },
    },
    search: ['target.name', 'kind'],
  }),
  success: { status: 200, schema: RuleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [RULE_EXAMPLE] },
});

/** `GET /admin/pricing-rules/:id`: one rule. */
export const showPricingRule = defineRoute({
  key: 'GET /admin/pricing-rules/:id',
  summary: 'Show a pricing rule',
  tags: ['pricing-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: RuleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: RULE_EXAMPLE },
});

/** `POST /admin/pricing-rules`: a new rule. */
export const createPricingRule = defineRoute({
  key: 'POST /admin/pricing-rules',
  summary: 'Create a pricing rule',
  description:
    'The whole rule. `targetId` names the category or the service by `scope` and is `null` for a global rule; `groupId: null` ' +
    'covers every merchant group. `percent`, `fixed` and `minProfit` are never negative (the kind gives the direction) and at ' +
    'least one of `percent` and `fixed` is above zero (`422` on `percent`); a discount or promo cannot take off more than 100 %. ' +
    '`endsAt` must come after `startsAt` (`422` on `endsAt`). An unknown or archived target is `422` on `targetId`; an unknown ' +
    'group is `422` on `groupId`. Rules change the price of new orders only.',
  tags: ['pricing-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:create',
  body: z.object(RuleFields),
  success: { status: 201, schema: RuleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: { request: RULE_REQUEST_EXAMPLE, response: RULE_EXAMPLE },
});

/** `PATCH /admin/pricing-rules/:id`: change some fields of a rule. */
export const updatePricingRule = defineRoute({
  key: 'PATCH /admin/pricing-rules/:id',
  summary: 'Change a pricing rule',
  description:
    'Only the keys sent change (`isActive` alone turns a rule off or on). The merged rule is judged exactly like a new one.',
  tags: ['pricing-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({
      scope: RuleFields.scope.optional(),
      targetId: RuleFields.targetId.optional(),
      groupId: RuleFields.groupId.optional(),
      kind: RuleFields.kind.optional(),
      percent: RuleFields.percent.optional(),
      fixed: RuleFields.fixed.optional(),
      rounding: RuleFields.rounding.optional(),
      minProfit: RuleFields.minProfit.optional(),
      priority: RuleFields.priority.optional(),
      startsAt: RuleFields.startsAt.optional(),
      endsAt: RuleFields.endsAt.optional(),
      isActive: z.boolean().optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: RuleRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { isActive: false }, response: { ...RULE_EXAMPLE, isActive: false } },
});

/** `DELETE /admin/pricing-rules/:id`: delete a rule. */
export const deletePricingRule = defineRoute({
  key: 'DELETE /admin/pricing-rules/:id',
  summary: 'Delete a pricing rule',
  description: 'Answers `204`. New orders stop using the rule; existing orders keep their pricing snapshot.',
  tags: ['pricing-rules'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:delete',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});
