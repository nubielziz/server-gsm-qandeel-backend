// OutboundHttp: httpRequest plus what every outbound call needs in production (decision 023): the https-only rule from the
// config, the request id header, a duration metric and a redacted log line.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Histogram } from 'prom-client';
import { getRequestId } from '../../common/request-id';
import { APP_CONFIG, type AppConfig } from '../../config';
import { MetricsService } from '../metrics';
import { type HttpRequestOptions, type HttpResult, HttpRequestError, httpRequest } from './http-request';

/**
 * Options of {@link OutboundHttp.request}: those of `httpRequest` (`httpsOnly` defaults to the production rule) plus the
 * labels that describe the call.
 */
export interface OutboundRequestOptions extends HttpRequestOptions {
  /**
   * Who is called: `supplier`, `gateway`, `merchant_webhook`, `fx_provider`, `telegram`... A metric label, so keep the
   * set small and fixed (never a host name or an id).
   */
  readonly target: string;
  /** What for, for the log only: `dhru.accountinfo`, `webhook.delivery`. No URLs, no ids. */
  readonly operation?: string;
}

/** Outcome label of the duration metric. */
function outcomeOf(result: HttpResult | undefined, error: unknown): string {
  if (result) return `${Math.floor(result.status / 100)}xx`;
  return error instanceof HttpRequestError ? error.kind : 'network';
}

/**
 * Makes outbound HTTP calls with the production defaults.
 *
 * Why: decision 023: suppliers, payment gateways, merchant webhooks and the FX provider are all called through
 * `httpRequest`; this service adds `https` only in production (unless the call opts out or is a private-network call), forwards the request id (so one id joins API, worker and
 * supplier logs, decision 012), records `outbound_http_request_duration_seconds{target,method,outcome}` and logs one
 * line per call with the host only (never the path, query, headers or body, which may hold secrets).
 *
 * Side effects: the HTTP call; a metric sample; a log line (debug for 2xx/3xx, warning for 4xx, 5xx and failures).
 *
 * @see docs/decisions/023-outbound-http.md
 */
@Injectable()
export class OutboundHttp {
  private readonly logger = new Logger(OutboundHttp.name);
  private readonly duration: Histogram<'target' | 'method' | 'outcome'>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    metrics: MetricsService,
  ) {
    this.duration = new Histogram({
      name: 'outbound_http_request_duration_seconds',
      help: 'Outbound HTTP call duration in seconds, by target, method and outcome (2xx, 4xx, timeout, network, ...).',
      labelNames: ['target', 'method', 'outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
      registers: [metrics.registry],
    });
  }

  /**
   * Makes a call.
   *
   * Why: see the class comment.
   *
   * @param options URL, method, headers, body, the required `timeoutMs`, and the `target` label
   * @returns the answer, whatever its status (4xx and 5xx are results, not errors)
   * @throws {HttpRequestError} `blocked`, `timeout`, `network`, `too_large` or `aborted`
   * @throws {RangeError} when `timeoutMs` is missing or out of range
   */
  async request(options: OutboundRequestOptions): Promise<HttpResult> {
    const requestId = getRequestId();
    // Header names are case-insensitive: a caller's own X-Request-Id wins over the current request's id.
    const headers = new Headers(options.headers);
    if (requestId && !headers.has('x-request-id')) headers.set('x-request-id', requestId);
    const method = options.method ?? 'GET';
    const started = performance.now();
    let result: HttpResult | undefined;
    let failure: unknown;
    try {
      result = await httpRequest({
        ...options,
        headers: Object.fromEntries(headers),
        // https only in production by default (merchant webhooks must be https, decision 023); an internal call
        // (allowPrivateNetwork, e.g. Prometheus) or a caller with an explicit setting decides for itself.
        httpsOnly: options.httpsOnly ?? (this.config.isProduction && !options.allowPrivateNetwork),
      });
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const seconds = (performance.now() - started) / 1000;
      const outcome = outcomeOf(result, failure);
      this.duration.observe({ target: options.target, method, outcome }, seconds);
      this.log(options, method, outcome, seconds, result, failure);
    }
  }

  private log(
    options: OutboundRequestOptions,
    method: string,
    outcome: string,
    seconds: number,
    result: HttpResult | undefined,
    failure: unknown,
  ): void {
    let host = 'invalid';
    try {
      host = new URL(options.url).host;
    } catch {
      // the call failed as `blocked`; the line says so
    }
    const line = {
      msg: 'Outbound HTTP',
      target: options.target,
      operation: options.operation,
      method,
      host,
      status: result?.status,
      outcome,
      durationMs: Math.round(seconds * 1000),
      requestId: getRequestId(),
      error: failure instanceof Error ? failure.message : undefined,
    };
    if (result && result.status < 400) this.logger.debug(line);
    else this.logger.warn(line);
  }
}
