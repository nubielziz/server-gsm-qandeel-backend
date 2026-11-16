// SearchEngine: the one door through which the API calls the search engine (feature 29, decision 038, plan sections 3.4 and 5.5). It
// answers "the engine's value" or "the fallback's value", never an error: search must not make a page fail.
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import {
  type FallbackReason,
  SearchCircuit,
  SearchMetrics,
  type SearchRoute,
  SearchNotReady,
  SearchRejected,
  SearchUnavailable,
  TypesenseClient,
} from '../../../../infra/search';

/** Which side answered: the engine with its value, or the fallback with its own. */
export type EngineOutcome<T, F> =
  | { readonly engine: 'typesense'; readonly value: T }
  | { readonly engine: 'fallback'; readonly value: F; readonly reason: FallbackReason };

/**
 * Runs a search against the engine with the circuit, the metrics and the fallback.
 *
 * Why: plan section 5.5: circuit open, `SEARCH_ENABLED=false` or any failure of the call (the engine down, slow, not ready, refusing our
 * key, an answer that does not parse, a failed sub-search) gives the fallback and `search_fallback_total{reason}`; `timeout` and
 * `not_ready` are told apart, everything else is `error`. The call must hold only engine work: a database failure after it is not the
 * engine's and is never swallowed here.
 *
 * Side effects: `search_requests_total{route,engine}`, `search_engine_seconds{route}` (engine calls only), `search_fallback_total{reason}`;
 * the circuit's state.
 */
@Injectable()
export class SearchEngine {
  constructor(
    private readonly client: TypesenseClient,
    private readonly circuit: SearchCircuit,
    private readonly metrics: SearchMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Whether search is switched on at all (`SEARCH_ENABLED`). */
  get enabled(): boolean {
    return this.config.search.enabled;
  }

  /**
   * Runs one engine call, or the fallback.
   *
   * @param route which route asks (a metric label)
   * @param call the engine work; it receives the client and the timeout of the route
   * @param fallback what to answer instead; it receives the reason
   * @returns the engine's value, or the fallback's, and which one it was
   * @throws whatever `fallback` throws
   */
  async run<T, F>(
    route: SearchRoute,
    call: (client: TypesenseClient, timeoutMs: number) => Promise<T>,
    fallback: (reason: FallbackReason) => Promise<F>,
  ): Promise<EngineOutcome<T, F>> {
    const refused = this.refusal();
    if (refused !== null) return this.fellBack(route, refused, fallback);
    const timeoutMs = route === 'suggest' ? this.config.search.suggestTimeoutMs : this.config.search.timeoutMs;
    const stop = this.metrics.engineSeconds.startTimer({ route });
    try {
      const value = await call(this.client, timeoutMs);
      stop();
      this.circuit.succeeded();
      this.metrics.requests.inc({ route, engine: 'typesense' });
      return { engine: 'typesense', value };
    } catch (error) {
      stop();
      // A 4xx caused by our own request (`SearchRejected`) says nothing about the engine's health: it must not open the circuit,
      // or one visitor's bad parameter would switch the search off for everyone. The call still falls back.
      if (!(error instanceof SearchRejected)) this.circuit.failed(error);
      return this.fellBack(route, reasonOf(error), fallback);
    }
  }

  private refusal(): FallbackReason | null {
    if (!this.config.search.enabled) return 'disabled';
    return this.circuit.allow() ? null : 'circuit_open';
  }

  private async fellBack<T, F>(
    route: SearchRoute,
    reason: FallbackReason,
    fallback: (reason: FallbackReason) => Promise<F>,
  ): Promise<EngineOutcome<T, F>> {
    this.metrics.fallbacks.inc({ reason });
    this.metrics.requests.inc({ route, engine: 'fallback' });
    return { engine: 'fallback', value: await fallback(reason), reason };
  }
}

/**
 * Names why an engine call failed, for the fallback metric.
 *
 * @param error what the call threw
 * @returns `timeout`, `not_ready` (a missing alias) or `error`
 */
export function reasonOf(error: unknown): FallbackReason {
  if (error instanceof SearchNotReady) return 'not_ready';
  if (error instanceof SearchUnavailable && error.kind === 'timeout') return 'timeout';
  return 'error';
}
