// A small client of the Prometheus HTTP API (decision 015, MISMATCHES B90): instant and range queries with a short deadline.
// Prometheus is optional: without `PROMETHEUS_URL`, or when it does not answer, every read throws `MONITORING_UNAVAILABLE`.
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../../config';

/** The longest a Prometheus call may take: the console polls these routes, so a slow Prometheus must not hang a page. */
export const PROMETHEUS_TIMEOUT_MS = 2_000;

/** One series of an instant query. */
export interface PromVector {
  readonly metric: Readonly<Record<string, string>>;
  /** The sample, `NaN` when Prometheus answered `NaN` (a quantile without data). */
  readonly value: number;
}

/** One series of a range query: samples as seconds since the epoch and a value. */
export interface PromMatrix {
  readonly metric: Readonly<Record<string, string>>;
  readonly values: ReadonlyArray<readonly [number, number]>;
}

interface PromResponse {
  readonly status?: string;
  readonly data?: { readonly resultType?: string; readonly result?: unknown };
}

/**
 * Queries Prometheus.
 *
 * Why: the traffic and error history cannot come from the process registries (decision 015): a Prometheus server scrapes the API
 * and the worker and keeps the history; the System health routes read it with PromQL. The URL may carry basic-auth credentials
 * (`http://user:pass@host:9090`): they are sent as an `Authorization` header, because `fetch` refuses credentials in a URL.
 *
 * Side effects: outbound HTTP to the configured Prometheus only (an internal address from configuration, never user input).
 */
@Injectable()
export class PrometheusClient {
  private readonly base: URL | undefined;
  private readonly authorization: string | undefined;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const raw = config.observability.prometheusUrl;
    if (raw === undefined) return;
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '') {
      this.authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`;
      url.username = '';
      url.password = '';
    }
    this.base = url;
  }

  /** Whether a Prometheus URL is configured. */
  get configured(): boolean {
    return this.base !== undefined;
  }

  /**
   * Runs an instant query.
   *
   * @param promql the expression
   * @param at the evaluation time
   * @returns the series at that time
   * @throws {AppError} `MONITORING_UNAVAILABLE` when Prometheus is not configured, does not answer in time or answers an error
   */
  async query(promql: string, at: Date): Promise<PromVector[]> {
    const result = await this.call('/api/v1/query', { query: promql, time: String(at.getTime() / 1000) }, 'vector');
    return (result as Array<{ metric: Record<string, string>; value: [number, string] }>).map((row) => ({
      metric: row.metric,
      value: Number(row.value[1]),
    }));
  }

  /**
   * Runs a range query.
   *
   * @param promql the expression
   * @param start the first step time
   * @param end the last step time
   * @param stepSeconds the step
   * @returns the series with their samples
   * @throws {AppError} `MONITORING_UNAVAILABLE` as for {@link PrometheusClient.query}
   */
  async queryRange(promql: string, start: Date, end: Date, stepSeconds: number): Promise<PromMatrix[]> {
    const result = await this.call(
      '/api/v1/query_range',
      {
        query: promql,
        start: String(start.getTime() / 1000),
        end: String(end.getTime() / 1000),
        step: String(stepSeconds),
      },
      'matrix',
    );
    return (result as Array<{ metric: Record<string, string>; values: Array<[number, string]> }>).map((row) => ({
      metric: row.metric,
      values: row.values.map(([time, value]) => [time, Number(value)] as const),
    }));
  }

  private async call(path: string, params: Record<string, string>, resultType: string): Promise<unknown> {
    if (!this.base) {
      throw new AppError('MONITORING_UNAVAILABLE', { detail: 'Prometheus is not configured (PROMETHEUS_URL).' });
    }
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let body: PromResponse;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(PROMETHEUS_TIMEOUT_MS),
        headers: this.authorization ? { authorization: this.authorization } : {},
      });
      if (!response.ok) throw new Error(`Prometheus answered ${response.status}`);
      body = (await response.json()) as PromResponse;
    } catch (cause) {
      throw new AppError('MONITORING_UNAVAILABLE', { detail: 'Prometheus does not answer.', cause });
    }
    if (body.status !== 'success' || body.data?.resultType !== resultType || !Array.isArray(body.data.result)) {
      throw new AppError('MONITORING_UNAVAILABLE', { detail: 'Prometheus answered an error.' });
    }
    return body.data.result;
  }
}
