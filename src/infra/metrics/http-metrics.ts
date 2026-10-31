// Fastify onResponse hook that records http_request_duration_seconds (decision 015) for every request,
// including unknown routes (labelled `unmatched`) and errors.
import type { FastifyInstance } from 'fastify';
import type { MetricsService } from './metrics.service';

/**
 * Registers the request-duration hook on a Fastify instance.
 *
 * Why: the System health traffic page (p50/p95/p99, 4xx/5xx rates) is computed from this histogram.
 *
 * @param fastify the underlying Fastify instance
 * @param metrics the process metrics service
 * @returns nothing; the hook runs after each response is sent
 */
export function registerHttpMetrics(fastify: FastifyInstance, metrics: MetricsService): void {
  fastify.addHook('onResponse', (request, reply, done) => {
    metrics.observeHttpRequest(
      { method: request.method, route: request.routeOptions?.url ?? 'unmatched', status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
    done();
  });
}
