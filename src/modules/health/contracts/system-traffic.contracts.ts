// Route contracts of the API traffic page: `GET /admin/system/metrics` and `GET /admin/system/errors`, read from Prometheus
// (decision 015, MISMATCHES B90, B91, B114, B115). Both answer `503 MONITORING_UNAVAILABLE` when Prometheus is not configured or down.
import { z } from 'zod';
import { defineRoute, zIsoDateTime } from '../../../common/contract';
import { zMeasure, zRange, zSeriesPoint } from './system-common';

/** The surfaces of the API a traffic query can be scoped to. */
export const TRAFFIC_SURFACES = ['v1', 'dhru', 'client', 'store', 'admin', 'hooks'] as const;

const trafficQuery = z.object({
  range: zRange.default('24h'),
  // A free string on the wire (the console sends the surface key it was given); a value outside the list is a 422 on `surface`.
  surface: z
    .string()
    .refine((value) => (TRAFFIC_SURFACES as readonly string[]).includes(value), {
      message: `Must be one of ${TRAFFIC_SURFACES.join(', ')}.`,
    })
    .optional(),
});

const SurfaceMetrics = z.object({
  surface: z.string(),
  label: z.string(),
  requestsPerMin: zMeasure,
  p50: zMeasure,
  p95: zMeasure,
  p99: zMeasure,
  rate4xx: zMeasure,
  rate5xx: zMeasure,
  count429: zMeasure,
  series: z.object({
    requestsPerMin: z.array(zSeriesPoint),
    p50: z.array(zSeriesPoint),
    p95: z.array(zSeriesPoint),
    p99: z.array(zSeriesPoint),
    rate4xx: z.array(zSeriesPoint),
    rate5xx: z.array(zSeriesPoint),
  }),
});

/** `GET /admin/system/metrics`: API performance per surface. */
export const getApiMetrics = defineRoute({
  key: 'GET /admin/system/metrics',
  summary: 'API performance',
  description:
    'Requests per minute, latency p50, p95 and p99, 4xx and 5xx rates (percent, `503 MAINTENANCE` left out of the 5xx rate) and the count of 429 answers, per surface and in total, from the Prometheus histogram `http_request_duration_seconds` (decision 015). ' +
    '"Now" measures cover the last 5 minutes; `series` has 60, 72, 96 or 168 points for `1h`, `6h`, `24h` or `7d`, oldest first, with null where nothing was measured. With `?surface=` the whole answer is that surface. ' +
    '`slowest` is at most 10 route templates by p95 over the range. Without Prometheus (`PROMETHEUS_URL`) or when it does not answer in time: `503 MONITORING_UNAVAILABLE`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  query: trafficQuery,
  success: {
    status: 200,
    schema: z.object({
      range: zRange,
      bucketSeconds: z.number().int(),
      total: SurfaceMetrics,
      surfaces: z.array(SurfaceMetrics),
      slowest: z.array(
        z.object({
          method: z.string(),
          path: z.string(),
          surface: z.string(),
          p95: zMeasure,
          requestsPerMin: z.number(),
        }),
      ),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED', 'MONITORING_UNAVAILABLE'],
});

/** `GET /admin/system/errors`: the most frequent API errors. */
export const getApiErrors = defineRoute({
  key: 'GET /admin/system/errors',
  summary: 'Most frequent API errors',
  description:
    'The top 10 groups of (error code, method, route template) over the range by count, most frequent first, from the counter `api_errors_total`; `total` counts every problem answer in the range, listed or not. ' +
    '`firstSeenAt` and `lastSeenAt` are the first and last bucket of the range in which the group occurred; `lastRequestId` and `sentryUrl` are `null` (the counter keeps no request ids and no Sentry link is configured). ' +
    '`503 MAINTENANCE` answers form their own group. Without Prometheus: `503 MONITORING_UNAVAILABLE`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  query: trafficQuery,
  success: {
    status: 200,
    schema: z.object({
      range: zRange,
      total: z.number().int(),
      groups: z.array(
        z.object({
          code: z.string(),
          status: z.number().int(),
          method: z.string(),
          endpoint: z.string(),
          surface: z.string(),
          count: z.number().int(),
          firstSeenAt: zIsoDateTime,
          lastSeenAt: zIsoDateTime,
          lastRequestId: z.string().nullable(),
          sentryUrl: z.string().nullable(),
        }),
      ),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED', 'MONITORING_UNAVAILABLE'],
});

/** `GET /admin/queues`: the Bull Board UI (an HTML page with its own assets). */
export const queuesBoard = defineRoute({
  key: 'GET /admin/queues',
  summary: 'Queue board (Bull Board)',
  description:
    'The Bull Board page for the BullMQ queues, with its assets and read calls under `/admin/queues/*`. Staff only: the staff session cookie and the `queues:read` permission (no CSRF header: a top-level navigation). ' +
    'The board is read-only; retrying and pausing are `POST /admin/system/queues/:name/retry` and `/pause`, which are audited.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'queues:read',
  success: { status: 200, contentType: 'text/html' },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
});
