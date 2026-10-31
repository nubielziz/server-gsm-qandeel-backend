// The one way the backend makes outbound HTTP calls (decision 023): native fetch with a required timeout, no retries, no
// redirects, a bounded response, and by default only to public hosts. Pure function; OutboundHttp adds metrics and logs.
import { TimeoutError } from '../../common/timeout';
import { type HostLookup, UnsafeUrlError, assertPublicHttpUrl } from './public-url';

/** Methods outbound calls use. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

/** The longest `timeoutMs` accepted: two minutes. Longer waits belong in a job with its own schedule. */
export const MAX_TIMEOUT_MS = 120_000;
/** Largest response body read when the caller sets no limit: 5 MiB. */
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DNS_TIMEOUT_MS = 3_000;

/**
 * Options of {@link httpRequest}.
 *
 * Why: decision 023: every outbound call (suppliers, gateways, merchant webhooks) states its timeout, never retries by
 * itself (the caller owns the retry policy) and never follows a redirect.
 */
export interface HttpRequestOptions {
  readonly url: string | URL;
  /** Default `GET`. */
  readonly method?: HttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | URLSearchParams;
  /**
   * Required, no default: the time allowed for the whole exchange (DNS check, connecting, sending, the answer and reading
   * its body), 1 to 120000 ms. A slow supplier must never hold a worker for longer than its caller decided.
   */
  readonly timeoutMs: number;
  /** Stop reading the answer after this many bytes (default 5 MiB). */
  readonly maxResponseBytes?: number;
  /** Lets the caller cancel the call (shutdown). */
  readonly signal?: AbortSignal;
  /**
   * Default `false`: the host must resolve only to public addresses (see {@link assertPublicHttpUrl}). Set `true` for
   * calls to our own infrastructure (Prometheus) and for tests against a local server.
   */
  readonly allowPrivateNetwork?: boolean;
  /** Refuse plain `http:` (true in production). */
  readonly httpsOnly?: boolean;
  /** DNS resolver for the public-address check; tests replace it. */
  readonly lookup?: HostLookup;
}

/** How a call failed. */
export type HttpFailure = 'timeout' | 'network' | 'too_large' | 'blocked' | 'aborted';

/**
 * Raised when no usable answer arrived.
 *
 * Why: callers must tell failures apart: after a `timeout` the request may have reached the server (a supplier dispatch
 * must not be re-sent, decision 025), `blocked` never left the process, `network` is a connection problem. A 4xx or 5xx
 * answer is NOT an error here: it is returned and the caller reads `status`.
 */
export class HttpRequestError extends Error {
  constructor(
    readonly kind: HttpFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpRequestError';
  }
}

/** The answer of a call, with the body already read (at most `maxResponseBytes`). */
export interface HttpResult {
  readonly status: number;
  /** True for 200 to 299. A 3xx is returned as it is: redirects are not followed. */
  readonly ok: boolean;
  readonly headers: Headers;
  readonly body: Uint8Array;
  /** Milliseconds from the start of the call to the end of the body. */
  readonly durationMs: number;
  /** The body as UTF-8 text. */
  text(): string;
  /** The body parsed as JSON; throws `SyntaxError` when it is not JSON. */
  json<T = unknown>(): T;
}

async function readBody(response: Response, method: HttpMethod, maxBytes: number): Promise<Uint8Array> {
  // An answer to HEAD has no body, but its Content-Length describes the body a GET would return.
  if (method === 'HEAD') {
    await response.body?.cancel();
    return new Uint8Array();
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new HttpRequestError('too_large', `The response is larger than ${maxBytes} bytes.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // Bun types the reader's chunks loosely; the body of a fetch Response is a stream of bytes.
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done || value === undefined) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpRequestError('too_large', `The response is larger than ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

/** The parts of a runtime error that are safe to keep: Bun's fetch errors carry the full URL (query included). */
function safeCause(error: unknown): { name?: string; code?: string } {
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  return { name: typeof name === 'string' ? name : undefined, code: typeof code === 'string' ? code : undefined };
}

function classify(error: unknown, caller: AbortSignal | undefined): HttpRequestError {
  if (error instanceof HttpRequestError) return error;
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || error instanceof TimeoutError) {
    return new HttpRequestError('timeout', 'The request timed out.', { cause: safeCause(error) });
  }
  if (caller?.aborted || name === 'AbortError') {
    return new HttpRequestError('aborted', 'The request was cancelled.', { cause: safeCause(error) });
  }
  // The runtime's message ("fetch failed", "Unable to connect") never contains the URL's query or credentials.
  return new HttpRequestError('network', 'The request could not be completed (connection failed).', {
    cause: safeCause(error),
  });
}

/**
 * Makes one HTTP request.
 *
 * Why: decision 023 puts all outbound calls behind one helper so timeouts, redirects and SSRF rules cannot be forgotten
 * at a call site. It never retries (a retry of a supplier dispatch could double-order), never follows redirects (a 3xx
 * is returned, the caller treats it as a failure) and refuses non-public hosts unless the caller opts in.
 *
 * Side effects: one DNS lookup (public check) and one HTTP exchange; nothing is logged or counted here (OutboundHttp does).
 *
 * @param options URL, method, headers, body and the required timeout
 * @returns the status, headers and body of the answer, whatever the status
 * @throws {RangeError} when `timeoutMs` is missing or outside 1 to 120000
 * @throws {HttpRequestError} `blocked` (URL refused by the guard; nothing was sent), `timeout`, `network` (also a host
 *   name that does not resolve), `too_large` or `aborted`
 *
 * @see docs/decisions/023-outbound-http.md
 */
export async function httpRequest(options: HttpRequestOptions): Promise<HttpResult> {
  const { timeoutMs } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `timeoutMs is required and must be an integer from 1 to ${MAX_TIMEOUT_MS}, got ${String(timeoutMs)}`,
    );
  }
  const started = performance.now();
  const httpsOnly = options.httpsOnly ?? false;
  let target: URL;
  try {
    target = new URL(options.url);
  } catch {
    throw new HttpRequestError('blocked', 'The URL is not valid.');
  }
  try {
    let url = target;
    if (options.allowPrivateNetwork) {
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !httpsOnly)) {
        throw new UnsafeUrlError('scheme_not_allowed', url.hostname);
      }
    } else {
      ({ url } = await assertPublicHttpUrl(target, {
        httpsOnly,
        lookup: options.lookup,
        dnsTimeoutMs: Math.min(DNS_TIMEOUT_MS, timeoutMs),
      }));
    }
    // One deadline for everything that follows, the body included.
    const remaining = Math.max(1, timeoutMs - (performance.now() - started));
    const deadline = AbortSignal.timeout(remaining);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const method = options.method ?? 'GET';
    const response = await fetch(url, {
      method,
      headers: options.headers,
      body: options.body,
      redirect: 'manual',
      signal,
    });
    const body = await readBody(response, method, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: response.headers,
      body,
      durationMs: performance.now() - started,
      text: () => new TextDecoder().decode(body),
      json: <T = unknown>() => JSON.parse(new TextDecoder().decode(body)) as T,
    };
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      // A host that does not resolve is a network problem, not an attempt to reach a forbidden address: keep `blocked`
      // (and its metric) for the guard's real refusals.
      throw new HttpRequestError(error.reason === 'dns_failure' ? 'network' : 'blocked', error.message, {
        cause: error,
      });
    }
    throw classify(error, options.signal);
  }
}
