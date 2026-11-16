// Prometheus metrics of the storefront search (feature 29, plan section 3.4): the API's request, engine time, fallback and stale-hit
// counters, and the worker's sync, rebuild and reconcile figures. Labels are small fixed sets (routes, engines, reasons, operations).
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';

/** The search routes of the API (`route` label). */
export type SearchRoute = 'suggest' | 'results' | 'services';

/** Why a search answered from Postgres (`search_fallback_total{reason}`). */
export type FallbackReason = 'timeout' | 'error' | 'not_ready' | 'circuit_open' | 'disabled';

/**
 * Every search metric of one process.
 *
 * Why: operations watch the fallback rate, the engine latency and the sync lag (plan section 3.4, `docs/OPERATIONS.md`); one class
 * registers them all on the process registry (a metric name can be registered once per registry), and each process uses its own
 * part: the API the request metrics, the worker the sync and index metrics.
 */
export class SearchMetrics {
  readonly requests: Counter<'route' | 'engine'>;
  readonly engineSeconds: Histogram<'route'>;
  readonly fallbacks: Counter<'reason'>;
  readonly staleHits: Counter;
  readonly zeroResults: Counter<'route'>;
  readonly suggestLimited: Counter;
  readonly termsDropped: Counter;
  readonly syncDocuments: Counter<'op'>;
  readonly syncFailures: Counter;
  readonly syncRejected: Counter;
  readonly authFailures: Counter;
  readonly syncLag: Histogram;
  readonly indexDocuments: Gauge;
  readonly lastRebuild: Gauge;
  readonly lastReconcile: Gauge;
  readonly engineMemory: Gauge;

  /** @param registry the process registry (`MetricsService.registry`) */
  constructor(registry: Registry) {
    const registers = [registry];
    this.requests = new Counter({
      name: 'search_requests_total',
      help: 'Search requests answered, by route (suggest, results, services) and engine (typesense, fallback).',
      labelNames: ['route', 'engine'],
      registers,
    });
    this.engineSeconds = new Histogram({
      name: 'search_engine_seconds',
      help: 'Time of the engine part of a search request, in seconds, by route.',
      labelNames: ['route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers,
    });
    this.fallbacks = new Counter({
      name: 'search_fallback_total',
      help: 'Searches answered from Postgres, by reason (timeout, error, not_ready, circuit_open, disabled).',
      labelNames: ['reason'],
      registers,
    });
    this.staleHits = new Counter({
      name: 'search_stale_hits_total',
      help: 'Engine hits dropped because Postgres no longer lets the shop show them.',
      registers,
    });
    this.zeroResults = new Counter({
      name: 'search_zero_results_total',
      help: 'Searches that found nothing, by route.',
      labelNames: ['route'],
      registers,
    });
    this.suggestLimited = new Counter({
      name: 'search_suggest_limited_total',
      help: 'Suggest requests refused by the search-suggest limiter.',
      registers,
    });
    this.termsDropped = new Counter({
      name: 'search_terms_dropped_total',
      help: 'Searched terms not counted because the day reached its field cap.',
      registers,
    });
    this.syncDocuments = new Counter({
      name: 'search_sync_documents_total',
      help: 'Documents the search sync wrote, by operation (upsert, delete).',
      labelNames: ['op'],
      registers,
    });
    this.syncFailures = new Counter({
      name: 'search_sync_failures_total',
      help: 'Search sync runs that failed and will be retried.',
      registers,
    });
    this.syncRejected = new Counter({
      name: 'search_sync_rejected_total',
      help: 'Documents the engine refused during a sync or a rebuild.',
      registers,
    });
    this.authFailures = new Counter({
      name: 'search_auth_failures_total',
      help: 'Engine calls of the worker refused for the key (401 or 403): the search keys are missing.',
      registers,
    });
    this.syncLag = new Histogram({
      name: 'search_sync_lag_seconds',
      help: 'Seconds from the outbox event of a change to its documents being written.',
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 300, 900],
      registers,
    });
    this.indexDocuments = new Gauge({
      name: 'search_index_documents',
      help: 'Documents in the live services collection, as the last reconcile counted.',
      registers,
    });
    this.lastRebuild = new Gauge({
      name: 'search_index_last_rebuild_timestamp_seconds',
      help: 'Unix time of the last successful rebuild of the services index.',
      registers,
    });
    this.lastReconcile = new Gauge({
      name: 'search_index_last_reconcile_timestamp_seconds',
      help: 'Unix time of the last finished reconcile of the services index.',
      registers,
    });
    this.engineMemory = new Gauge({
      name: 'typesense_memory_allocated_bytes',
      help: 'Memory the search engine allocated, read from its /metrics.json by the reconcile.',
      registers,
    });
  }
}
