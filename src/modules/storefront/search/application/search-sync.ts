// SearchSync: the `search_sync` job of the `search-index` queue (feature 29, plan section 4.5): rebuilds the documents of some
// services from Postgres and writes them through the services alias, deletes first. The only writer of documents through the alias.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { DbService } from '../../../../infra/db';
import { UnrecoverableError } from '../../../../infra/queues';
import {
  type ImportFailure,
  SearchMetrics,
  SearchNotReady,
  SearchRejected,
  SearchUnavailable,
  TypesenseClient,
} from '../../../../infra/search';
import { StorefrontServices } from '../../../catalog';
import { writeIndexState } from '../infra/search-tables.repository';
import { SearchCollections } from './search-collections';
import { SearchDocuments } from './search-documents';

/** Ids per build and per import batch (plan section 4.5). */
export const SYNC_BATCH = 500;
/** What `last_error` says when the worker's key is refused (plan section 3.4; an alert rule watches the metric). */
export const KEYS_MISSING = 'search keys missing';

/** What one sync is about: some services, or every service of a category. */
export interface SyncInput {
  readonly serviceIds?: readonly number[];
  readonly categoryId?: number;
}

/** What one sync did. */
export interface SyncResult {
  /** `synced`; `disabled` (SEARCH_ENABLED=false, no call); `not_ready` (no alias: the rebuild covers the change). */
  readonly outcome: 'synced' | 'disabled' | 'not_ready';
  readonly upserted: number;
  readonly deleted: number;
  readonly rejected: number;
}

/**
 * Applies a change to the search index.
 *
 * Why: decision 038 ("one writer"): the documents of the services an event names are rebuilt from Postgres and written whole, so the
 * job is idempotent and a late or repeated run writes what Postgres says now. Ids that fail the searchable rule (unlisted, Arabic only,
 * unpriced, hidden category, archived) are deleted first, then the rest is upserted in batches of 500. A refused line never stops the
 * others (its id and error go to `last_error`); the engine being unavailable throws (the queue retries for about an hour); a missing
 * alias completes without writes (the rebuild and its reconcile cover the change); a refusal of the whole request is unrecoverable.
 *
 * Side effects: Typesense deletes and imports through `<prefix>services_v<N>`; `search_index_state.last_sync_at` and `last_error`;
 * the metrics `search_sync_documents_total{op}`, `search_sync_failures_total`, `search_sync_rejected_total`, `search_auth_failures_total`
 * and `search_sync_lag_seconds`.
 */
@Injectable()
export class SearchSync {
  private readonly logger = new Logger(SearchSync.name);

  constructor(
    private readonly db: DbService,
    private readonly documents: SearchDocuments,
    private readonly services: StorefrontServices,
    private readonly client: TypesenseClient,
    private readonly collections: SearchCollections,
    private readonly metrics: SearchMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs one sync.
   *
   * @param input the services, or the category, to bring up to date
   * @param enqueuedAtMs when the change was handed to the queue (for the lag metric)
   * @returns what was written
   * @throws {SearchUnavailable} the engine is down, slow, refuses the key or lacks resources (retried)
   * @throws {UnrecoverableError} the engine refused a whole request (a programming error; `last_error` says which)
   */
  async run(input: SyncInput, enqueuedAtMs?: number): Promise<SyncResult> {
    if (!this.config.search.enabled) return { outcome: 'disabled', upserted: 0, deleted: 0, rejected: 0 };
    const alias = this.collections.names.alias('services');
    let upserted = 0;
    let deleted = 0;
    const failures: ImportFailure[] = [];
    try {
      const retailGroupId = await this.documents.retailGroupIdOf(this.db.db);
      for await (const ids of this.batches(input)) {
        const build = await this.documents.build(this.db.db, ids, retailGroupId);
        if (build.deleteIds.length > 0) deleted += await this.client.deleteByIds(alias, build.deleteIds);
        const docs = build.documents.map((entry) => entry.document);
        for (let start = 0; start < docs.length; start += SYNC_BATCH) {
          const outcome = await this.client.importJsonl(alias, docs.slice(start, start + SYNC_BATCH), 'upsert');
          upserted += outcome.imported;
          failures.push(...outcome.failed);
        }
      }
    } catch (error) {
      if (error instanceof SearchNotReady) {
        this.logger.debug(
          'The services alias does not exist yet: the sync wrote nothing (the rebuild covers the change).',
        );
        return { outcome: 'not_ready', upserted, deleted, rejected: failures.length };
      }
      this.metrics.syncFailures.inc();
      if (error instanceof SearchUnavailable && error.kind === 'auth') {
        this.metrics.authFailures.inc();
        await this.recordError(KEYS_MISSING);
      }
      if (error instanceof SearchRejected) {
        await this.recordError(error.message);
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
    this.metrics.syncDocuments.inc({ op: 'upsert' }, upserted);
    this.metrics.syncDocuments.inc({ op: 'delete' }, deleted);
    if (failures.length > 0) this.metrics.syncRejected.inc(failures.length);
    const now = this.clock.now();
    await writeIndexState(
      this.db.db,
      {
        lastSyncAt: now,
        ...(failures.length > 0 ? { lastError: describeFailures(failures) } : {}),
      },
      now,
    );
    if (enqueuedAtMs !== undefined) this.metrics.syncLag.observe(Math.max(0, now.getTime() - enqueuedAtMs) / 1000);
    return { outcome: 'synced', upserted, deleted, rejected: failures.length };
  }

  /** The ids of the input, 500 at a time (a category's services read page by page). */
  private async *batches(input: SyncInput): AsyncGenerator<number[]> {
    const ids = [...new Set(input.serviceIds ?? [])];
    for (let start = 0; start < ids.length; start += SYNC_BATCH) yield ids.slice(start, start + SYNC_BATCH);
    if (input.categoryId === undefined) return;
    let afterId = 0;
    for (;;) {
      const page = await this.services.serviceIdsOfCategory(this.db.db, input.categoryId, afterId, SYNC_BATCH);
      if (page.length === 0) return;
      yield page;
      if (page.length < SYNC_BATCH) return;
      afterId = page[page.length - 1]!;
    }
  }

  private async recordError(message: string): Promise<void> {
    const now = this.clock.now();
    await writeIndexState(this.db.db, { lastError: message.slice(0, 1000) }, now).catch(() => undefined);
  }
}

/**
 * The `last_error` text of refused document lines: the first three ids with their errors.
 *
 * @param failures the refused lines
 * @returns at most 1000 characters
 */
export function describeFailures(failures: readonly ImportFailure[]): string {
  const shown = failures
    .slice(0, 3)
    .map((failure) => `document ${failure.id}: ${failure.error}`)
    .join('; ');
  const more = failures.length > 3 ? ` (and ${failures.length - 3} more)` : '';
  return `${shown}${more}`.slice(0, 1000);
}
