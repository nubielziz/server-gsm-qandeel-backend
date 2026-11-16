// Global Nest module of the search engine client (feature 29, decision 038): the Typesense client with the key of this process, the
// API's circuit breaker and the search metrics. Loaded by the API (role `search`) and the worker (role `indexer`).
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../config';
import { OutboundHttp } from '../http';
import { MetricsService } from '../metrics';
import { SearchCircuit } from './search-circuit';
import { SearchMetrics } from './search-metrics';
import { TypesenseClient } from './typesense-client';

/**
 * Which key a process holds: the API the search key, the worker the indexer key.
 *
 * Why: decision 038: each container gets only its own key, so the API can never write to the index even if it is compromised.
 */
export type SearchKeyRole = 'search' | 'indexer';

/** Injection token of the process's {@link SearchKeyRole}. */
export const SEARCH_KEY_ROLE = Symbol.for('gsm.SEARCH_KEY_ROLE');

/**
 * The key of a role, as the configuration holds it.
 *
 * Why: plan section 3.2: a production process with search on must have its own key (the development key is refused by the config);
 * outside production both roles use the node's development key.
 *
 * @param config the process configuration
 * @param role the process's role
 * @returns the key
 * @throws {Error} in production with search on when the role's key is not set (the process must not start half-configured)
 */
export function searchKeyOf(config: AppConfig, role: SearchKeyRole): string {
  const key = role === 'search' ? config.search.searchKey : config.search.indexerKey;
  const variable = role === 'search' ? 'TYPESENSE_SEARCH_KEY' : 'TYPESENSE_INDEXER_KEY';
  if (key === undefined) {
    if (config.isProduction && config.search.enabled) {
      throw new Error(`${variable} is required in production for the ${role === 'search' ? 'API' : 'worker'}.`);
    }
    // Search is off: the client is never called with it.
    return '';
  }
  return key;
}

/**
 * Provides {@link TypesenseClient}, {@link SearchCircuit}, {@link SearchMetrics} and {@link SEARCH_KEY_ROLE} to every module.
 *
 * Why: one client per process with the key of its role (decision 038); the storefront's search code (index, sync, the public routes)
 * injects it. The constructor makes no call, so the API boots without the engine (`depends_on: service_started`).
 */
@Global()
@Module({})
export class SearchModule {
  /**
   * The module for one process.
   *
   * @param options the role of the process: `search` (API) or `indexer` (worker)
   * @returns the dynamic module
   */
  static forRoot(options: { readonly role: SearchKeyRole }): DynamicModule {
    return {
      module: SearchModule,
      global: true,
      providers: [
        { provide: SEARCH_KEY_ROLE, useValue: options.role },
        {
          provide: SearchMetrics,
          useFactory: (metrics: MetricsService) => new SearchMetrics(metrics.registry),
          inject: [MetricsService],
        },
        {
          provide: TypesenseClient,
          useFactory: (http: OutboundHttp, config: AppConfig, role: SearchKeyRole) =>
            new TypesenseClient(http, {
              url: config.search.url,
              apiKey: searchKeyOf(config, role),
              searchTimeoutMs: config.search.timeoutMs,
            }),
          inject: [OutboundHttp, APP_CONFIG, SEARCH_KEY_ROLE],
        },
        { provide: SearchCircuit, useFactory: (clock: Clock) => new SearchCircuit(clock), inject: [CLOCK] },
      ],
      exports: [SEARCH_KEY_ROLE, SearchMetrics, TypesenseClient, SearchCircuit],
    };
  }
}
