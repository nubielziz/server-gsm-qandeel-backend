// Route contracts of the System health overview: `GET /admin/system/health`, `GET /admin/system/checks` and
// `PUT /admin/system/maintenance` (map domain G, stage 9; docs/contract/endpoints/health.md, ANSWERS system-health).
import { z } from 'zod';
import { defineRoute, zId, zIsoDateTime } from '../../../common/contract';
import { zCheckStatus, zMeasure, zRange, zSeriesPoint, zStaffRef } from './system-common';

const UptimeWindows = z.object({ h24: zMeasure, d7: zMeasure, d30: zMeasure });

const MaintenanceState = z.object({
  enabled: z.boolean(),
  scope: z.enum(['store', 'checkout', 'api_orders', 'all']).nullable(),
  message: z.string().nullable(),
  expectedEndAt: zIsoDateTime.nullable(),
  startedAt: zIsoDateTime.nullable(),
  startedBy: zStaffRef.nullable(),
});

const HealthComponent = z.object({
  key: z.string(),
  name: z.string(),
  kind: z.enum(['core', 'supplier', 'gateway']),
  status: zCheckStatus,
  since: zIsoDateTime.nullable(),
  latency: zMeasure,
  uptime: UptimeWindows,
  lastCheckedAt: zIsoDateTime.nullable(),
  detail: z.string().nullable(),
  supplierId: zId.nullable(),
  gatewayId: zId.nullable(),
});

const SystemHealth = z.object({
  status: z.enum(['operational', 'degraded', 'outage', 'unknown']),
  since: zIsoDateTime.nullable(),
  checkedAt: zIsoDateTime,
  monitoring: z.object({
    status: z.enum(['available', 'unavailable']),
    detail: z.string().nullable(),
    lastScrapeAt: zIsoDateTime.nullable(),
  }),
  build: z.object({
    version: z.string(),
    commit: z.string(),
    environment: z.string(),
    deployedAt: zIsoDateTime.nullable(),
  }),
  components: z.array(HealthComponent),
  uptime: z.object({ h24: zMeasure, d7: zMeasure, d30: zMeasure, daily: z.array(zSeriesPoint) }),
  alerts: z.object({
    open: zMeasure,
    critical: z.number().int(),
    items: z.array(
      z.object({
        id: zId,
        ruleName: z.string(),
        severity: z.enum(['info', 'warning', 'critical']),
        status: z.enum(['firing', 'acknowledged']),
        subjectLabel: z.string().nullable(),
        startedAt: zIsoDateTime.nullable(),
      }),
    ),
    trend: z.array(zSeriesPoint),
  }),
  incidents: z.array(
    z.object({
      id: zId,
      title: z.string(),
      severity: z.enum(['minor', 'major', 'critical']),
      status: z.enum(['investigating', 'identified', 'monitoring']),
      components: z.array(z.string()),
      startedAt: zIsoDateTime.nullable(),
    }),
  ),
  maintenance: MaintenanceState,
});

/** `GET /admin/system/health`: the overall status with every component, uptime, open alerts, incidents and maintenance. */
export const getSystemHealth = defineRoute({
  key: 'GET /admin/system/health',
  summary: 'System health overview',
  description:
    'One snapshot for the verdict, the Overview tab and the maintenance banner of every admin page. `status` is `outage` when a core component is down, `degraded` when any component is down or degraded or a critical alert is open, ' +
    '`operational` otherwise, and never `operational` while `monitoring.status` is `unavailable` (then `unknown` unless the checks prove a problem). Components come from the latest `service_checks` row per key: the core keys ' +
    '`api`, `postgres`, `redis`, `redis_queue`, `storage`, `workers`, `mail`, `supplier:<id>` for every supplier (a disabled one is `unknown` with the detail `checks are off`) and `gateway:<id>`. `detail` is the failure text of a degraded or down check, else `null`. ' +
    'Uptime is checks that were not down over all checks (`value` null without checks). The answer is cached for a few seconds.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  success: { status: 200, schema: SystemHealth },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'DATABASE_UNAVAILABLE'],
});

const ComponentChecks = z.object({
  key: z.string(),
  name: z.string(),
  uptime: zMeasure,
  latency: zMeasure,
  buckets: z.array(
    z.object({
      start: zIsoDateTime,
      status: zCheckStatus,
      checks: z.number().int(),
      failures: z.number().int(),
      latencyMs: z.number().nullable(),
    }),
  ),
});

/** `GET /admin/system/checks`: the check history of the components over a range. */
export const getChecks = defineRoute({
  key: 'GET /admin/system/checks',
  summary: 'Check history of the components',
  description:
    'Uptime bars and response time per component. `range` is `1h`, `6h`, `24h` or `7d` (default `24h`): 60, 72, 48 or 56 buckets of 60 s, 300 s, 1800 s or 10800 s, oldest first, the last one still filling. A bucket is the worst check in it ' +
    '(`down` > `degraded` > `ok`, `unknown` with no checks), `failures` counts `down` rows and `latencyMs` is the p95 of the answered checks. `component` is a stored key (`postgres`, `supplier:3`); an unknown key is 404. Cached about 30 s per range and component.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  query: z.object({ range: zRange.default('24h'), component: z.string().min(1).max(100).optional() }),
  success: {
    status: 200,
    schema: z.object({ range: zRange, bucketSeconds: z.number().int(), components: z.array(ComponentChecks) }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'DATABASE_UNAVAILABLE'],
});

const MaintenanceBody = z.discriminatedUnion('enabled', [
  z.object({
    enabled: z.literal(true),
    scope: z.enum(['store', 'checkout', 'api_orders', 'all']),
    message: z.string().trim().min(1).max(300),
    expectedEndAt: zIsoDateTime.nullable(),
  }),
  z.object({ enabled: z.literal(false) }),
]);

/** `PUT /admin/system/maintenance`: switch maintenance mode on, change it, or switch it off. */
export const setMaintenance = defineRoute({
  key: 'PUT /admin/system/maintenance',
  summary: 'Set maintenance mode',
  description:
    'Body `{ enabled: true, scope, message, expectedEndAt }` or `{ enabled: false }`. `scope` is `store` (the storefront API), `checkout` (starting a storefront checkout only), `api_orders` (placing orders over REST v1 and Dhru) or `all`; ' +
    'requests in scope answer `503 MAINTENANCE`; the admin console and the merchant portal are never affected. Enabling while on changes scope, message and end but keeps `startedAt` and `startedBy`; switching off resets the other fields to `null`. ' +
    '`expectedEndAt` must be in the future and only informs customers. Writes the audit entries `turned on maintenance`, `changed maintenance` and `turned off maintenance`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:manage',
  body: MaintenanceBody,
  success: { status: 200, schema: MaintenanceState },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      enabled: true,
      scope: 'checkout',
      message: 'Back at 10:00 UTC.',
      expectedEndAt: '2030-01-01T10:00:00.000Z',
    },
  },
});
