// Route contracts of the commission plans (map domain F, routes /admin/commission-plans*, stage 11): list, show, create, change, delete.
// Shapes match the console's `src/features/commissions/types` (docs/contract/endpoints/commissions.md, resolutions health-commissions-1).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zJsonObject } from '../../../common/contract';
import { COMMISSION_PLAN_KINDS } from '../db/schema';
import { planRateProblem } from '../domain/plan-input';

const id = z.object({ id: zIdParam });

const Kind = z.enum(COMMISSION_PLAN_KINDS);

/** A plan as the Plans tab reads it. */
const PlanRow = z.object({
  id: zId,
  name: z.string(),
  kind: Kind,
  basis: z
    .string()
    .describe('What the rate applies to, free text (for example "Order revenue of referred merchants").'),
  percent: zDecimal.describe('The rate in percent with 4 decimals: `3.0000` is 3 percent.'),
  tiers: zJsonObject.describe(
    'The plan conditions as a JSON object, stored as sent (`{}` when none); never interpreted.',
  ),
  period: z.string().describe('How often it is paid, free text (for example "monthly").'),
  isActive: z.boolean(),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
});

const PLAN_EXAMPLE = {
  id: 1,
  name: 'Referral',
  kind: 'referral',
  basis: 'Order revenue of referred merchants',
  percent: '3.0000',
  tiers: { minPayout: '50.0000' },
  period: 'monthly',
  isActive: true,
  createdAt: '2026-09-26T12:00:00.000Z',
  updatedAt: '2026-10-21T12:00:00.000Z',
} as const;

const Name = z.string().trim().min(1, 'Enter a name.').max(120, 'Use at most 120 characters.');
const Label = z.string().trim().min(1, 'Fill this in.').max(200, 'Use at most 200 characters.');
const Percent = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const problem = planRateProblem(value);
    if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
  });
const Tiers = zJsonObject.describe('A JSON object; an array, a text or `null` is refused.');

/** `GET /admin/commission-plans`. */
export const listCommissionPlans = defineRoute({
  key: 'GET /admin/commission-plans',
  summary: 'List commission plans',
  description:
    'Referral and rebate plans, `id` ascending by default. The console reads the whole list (`_start=0&_end=200`). `percent` is a ' +
    'percent string (`3.0000` is 3 percent) and `tiers` a JSON object (`{}` when none, never `[]`).',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:read',
  query: listQuery({
    sorts: ['id', 'name', 'percent', 'createdAt'],
    defaultSort: { field: 'id', order: 'asc' },
    filters: { kind: { type: 'enum', values: COMMISSION_PLAN_KINDS }, isActive: { type: 'boolean' } },
    search: ['name'],
  }),
  success: { status: 200, schema: PlanRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [PLAN_EXAMPLE] },
});

/** `GET /admin/commission-plans/:id`. */
export const showCommissionPlan = defineRoute({
  key: 'GET /admin/commission-plans/:id',
  summary: 'Show a commission plan',
  description: 'The same row as the list.',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:read',
  params: id,
  success: { status: 200, schema: PlanRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: PLAN_EXAMPLE },
});

/** `POST /admin/commission-plans`. */
export const createCommissionPlan = defineRoute({
  key: 'POST /admin/commission-plans',
  summary: 'Add a commission plan',
  description:
    '`name`, `kind` (`referral` pays the agent that brought a merchant, `rebate` pays a merchant back on its own orders), `percent`, ' +
    '`basis` and `period` are required; `tiers` is a JSON object (`{}` by default) and `isActive` is true by default. The rate is ' +
    '0.5 to 15 percent (`422` on `percent` otherwise) and is stored with 4 decimals. The commission of an order is its revenue times ' +
    'the rate (`basis` is a label: the amount is always worked out on revenue).',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:create',
  body: z.object({
    name: Name,
    kind: Kind,
    percent: Percent,
    basis: Label,
    period: Label,
    tiers: Tiers.optional(),
    isActive: z.boolean().optional(),
  }),
  success: { status: 201, schema: PlanRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      name: 'Referral',
      kind: 'referral',
      percent: '3.5',
      basis: 'Order revenue of referred merchants',
      period: 'monthly',
      tiers: {},
    },
    response: { ...PLAN_EXAMPLE, percent: '3.5000', tiers: {} },
  },
});

/** `PATCH /admin/commission-plans/:id`. */
export const updateCommissionPlan = defineRoute({
  key: 'PATCH /admin/commission-plans/:id',
  summary: 'Change a commission plan',
  description:
    'Only the keys sent change (the console sends a diff). A new rate applies to orders completed after the save: accruals already ' +
    "earned keep the rate they were earned at. Changing the `kind` gives the plan's current assignments the matching scope. The same " +
    'field rules as the create apply.',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:update',
  params: id,
  body: z
    .object({
      name: Name.optional(),
      kind: Kind.optional(),
      percent: Percent.optional(),
      basis: Label.optional(),
      period: Label.optional(),
      tiers: Tiers.optional(),
      isActive: z.boolean().optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: PlanRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { percent: '5' }, response: { ...PLAN_EXAMPLE, percent: '5.0000' } },
});

/** `DELETE /admin/commission-plans/:id`. */
export const deleteCommissionPlan = defineRoute({
  key: 'DELETE /admin/commission-plans/:id',
  summary: 'Delete a commission plan',
  description:
    'Refused with `409 PLAN_IN_USE` while an assignment is current ("N merchants are on the X plan. End or move those assignments ' +
    'first.") and also when the plan has ended assignments or accruals in its history (switch it off with `isActive: false` instead).',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:delete',
  params: id,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'PLAN_IN_USE'],
});
