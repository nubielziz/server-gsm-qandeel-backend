// Route contracts of the risk rules (map domain K, stage 18): the eight rules and their thresholds. Shapes are the console's
// (src/features/risk/types: RiskRules, SaveRiskRulesBody).
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';

/** One rule as the console reads it. */
export const RiskRuleSchema = z.object({
  id: z
    .string()
    .describe(
      'blockBlacklistedImei, reviewThreshold, blockThreshold, maxOrdersPerEmail, reviewFirstOrderAbove, require3ds, reviewIpCountryMismatch or blockDisposableEmail.',
    ),
  on: z.boolean(),
  value: z.number().int().nullable().describe('Points, orders per 24 hours or whole USD; null for a plain switch.'),
  label: z.string().optional(),
  hint: z.string().optional(),
  unit: z.string().optional(),
});

/** The answer of `GET` and `PUT /admin/risk/rules`. */
export const RiskRulesSchema = z.object({ rules: z.array(RiskRuleSchema) });

const RULES_EXAMPLE = {
  rules: [
    {
      id: 'reviewThreshold',
      on: true,
      value: 50,
      label: 'Hold orders scoring at least',
      hint: 'Held orders wait in the risk queue and are not sent to a supplier.',
      unit: 'points',
    },
    { id: 'blockThreshold', on: true, value: 80, label: 'Block orders scoring at least', unit: 'points' },
  ],
} as const;

/** `GET /admin/risk/rules`. */
export const getRiskRules = defineRoute({
  key: 'GET /admin/risk/rules',
  summary: 'The risk rules',
  description:
    'The eight rules in display order, each with its switch and, for the four numeric ones, its number: `reviewThreshold` and ' +
    '`blockThreshold` (points), `maxOrdersPerEmail` (orders in 24 hours) and `reviewFirstOrderAbove` (whole USD). `label`, `hint` ' +
    'and `unit` are the demo’s words. `require3ds` is the storefront policy of the same name: one stored value.',
  tags: ['risk'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:read',
  success: { status: 200, schema: RiskRulesSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
  examples: { response: RULES_EXAMPLE },
});

/** The body of `PUT /admin/risk/rules`. */
export const SaveRiskRulesBodySchema = z.object({
  rules: z
    .array(
      z.object({
        id: z.string(),
        on: z.boolean(),
        value: z
          .number()
          .nullable()
          .describe('A whole number from 0, or null (a numeric rule keeps its stored number).'),
      }),
    )
    .describe('The whole set with one change applied; a rule the request leaves out keeps its stored value.'),
});

/** `PUT /admin/risk/rules`. */
export const saveRiskRules = defineRoute({
  key: 'PUT /admin/risk/rules',
  summary: 'Save the risk rules',
  description:
    'Saves the set the console sends (last write wins, no `If-Match`) and answers the saved set. `422` names the rule: an unknown ' +
    'id, a value that is not a whole number from 0, a number on a plain switch, and `reviewThreshold` when the review threshold is ' +
    'not lower than the block threshold (whether or not either switch is on). Every change is audited as `turned on risk rule`, ' +
    '`turned off risk rule` or `changed risk rule`. Needs the literal `risk:*` (or `*`).',
  tags: ['risk'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'risk:*',
  body: SaveRiskRulesBodySchema,
  success: { status: 200, schema: RiskRulesSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      rules: [
        { id: 'reviewThreshold', on: true, value: 50 },
        { id: 'blockThreshold', on: true, value: 80 },
      ],
    },
    response: RULES_EXAMPLE,
  },
});
