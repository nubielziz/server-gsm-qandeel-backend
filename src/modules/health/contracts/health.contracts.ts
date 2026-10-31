// Route contracts of the health module's system routes: GET /health and GET /metrics (map: surface system).
import { z } from 'zod';
import { defineRoute } from '../../../common/contract';

/**
 * Body of `GET /health`: overall status and one `ok`/`down` per checked dependency (no versions or error texts).
 *
 * Why: the console's `Health` type: status plus ok/down per check, nothing internal.
 */
export const HealthBody = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  checks: z.record(z.string(), z.enum(['ok', 'down'])).optional(),
});

/**
 * Contract of `GET /health`.
 *
 * Why: the console reads `{status, checks}` and treats any non-2xx as "API unreachable" (B11), so it always
 * answers 200; `?strict=1` answers 503 with the same body for load balancers (decision 015).
 *
 * @route GET /health
 */
export const healthContract = defineRoute({
  key: 'GET /health',
  summary: 'Service health check',
  description:
    'Checks Postgres (critical), the two Redis roles and object storage. Always answers 200 with `{ status, checks }`; with `?strict=1` it answers 503 and the same body when the status is `down` (a critical dependency failed), for load balancers and readiness probes. Contains no versions, hostnames or error texts.',
  tags: ['system'],
  surface: 'system',
  access: 'public',
  query: z.object({
    strict: z.stringbool().optional().describe('Answer 503 when the status is not ok (`1` or `true`).'),
  }),
  success: { status: 200, schema: HealthBody, alsoStatuses: [503] },
  errors: ['VALIDATION_FAILED'],
  examples: { response: { status: 'degraded', checks: { postgres: 'ok', redis: 'down' } } },
});

/**
 * Contract of `GET /metrics`.
 *
 * Why: Prometheus scrapes it; the System health pages read the history from Prometheus (decision 015). Reachable from
 * the internal network, or with `Authorization: Bearer <METRICS_TOKEN>` when that is set.
 *
 * @route GET /metrics
 */
export const metricsContract = defineRoute({
  key: 'GET /metrics',
  summary: 'Prometheus metrics',
  description:
    'Prometheus text exposition: default process metrics, `http_request_duration_seconds` and `api_errors_total`. Allowed from loopback and private networks, or with `Authorization: Bearer <METRICS_TOKEN>` when a token is configured (then the token is required from everyone).',
  tags: ['system'],
  surface: 'system',
  access: 'internal-or-token',
  success: { status: 200, contentType: 'text/plain' },
  errors: ['FORBIDDEN'],
});
