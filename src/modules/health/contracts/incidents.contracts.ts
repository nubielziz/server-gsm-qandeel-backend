// Route contracts of the incidents (map domain G, routes /admin/incidents*, feature 12b): list, show, declare and update. Shapes match the
// console's `Incident` (docs/contract/endpoints/health.md; resolutions health-commissions-15, ANSWERS system-health Q8, Q9, Q19, Q31).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES } from '../db/schema';
import { zStaffRef } from './system-common';

const id = z.object({ id: zIdParam });

/** One line of an incident's timeline. */
const TimelineLine = z.object({
  at: zIsoDateTime,
  status: z.enum(INCIDENT_STATUSES),
  text: z.string(),
  by: zStaffRef.nullable(),
});

/** An incident as the console reads it (`Incident`). */
export const IncidentShape = z.object({
  id: zId,
  title: z.string(),
  severity: z.enum(INCIDENT_SEVERITIES),
  status: z.enum(INCIDENT_STATUSES),
  components: z
    .array(z.string())
    .describe('Health component keys: `api`, `postgres`, `supplier:<id>`, `gateway:<id>`, ...'),
  summary: z.string(),
  timeline: z.array(TimelineLine).describe('Oldest line first.'),
  rootCause: z.string().nullable().describe('`null` until the incident is closed.'),
  startedAt: zIsoDateTime,
  resolvedAt: zIsoDateTime.nullable(),
  alertEventId: zId.nullable(),
  createdBy: zStaffRef.nullable(),
  resolvedBy: zStaffRef.nullable(),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime.nullable(),
});

const INCIDENT_EXAMPLE = {
  id: 3,
  title: 'Supplier timeouts',
  severity: 'major',
  status: 'investigating',
  components: ['supplier:6'],
  summary: 'Bosphorus Unlock answers in about 6 seconds and times out. Orders sent to it are late.',
  timeline: [
    {
      at: '2026-11-07T08:25:00.000Z',
      status: 'investigating',
      text: 'Incident declared. We are investigating.',
      by: { id: 4, name: 'Dana M.' },
    },
  ],
  rootCause: null,
  startedAt: '2026-11-07T08:25:00.000Z',
  resolvedAt: null,
  alertEventId: 7,
  createdBy: { id: 4, name: 'Dana M.' },
  resolvedBy: null,
  createdAt: '2026-11-07T08:25:00.000Z',
  updatedAt: '2026-11-07T08:25:00.000Z',
} as const;

const Title = z
  .string({ error: 'Enter a title of 3 to 120 characters.' })
  .trim()
  .min(3, 'Enter a title of 3 to 120 characters.')
  .max(120, 'Enter a title of 3 to 120 characters.');
const Severity = z.enum(INCIDENT_SEVERITIES, { error: 'Choose minor, major or critical.' });
const Components = z
  .array(z.string().trim().min(1).max(60), { error: 'Choose at least one affected component.' })
  .min(1, 'Choose at least one affected component.')
  .max(30, 'Choose at most 30 components.')
  .transform((components) => [...new Set(components)]);
const Summary = z
  .string({ error: 'Describe what is happening in at least 10 characters.' })
  .trim()
  .min(10, 'Describe what is happening in at least 10 characters.')
  .max(2000, 'Keep the summary under 2000 characters.');
const Status = z.enum(INCIDENT_STATUSES, { error: 'Choose investigating, identified, monitoring or resolved.' });

/** `GET /admin/incidents`. */
export const listIncidents = defineRoute({
  key: 'GET /admin/incidents',
  summary: 'List incidents',
  description:
    'Newest first, each with its whole timeline. Filters: `open=true` (every status but resolved; `open=false` is resolved), `status` (repeat the key for ' +
    'several) and `severity`. `q` searches the title and the summary. During a database outage the route answers `503 DATABASE_UNAVAILABLE`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'incidents:read',
  query: listQuery({
    sorts: ['startedAt', 'id', 'severity', 'status'],
    defaultSort: { field: 'startedAt', order: 'desc' },
    filters: {
      status: { type: 'enum', values: INCIDENT_STATUSES },
      severity: { type: 'enum', values: INCIDENT_SEVERITIES },
      open: { type: 'boolean' },
    },
    search: ['title', 'summary'],
  }),
  success: { status: 200, schema: IncidentShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED', 'DATABASE_UNAVAILABLE'],
  examples: { response: [INCIDENT_EXAMPLE] },
});

/** `GET /admin/incidents/:id`. */
export const showIncident = defineRoute({
  key: 'GET /admin/incidents/:id',
  summary: 'Show an incident',
  description: 'The same row as the list, with the whole timeline.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'incidents:read',
  params: id,
  success: { status: 200, schema: IncidentShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'DATABASE_UNAVAILABLE'],
  examples: { response: INCIDENT_EXAMPLE },
});

/** `POST /admin/incidents`. */
export const createIncident = defineRoute({
  key: 'POST /admin/incidents',
  summary: 'Declare an incident',
  description:
    'Starts at `investigating` with the timeline line "Incident declared. We are investigating." by the staff member. `components` are health component ' +
    'keys (`api`, `postgres`, `redis`, `redis_queue`, `storage`, `workers`, `mail`, `supplier:<id>`, `gateway:<id>`); an unknown one is `422` on `components`. ' +
    '`alertEventId` links the alert the incident is declared from: one incident per alert, so an alert that has one (or does not exist) is `422` on ' +
    '`alertEventId`; a resolved alert may still start one. Writes the audit entry `opened incident`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'incidents:create',
  body: z.object({
    title: Title,
    severity: Severity,
    components: Components,
    summary: Summary,
    alertEventId: zId.nullable().optional(),
  }),
  success: { status: 201, schema: IncidentShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      title: 'Supplier timeouts',
      severity: 'major',
      components: ['supplier:6'],
      summary: 'Bosphorus Unlock answers in about 6 seconds and times out. Orders sent to it are late.',
      alertEventId: 7,
    },
    response: INCIDENT_EXAMPLE,
  },
});

/** `PATCH /admin/incidents/:id`. */
export const updateIncident = defineRoute({
  key: 'PATCH /admin/incidents/:id',
  summary: 'Update or close an incident',
  description:
    'Only the fields sent change. A new `status`, or a non-empty `update` (at most 1000 characters), appends one timeline line {now, status, `update` or ' +
    'a default sentence, the staff member}. `status: "resolved"` closes the incident: it needs a `rootCause` of at least 10 characters (sent now, or saved ' +
    'earlier), sets `resolvedAt` and `resolvedBy`, and the optional `update` ("the action taken") becomes the `resolved` line (B104). A resolved incident ' +
    'cannot be changed or reopened: `409 INCIDENT_CLOSED`. Writes the audit entry `updated incident` (`closed incident` when it closes).',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'incidents:update',
  params: id,
  body: z
    .object({
      title: Title.optional(),
      severity: Severity.optional(),
      components: Components.optional(),
      summary: Summary.optional(),
      status: Status.optional(),
      update: z.string().trim().max(1000, 'Keep the update under 1000 characters.').optional(),
      rootCause: z.string().trim().max(2000, 'Keep the root cause under 2000 characters.').optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: IncidentShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'INCIDENT_CLOSED', 'VALIDATION_FAILED'],
  examples: {
    request: { status: 'identified', update: 'The supplier confirmed a problem on its side.' },
    response: { ...INCIDENT_EXAMPLE, status: 'identified' },
  },
});
