// Turns anything a handler, guard, pipe or Fastify can throw into an AppError (decision 028).
// Pure and unit-tested; the exception filter only adds logging, metrics and the HTTP reply.
import { HttpException } from '@nestjs/common';
import { AppError } from './app-error';
import type { ErrorCode } from './catalog';

/**
 * Result of {@link normalizeException}.
 *
 * Why: the exception filter needs both the error to send and whether it is a server fault to log (decision 028).
 */
export interface NormalizedException {
  /** What to send to the client. */
  readonly error: AppError;
  /** True for server faults: the original error is logged at error level with the request id. */
  readonly logAsError: boolean;
}

const INTERNAL_DETAIL =
  'Something went wrong on our side. If it keeps happening, quote the request id when you report it.';

/** Curated sentences for the framework-level 4xx answers (their raw messages are technical). */
const FRAMEWORK_DETAIL: Readonly<Record<number, string>> = {
  400: 'The request could not be read. Check that the URL and the JSON body are valid.',
  404: 'No endpoint matches this request.',
  413: 'The request body is larger than this endpoint accepts.',
  415: 'This endpoint does not accept that content type. Send application/json.',
};

/**
 * Maps an HTTP status to the closest catalog code.
 *
 * Why: framework errors carry only a status, while the console reacts to codes.
 *
 * @param status a 4xx or 5xx status
 * @returns the catalog code (unknown 4xx become `BAD_REQUEST`, unknown 5xx `INTERNAL_ERROR`)
 */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  }
}

/** A Fastify error: carries an HTTP status and a code such as `FST_ERR_CTP_BODY_TOO_LARGE`. */
function isFastifyError(value: unknown): value is { statusCode: number; code: string; message: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { statusCode?: unknown; code?: unknown };
  return (
    typeof candidate.statusCode === 'number' &&
    candidate.statusCode >= 400 &&
    candidate.statusCode <= 599 &&
    typeof candidate.code === 'string' &&
    candidate.code.startsWith('FST_ERR')
  );
}

function httpMessage(exception: HttpException): string | undefined {
  const response = exception.getResponse();
  if (typeof response === 'string' && response !== '') return response;
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const message = response.message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return undefined;
}

function fromStatus(
  status: number,
  message: string | undefined,
  cause: unknown,
  exposeInternals: boolean,
): NormalizedException {
  const code = codeForStatus(status);
  const server = status >= 500;
  const detail = server
    ? exposeInternals && message
      ? message.slice(0, 500)
      : INTERNAL_DETAIL
    : (FRAMEWORK_DETAIL[status] ?? message);
  return { error: new AppError(code, { ...(detail ? { detail } : {}), cause }), logAsError: server };
}

/**
 * Converts any thrown value into the AppError to answer with.
 *
 * Why: decision 028 maps `AppError`, Nest `HttpException` and Fastify errors (400 malformed JSON, 404 unknown route,
 * 413 body too large, 415 media type) to catalog codes and everything else to `500 INTERNAL_ERROR` with a generic
 * detail; the full error is logged by the filter. A raw ZodError is a bug (contract validation throws AppError
 * itself), so it is a 500 too.
 *
 * @param exception whatever was thrown
 * @param options `exposeInternals`: outside production the 500 detail may show the error message (never the stack)
 * @returns the error to send and whether it is a server fault
 */
export function normalizeException(exception: unknown, options: { exposeInternals: boolean }): NormalizedException {
  // MAINTENANCE is a planned 503, not a fault: no error line with a stack for every refused request.
  if (exception instanceof AppError) {
    return { error: exception, logAsError: exception.status >= 500 && exception.code !== 'MAINTENANCE' };
  }
  if (exception instanceof HttpException) {
    return fromStatus(exception.getStatus(), httpMessage(exception), exception, options.exposeInternals);
  }
  if (isFastifyError(exception)) {
    return fromStatus(exception.statusCode, exception.message, exception, options.exposeInternals);
  }
  const message = exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception);
  return {
    error: new AppError('INTERNAL_ERROR', {
      detail: options.exposeInternals ? message.slice(0, 500) : INTERNAL_DETAIL,
      cause: exception,
    }),
    logAsError: true,
  };
}
