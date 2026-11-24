// Wire types of the Typesense 30.2 API as the search client uses them (feature 29, decision 038): collection schemas, search and
// multi-search answers, import results, aliases, synonym sets, API keys. Only the fields this backend reads or writes.

/**
 * The field types the collections of this backend use.
 *
 * Why: the services and terms schemas (plan section 4.2, 4.4) need only these; a narrower union catches a typo at compile time.
 */
export type FieldType = 'string' | 'string[]' | 'int32' | 'int64' | 'bool';

/** One field of a collection schema. */
export interface CollectionField {
  readonly name: string;
  readonly type: FieldType;
  readonly facet?: boolean;
  readonly optional?: boolean;
  readonly sort?: boolean;
  /** `false` stores the value without indexing it (the reconcile hash). */
  readonly index?: boolean;
}

/**
 * What `POST /collections` takes.
 *
 * Why: plan section 3.3: every services collection links the environment's synonym set at creation (no curation set since decision
 * 068).
 */
export interface CollectionSchema {
  readonly name: string;
  readonly fields: readonly CollectionField[];
  readonly default_sorting_field?: string;
  readonly synonym_sets?: readonly string[];
}

/** What `GET /collections` and `GET /collections/:name` answer (the parts read here). */
export interface CollectionInfo {
  readonly name: string;
  readonly num_documents: number;
  readonly created_at?: number;
  readonly synonym_sets?: readonly string[];
  /** The curation sets the collection links: none since decision 068 (a collection of schema version 1 linked one). */
  readonly curation_sets?: readonly string[];
}

/** An alias and the collection it points at. */
export interface AliasInfo {
  readonly name: string;
  readonly collection_name: string;
}

/**
 * The parameters of one search (`q`, `query_by`, `filter_by`, ...), as Typesense names them.
 *
 * Why: the ranking parameters live in the search domain (`ranking.ts`, slice B2); the client passes them through unchanged.
 */
export type SearchParams = Readonly<Record<string, string | number | boolean>>;

/** One sub-search of a multi-search: the collection (an alias) and its parameters. */
export type MultiSearchRequest = SearchParams & { readonly collection: string };

/** The highlight of one field of a hit. */
export interface SearchHighlight {
  readonly field: string;
  /** A string field gives a list of tokens; a string[] field a list per matched element. */
  readonly matched_tokens?: ReadonlyArray<string | readonly string[]>;
  readonly snippet?: string;
}

/** One hit of a search. */
export interface SearchHit<D> {
  readonly document: D;
  readonly highlights?: readonly SearchHighlight[];
  readonly text_match?: number;
}

/** The counts of one facet field. */
export interface FacetCounts {
  readonly field_name: string;
  readonly counts: ReadonlyArray<{ readonly value: string; readonly count: number }>;
}

/** The answer of one search (or of one entry of a multi-search). */
export interface SearchResult<D> {
  readonly found: number;
  readonly out_of?: number;
  readonly page?: number;
  readonly hits: ReadonlyArray<SearchHit<D>>;
  readonly facet_counts?: readonly FacetCounts[];
  readonly search_time_ms?: number;
}

/**
 * How an import treats an existing document.
 *
 * Why: the sync and the rebuild write whole documents (`upsert`); the other actions exist for completeness of the wire.
 */
export type ImportAction = 'create' | 'upsert' | 'update' | 'emplace';

/** One line of an import that Typesense refused. */
export interface ImportFailure {
  /** The id of the document on the same line of the request (Typesense's line has no id: step 0). */
  readonly id: string;
  readonly error: string;
}

/** What one import did. */
export interface ImportOutcome {
  /** True when every line succeeded. */
  readonly ok: boolean;
  /** Lines that succeeded. */
  readonly imported: number;
  readonly failed: readonly ImportFailure[];
}

/** One item of a synonym set (`PUT /synonym_sets/:name`). */
export interface SynonymItem {
  readonly id: string;
  readonly synonyms: readonly string[];
  /** Set for a one-way synonym: the word that expands to `synonyms`. */
  readonly root?: string;
}

/** What `GET /health` says. */
export interface EngineHealth {
  readonly ok: boolean;
  /** `OUT_OF_DISK` or `OUT_OF_MEMORY` while writes are refused; `null` otherwise. */
  readonly resourceError: string | null;
}

/** The figures of `GET /metrics.json` the reconcile records. */
export interface EngineMetrics {
  /** `typesense_memory_allocated_bytes`: the engine's own allocation (the system figures report the host, not the container). */
  readonly memoryAllocatedBytes: number | null;
  readonly memoryResidentBytes: number | null;
}

/** An API key as `GET /keys` lists it (the value is never listed, only on creation). */
export interface ApiKeyInfo {
  readonly id: number;
  readonly description: string;
  readonly actions: readonly string[];
  readonly collections: readonly string[];
}

/** What `POST /keys` takes. */
export interface ApiKeySpec {
  /** The fixed key from the secret store (plan section 3.3). */
  readonly value: string;
  readonly description: string;
  readonly actions: readonly string[];
  readonly collections: readonly string[];
}
