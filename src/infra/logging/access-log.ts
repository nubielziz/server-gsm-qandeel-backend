// Access log (decision 012): one line per finished request with the request id, route template, status and duration.
// Logs the route template, never the raw path, so capability tokens in URLs (tracking, checkout) never reach the logs.
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'nestjs-pino';
import { recalledProblemCode } from '../../common/errors/problem';

/** Health probes and metric scrapes are frequent and uninteresting: logged at debug. */
const QUIET_ROUTES = new Set(['/health', '/metrics']);

/**
 * Registers the Fastify onResponse hook that writes the access log.
 *
 * Why: operations need status, duration and error code per request; 5xx logs at error, 4xx at warn, the rest at info.
 * Not a request/response body log: bodies are never logged (decision 012).
 *
 * @param fastify the underlying Fastify instance
 * @param logger the application logger (nestjs-pino)
 */
export function registerAccessLog(fastify: FastifyInstance, logger: Logger): void {
  fastify.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions?.url ?? 'unmatched';
    const status = reply.statusCode;
    const code = recalledProblemCode(request.raw);
    // A planned maintenance 503 is an expected answer, not a server fault: it logs like a refusal (warn).
    const fault = status >= 500 && code !== 'MAINTENANCE';
    const level = QUIET_ROUTES.has(route) ? 'debug' : fault ? 'error' : status >= 400 ? 'warn' : 'log';
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
