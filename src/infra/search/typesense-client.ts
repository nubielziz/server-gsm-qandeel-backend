// TypesenseClient: our own small client of the Typesense 30.2 HTTP API over OutboundHttp (feature 29, decision 038): explicit
// timeouts, no hidden retries, every answer parsed and checked, typed failures. It never logs a key or a query body.
import type { HttpMethod, HttpResult, OutboundHttp, OutboundRequestOptions } from '../http';
import { SearchNotReady, SearchRejected, SearchUnavailable, failureOf, transportFailureOf } from './search-errors';
import type {
  AliasInfo,
  ApiKeyInfo,
  ApiKeySpec,
  CollectionInfo,
  CollectionSchema,
  EngineHealth,
  EngineMetrics,
  ImportAction,
  ImportFailure,
  ImportOutcome,
  MultiSearchRequest,
  SearchParams,
  SearchResult,
  SynonymItem,
} from './typesense.types';

/** The part of `OutboundHttp` the client uses (tests pass a recording wrapper). */
export type SearchTransport = Pick<OutboundHttp, 'request'>;

/** Where the client talks to and with which key. */
export interface TypesenseClientOptions {
  /** The node's base URL without a trailing slash (`TYPESENSE_URL`). */
  readonly url: string;
  /** The key of the process (`X-TYPESENSE-API-KEY`). */
  readonly apiKey: string;
  /** Default timeout of `search` and `multiSearch` (`SEARCH_TIMEOUT_MS`). */
  readonly searchTimeoutMs: number;
}

/** Per-call options of the search calls. */
export interface SearchCallOptions {
  /** Overrides the default search timeout (the suggest passes `SEARCH_SUGGEST_TIMEOUT_MS`). */
  readonly timeoutMs?: number;
}

/** Timeout of an import batch (plan section 3.4: 120 s per batch of 500). */
export const IMPORT_TIMEOUT_MS = 120_000;
/** Timeout of an export (60 s). */
export const EXPORT_TIMEOUT_MS = 60_000;
/** Timeout of every other call (5 s). */
export const DEFAULT_TIMEOUT_MS = 5_000;
/** Timeout of `GET /health` (the health indicator's 1 s). */
export const HEALTH_TIMEOUT_MS = 1_000;
/** The largest export read (64 MiB: 100 000 documents of `id` and `hash`). */
export const EXPORT_MAX_BYTES = 64 * 1024 * 1024;
/** Ids per `filter_by=id:[...]` delete. */
export const DELETE_BATCH = 250;

interface Call {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operation: string;
  readonly query?: URLSearchParams;
  readonly body?: string;
  readonly contentType?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** The body as JSON, or `undefined` when it is not JSON. */
function jsonOf(result: HttpResult): unknown {
  try {
    return result.json();
  } catch {
    return undefined;
  }
}

function malformed(operation: string): SearchUnavailable {
  return new SearchUnavailable('server', `Typesense ${operation} answered a body this client cannot read.`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks the shape of a search answer (`found` and `hits`); anything else is a failure of the call. */
function asSearchResult<D>(operation: string, value: unknown): SearchResult<D> {
  if (!isObject(value) || typeof value.found !== 'number' || !Array.isArray(value.hits)) throw malformed(operation);
  for (const hit of value.hits as unknown[]) {
    if (!isObject(hit) || !isObject(hit.document)) throw malformed(operation);
  }
  if (value.facet_counts !== undefined && !Array.isArray(value.facet_counts)) throw malformed(operation);
  return value as unknown as SearchResult<D>;
}

/** The typed failure of one multi-search entry that carries `code` and `error` (step 0: the HTTP status is 200). */
function subSearchFailure(index: number, entry: Record<string, unknown>): Error {
  const code = typeof entry.code === 'number' ? entry.code : 500;
  return failureOf(`multi_search entry ${index}`, code, entry);
}

function queryOf(params: SearchParams): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  return query;
}

function idOf(document: object, index: number): string {
  const id = (document as { id?: unknown }).id;
  return typeof id === 'string' ? id : `line ${index + 1}`;
}

/**
 * Talks to one Typesense node with one key.
 *
 * Why: decision 038 (owner choice): no official client (it brings axios and its own retry loop); every call goes through
 * `OutboundHttp` (decision 023) with `allowPrivateNetwork` (the node is on the internal network) and an explicit timeout, never
 * retries by itself, and parses every import line and every multi-search entry, so a partial failure in a 200 is never taken for
 * success. Failures are typed (`SearchUnavailable`, `SearchNotReady`, `SearchRejected`).
 *
 * Side effects: HTTP calls to the node (one metric sample and one host-only log line each, by `OutboundHttp`); nothing is logged here.
 */
export class TypesenseClient {
  constructor(
    private readonly http: SearchTransport,
    private readonly options: TypesenseClientOptions,
  ) {}

  /**
   * Runs one search.
   *
   * @param collection the collection or alias
   * @param params the search parameters
   * @param options the timeout of this call
   * @returns the answer, checked for `found` and `hits`
   * @throws {SearchUnavailable} engine down, slow, our key refused, or an answer that does not parse
   * @throws {SearchNotReady} the alias or collection does not exist
   * @throws {SearchRejected} the engine refused the parameters
   */
  async search<D = Record<string, unknown>>(
    collection: string,
    params: SearchParams,
    options: SearchCallOptions = {},
  ): Promise<SearchResult<D>> {
    const body = await this.json({
      method: 'GET',
      path: `/collections/${encodeURIComponent(collection)}/documents/search`,
      operation: 'search',
      query: queryOf(params),
      timeoutMs: options.timeoutMs ?? this.options.searchTimeoutMs,
    });
    return asSearchResult<D>('search', body);
  }

  /**
   * Runs several searches in one request.
   *
   * Why: step 0: the HTTP status is 200 even when an entry failed; such an entry is `{ code, error }`. Any failed or malformed entry
   * fails the whole call, so a caller never builds an answer from half the searches.
   *
   * @param searches the sub-searches, each naming its collection
   * @param options the timeout of this call
   * @returns one checked answer per sub-search, in order
   * @throws {SearchUnavailable} | {SearchNotReady} | {SearchRejected} for the request or for the first failed entry
   */
  async multiSearch<D = Record<string, unknown>>(
    searches: readonly MultiSearchRequest[],
    options: SearchCallOptions = {},
  ): Promise<Array<SearchResult<D>>> {
    const body = await this.json({
      method: 'POST',
      path: '/multi_search',
      operation: 'multi_search',
      body: JSON.stringify({ searches }),
      contentType: 'application/json',
      timeoutMs: options.timeoutMs ?? this.options.searchTimeoutMs,
    });
    if (!isObject(body) || !Array.isArray(body.results) || body.results.length !== searches.length) {
      throw malformed('multi_search');
    }
    return (body.results as unknown[]).map((entry, index) => {
      if (isObject(entry) && (entry.error !== undefined || (entry.code !== undefined && entry.hits === undefined))) {
        throw subSearchFailure(index, entry);
      }
      return asSearchResult<D>(`multi_search entry ${index}`, entry);
    });
  }

  /**
   * Imports documents as JSON lines.
   *
   * Why: plan section 3.4 and step 0: the answer is one JSON line per input line, in order, `{"success":true}` or
   * `{"code":400,"error":"...","success":false}` without an id, so failures are mapped back to the documents by line index. A refused
   * line never hides the others: the caller gets every failure.
   *
   * @param collection the collection or alias
   * @param documents the documents (each with an `id`)
   * @param action how an existing document is treated
   * @returns how many lines succeeded and which failed
   * @throws {SearchUnavailable} engine down, slow, key refused, out of resources, or an answer with a different line count
   * @throws {SearchNotReady} | {SearchRejected} for the request as a whole
   */
  async importJsonl(collection: string, documents: readonly object[], action: ImportAction): Promise<ImportOutcome> {
    if (documents.length === 0) return { ok: true, imported: 0, failed: [] };
    const result = await this.call({
      method: 'POST',
      path: `/collections/${encodeURIComponent(collection)}/documents/import`,
      operation: 'import',
      query: new URLSearchParams({ action }),
      body: documents.map((document) => JSON.stringify(document)).join('\n'),
      contentType: 'text/plain',
      timeoutMs: IMPORT_TIMEOUT_MS,
    });
    const lines = result
      .text()
      .split('\n')
      .filter((line) => line.trim() !== '');
    if (lines.length !== documents.length) throw malformed('import');
    const failed: ImportFailure[] = [];
    lines.forEach((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw malformed('import');
      }
      if (!isObject(parsed) || typeof parsed.success !== 'boolean') throw malformed('import');
      if (parsed.success) return;
      const code = typeof parsed.code === 'number' ? parsed.code : 400;
      const error = typeof parsed.error === 'string' ? parsed.error.slice(0, 200) : 'refused';
      // A line refused for lack of resources is the engine's state, not the document's: the whole batch is retried.
      const typed = failureOf('import', code, { error });
      if (typed instanceof SearchUnavailable) throw typed;
      failed.push({ id: idOf(documents[index]!, index), error });
    });
    return { ok: failed.length === 0, imported: documents.length - failed.length, failed };
  }

  /**
   * Deletes documents by id, 250 per request (`filter_by=id:[...]`).
   *
   * Why: step 0: a filter delete of absent ids answers 200 `{"num_deleted":0}`, so a repeat is harmless.
   *
   * @param collection the collection or alias
   * @param ids the document ids
   * @returns how many documents were deleted
   * @throws {SearchUnavailable} | {SearchNotReady} | {SearchRejected}
   */
  async deleteByIds(collection: string, ids: readonly string[]): Promise<number> {
    let deleted = 0;
    for (let start = 0; start < ids.length; start += DELETE_BATCH) {
      const batch = ids.slice(start, start + DELETE_BATCH);
      if (batch.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
        throw new SearchRejected(400, 'Typesense delete: a document id has characters a filter cannot carry.');
      }
      const body = await this.json({
        method: 'DELETE',
        path: `/collections/${encodeURIComponent(collection)}/documents`,
        operation: 'delete',
        query: new URLSearchParams({ filter_by: `id:[${batch.join(',')}]` }),
      });
      if (!isObject(body) || typeof body.num_deleted !== 'number') throw malformed('delete');
      deleted += body.num_deleted;
    }
    return deleted;
  }

  /**
   * Exports some fields of every document.
   *
   * @param collection the collection or alias
   * @param fields the fields to include (`id` and `hash` for the reconcile)
   * @returns one object per document
   * @throws {SearchUnavailable} (also a line that does not parse) | {SearchNotReady} | {SearchRejected}
   */
  async exportFields(collection: string, fields: readonly string[]): Promise<Array<Record<string, unknown>>> {
    const result = await this.call({
      method: 'GET',
      path: `/collections/${encodeURIComponent(collection)}/documents/export`,
      operation: 'export',
      query: new URLSearchParams({ include_fields: fields.join(',') }),
      timeoutMs: EXPORT_TIMEOUT_MS,
      maxResponseBytes: EXPORT_MAX_BYTES,
    });
    const out: Array<Record<string, unknown>> = [];
    for (const line of result.text().split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw malformed('export');
      }
      if (!isObject(parsed)) throw malformed('export');
      out.push(parsed);
    }
    return out;
  }

  /**
   * Creates a collection.
   *
   * @param schema the schema (name, fields, sorting field, linked sets)
   * @returns what the engine stored
   * @throws {SearchUnavailable} | {SearchRejected} (for example a name that exists: 409)
   */
  async createCollection(schema: CollectionSchema): Promise<CollectionInfo> {
    const body = await this.json({
      method: 'POST',
      path: '/collections',
      operation: 'create collection',
      body: JSON.stringify(schema),
      contentType: 'application/json',
    });
    if (!isObject(body) || typeof body.name !== 'string') throw malformed('create collection');
    return body as unknown as CollectionInfo;
  }

  /**
   * Drops a collection.
   *
   * @param name the collection
   * @returns false when it did not exist
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async dropCollection(name: string): Promise<boolean> {
    return this.deleteOrAbsent(`/collections/${encodeURIComponent(name)}`, 'drop collection');
  }

  /**
   * Reads one collection.
   *
   * @param name the collection (or an alias, which the engine resolves)
   * @returns the collection, or `null` when it does not exist
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async getCollection(name: string): Promise<CollectionInfo | null> {
    try {
      const body = await this.json({
        method: 'GET',
        path: `/collections/${encodeURIComponent(name)}`,
        operation: 'get collection',
      });
      if (!isObject(body) || typeof body.name !== 'string') throw malformed('get collection');
      return body as unknown as CollectionInfo;
    } catch (error) {
      if (error instanceof SearchNotReady) return null;
      throw error;
    }
  }

  /**
   * Lists the collections whose name starts with a prefix.
   *
   * Why: step 0: a key scoped to `<prefix>.*` lists only matching collections; the filter here also keeps the bootstrap key (db-reset,
   * tests) to one environment.
   *
   * @param prefix the environment's prefix
   * @returns the matching collections
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async listCollections(prefix: string): Promise<CollectionInfo[]> {
    const body = await this.json({
      method: 'GET',
      path: '/collections',
      operation: 'list collections',
      query: new URLSearchParams({ exclude_fields: 'fields' }),
    });
    if (!Array.isArray(body)) throw malformed('list collections');
    return (body as unknown[])
      .filter((entry): entry is CollectionInfo => isObject(entry) && typeof entry.name === 'string')
      .filter((entry) => entry.name.startsWith(prefix));
  }

  /**
   * Reads an alias.
   *
   * @param name the alias
   * @param options a shorter timeout for the health check
   * @returns the alias, or `null` when it does not exist
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async getAlias(name: string, options: { readonly timeoutMs?: number } = {}): Promise<AliasInfo | null> {
    try {
      const body = await this.json({
        method: 'GET',
        path: `/aliases/${encodeURIComponent(name)}`,
        operation: 'get alias',
        timeoutMs: options.timeoutMs,
      });
      if (!isObject(body) || typeof body.collection_name !== 'string') throw malformed('get alias');
      return body as unknown as AliasInfo;
    } catch (error) {
      if (error instanceof SearchNotReady) return null;
      throw error;
    }
  }

  /**
   * Lists the aliases whose name starts with a prefix.
   *
   * @param prefix the environment's prefix
   * @returns the matching aliases
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async listAliases(prefix: string): Promise<AliasInfo[]> {
    const body = await this.json({ method: 'GET', path: '/aliases', operation: 'list aliases' });
    if (!isObject(body) || !Array.isArray(body.aliases)) throw malformed('list aliases');
    return (body.aliases as unknown[])
      .filter((entry): entry is AliasInfo => isObject(entry) && typeof entry.name === 'string')
      .filter((entry) => entry.name.startsWith(prefix));
  }

  /**
   * Points an alias at a collection (creates or moves it in one step: searches through the alias never fail during the swap).
   *
   * @param name the alias
   * @param collection the collection
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async putAlias(name: string, collection: string): Promise<void> {
    await this.json({
      method: 'PUT',
      path: `/aliases/${encodeURIComponent(name)}`,
      operation: 'put alias',
      body: JSON.stringify({ collection_name: collection }),
      contentType: 'application/json',
    });
  }

  /**
   * Deletes an alias (never its collection).
   *
   * @param name the alias
   * @returns false when it did not exist
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async deleteAlias(name: string): Promise<boolean> {
    return this.deleteOrAbsent(`/aliases/${encodeURIComponent(name)}`, 'delete alias');
  }

  /**
   * Replaces a synonym set with these items.
   *
   * @param name the set (`<prefix>synonyms`)
   * @param items every enabled synonym
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async putSynonymSet(name: string, items: readonly SynonymItem[]): Promise<void> {
    await this.json({
      method: 'PUT',
      path: `/synonym_sets/${encodeURIComponent(name)}`,
      operation: 'put synonym set',
      body: JSON.stringify({ items }),
      contentType: 'application/json',
    });
  }

  /**
   * Deletes a synonym set.
   *
   * @param name the set
   * @returns false when it did not exist
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async deleteSynonymSet(name: string): Promise<boolean> {
    return this.deleteOrAbsent(`/synonym_sets/${encodeURIComponent(name)}`, 'delete synonym set');
  }

  /**
   * Deletes a curation set (the rebuild deletes the one schema version 1 linked: pins are retired by decision 068).
   *
   * @param name the set
   * @returns false when it did not exist
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async deleteCurationSet(name: string): Promise<boolean> {
    return this.deleteOrAbsent(`/curation_sets/${encodeURIComponent(name)}`, 'delete curation set');
  }

  /**
   * Asks the node whether it is up (`GET /health` needs no key; it is sent anyway).
   *
   * @returns `ok`, and the resource the node lacks while it refuses writes (step 0: `resource_error`)
   * @throws {SearchUnavailable} when the node does not answer within 1 s or answers an error
   */
  async health(): Promise<EngineHealth> {
    const body = await this.json({ method: 'GET', path: '/health', operation: 'health', timeoutMs: HEALTH_TIMEOUT_MS });
    if (!isObject(body) || typeof body.ok !== 'boolean') throw malformed('health');
    return { ok: body.ok, resourceError: typeof body.resource_error === 'string' ? body.resource_error : null };
  }

  /**
   * Reads the engine's memory figures (`GET /metrics.json`; Typesense has no Prometheus endpoint).
   *
   * @returns the allocated and resident bytes, `null` when a figure is missing
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async metrics(): Promise<EngineMetrics> {
    const body = await this.json({ method: 'GET', path: '/metrics.json', operation: 'metrics' });
    if (!isObject(body)) throw malformed('metrics');
    const figure = (key: string): number | null => {
      const value = Number(body[key]);
      return Number.isFinite(value) ? value : null;
    };
    return {
      memoryAllocatedBytes: figure('typesense_memory_allocated_bytes'),
      memoryResidentBytes: figure('typesense_memory_resident_bytes'),
    };
  }

  /**
   * Reads the engine version (`GET /debug`).
   *
   * @returns the version text, for example `30.2`
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async version(): Promise<string> {
    const body = await this.json({ method: 'GET', path: '/debug', operation: 'debug' });
    if (!isObject(body) || typeof body.version !== 'string') throw malformed('debug');
    return body.version.slice(0, 40);
  }

  /**
   * Lists the API keys (bootstrap key only; `scripts/search-keys.ts`).
   *
   * @returns every key, without its value
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async listKeys(): Promise<ApiKeyInfo[]> {
    const body = await this.json({ method: 'GET', path: '/keys', operation: 'list keys' });
    if (!isObject(body) || !Array.isArray(body.keys)) throw malformed('list keys');
    return body.keys as ApiKeyInfo[];
  }

  /**
   * Creates an API key with a fixed value (bootstrap key only).
   *
   * @param spec the value, description, actions and collections
   * @returns the new key's id
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async createKey(spec: ApiKeySpec): Promise<number> {
    const body = await this.json({
      method: 'POST',
      path: '/keys',
      operation: 'create key',
      body: JSON.stringify(spec),
      contentType: 'application/json',
    });
    if (!isObject(body) || typeof body.id !== 'number') throw malformed('create key');
    return body.id;
  }

  /**
   * Deletes an API key (bootstrap key only).
   *
   * @param id the key's id
   * @returns false when it did not exist
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async deleteKey(id: number): Promise<boolean> {
    return this.deleteOrAbsent(`/keys/${id}`, 'delete key');
  }

  private async deleteOrAbsent(path: string, operation: string): Promise<boolean> {
    try {
      await this.json({ method: 'DELETE', path, operation });
      return true;
    } catch (error) {
      if (error instanceof SearchNotReady) return false;
      throw error;
    }
  }

  private async json(call: Call): Promise<unknown> {
    const result = await this.call(call);
    const body = jsonOf(result);
    if (body === undefined) throw malformed(call.operation);
    return body;
  }

  private async call(call: Call): Promise<HttpResult> {
    const url = new URL(`${this.options.url}${call.path}`);
    if (call.query) url.search = call.query.toString();
    const headers: Record<string, string> = { 'x-typesense-api-key': this.options.apiKey };
    if (call.contentType) headers['content-type'] = call.contentType;
    const request: OutboundRequestOptions = {
      url,
      method: call.method,
      headers,
      ...(call.body === undefined ? {} : { body: call.body }),
      timeoutMs: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(call.maxResponseBytes === undefined ? {} : { maxResponseBytes: call.maxResponseBytes }),
      // The node lives on the internal network (decision 038); OutboundHttp's public-host guard would refuse it.
      allowPrivateNetwork: true,
      target: 'search',
      operation: `typesense.${call.operation.replaceAll(' ', '_')}`,
    };
    let result: HttpResult;
    try {
      result = await this.http.request(request);
    } catch (error) {
      throw transportFailureOf(call.operation, error);
    }
    if (!result.ok) throw failureOf(call.operation, result.status, jsonOf(result));
    return result;
  }
}
