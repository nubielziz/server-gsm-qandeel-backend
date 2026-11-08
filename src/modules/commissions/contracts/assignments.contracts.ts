// Route contracts of the commission assignments (map domain F, routes /admin/commission-assignments*, stage 11): list, show, assign,
// change the plan, end. Shapes match the console's `src/features/commissions/types` (docs/contract/endpoints/commissions.md,
// resolutions health-commissions-2 and -12, MISMATCHES B42, M155).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';

const id = z.object({ id: zIdParam });

/** An assignment as the Agents tab reads it: the console's fields, the merchant and the plan joined, and the agent's figures. */
const AssignmentRow = z.object({
  id: zId,
  planId: zId,
  beneficiaryId: zId,
  scope: z
    .string()
    .describe(
      '`referrals` (a referral plan: the agent earns on the orders of merchants it referred) or `own` (a rebate plan).',
    ),
  startsAt: zIsoDateTime.nullable(),
  endsAt: zIsoDateTime
    .nullable()
    .describe('Set when the assignment ended; the list leaves ended rows out unless `includeEnded=true`.'),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
  beneficiary: z
    .object({ id: zId, name: z.string(), country: z.string() })
    .nullable()
    .describe('The agent (the merchant on the plan).'),
  plan: z.object({ id: zId, name: z.string(), percent: zDecimal }).nullable(),
  referredCount: z.number().int().optional().describe('Extra (M155): merchants the agent referred.'),
  revenue30d: zMoney
    .optional()
    .describe("Extra (M155): revenue of the referred merchants' orders completed in the last 30 days."),
  readyAmount: zMoney.optional().describe('Extra (M155): commission waiting for approval.'),
  approvedAmount: zMoney
    .optional()
    .describe('Extra (M155): commission approved, all time, not counting what was paid back.'),
});

const ASSIGNMENT_EXAMPLE = {
  id: 1,
  planId: 1,
  beneficiaryId: 1,
  scope: 'referrals',
  startsAt: '2026-09-16T12:00:00.000Z',
  endsAt: null,
  createdAt: '2026-09-16T12:00:00.000Z',
  updatedAt: '2026-09-16T12:00:00.000Z',
  beneficiary: { id: 1, name: 'Zain Mobile Hub', country: 'JO' },
  plan: { id: 1, name: 'Referral', percent: '3.0000' },
  referredCount: 4,
  revenue30d: '812.4000',
  readyAmount: '3.2100',
  approvedAmount: '48.9000',
} as const;

/** `GET /admin/commission-assignments`. */
export const listCommissionAssignments = defineRoute({
  key: 'GET /admin/commission-assignments',
  summary: 'List commission assignments',
  description:
    'The merchants that are on a plan, newest first by default, with the merchant and the plan joined. Only current assignments ' +
    'are listed; `includeEnded=true` adds the ended ones (MISMATCHES B42). Each row carries the per-agent figures of M155 as extra ' +
    'fields (`referredCount`, `revenue30d`, `readyAmount`, `approvedAmount`). The console reads `_start=0&_end=200&_sort=createdAt&_order=desc`.',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:read',
  query: listQuery({
    sorts: ['createdAt', 'id', 'startsAt'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: { planId: { type: 'id', ops: ['eq'] }, beneficiaryId: { type: 'id', ops: ['eq'] } },
    extra: { includeEnded: z.enum(['true', 'false']).optional() },
  }),
  success: { status: 200, schema: AssignmentRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [ASSIGNMENT_EXAMPLE] },
});

/** `GET /admin/commission-assignments/:id`. */
export const showCommissionAssignment = defineRoute({
  key: 'GET /admin/commission-assignments/:id',
  summary: 'Show a commission assignment',
  description: 'The same row as the list; an ended assignment is shown with its `endsAt`.',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:read',
  params: id,
  success: { status: 200, schema: AssignmentRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: ASSIGNMENT_EXAMPLE },
});

/** `POST /admin/commission-assignments`. */
export const createCommissionAssignment = defineRoute({
  key: 'POST /admin/commission-assignments',
  summary: 'Put a merchant on a plan',
  description:
    'The merchant becomes an agent on the plan. The server sets the scope (`referrals` for a referral plan, `own` for a rebate plan) ' +
    'and `startsAt` (now). A merchant has one current plan: a second one is `409 ALREADY_ASSIGNED` ("<merchant> is already on the ' +
    '<plan> plan"), also when two requests race. `422` names `beneficiaryId` (no such merchant) or `planId` (no such plan, or one that ' +
    'is switched off).',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:create',
  body: z.object({ beneficiaryId: zId, planId: zId }),
  success: { status: 201, schema: AssignmentRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'ALREADY_ASSIGNED'],
  examples: { request: { beneficiaryId: 1, planId: 1 }, response: ASSIGNMENT_EXAMPLE },
});

/** `PATCH /admin/commission-assignments/:id`. */
export const updateCommissionAssignment = defineRoute({
  key: 'PATCH /admin/commission-assignments/:id',
  summary: 'Move a merchant to another plan',
  description:
    'Ends the current assignment and starts a new one on `planId`, in one transaction; orders completed from now earn the new rate and ' +
    'accruals already earned keep theirs. The answer is the new assignment (its id differs from the one sent). The same plan again is ' +
    '`409 ALREADY_ASSIGNED`; an assignment that already ended is `404`; `422` names `planId` (unknown, or switched off).',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:update',
  params: id,
  body: z.object({ planId: zId }),
  success: { status: 200, schema: AssignmentRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED', 'ALREADY_ASSIGNED'],
  examples: {
    request: { planId: 2 },
    response: { ...ASSIGNMENT_EXAMPLE, id: 3, planId: 2, plan: { id: 2, name: 'Partner', percent: '5.0000' } },
  },
});

/** `DELETE /admin/commission-assignments/:id`. */
export const deleteCommissionAssignment = defineRoute({
  key: 'DELETE /admin/commission-assignments/:id',
  summary: 'End a commission assignment',
  description:
    'Sets `endsAt` to now: no commission accrues on orders completed afterwards, and accruals already earned stay approvable. It never ' +
    'refuses because commissions are ready to approve (there is no `HAS_PENDING`). An assignment that already ended is `404`.',
  tags: ['commissions'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'commissions:delete',
  params: id,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});
