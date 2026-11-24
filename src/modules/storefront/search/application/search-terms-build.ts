// SearchTermsBuild: the `search_terms_build` job (feature 29, plan section 4.4-4.5): builds the terms collection (phrase completion) in
// full from the indexed catalog, the enabled synonyms and the popular queries, and swaps its alias. The only writer of terms collections.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { DbService } from '../../../../infra/db';
import { UnrecoverableError } from '../../../../infra/queues';
import { type ImportFailure, SearchMetrics, SearchUnavailable, TypesenseClient } from '../../../../infra/search';
import { countryName } from '../domain/countries';
import { type TermQuery, type TermService, buildTerms, dayOf, isPopularQuery } from '../domain/terms';
import { type VocabularySource, buildVocabulary } from '../domain/vocabulary';
import { enabledSynonyms, popularCandidates, writeIndexState } from '../infra/search-tables.repository';
import { SearchCollections } from './search-collections';
import { SearchDocuments } from './search-documents';
import { SearchLocks } from './search-locks';
import { KEYS_MISSING, SYNC_BATCH, describeFailures } from './search-sync';

/** The window of the popular queries, in days (plan section 4.4). */
export const POPULAR_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** What one terms build did. */
export interface TermsBuildReport {
  /** `built`; `skipped` (the lock is held); `disabled`. */
  readonly outcome: 'built' | 'skipped' | 'disabled';
  readonly collection: string | null;
  readonly terms: number;
  /** Popular queries that made it into the collection. */
  readonly queries: number;
}

/**
 * Builds the terms collection.
 *
 * Why: plan section 4.4: completions come from a collection of one document per normalised phrase (title phrases, facet values,
 * synonym phrases, popular queries), built in full each time from Postgres and swapped in through `<prefix>terms_v<N>`, so a delisted
 * service or a query that is no longer popular leaves the completions at the next build. Popular queries are counted visitors (never searches) and must
 * use only words of the index vocabulary.
 *
 * Side effects: holds `gsm:{env}:storefront:search-terms:lock`; Typesense: drops terms orphans, creates and fills a terms collection,
 * swaps the alias, drops the old terms collections; `search_index_state.terms_collection` and `last_terms_build_at`.
 */
@Injectable()
export class SearchTermsBuild {
  private readonly logger = new Logger(SearchTermsBuild.name);

  constructor(
    private readonly db: DbService,
    private readonly documents: SearchDocuments,
    private readonly collections: SearchCollections,
    private readonly client: TypesenseClient,
    private readonly locks: SearchLocks,
    private readonly metrics: SearchMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs one terms build.
   *
   * @returns what it built
   * @throws {SearchUnavailable} | {SearchRejected} when the engine fails (retried; the old alias stays)
   * @throws {UnrecoverableError} when the new collection does not hold exactly the built terms (dropped)
   */
  async run(): Promise<TermsBuildReport> {
    if (!this.config.search.enabled) return { outcome: 'disabled', collection: null, terms: 0, queries: 0 };
    const lock = await this.locks.acquire('terms');
    if (!lock) return { outcome: 'skipped', collection: null, terms: 0, queries: 0 };
    try {
      return await this.build();
    } catch (error) {
      if (error instanceof SearchUnavailable && error.kind === 'auth') {
        this.metrics.authFailures.inc();
        await writeIndexState(this.db.db, { lastError: KEYS_MISSING }, this.clock.now()).catch(() => undefined);
      }
      throw error;
    } finally {
      await lock.release();
    }
  }

  private async build(): Promise<TermsBuildReport> {
    const db = this.db.db;
    const services: TermService[] = [];
    const vocabulary: VocabularySource[] = [];
    for await (const page of this.documents.all(db)) {
      for (const { document, source } of page) {
        const country = source.country === '' ? '' : (countryName(source.country) ?? '');
        services.push({
          title: source.title,
          popularity: source.sales30d,
          brand: source.brand,
          carrier: source.carrier,
          networks: source.networks,
          categoryName: source.categoryName,
          countryName: country,
        });
        vocabulary.push({
          title: source.title,
          brand: source.brand,
          carrier: source.carrier,
          networks: source.networks,
          categoryName: source.categoryName,
          countryNames: document.country_names ?? [],
          codes: document.codes ?? [],
        });
      }
    }
    const synonyms = await enabledSynonyms(db);
    const words = buildVocabulary(
      vocabulary,
      synonyms.flatMap((row) => [...row.terms, ...(row.root ? [row.root] : [])]),
    );
    const since = dayOf(new Date(this.clock.nowMs() - (POPULAR_WINDOW_DAYS - 1) * DAY_MS));
    const queries: TermQuery[] = (await popularCandidates(db, since))
      .filter((candidate) => isPopularQuery(candidate, words))
      .map((candidate) => ({ term: candidate.term, visitors: candidate.visitors }));
    const terms = buildTerms({
      services,
      synonyms: synonyms.map((row) => ({ terms: row.terms, root: row.root })),
      queries,
    });

    await this.collections.dropOrphans('terms');
    const collection = await this.collections.create('terms');
    try {
      const failed: ImportFailure[] = [];
      for (let start = 0; start < terms.length; start += SYNC_BATCH) {
        const outcome = await this.client.importJsonl(collection, terms.slice(start, start + SYNC_BATCH), 'upsert');
        failed.push(...outcome.failed);
      }
      const count = await this.collections.count(collection);
      if (failed.length > 0 || count !== terms.length) {
        const reason =
          failed.length > 0
            ? `terms build refused ${failed.length} terms: ${describeFailures(failed)}`
            : `terms build built ${terms.length} terms but the new collection holds ${String(count)}`;
        await writeIndexState(db, { lastError: reason.slice(0, 1000) }, this.clock.now());
        throw new UnrecoverableError(reason);
      }
    } catch (error) {
      await this.collections.drop(collection).catch(() => undefined);
      throw error;
    }
    await this.collections.swap('terms', collection);
    await this.collections.dropAfterSwap('terms', collection);
    const now = this.clock.now();
    await writeIndexState(db, { termsCollection: collection, lastTermsBuildAt: now }, now);
    this.logger.log(
      `Search terms rebuilt into ${collection}: ${terms.length} terms, ${queries.length} popular queries.`,
    );
    return { outcome: 'built', collection, terms: terms.length, queries: queries.length };
  }
}
