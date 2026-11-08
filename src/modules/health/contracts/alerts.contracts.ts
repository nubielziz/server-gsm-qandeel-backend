// Route contracts of the fired alerts (map domain G, routes /admin/alerts*, feature 12b): list, show and acknowledge. Alerts are made by the
// evaluator, so there is no create or delete. Shapes match the console's `AlertEvent` (docs/contract/endpoints/health.md; resolutions
// health-commissions-5, -14, ANSWERS system-health Q28, Q31).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { ALERT_COMPARATORS, ALERT_SEVERITIES, ALERT_STATUSES, ALERT_SUBJECT_TYPES, ALERT_UNITS } from '../db/schema';
import { METRIC_KEYS } from '../domain/metric-registry';
import { zStaffRef } from './system-common';

const id = z.object({ id: zIdParam });

/** The rule an alert came from, as the alert carries it: id and key live, the rest is the snapshot taken when it fired. */
const RuleRef = z.object({
  id: zId,
  key: z.string(),
  name: z.string(),
  metric: z.enum(METRIC_KEYS),
  comparator: z.enum(ALERT_COMPARATORS),
  threshold: z.number(),
  windowSeconds: z.number().int(),
  unit: z.enum(ALERT_UNITS).nullable(),
});

/** A fired alert as the console reads it (`AlertEvent`). */
export const AlertEventShape = z.object({
  id: zId,
  ruleId: zId,
  rule: RuleRef.describe('Name, metric, comparator, threshold, window and unit as they were when the alert fired.'),
  status: z.enum(ALERT_STATUSES),
  severity: z.enum(ALERT_SEVERITIES).describe('Copied from the rule when the alert fired.'),
  value: z.number().describe('The measured value that fired the alert, in the metric unit.'),
  subjectType: z.enum(ALERT_SUBJECT_TYPES).describe('Never null: `system` when the alert belongs to no record.'),
  subjectId: z.number().int().min(0).describe('`0` when the subject has no id (the platform, a queue); never null.'),
  subjectLabel: z.string().nullable().describe('The supplier or queue name; `null` for a system alert.'),
  startedAt: zIsoDateTime,
  acknowledgedAt: zIsoDateTime.nullable(),
  acknowledgedBy: zStaffRef.nullable(),
  resolvedAt: zIsoDateTime.nullable(),
  note: z.string().nullable(),
  incidentId: zId.nullable().describe('The incident declared from this alert, if any.'),
});

const ALERT_EXAMPLE = {
  id: 7,
  ruleId: 1,
  rule: {
    id: 1,
    key: 'supplier_timeout_rate',
    name: 'Supplier timeouts',
    metric: 'supplier.timeout_rate',
    comparator: 'gt',
    threshold: 20,
    windowSeconds: 180,
    unit: 'percent',
  },
  status: 'firing',
  severity: 'critical',
  value: 23.4,
  subjectType: 'supplier',
  subjectId: 6,
  subjectLabel: 'Bosphorus Unlock',
  startedAt: '2026-11-07T08:12:00.000Z',
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedAt: null,
  note: null,
  incidentId: null,
} as const;

/** `GET /admin/alerts`. */
export const listAlerts = defineRoute({
  key: 'GET /admin/alerts',
  summary: 'List alerts',
  description:
    'Newest first. Filters: `status` (`firing`, `acknowledged` or `resolved`; repeat the key for several), `severity`, and `open=true` (firing or ' +
    'acknowledged; `open=false` is resolved). `q` searches the rule name, the subject label and the note. `rule` is the snapshot taken when the alert ' +
    'fired, so a later edit or delete of the rule never rewrites it; `rule.id` and `rule.key` are live. An acknowledged alert stays open (and counts ' +
    'in the health page, critical included) until the value is back in range. During a database outage the route answers `503 DATABASE_UNAVAILABLE`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'alerts:read',
  query: listQuery({
    sorts: ['startedAt', 'id', 'severity', 'status'],
    defaultSort: { field: 'startedAt', order: 'desc' },
    filters: {
      status: { type: 'enum', values: ALERT_STATUSES },
      severity: { type: 'enum', values: ALERT_SEVERITIES },
      open: { type: 'boolean' },
    },
    search: ['rule.name', 'subjectLabel', 'note'],
  }),
  success: { status: 200, schema: AlertEventShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED', 'DATABASE_UNAVAILABLE'],
  examples: { response: [ALERT_EXAMPLE] },
});

/** `GET /admin/alerts/:id`. */
export const showAlert = defineRoute({
  key: 'GET /admin/alerts/:id',
  summary: 'Show an alert',
  description: 'The same row as the list.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'alerts:read',
  params: id,
  success: { status: 200, schema: AlertEventShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'DATABASE_UNAVAILABLE'],
  examples: { response: ALERT_EXAMPLE },
});

/** `POST /admin/alerts/:id/ack`. */
export const ackAlert = defineRoute({
  key: 'POST /admin/alerts/:id/ack',
  summary: 'Acknowledge an alert',
  description:
    'Stops the repeated messages and records the staff member, the time and an optional `note` (at most 500 characters). The alert stays open until the ' +
    'value is back in range. A conditional update, so a double click is `409 ALERT_ACKNOWLEDGED` (the detail names who); an alert the server already ' +
    'closed is `409 ALERT_RESOLVED`. Writes the audit entry `acknowledged alert`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'alerts:update',
  params: id,
  body: z.object({
    note: z.string().trim().max(500, 'Keep the note under 500 characters.').optional(),
  }),
  success: { status: 200, schema: AlertEventShape },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ALERT_ACKNOWLEDGED',
    'ALERT_RESOLVED',
    'VALIDATION_FAILED',
  ],
  examples: {
    request: { note: 'Checking with the supplier.' },
    response: {
      ...ALERT_EXAMPLE,
      status: 'acknowledged',
      acknowledgedAt: '2026-11-07T08:20:00.000Z',
      acknowledgedBy: { id: 4, name: 'Dana M.' },
      note: 'Checking with the supplier.',
    },
  },
});
