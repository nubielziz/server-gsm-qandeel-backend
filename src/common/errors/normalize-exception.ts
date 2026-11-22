// Turns anything a handler, guard, pipe or Fastify can throw into an AppError (decision 028).
// Pure and unit-tested; the exception filter only adds logging, metrics and the HTTP reply.
import { HttpException } from '@nestjs/common';
import { pgErrorInfo } from '../../infra/db/pg-errors';
import { AppError } from './app-error';
import type { ErrorCode } from './catalog';
import { errorTypeOf, safeErrorText, withoutStatementText } from './safe-error';

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
  /** True for a retryable clash that is not a fault (a Postgres deadlock): logged at warn level with the request id. */
  readonly logAsWarning: boolean;
}

const INTERNAL_DETAIL =
  'Something went wrong on our side. If it keeps happening, quote the request id when you report it.';

/** Shown for a deadlock or serialization failure: Postgres rolled the transaction back, so nothing was written. */
const RETRYABLE_CONFLICT_DETAIL = 'This was changed by another request at the same moment. Try again.';

/** SQLSTATE `40P01` (deadlock detected) and `40001` (serialization failure): Postgres asks the caller to retry. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40P01', '40001']);

/** Shown when Postgres stopped a statement or ended the session (decision 055): nothing of the transaction was written. */
const DATABASE_TIMEOUT_DETAIL = 'The database took too long to answer. Try again in a moment.';

/**
 * Decision 055: a statement cancelled by `statement_timeout` (`57014`), a lock not granted within `lock_timeout` (`55P03`), a session
 * ended by `idle_in_transaction_session_timeout` (`25P03`), by an administrator or a restart (`57P01`) or by `idle_session_timeout`
 * (`57P05`): the transaction was rolled back and the client can repeat the request.
 */
const TIMEOUT_SQLSTATES: ReadonlySet<string> = new Set(['57014', '55P03', '25P03', '57P01', '57P05']);

const MAX_CAUSE_DEPTH = 4;

/**
 * True for the error pg gives a statement sent on a client whose session Postgres already ended (it has no SQLSTATE), also as the
 * `cause` of another error.
 */
function isEndedSessionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (current.message.includes('has encountered a connection error and is not queryable')) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

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
      ? withoutStatementText(message).slice(0, 500)
      : INTERNAL_DETAIL
    : (FRAMEWORK_DETAIL[status] ?? message);
  return {
    error: new AppError(code, { ...(detail ? { detail } : {}), cause }),
    logAsError: server,
    logAsWarning: false,
  };
}

/**
 * Converts any thrown value into the AppError to answer with.
 *
 * Why: decision 028 maps `AppError`, Nest `HttpException` and Fastify errors (400 malformed JSON, 404 unknown route,
 * 413 body too large, 415 media type) to catalog codes and everything else to `500 INTERNAL_ERROR` with a generic
 * detail; the full error is logged by the filter. A raw ZodError is a bug (contract validation throws AppError
 * itself), so it is a 500 too. A Postgres deadlock (`40P01`) or serialization failure (`40001`), also when it is the
 * `cause` of another error, is not a fault: Postgres rolled the transaction back, so the answer is a retryable
 * `409 CONFLICT`, logged at warn level (a rare lock-order clash between two money paths cannot be removed by ordering alone). A
 * database time limit (a statement or lock limit, an idle transaction ended) or a session Postgres ended answers a retryable
 * `503 UNAVAILABLE`, logged at warn level (decision 055).
 * Outside production the 500 detail shows the error's type and its safe text: never a database statement or its values (decision 054).
 *
 * @param exception whatever was thrown
 * @param options `exposeInternals`: outside production the 500 detail may show the error message (never the stack)
 * @returns the error to send and whether it is a server fault
 */
export function normalizeException(exception: unknown, options: { exposeInternals: boolean }): NormalizedException {
  // MAINTENANCE is a planned 503, not a fault: no error line with a stack for every refused request.
  if (exception instanceof AppError) {
    return {
      error: exception,
      logAsError: exception.status >= 500 && exception.code !== 'MAINTENANCE',
      logAsWarning: false,
    };
  }
  if (exception instanceof HttpException) {
    return fromStatus(exception.getStatus(), httpMessage(exception), exception, options.exposeInternals);
  }
  if (isFastifyError(exception)) {
    return fromStatus(exception.statusCode, exception.message, exception, options.exposeInternals);
  }
  const pg = pgErrorInfo(exception);
  if (pg && RETRYABLE_SQLSTATES.has(pg.code)) {
    return {
      error: new AppError('CONFLICT', { detail: RETRYABLE_CONFLICT_DETAIL, cause: exception }),
      logAsError: false,
      logAsWarning: true,
    };
  }
  if ((pg && TIMEOUT_SQLSTATES.has(pg.code)) || (!pg && isEndedSessionError(exception))) {
    return {
      error: new AppError('UNAVAILABLE', { detail: DATABASE_TIMEOUT_DETAIL, cause: exception }),
      logAsError: false,
      logAsWarning: true,
    };
  }
  const message =
    exception instanceof Error
      ? `${errorTypeOf(exception)}: ${safeErrorText(exception, 500)}`
      : safeErrorText(exception, 500);
  return {
    error: new AppError('INTERNAL_ERROR', {
      detail: options.exposeInternals ? message.slice(0, 500) : INTERNAL_DETAIL,
      cause: exception,
    }),
    logAsError: true,
    logAsWarning: false,
  };
}
