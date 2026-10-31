// Prometheus registry of one process (decision 015): default process metrics, HTTP latency and API error counters.
// The API serves it at GET /metrics, the worker on WORKER_METRICS_PORT; the System health pages query Prometheus.
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Labels of `http_request_duration_seconds`.
 *
 * Why: the System health pages chart latency per surface and route (decision 015); labels stay low-cardinality (route
 * templates, not URLs).
 */
export interface HttpMetricLabels {
  readonly method: string;
  /** The route template (`/admin/staff/:id`) or `unmatched`; never the raw path, so cardinality stays small. */
  readonly route: string;
  readonly status: string;
}

/**
 * Labels of `api_errors_total`.
 *
 * Why: the System health errors page counts failures per surface, route, status and code (decision 015).
 */
export interface ApiErrorLabels {
  readonly surface: string;
  readonly method: string;
  readonly route: string;
  readonly status: string;
  readonly code: string;
}

/**
 * Owns the process's single prom-client registry and its HTTP/error metrics.
 *
 * Why: decision 015 wants one registry per process, default metrics, request latency by route template and a counter
 * of every problem+json answer by surface, route, status and code for the System health errors page.
 * Each instance has its own registry (not prom-client's global one), so tests can build many apps in one process.
 */
@Injectable()
export class MetricsService implements OnApplicationShutdown {
  /** The registry served by `/metrics`. */
  readonly registry = new Registry();
  private readonly httpDuration: Histogram<keyof HttpMetricLabels>;
  private readonly apiErrors: Counter<keyof ApiErrorLabels>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds, by method, route template and status.',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.apiErrors = new Counter({
      name: 'api_errors_total',
      help: 'Problem+json answers, by surface, method, route template, status and error code.',
      labelNames: ['surface', 'method', 'route', 'status', 'code'],
      registers: [this.registry],
    });
  }

  /**
   * Records one finished HTTP request.
   *
   * @param labels method, route template and status
   * @param seconds time from first byte received to response finished
   */
  observeHttpRequest(labels: HttpMetricLabels, seconds: number): void {
    this.httpDuration.observe({ ...labels }, seconds);
  }

  /**
   * Counts one problem+json answer.
   *
   * @param labels surface, method, route template, status and code
   */
  recordApiError(labels: ApiErrorLabels): void {
    this.apiErrors.inc({ ...labels });
  }

  /** @returns the `Content-Type` of the exposition text (`text/plain; version=0.0.4; charset=utf-8`) */
  get contentType(): string {
    return this.registry.contentType;
  }

  /**
   * Renders the registry in the Prometheus text format.
   *
   * @returns the exposition text
   */
  render(): Promise<string> {
    return this.registry.metrics();
  }

  /** Drops the collectors so a closed app leaves nothing behind. */
  onApplicationShutdown(): void {
    this.registry.clear();
  }
}
