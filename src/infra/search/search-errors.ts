// The typed failures of the Typesense client (feature 29, decision 038): the engine is unavailable, not ready, or refused a request.
// Messages carry the operation and the status, never a key or a query body.
import { HttpRequestError } from '../http';

/**
 * Why the engine could not answer.
 *
 * Why: plan section 3.4: the worker retries all of them and the API falls back; the circuit opens at once on `server`, `auth` and
 * `resources` (step 0: a write refused for disk answers 422 `Rejecting write: running out of resource type: OUT_OF_DISK`).
 */
export type SearchUnavailableKind = 'network' | 'timeout' | 'server' | 'auth' | 'resources';

/**
 * The engine is down, slow, refuses our key, or refuses writes for lack of resources.
 *
 * Why: these failures are about the engine, not about the request: a job retries them and a search falls back.
 */
export class SearchUnavailable extends Error {
  constructor(
    readonly kind: SearchUnavailableKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SearchUnavailable';
  }
}

/**
 * The alias or collection does not exist (404).
 *
 * Why: a missing alias of the running schema version means "not ready": the API falls back (`not_ready`), the sync records it and
 * completes, and the reconcile starts a rebuild (plan section 3.3).
 */
export class SearchNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchNotReady';
  }
}

/**
 * The engine refused the request itself (any other 4xx): a programming error, never retried.
 *
 * Why: plan section 3.4: a whole-request refusal of the sync is an `UnrecoverableError` with `last_error`.
 */
export class SearchRejected extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SearchRejected';
  }
}

/** Any of the three failures. */
export type SearchFailure = SearchUnavailable | SearchNotReady | SearchRejected;

/**
 * Tells whether an error is one of the client's typed failures.
 *
 * @param error anything thrown
 * @returns true for {@link SearchUnavailable}, {@link SearchNotReady} and {@link SearchRejected}
 */
export function isSearchFailure(error: unknown): error is SearchFailure {
  return error instanceof SearchUnavailable || error instanceof SearchNotReady || error instanceof SearchRejected;
}

const RESOURCE_REFUSAL = /^Rejecting write: running out of resource/;

/**
 * The text of a Typesense error body.
 *
 * Why: plain requests answer `{ message }`, multi-search entries and import lines `{ error }`; the text decides the resource refusal.
 *
 * @param body the parsed body
 * @returns its `message` or `error`, cut to 200 characters; `''` when there is none
 */
export function engineMessageOf(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const { message, error } = body as { message?: unknown; error?: unknown };
  const text = typeof message === 'string' ? message : typeof error === 'string' ? error : '';
  return text.slice(0, 200);
}

/**
 * Turns a non-2xx answer into its typed failure.
 *
 * Why: plan section 3.4 and step 0: 401/403 is `auth`; a 422 whose message starts with `Rejecting write: running out of resource` is
 * `resources`; 5xx is `server`; 404 is {@link SearchNotReady}; any other 4xx is {@link SearchRejected}.
 *
 * @param operation what was asked (`search`, `import`, ...), for the message
 * @param status the HTTP status
 * @param body the parsed body, if it was JSON
 * @returns the error to throw
 */
export function failureOf(operation: string, status: number, body: unknown): SearchFailure {
  const message = engineMessageOf(body);
  const text = `Typesense ${operation} answered ${status}${message === '' ? '' : `: ${message}`}`;
  if (status === 401 || status === 403)
    return new SearchUnavailable('auth', `Typesense ${operation} answered ${status}.`);
  if (RESOURCE_REFUSAL.test(message)) return new SearchUnavailable('resources', text);
  if (status >= 500) return new SearchUnavailable('server', text);
  // A sub-search that names a field the schema lacks also answers 404 (step 0): that is our mistake, not a missing index.
  if (status === 404 && /could not find a field/i.test(message)) return new SearchRejected(status, text);
  if (status === 404) return new SearchNotReady(text);
  return new SearchRejected(status, text);
}

/**
 * Turns a failure of the HTTP call itself into its typed failure.
 *
 * @param operation what was asked, for the message
 * @param error what `OutboundHttp.request` threw
 * @returns a `SearchUnavailable` of kind `timeout` or `network` (`server` for an answer over the size limit)
 */
export function transportFailureOf(operation: string, error: unknown): SearchUnavailable {
  if (error instanceof HttpRequestError) {
    if (error.kind === 'timeout') return new SearchUnavailable('timeout', `Typesense ${operation} timed out.`);
    if (error.kind === 'too_large') {
      return new SearchUnavailable('server', `Typesense ${operation} answered more than the size limit.`);
    }
  }
  return new SearchUnavailable('network', `Typesense ${operation} could not be reached.`, { cause: error });
}
