// Public API of the search engine infrastructure (feature 29, decision 038): the Typesense client, its typed failures, the circuit
// breaker, the health indicator, the metrics and the Nest module.
export { SearchModule, SEARCH_KEY_ROLE, searchKeyOf } from './search.module';
export type { SearchKeyRole } from './search.module';
export {
  DEFAULT_TIMEOUT_MS,
  DELETE_BATCH,
  EXPORT_MAX_BYTES,
  EXPORT_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  IMPORT_TIMEOUT_MS,
  TypesenseClient,
} from './typesense-client';
export type { SearchCallOptions, SearchTransport, TypesenseClientOptions } from './typesense-client';
export {
  SearchNotReady,
  SearchRejected,
  SearchUnavailable,
  engineMessageOf,
  failureOf,
  isSearchFailure,
  transportFailureOf,
} from './search-errors';
export type { SearchFailure, SearchUnavailableKind } from './search-errors';
export { SEARCH_CIRCUIT_DEFAULTS, SearchCircuit, opensAtOnce } from './search-circuit';
export type { CircuitState, SearchCircuitOptions } from './search-circuit';
export { SearchHealthIndicator } from './search-health.indicator';
export { SearchMetrics } from './search-metrics';
export type { FallbackReason, SearchRoute } from './search-metrics';
export type {
  AliasInfo,
  ApiKeyInfo,
  ApiKeySpec,
  CollectionField,
  CollectionInfo,
  CollectionSchema,
  EngineHealth,
  EngineMetrics,
  FacetCounts,
  FieldType,
  ImportAction,
  ImportFailure,
  ImportOutcome,
  MultiSearchRequest,
  SearchHighlight,
  SearchHit,
  SearchParams,
  SearchResult,
  SynonymItem,
} from './typesense.types';
