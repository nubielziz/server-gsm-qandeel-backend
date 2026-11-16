// `bun scripts/search-keys.ts`: creates (or repairs) the two Typesense keys of an environment (feature 29, plan section 3.3): the
// worker's indexer key and the API's search key, with the fixed values from the secret store, limited to the environment's prefix.
// Idempotent; run it after any wipe or upgrade of the Typesense volume, before the api and the worker start. Never prints a key.
//
// Shell: TYPESENSE_URL, TYPESENSE_BOOTSTRAP_KEY, TYPESENSE_INDEXER_KEY, TYPESENSE_SEARCH_KEY, TYPESENSE_PREFIX.
import { httpRequest } from '../src/infra/http/http-request';
import { type ApiKeyInfo, SearchUnavailable, TypesenseClient } from '../src/infra/search';
import { SearchNames } from '../src/modules/storefront';

/** What the worker's key may do (plan section 3.3). */
export const INDEXER_ACTIONS = [
  'collections:*',
  'documents:*',
  'aliases:*',
  'synonym_sets:*',
  'curation_sets:*',
  'metrics.json:list',
  'stats.json:list',
  'debug:list',
] as const;
/** What the API's key may do: search, and read an alias or a collection (the health and index reads). */
export const SEARCH_ACTIONS = ['documents:search', 'aliases:get', 'collections:get'] as const;

/** One key's role. */
export type KeyRole = 'indexer' | 'search';

/** What happened to one key. */
export interface KeyOutcome {
  readonly role: KeyRole;
  readonly description: string;
  /** `kept` (it matched and worked), `created` (there was none) or `recreated` (it differed or was refused). */
  readonly action: 'kept' | 'created' | 'recreated';
}

/** Everything the keys step needs. */
export interface SearchKeysInput {
  /** A client on the bootstrap key. */
  readonly admin: TypesenseClient;
  /** Makes a client on another key (to try the key once). */
  readonly clientFor: (key: string) => TypesenseClient;
  readonly prefix: string;
  readonly indexerKey: string;
  readonly searchKey: string;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

/** Tries one call with a key: a 401/403 means the engine does not know it (or not with these rights). */
async function works(client: TypesenseClient, role: KeyRole, prefix: string): Promise<boolean> {
  try {
    if (role === 'indexer') await client.listCollections(prefix);
    else await client.getAlias(new SearchNames(prefix).alias('services'));
    return true;
  } catch (error) {
    if (error instanceof SearchUnavailable && error.kind === 'auth') return false;
    throw error;
  }
}

/**
 * Makes sure both keys exist with the right value, actions and collections.
 *
 * Why: plan section 3.3: the keys carry fixed values from the secret store (each container gets only its own), so after a volume
 * wipe they must be created again with the same values; the step lists the keys, finds each by its description
 * (`gsm:<prefix>:indexer`, `gsm:<prefix>:search`), compares actions and collections, tries one call with the key, and deletes and
 * recreates it when anything differs or the call answers 401. The collection scope `<prefix>.*` does not restrict global endpoints
 * such as the synonym and curation sets (accepted in the plan).
 *
 * @param input the bootstrap client, the prefix and the two key values
 * @returns what happened to each key
 * @throws {SearchUnavailable} | {SearchRejected} when the engine fails
 */
export async function ensureSearchKeys(input: SearchKeysInput): Promise<KeyOutcome[]> {
  const keys: ApiKeyInfo[] = await input.admin.listKeys();
  const outcomes: KeyOutcome[] = [];
  const wanted: Array<{ role: KeyRole; value: string; actions: readonly string[] }> = [
    { role: 'indexer', value: input.indexerKey, actions: INDEXER_ACTIONS },
    { role: 'search', value: input.searchKey, actions: SEARCH_ACTIONS },
  ];
  for (const key of wanted) {
    const description = `gsm:${input.prefix}:${key.role}`;
    const collections = [`${input.prefix}.*`];
    const existing = keys.filter((entry) => entry.description === description);
    const match =
      existing.length === 1 &&
      sameList(existing[0]!.actions, key.actions) &&
      sameList(existing[0]!.collections, collections);
    if (match && (await works(input.clientFor(key.value), key.role, input.prefix))) {
      outcomes.push({ role: key.role, description, action: 'kept' });
      continue;
    }
    for (const entry of existing) await input.admin.deleteKey(entry.id);
    await input.admin.createKey({ value: key.value, description, actions: key.actions, collections });
    outcomes.push({ role: key.role, description, action: existing.length === 0 ? 'created' : 'recreated' });
  }
  return outcomes;
}

/**
 * A client of the node on one key, for scripts (no metrics, no logs).
 *
 * @param url the node's base URL
 * @param apiKey the key
 * @returns the client
 */
export function scriptClient(url: string, apiKey: string): TypesenseClient {
  return new TypesenseClient(
    { request: (options) => httpRequest(options) },
    { url: url.replace(/\/+$/, ''), apiKey, searchTimeoutMs: 5_000 },
  );
}

/**
 * Tells whether the bootstrap, indexer and search keys are three different values.
 *
 * Why: plan section 3.3: each container holds only its own key, scoped to the environment's `<prefix>.*`. An indexer key equal to the
 * bootstrap key would hand the worker the node's unscoped admin key (on a shared node it could touch every environment), and a search
 * key equal to either would hand the API write rights. So all three pairs are compared, not only the pairs with the search key.
 *
 * @param keys the three key values
 * @returns `true` when no two of them are equal
 */
export function keysAreDistinct(keys: { bootstrap: string; indexer: string; search: string }): boolean {
  return keys.bootstrap !== keys.indexer && keys.bootstrap !== keys.search && keys.indexer !== keys.search;
}

if (import.meta.main) {
  const env = process.env;
  const missing = [
    'TYPESENSE_BOOTSTRAP_KEY',
    'TYPESENSE_INDEXER_KEY',
    'TYPESENSE_SEARCH_KEY',
    'TYPESENSE_PREFIX',
  ].filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(`Set ${missing.join(', ')} in the shell (and TYPESENSE_URL, default http://localhost:8108).`);
    process.exit(1);
  }
  const prefix = env.TYPESENSE_PREFIX!;
  if (!/^[a-z0-9_]{1,40}_$/.test(prefix)) {
    console.error('TYPESENSE_PREFIX must be lower-case letters, digits and "_", ending in "_".');
    process.exit(1);
  }
  if (
    !keysAreDistinct({
      bootstrap: env.TYPESENSE_BOOTSTRAP_KEY!,
      indexer: env.TYPESENSE_INDEXER_KEY!,
      search: env.TYPESENSE_SEARCH_KEY!,
    })
  ) {
    console.error('The bootstrap, indexer and search keys must be three different values.');
    process.exit(1);
  }
  const url = env.TYPESENSE_URL ?? 'http://localhost:8108';
  try {
    const outcomes = await ensureSearchKeys({
      admin: scriptClient(url, env.TYPESENSE_BOOTSTRAP_KEY!),
      clientFor: (key) => scriptClient(url, key),
      prefix,
      indexerKey: env.TYPESENSE_INDEXER_KEY!,
      searchKey: env.TYPESENSE_SEARCH_KEY!,
    });
    for (const outcome of outcomes)
      console.log(`  ${outcome.role.padEnd(8)} ${outcome.description}: ${outcome.action}`);
    console.log('Search keys are in place.');
  } catch (error) {
    console.error(`The search keys could not be set: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
