// Route contracts of the alert rules (map domain G, routes /admin/alert-rules*, feature 12b): list, show, create, change and delete.
// Shapes match the console's `src/features/system-health/types/alerts.ts` (docs/contract/endpoints/health.md; resolutions
// health-commissions-13, ANSWERS system-health Q29 to Q31).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { ALERT_CHANNELS, ALERT_COMPARATORS, ALERT_SEVERITIES, ALERT_UNITS, type AlertChannel } from '../db/schema';
import { METRIC_KEYS } from '../domain/metric-registry';

const id = z.object({ id: zIdParam });

/** The wire unit of a metric (`null` is "no unit"). */
const Unit = z.enum(ALERT_UNITS).nullable();

/** An alert rule as the console reads it (`AlertRule`). */
export const AlertRuleShape = z.object({
  id: zId,
  key: z.string(),
  name: z.string(),
  metric: z.enum(METRIC_KEYS),
  comparator: z.enum(ALERT_COMPARATORS),
  threshold: z.number().describe('A JSON number in the metric unit.'),
  windowSeconds: z.number().int(),
  severity: z.enum(ALERT_SEVERITIES),
  channels: z.array(z.enum(ALERT_CHANNELS)),
  isActive: z.boolean(),
  mutedUntil: zIsoDateTime.nullable().describe('A past time is not muted.'),
  unit: Unit.describe('From the metric registry; `null` for `supplier.balance`.'),
  open: z.boolean().describe('True while an alert of the rule is firing or acknowledged.'),
  muted: z.boolean().optional().describe('Extra field (always sent): `mutedUntil` is in the future.'),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime.nullable().describe('`null` until the rule is edited.'),
});

const RULE_EXAMPLE = {
  id: 1,
  key: 'supplier_timeout_rate',
  name: 'Supplier timeouts',
  metric: 'supplier.timeout_rate',
  comparator: 'gt',
  threshold: 20,
  windowSeconds: 180,
  severity: 'critical',
  channels: ['telegram', 'email'],
  isActive: true,
  mutedUntil: null,
  unit: 'percent',
  open: false,
  muted: false,
  createdAt: '2026-06-01T08:00:00.000Z',
  updatedAt: null,
} as const;

const Key = z
  .string({ error: 'Enter a key.' })
  .regex(/^[a-z][a-z0-9_]{2,40}$/, 'Use 3 to 41 lowercase letters, digits or underscores, starting with a letter.');
const Name = z
  .string({ error: 'Enter a name of 3 to 80 characters.' })
  .trim()
  .min(3, 'Enter a name of 3 to 80 characters.')
  .max(80, 'Enter a name of 3 to 80 characters.');
const Metric = z.enum(METRIC_KEYS, { error: 'Unknown metric. Choose one from the list.' });
const Comparator = z.enum(ALERT_COMPARATORS, { error: 'Choose how the value is compared with the threshold.' });
const Threshold = z
  .number({ error: 'Enter a number.' })
  .min(-1e12, 'Enter a number between -1,000,000,000,000 and 1,000,000,000,000.')
  .max(1e12, 'Enter a number between -1,000,000,000,000 and 1,000,000,000,000.');
const WindowSeconds = z
  .number({ error: 'Enter a whole number of seconds from 60 to 86400.' })
  .int('Enter a whole number of seconds from 60 to 86400.')
  .min(60, 'Enter a whole number of seconds from 60 to 86400.')
  .max(86_400, 'Enter a whole number of seconds from 60 to 86400.');
const Severity = z.enum(ALERT_SEVERITIES, { error: 'Choose info, warning or critical.' });
const CHANNEL_MESSAGE = 'Choose at least one channel: Telegram or email.';
// A plain string list with a refinement, not `z.enum` elements: the error then belongs to the field `channels` (an enum element would report `channels.0`).
const Channels = z
  .array(z.string(), { error: CHANNEL_MESSAGE })
  .min(1, CHANNEL_MESSAGE)
  .refine(
    (channels): channels is AlertChannel[] => channels.every((c) => (ALERT_CHANNELS as readonly string[]).includes(c)),
    CHANNEL_MESSAGE,
  )
  .transform((channels) => [...new Set(channels)])
  .describe('A non-empty list of `telegram` and `email`.');
const IsActive = z.boolean({ error: 'Send true or false.' });

/** `GET /admin/alert-rules`. */
export const listAlertRules = defineRoute({
  key: 'GET /admin/alert-rules',
  summary: 'List alert rules',
  description:
    'The rules that are not deleted, by name (the console sends `_start` and `_end` only). `open` is true while an alert of the rule is ' +
    'firing or acknowledged. `unit` comes from the metric registry: `percent`, `ms`, `s`, `count` or `null` (`supplier.balance`). ' +
    '`muted` is true while `mutedUntil` is in the future. During a database outage the route answers `503 DATABASE_UNAVAILABLE`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'alerts:read',
  query: listQuery({
    sorts: ['name', 'key', 'severity', 'createdAt', 'id'],
    defaultSort: { field: 'name', order: 'asc' },
    filters: {
      severity: { type: 'enum', values: ALERT_SEVERITIES },
      isActive: { type: 'boolean' },
      metric: { type: 'enum', values: METRIC_KEYS },
    },
    search: ['name', 'key', 'metric'],
  }),
  success: { status: 200, schema: AlertRuleShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED', 'DATABASE_UNAVAILABLE'],
  examples: { response: [RULE_EXAMPLE] },
});

/** `GET /admin/alert-rules/:id`. */
export const showAlertRule = defineRoute({
  key: 'GET /admin/alert-rules/:id',
  summary: 'Show an alert rule',
  description: 'The same row as the list. A deleted rule is `404`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'alerts:read',
  params: id,
  success: { status: 200, schema: AlertRuleShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'DATABASE_UNAVAILABLE'],
  examples: { response: RULE_EXAMPLE },
});

/** `POST /admin/alert-rules`. */
export const createAlertRule = defineRoute({
  key: 'POST /admin/alert-rules',
  summary: 'Add an alert rule',
  description:
    'Every field is required except `isActive` (default true). `key` is unique among the rules that are not deleted (a duplicate is `422` on ' +
    '`key`). `metric` is one of the eleven registry keys and the server sets `unit` from it: `supplier.timeout_rate`, `supplier.error_rate`, ' +
    '`api.rate5xx`, `db.connection_usage`, `redis.memory_usage` and `webhooks.success_rate` are `percent`; `api.p95` is `ms`; `queue.oldest_age` is ' +
    '`s`; `orders.past_sla` and `ledger.mismatch_count` are `count`; `supplier.balance` has no unit (`null`). `threshold` is a number in that unit. ' +
    '`windowSeconds` (60 to 86400) is the period a rate or percentile is measured over (`supplier.timeout_rate`, `supplier.error_rate`, `api.p95`, ' +
    '`api.rate5xx`, `webhooks.success_rate`); for `supplier.balance`, `queue.oldest_age`, `orders.past_sla`, `db.connection_usage` and ' +
    '`redis.memory_usage`, which read the moment, it is how long the condition must hold: the alert opens after every evaluation of the whole window ' +
    'was over the threshold and closes after every evaluation of the whole window was back in range. `ledger.mismatch_count` is the result of the ' +
    'newest integrity run and ignores the window. `channels` is a non-empty list of `telegram` and `email`. Writes the audit entry `added alert rule`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'alerts:create',
  body: z.object({
    key: Key,
    name: Name,
    metric: Metric,
    comparator: Comparator,
    threshold: Threshold,
    windowSeconds: WindowSeconds,
    severity: Severity,
    channels: Channels,
    isActive: IsActive.optional(),
  }),
  success: { status: 201, schema: AlertRuleShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      key: 'supplier_timeout_rate',
      name: 'Supplier timeouts',
      metric: 'supplier.timeout_rate',
      comparator: 'gt',
      threshold: 20,
      windowSeconds: 180,
      severity: 'critical',
      channels: ['telegram', 'email'],
    },
    response: RULE_EXAMPLE,
  },
});

/** `PATCH /admin/alert-rules/:id`. */
export const updateAlertRule = defineRoute({
  key: 'PATCH /admin/alert-rules/:id',
  summary: 'Change an alert rule',
  description:
    "Only the fields sent change, and each is checked like on create. `isActive: false` resolves the rule's open alerts. `mutedUntil` (a future time) " +
    'mutes the rule: it opens no new alerts until then, alerts already open stay open and still close by themselves; `null` unmutes; a past or ' +
    'invalid time is `422` on `mutedUntil`. A new `metric` recomputes `unit` and resolves the open alerts of the old metric. Writes the audit entry ' +
    '`changed alert rule` (`muted alert rule`, `unmuted alert rule`, `turned on alert rule` or `turned off alert rule` when that is all that changed).',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'alerts:update',
  params: id,
  body: z
    .object({
      key: Key.optional(),
      name: Name.optional(),
      metric: Metric.optional(),
      comparator: Comparator.optional(),
      threshold: Threshold.optional(),
      windowSeconds: WindowSeconds.optional(),
      severity: Severity.optional(),
      channels: Channels.optional(),
      isActive: IsActive.optional(),
      mutedUntil: zIsoDateTime.nullable().optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: AlertRuleShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { isActive: false }, response: { ...RULE_EXAMPLE, isActive: false } },
});

/** `DELETE /admin/alert-rules/:id`. */
export const deleteAlertRule = defineRoute({
  key: 'DELETE /admin/alert-rules/:id',
  summary: 'Delete an alert rule',
  description:
    'A soft delete: the rule stops alerting and leaves the list, its open alerts are resolved, and the alerts it fired keep their rule ' +
    '(B102). Its key can be used again. Writes the audit entry `deleted alert rule`. Deleting a rule that is already deleted is `404`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'alerts:delete',
  params: id,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});
