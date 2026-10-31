// The problem+json document (decision 028, RFC 9457 style) and the helper that stashes the code of a failed request.
// Every error on the admin, client, v1, store, hooks and system surfaces is sent in this shape.
import { AppError, type FieldError } from './app-error';
import { problemSlug } from './catalog';

/**
 * Media type of an error body.
 *
 * Why: decision 028: every error body is application/problem+json.
 */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/**
 * The error body sent to clients; `errors` is present only when there are field problems.
 *
 * Why: the console reads `code`, `title`, `detail`, `errors` and `requestId` from every failed answer (ALIGNMENT § 5).
 */
export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly errors?: readonly FieldError[];
  readonly requestId: string;
}

/**
 * Builds the problem+json document of an error.
 *
 * Why: one builder keeps the HTTP filter and the worker's metrics listener answering identical bodies.
 *
 * @param error the application error
 * @param context the request id and the base of the `type` URI (`ERRORS_BASE_URL`, no trailing slash)
 * @returns the document, with `detail` defaulting to the title
 */
export function buildProblem(error: AppError, context: { requestId: string; errorsBaseUrl: string }): ProblemDocument {
  return {
    type: `${context.errorsBaseUrl}/${problemSlug(error.code)}`,
    title: error.title,
    status: error.status,
    code: error.code,
    detail: error.detail ?? error.title,
    ...(error.errors.length > 0 ? { errors: error.errors } : {}),
    requestId: context.requestId,
  };
}

const answeredCodes = new WeakMap<object, string>();

/**
 * Remembers which error code answered a request, so the access log can print it.
 *
 * Why: the access log can print the code of a failed request without the filter knowing about logging.
 *
 * @param request the raw request object (`request.raw`)
 * @param code the catalog code that was sent
 */
export function rememberProblemCode(request: object, code: string): void {
  answeredCodes.set(request, code);
}

/**
 * Reads the error code remembered for a request.
 *
 * Why: see {@link rememberProblemCode}.
 *
 * @param request the raw request object (`request.raw`)
 * @returns the code, or `undefined` when the request did not fail with a problem
 */
export function recalledProblemCode(request: object): string | undefined {
  return answeredCodes.get(request);
}
