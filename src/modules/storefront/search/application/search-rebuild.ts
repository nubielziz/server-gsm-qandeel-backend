// SearchRebuild: the `search_rebuild` job (feature 29, plan section 4.5): builds a new services collection from Postgres, checks it,
// swaps the alias with no downtime and drops the old collections. It writes only its own new collection.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { DbService } from '../../../../infra/db';
import { QueuesService, UnrecoverableError, queueJobId } from '../../../../infra/queues';
import { type ImportFailure, SearchMetrics, SearchUnavailable, TypesenseClient } from '../../../../infra/search';
import { writeIndexState } from '../infra/search-tables.repository';
import { SearchCollections } from './search-collections';
import { SearchDocuments } from './search-documents';
import { SearchLocks } from './search-locks';
import { SEARCH_JOBS } from './search-signals';
import { SearchSynonymPush } from './search-synonym-push';
import { KEYS_MISSING, SYNC_BATCH, describeFailures } from './search-sync';

/** What one rebuild did. */
export interface RebuildReport {
  /** `rebuilt`; `skipped` (the lock is held); `disabled`. */
  readonly outcome: 'rebuilt' | 'skipped' | 'disabled';
  /** The new collection the alias points at. */
  readonly collection: string | null;
  readonly documents: number;
  /** Collections, aliases and sets dropped (orphans first, then the old ones and the retired curation set after the swap). */
  readonly dropped: number;
}

/**
 * Rebuilds the services index.
 *
 * Why: decision 038: a lost, stale or old-version index is harmless because a nightly (and on-demand) rebuild makes it whole from
 * Postgres. Order (plan section 4.5): push the synonym set (the new collection links it), drop the orphans of a stalled run (never three
 * collections), create the collection (`SearchCollections.create`, the only creator), import every document into **that collection
 * only**, check that it holds exactly the built count with no refused line (else drop it, keep the old alias, record the error), swap
 * the alias, drop the older collections and every collection and alias of older versions, delete the curation set of schema version 1
 * (decision 068: once its collections are gone nothing links it; absent is fine), release the lock, then queue the terms build and a
 * reconcile, which turns the changes made during the build into `search_sync` jobs. A worker that boots with a new schema version gets
 * here by itself: its boot reconcile finds no alias of the running version and queues this job.
 *
 * Side effects: holds `gsm:{env}:storefront:search-index:lock`; Typesense synonym set push, collection create, imports, alias swap,
 * drops, `DELETE /curation_sets/<prefix>curations`;
 * `search_index_state` (`schema_version`, `services_collection`, `documents`, `last_rebuild_at`, `last_error`); the gauge
 * `search_index_last_rebuild_timestamp_seconds`; enqueues `search_terms_build` and `search_reconcile` (job ids
 * `after-rebuild-<run id>-terms` and `-reconcile`).
 */
@Injectable()
export class SearchRebuild {
  private readonly logger = new Logger(SearchRebuild.name);

  constructor(
    private readonly db: DbService,
    private readonly documents: SearchDocuments,
    private readonly collections: SearchCollections,
    private readonly client: TypesenseClient,
    private readonly synonyms: SearchSynonymPush,
    private readonly locks: SearchLocks,
    private readonly queues: QueuesService,
    private readonly metrics: SearchMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs one rebuild.
   *
   * @param runId the `job_runs` row of the run (the follow-up jobs' ids)
   * @returns what it built
   * @throws {SearchUnavailable} | {SearchRejected} when the engine fails on the way (retried; the old alias stays)
   * @throws {UnrecoverableError} when the new collection does not hold exactly the built documents (dropped; `last_error` says why)
   */
  async run(runId: number): Promise<RebuildReport> {
    if (!this.config.search.enabled) return { outcome: 'disabled', collection: null, documents: 0, dropped: 0 };
    const lock = await this.locks.acquire('index');
    if (!lock) return { outcome: 'skipped', collection: null, documents: 0, dropped: 0 };
    let report: RebuildReport;
    try {
      report = await this.rebuild();
    } catch (error) {
      if (error instanceof SearchUnavailable && error.kind === 'auth') {
        this.metrics.authFailures.inc();
        await writeIndexState(this.db.db, { lastError: KEYS_MISSING }, this.clock.now()).catch(() => undefined);
      }
      throw error;
    } finally {
      await lock.release();
    }
    await this.queues.addBulk('maintenance', [
      {
        jobName: SEARCH_JOBS.termsBuild,
        data: { reason: 'after_rebuild' },
        options: { jobId: queueJobId('after-rebuild', runId, 'terms') },
      },
      {
        jobName: SEARCH_JOBS.reconcile,
        data: { reason: 'after_rebuild' },
        options: { jobId: queueJobId('after-rebuild', runId, 'reconcile') },
      },
    ]);
    return report;
  }

  private async rebuild(): Promise<RebuildReport> {
    await this.synonyms.push();
    const orphans = await this.collections.dropOrphans('services');
    const collection = await this.collections.create('services');
    let built = 0;
    const failures: ImportFailure[] = [];
    try {
      for await (const page of this.documents.all(this.db.db)) {
        const docs = page.map((entry) => entry.document);
        built += docs.length;
        for (let start = 0; start < docs.length; start += SYNC_BATCH) {
          const outcome = await this.client.importJsonl(collection, docs.slice(start, start + SYNC_BATCH), 'upsert');
          failures.push(...outcome.failed);
        }
      }
      const count = await this.collections.count(collection);
      if (failures.length > 0 || count !== built) {
        const reason =
          failures.length > 0
            ? `rebuild refused ${failures.length} documents: ${describeFailures(failures)}`
            : `rebuild built ${built} documents but the new collection holds ${String(count)}`;
        if (failures.length > 0) this.metrics.syncRejected.inc(failures.length);
        await writeIndexState(this.db.db, { lastError: reason.slice(0, 1000) }, this.clock.now());
        throw new UnrecoverableError(reason);
      }
    } catch (error) {
      // The half-built collection must not stay: the next rebuild would find it as an orphan anyway, but memory counts now.
      await this.collections.drop(collection).catch(() => undefined);
      throw error;
    }
    await this.collections.swap('services', collection);
    const dropped = await this.collections.dropAfterSwap('services', collection);
    // After the old collections: a set that a collection still links must not go first (decision 068). The alias is already swapped, so a
    // failure here must not fail the rebuild (the state would not be written and the follow-up jobs not queued): the next rebuild tries again.
    try {
      if (await this.collections.dropRetiredCurationSet()) dropped.push(this.collections.names.retiredCurationSet);
    } catch (error) {
      this.logger.warn(
        `The retired curation set was not deleted (${error instanceof Error ? error.message : String(error)}); the next rebuild tries again.`,
      );
    }
    const now = this.clock.now();
    await writeIndexState(
      this.db.db,
      {
        schemaVersion: this.collections.names.version('services'),
        servicesCollection: collection,
        documents: built,
        lastRebuildAt: now,
        lastError: null,
      },
      now,
    );
    this.metrics.lastRebuild.set(Math.floor(now.getTime() / 1000));
    this.metrics.indexDocuments.set(built);
    this.logger.log(`Search index rebuilt into ${collection}: ${built} documents.`);
    return { outcome: 'rebuilt', collection, documents: built, dropped: orphans.length + dropped.length };
  }
}
