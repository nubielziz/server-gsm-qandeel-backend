// Access log (decision 012): one line per finished request with the request id, route template, status and duration.
// Logs the route template, never the raw path, so capability tokens in URLs (tracking, checkout) never reach the logs.
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'nestjs-pino';
import { recalledProblemCode } from '../../common/errors/problem';
import { isEventStream } from '../metrics/http-metrics';

/** Health probes and metric scrapes are frequent and uninteresting: logged at debug. */
const QUIET_ROUTES = new Set(['/health', '/metrics']);

/** What the level of an access log line depends on. */
export interface AccessLogFacts {
  /** The route template, or `unmatched`. */
  readonly route: string;
  readonly status: number;
  /** The problem+json code of an error answer, if any. */
  readonly code: string | undefined;
  /** The `Content-Type` of the reply. */
  readonly contentType: unknown;
}

/**
 * The level of the access log line of one request.
 *
 * Why: operations need 5xx at error and 4xx at warn; health probes, metric scrapes and live event streams (decision 037: one
 * "request" that lasted up to 15 minutes, logged by the hub as `stream closed`) are noise at info, so they log at debug.
 *
 * @param facts route template, status, problem code and content type
 * @returns the nestjs-pino method to call
 */
export function accessLogLevel(facts: AccessLogFacts): 'debug' | 'error' | 'warn' | 'log' {
  if (QUIET_ROUTES.has(facts.route) || isEventStream(facts.contentType)) return 'debug';
  // A planned maintenance 503 is an expected answer, not a server fault: it logs like a refusal (warn).
  if (facts.status >= 500 && facts.code !== 'MAINTENANCE') return 'error';
  return facts.status >= 400 ? 'warn' : 'log';
}

/**
 * Registers the Fastify onResponse hook that writes the access log.
 *
 * Why: operations need status, duration and error code per request; 5xx logs at error, 4xx at warn, the rest at info
 * ({@link accessLogLevel}). Not a request/response body log: bodies are never logged (decision 012).
 *
 * @param fastify the underlying Fastify instance
 * @param logger the application logger (nestjs-pino)
 */
export function registerAccessLog(fastify: FastifyInstance, logger: Logger): void {
  fastify.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions?.url ?? 'unmatched';
    const status = reply.statusCode;
    const code = recalledProblemCode(request.raw);
    const level = accessLogLevel({ route, status, code, contentType: reply.getHeader('content-type') });
    logger[level](
      {
        msg: 'request completed',
        requestId: request.id,
        method: request.method,
        route,
        status,
        durationMs: Math.round(reply.elapsedTime * 100) / 100,
        ...(code ? { code } : {}),
      },
      'http',
    );
    done();
  });
}
