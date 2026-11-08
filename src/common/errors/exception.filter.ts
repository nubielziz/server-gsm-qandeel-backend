// Global exception filter (decision 028): every failure becomes problem+json (or a surface's own envelope),
// is counted in api_errors_total, and server faults are logged with the request id.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../config';
import { MetricsService } from '../../infra/metrics/metrics.service';
import { resolveRequestId } from '../request-id';
import { surfaceOfPath } from '../surface';
import { AlternateResponse } from './alternate-response';
import type { AppError } from './app-error';
import { type ErrorResponse, ErrorFormatterRegistry } from './formatter-registry';
import { normalizeException } from './normalize-exception';
import { PROBLEM_CONTENT_TYPE, buildProblem, rememberProblemCode } from './problem';

/** Minimal view of a reply: a Fastify reply, or a raw Node response when a middleware failed. */
type Reply = FastifyReply | ServerResponse;

function isFastifyReply(reply: Reply): reply is FastifyReply {
  return typeof (reply as FastifyReply).code === 'function';
}

/** The route template of a request (`/admin/staff/:id`), or `undefined` when no route matched or none is known yet. */
function routeTemplateOf(request: FastifyRequest | IncomingMessage): string | undefined {
  try {
    return (request as FastifyRequest).routeOptions?.url;
  } catch {
    // Router-level failures (a malformed URL) happen before a route context exists.
    return undefined;
  }
}

/**
 * Catches everything thrown while a request is handled and answers with the catalog's problem+json.
 *
 * Why: the console reacts to `code`, shows `title`/`detail` and maps `errors[]` onto form fields, so every failure on
 * every route must have the same shape (decision 028, ALIGNMENT § 5). The filter also feeds the System health errors
 * page (`api_errors_total`, decision 015) and logs server faults with the request id so support can find them.
 *
 * Side effects: increments `api_errors_total{surface,method,route,status,code}`; logs 5xx at error level and a Postgres deadlock or serialization failure (answered 409) at warn level; sets
 * `Retry-After` on 429 (default 1 s), `Cache-Control: no-store` and `X-Request-Id` (also added by the onSend hook).
 */
@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly formatters: ErrorFormatterRegistry,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProblemExceptionFilter.name);
  }

  /**
   * Nest's exception-filter hook: answers whatever was thrown while handling a request.
   *
   * @param exception whatever was thrown
   * @param host the request being handled
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    this.handle(exception, http.getRequest<FastifyRequest>(), http.getResponse<Reply>());
  }

  /**
   * Answers a failed request. `catch` calls it for everything thrown inside Nest; the Fastify adapter's
   * `frameworkErrors` hook calls it for router-level failures (a malformed URL) that never reach Nest.
   *
   * @param exception whatever was thrown
   * @param request the Fastify request (or the raw Node request when a middleware failed)
   * @param reply the Fastify reply (or the raw Node response)
   */
  handle(exception: unknown, request: FastifyRequest | IncomingMessage, reply: Reply): void {
    // A middleware failure hands over the raw Node request/response instead of Fastify's wrappers.
    const raw: IncomingMessage = (request as { raw?: IncomingMessage }).raw ?? (request as IncomingMessage);
    const requestId = (request as { id?: string }).id ?? resolveRequestId(raw);

    if (exception instanceof AlternateResponse) {
      this.send(reply, {
        status: exception.status,
        contentType: 'application/json; charset=utf-8',
        headers: { 'x-request-id': requestId },
        body: exception.body,
      });
      return;
    }

    const { error, logAsError, logAsWarning } = normalizeException(exception, {
      exposeInternals: !this.config.isProduction,
    });
    const method = String(raw.method ?? 'GET');
    const template = routeTemplateOf(request);
    const path = raw.url ?? '/';
    const surface = surfaceOfPath(template ?? path);

    rememberProblemCode(raw, error.code);
    this.metrics.recordApiError({
      surface,
      method,
      route: template ?? 'unmatched',
      status: String(error.status),
      code: error.code,
    });
    if (logAsError) {
      // Full error (with cause chain and stack) goes to the log only; the client gets the generic detail.
      this.logger.error(
        { err: exception, requestId, code: error.code, status: error.status, method, route: template ?? 'unmatched' },
        'Request failed with a server error',
      );
    } else if (logAsWarning) {
      // A retryable clash (Postgres rolled the transaction back): a warning with the request id and the error.
      this.logger.warn(
        { err: exception, requestId, code: error.code, status: error.status, method, route: template ?? 'unmatched' },
        'Request lost a database race and was answered with a retryable conflict',
      );
    }

    this.send(reply, this.respond(error, { requestId, path, surface }));
  }

  private respond(
    error: AppError,
    request: { requestId: string; path: string; surface: ReturnType<typeof surfaceOfPath> },
  ): ErrorResponse {
    const problem = buildProblem(error, {
      requestId: request.requestId,
      errorsBaseUrl: this.config.http.errorsBaseUrl,
    });
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-request-id': request.requestId };
    if (error.status === 429) headers['retry-after'] = String(error.retryAfterSeconds ?? 1);
    else if (error.retryAfterSeconds !== undefined) headers['retry-after'] = String(error.retryAfterSeconds);

    const formatter = this.formatters.resolve({ path: request.path, surface: request.surface });
    if (formatter) {
      const custom = formatter.format({
        error,
        problem,
        requestId: request.requestId,
        path: request.path,
        surface: request.surface,
      });
      return { ...custom, headers: { ...headers, ...custom.headers } };
    }
    return { status: error.status, contentType: PROBLEM_CONTENT_TYPE, headers, body: problem };
  }

  private send(reply: Reply, response: ErrorResponse): void {
    if (isFastifyReply(reply)) {
      if (reply.sent) return;
      void reply
        .status(response.status)
        .headers({ ...response.headers })
        .type(response.contentType)
        .send(response.body);
      return;
    }
    if (reply.headersSent) return;
    reply.statusCode = response.status;
    for (const [name, value] of Object.entries({ ...response.headers, 'content-type': response.contentType })) {
      reply.setHeader(name, value);
    }
    reply.end(JSON.stringify(response.body));
  }
}
