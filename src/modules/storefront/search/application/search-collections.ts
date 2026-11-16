// SearchCollections: the collections and aliases of the storefront search (feature 29, plan section 3.3): the only code that creates a
// collection (a services collection always links the environment's synonym and curation sets), swaps an alias, and drops old ones.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { TypesenseClient } from '../../../../infra/search';
import { type SearchCollectionKind, SearchNames, servicesSchema } from '../domain/services-schema';
import { termsSchema } from '../domain/terms';

/** How many later seconds a new collection name may move to when the first stamp is taken (two builds in one second). */
const NAME_TRIES = 30;

/**
 * Manages the collections and aliases of one environment.
 *
 * Why: plan section 3.3 and 4.5: every read and every incremental write goes through an alias, so a rebuild fills a new collection
 * and swaps the alias in one call (no failed search during it); the synonym and curation sets are linked at creation, which is why
 * this class is the only creator (a test asserts the alias target carries the links). Names are matched whole
 * (`SearchNames.parse`), so a longer prefix of another environment or test run is never touched.
 *
 * Side effects: Typesense calls (create and drop collections, put and delete aliases) with the worker's key.
 */
@Injectable()
export class SearchCollections {
  /** The names of this environment. */
  readonly names: SearchNames;

  constructor(
    private readonly client: TypesenseClient,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.names = new SearchNames(config.search.prefix);
  }

  /**
   * Finds the collection the running version's alias points at.
   *
   * @param kind services or terms
   * @returns the collection, or `null` when the alias does not exist (not ready)
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async aliasTarget(kind: SearchCollectionKind): Promise<string | null> {
    return (await this.client.getAlias(this.names.alias(kind)))?.collection_name ?? null;
  }

  /**
   * Creates a new collection of the running version.
   *
   * @param kind services (linked to `<prefix>synonyms` and `<prefix>curations`) or terms
   * @returns the new collection's name (`<prefix><kind>_v<N>_<yyyymmddhhmmss>`; a later second when that one is taken)
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async create(kind: SearchCollectionKind): Promise<string> {
    const taken = new Set((await this.client.listCollections(this.names.prefix)).map((entry) => entry.name));
    const now = this.clock.nowMs();
    let name = this.names.collection(kind, new Date(now));
    for (let step = 1; taken.has(name) && step < NAME_TRIES; step += 1) {
      name = this.names.collection(kind, new Date(now + step * 1000));
    }
    const schema =
      kind === 'services'
        ? servicesSchema(name, { synonyms: this.names.synonymSet, curations: this.names.curationSet })
        : termsSchema(name);
    await this.client.createCollection(schema);
    return name;
  }

  /**
   * Points the running version's alias at a collection.
   *
   * @param kind services or terms
   * @param collection the new target
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async swap(kind: SearchCollectionKind, collection: string): Promise<void> {
    await this.client.putAlias(this.names.alias(kind), collection);
  }

  /**
   * Drops the collections of a kind that no alias points at.
   *
   * Why: plan section 4.5: a rebuild first drops the orphans of a stalled run, so the node never holds three collections of a kind
   * (memory: a rebuild already doubles the services part). Only the kind being rebuilt: the other kind's build may hold an unswapped
   * collection under its own lock right now.
   *
   * @param kind services or terms
   * @returns the dropped names
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async dropOrphans(kind: SearchCollectionKind): Promise<string[]> {
    const targets = new Set((await this.client.listAliases(this.names.prefix)).map((alias) => alias.collection_name));
    const dropped: string[] = [];
    for (const collection of await this.client.listCollections(this.names.prefix)) {
      const parsed = this.names.parse(collection.name);
      if (parsed?.kind !== kind || targets.has(collection.name)) continue;
      await this.client.dropCollection(collection.name);
      dropped.push(collection.name);
    }
    return dropped;
  }

  /**
   * After a swap: drops the older collections of the running version and every collection and alias of older versions of the kind.
   *
   * @param kind services or terms
   * @param keep the collection the alias points at now
   * @returns the dropped collection and alias names
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async dropAfterSwap(kind: SearchCollectionKind, keep: string): Promise<string[]> {
    const version = this.names.version(kind);
    const dropped: string[] = [];
    for (const alias of await this.client.listAliases(this.names.prefix)) {
      const parsed = this.names.parseAlias(alias.name);
      if (parsed?.kind !== kind || parsed.version === version) continue;
      await this.client.deleteAlias(alias.name);
      dropped.push(alias.name);
    }
    for (const collection of await this.client.listCollections(this.names.prefix)) {
      const parsed = this.names.parse(collection.name);
      if (parsed?.kind !== kind || collection.name === keep) continue;
      await this.client.dropCollection(collection.name);
      dropped.push(collection.name);
    }
    return dropped;
  }

  /**
   * Drops one collection (a failed build's).
   *
   * @param name the collection
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async drop(name: string): Promise<void> {
    await this.client.dropCollection(name);
  }

  /**
   * Counts the documents of a collection.
   *
   * @param name the collection
   * @returns the count, or `null` when it does not exist
   * @throws {SearchUnavailable} | {SearchRejected}
   */
  async count(name: string): Promise<number | null> {
    return (await this.client.getCollection(name))?.num_documents ?? null;
  }
}
