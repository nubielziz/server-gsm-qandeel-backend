// The services collection of the storefront search (feature 29, plan section 4.2): its fields, its options, its document type and the
// names of every collection, alias and set of an environment (plan section 3.3). Pure.
import type { CollectionField, CollectionSchema } from '../../../../infra/search';
import { TERMS_SCHEMA_VERSION } from './terms';

/**
 * The version of the services schema: any change of a field, a type or a collection option bumps it.
 *
 * Why: plan section 3.3: aliases carry the version, so a deploy with a new schema finds no alias, searches fall back, and the worker
 * rebuilds into a collection of the new version before it swaps the alias in.
 */
export const SERVICES_SCHEMA_VERSION = 1;

/**
 * One document of the services collection: public, English, price-free facts of one sellable service.
 *
 * Why: decision 038: the index holds only what a public visitor may see and never a price, a cost, a supplier, a stock count or a
 * person; `id` is the service id (stable across rebuilds, so pins keep working).
 */
export interface ServiceDocument {
  readonly id: string;
  readonly title: string;
  readonly title_words?: string;
  readonly title_sort: string;
  readonly summary?: string;
  readonly brand?: string;
  readonly carrier?: string;
  readonly brand_key?: string;
  readonly carrier_key?: string;
  readonly country?: string;
  readonly country_names?: readonly string[];
  readonly networks?: readonly string[];
  readonly category: string;
  readonly category_id: number;
  readonly type: string;
  readonly codes?: readonly string[];
  readonly joins?: readonly string[];
  readonly models?: readonly string[];
  readonly popularity: number;
  readonly featured: boolean;
  readonly in_stock: boolean;
  readonly sort: number;
  readonly listed_at: number;
  /** sha1 of every other field: the reconcile compares it with the hash of the document Postgres gives now. */
  readonly hash: string;
}

/**
 * The fields of the services collection (plan section 4.2, with the step 0 correction: `title` is searched with no typos and
 * `title_words` is its typo-safe copy).
 */
export const SERVICE_FIELDS: readonly CollectionField[] = [
  { name: 'title', type: 'string' },
  { name: 'title_words', type: 'string', optional: true },
  { name: 'title_sort', type: 'string', sort: true },
  { name: 'summary', type: 'string', optional: true },
  { name: 'brand', type: 'string', optional: true },
  { name: 'carrier', type: 'string', optional: true },
  { name: 'brand_key', type: 'string', facet: true, optional: true },
  { name: 'carrier_key', type: 'string', facet: true, optional: true },
  { name: 'country', type: 'string', facet: true, optional: true },
  { name: 'country_names', type: 'string[]', optional: true },
  { name: 'networks', type: 'string[]', optional: true },
  { name: 'category', type: 'string' },
  { name: 'category_id', type: 'int32', facet: true },
  { name: 'type', type: 'string', facet: true },
  { name: 'codes', type: 'string[]', optional: true },
  { name: 'joins', type: 'string[]', optional: true },
  { name: 'models', type: 'string[]', optional: true },
  { name: 'popularity', type: 'int32' },
  { name: 'featured', type: 'bool', facet: true },
  { name: 'in_stock', type: 'bool', facet: true },
  { name: 'sort', type: 'int32' },
  { name: 'listed_at', type: 'int64' },
  { name: 'hash', type: 'string', index: false },
];

/**
 * The schema of a new services collection, linked to the environment's synonym and curation sets.
 *
 * Why: plan section 3.3: the links are part of the collection, so `SearchCollections.create` (the only creator) always passes both
 * sets; no `token_separators` and no `symbols_to_index`, so Typesense drops special characters (`AT&T` gives `att`, `SM-A525F`
 * gives `sma525f`), which is what the owner's examples need.
 *
 * @param name the collection name (`<prefix>services_v<N>_<stamp>`)
 * @param sets the environment's synonym and curation set names
 * @returns the schema for `POST /collections`
 */
export function servicesSchema(name: string, sets: { synonyms: string; curations: string }): CollectionSchema {
  return {
    name,
    fields: SERVICE_FIELDS,
    default_sorting_field: 'popularity',
    synonym_sets: [sets.synonyms],
    curation_sets: [sets.curations],
  };
}

/** The two collections of the search. */
export type SearchCollectionKind = 'services' | 'terms';

/** A collection name of this environment, taken apart. */
export interface ParsedCollection {
  readonly kind: SearchCollectionKind;
  readonly version: number;
  /** `yyyymmddhhmmss` (UTC). */
  readonly stamp: string;
}

/**
 * The UTC stamp of a collection name.
 *
 * @param at the moment
 * @returns `yyyymmddhhmmss`
 */
export function collectionStamp(at: Date): string {
  return at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * Every Typesense name of one environment.
 *
 * Why: plan section 3.3: collections `<prefix><kind>_v<N>_<yyyymmddhhmmss>`, aliases `<prefix><kind>_v<N>` (every read and every
 * incremental write goes through the alias), the synonym set `<prefix>synonyms` and the curation set `<prefix>curations`. The parser
 * matches the whole name, so a longer prefix of another test run (`gsm_29_test_ab12_`) is never taken for this one's.
 */
export class SearchNames {
  constructor(readonly prefix: string) {}

  /**
   * The running schema version of a kind.
   *
   * @param kind services or terms
   * @returns the services or the terms schema version
   */
  version(kind: SearchCollectionKind): number {
    return kind === 'services' ? SERVICES_SCHEMA_VERSION : TERMS_SCHEMA_VERSION;
  }

  /**
   * The alias of a kind.
   *
   * @param kind services or terms
   * @param version the schema version (default: the running one)
   * @returns `<prefix><kind>_v<N>`
   */
  alias(kind: SearchCollectionKind, version = this.version(kind)): string {
    return `${this.prefix}${kind}_v${version}`;
  }

  /**
   * A new collection name of a kind at the running version.
   *
   * @param kind services or terms
   * @param at the moment the collection is made (its UTC stamp)
   * @returns `<prefix><kind>_v<N>_<yyyymmddhhmmss>`
   */
  collection(kind: SearchCollectionKind, at: Date): string {
    return `${this.prefix}${kind}_v${this.version(kind)}_${collectionStamp(at)}`;
  }

  /** The synonym set of the environment. */
  get synonymSet(): string {
    return `${this.prefix}synonyms`;
  }

  /** The curation set of the environment. */
  get curationSet(): string {
    return `${this.prefix}curations`;
  }

  /**
   * Takes a collection name apart.
   *
   * @param name any collection name
   * @returns the kind, version and stamp, or `null` for a name that is not one of this environment's collections
   */
  parse(name: string): ParsedCollection | null {
    if (!name.startsWith(this.prefix)) return null;
    const match = /^(services|terms)_v(\d{1,6})_(\d{14})$/.exec(name.slice(this.prefix.length));
    if (!match) return null;
    return { kind: match[1] as SearchCollectionKind, version: Number(match[2]), stamp: match[3]! };
  }

  /**
   * Takes an alias name apart.
   *
   * @param name any alias name
   * @returns the kind and version, or `null` for a name that is not one of this environment's aliases
   */
  parseAlias(name: string): { kind: SearchCollectionKind; version: number } | null {
    if (!name.startsWith(this.prefix)) return null;
    const match = /^(services|terms)_v(\d{1,6})$/.exec(name.slice(this.prefix.length));
    return match ? { kind: match[1] as SearchCollectionKind, version: Number(match[2]) } : null;
  }
}
