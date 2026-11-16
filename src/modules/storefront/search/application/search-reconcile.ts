// SearchReconcile: the `search_reconcile` job (feature 29, plan section 4.5): compares the index with Postgres by document hash and turns
// every difference into `search_sync` jobs; it never writes a document. Also records the engine's version, memory and count.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { DbService } from '../../../../infra/db';
import { QueuesService, queueJobId } from '../../../../infra/queues';
import { SearchMetrics, SearchUnavailable, TypesenseClient } from '../../../../infra/search';
import { collectionStamp } from '../domain/services-schema';
import { writeIndexState } from '../infra/search-tables.repository';
import { SearchCollections } from './search-collections';
import { SearchDocuments } from './search-documents';
import { SearchLocks } from './search-locks';
import { SEARCH_JOBS } from './search-signals';
import { KEYS_MISSING, SYNC_BATCH } from './search-sync';

/** What one reconcile found. */
export interface ReconcileReport {
  /** `reconciled`; `rebuild_requested` (no alias); `skipped` (the lock is held); `disabled`. */
  readonly outcome: 'reconciled' | 'rebuild_requested' | 'skipped' | 'disabled';
  /** Documents in the index. */
  readonly indexed: number;
  /** Documents Postgres expects. */
  readonly expected: number;
  readonly changed: number;
  readonly missing: number;
  readonly extra: number;
  /** `search_sync` jobs enqueued. */
  readonly jobs: number;
}

const EMPTY = { indexed: 0, expected: 0, changed: 0, missing: 0, extra: 0, jobs: 0 };

/**
 * Compares the index with Postgres.
 *
 * Why: plan section 4.5: anything a writer missed (the popularity job, a supplier import, an engine outage longer than the retries) is
 * repaired within one reconcile period; the reconcile only compares and enqueues `search_sync` (the one writer). When the alias of the
 * running schema version is missing (a new deploy, a wiped volume) it asks for a rebuild instead (one per hour at most).
 *
 * Side effects: holds `gsm:{env}:storefront:search-index:lock`; exports `id,hash` from the alias; enqueues `search_sync` jobs (job ids
 * `reconcile-<run id>-<n>`) or one `search_rebuild` (job id `rebuild-auto-v<N>-<yyyymmddhh>`); writes `search_index_state` (`documents`,
 * `memory_bytes`, `engine_version`, `last_reconcile_at`) and the gauges `search_index_documents`,
 * `search_index_last_reconcile_timestamp_seconds` and `typesense_memory_allocated_bytes`.
 */
@Injectable()
export class SearchReconcile {
  private readonly logger = new Logger(SearchReconcile.name);

  constructor(
    private readonly db: DbService,
    private readonly documents: SearchDocuments,
    private readonly collections: SearchCollections,
    private readonly client: TypesenseClient,
    private readonly locks: SearchLocks,
    private readonly queues: QueuesService,
    private readonly metrics: SearchMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs one reconcile.
   *
   * @param runId the `job_runs` row of the run (the sync jobs' ids)
   * @returns what it found and enqueued
   * @throws {SearchUnavailable} | {SearchRejected} when the engine cannot be read (retried by the queue)
   */
  async run(runId: number): Promise<ReconcileReport> {
    if (!this.config.search.enabled) return { outcome: 'disabled', ...EMPTY };
    const lock = await this.locks.acquire('index');
    if (!lock) return { outcome: 'skipped', ...EMPTY };
    try {
      return await this.reconcile(runId);
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

  private async reconcile(runId: number): Promise<ReconcileReport> {
    const names = this.collections.names;
    if ((await this.collections.aliasTarget('services')) === null) {
      const hour = collectionStamp(this.clock.now()).slice(0, 10);
      await this.queues.add(
        'maintenance',
        SEARCH_JOBS.rebuild,
        { reason: 'not_ready' },
        {
          jobId: queueJobId('rebuild-auto', `v${names.version('services')}`, hour),
        },
      );
      return { outcome: 'rebuild_requested', ...EMPTY };
    }
    const alias = names.alias('services');
    const indexed = new Map<string, string>();
    for (const row of await this.client.exportFields(alias, ['id', 'hash'])) {
      if (typeof row.id === 'string') indexed.set(row.id, typeof row.hash === 'string' ? row.hash : '');
    }
    const changed: number[] = [];
    const missing: number[] = [];
    const expected = new Set<string>();
    for await (const page of this.documents.all(this.db.db)) {
      for (const { document } of page) {
        expected.add(document.id);
        const hash = indexed.get(document.id);
        if (hash === undefined) missing.push(Number(document.id));
        else if (hash !== document.hash) changed.push(Number(document.id));
      }
    }
    const extra = [...indexed.keys()].filter((id) => !expected.has(id) && /^\d+$/.test(id)).map(Number);
    const ids = [...changed, ...missing, ...extra].sort((a, b) => a - b);
    const jobs: Array<{ jobName: string; data: object; options: { jobId: string } }> = [];
    for (let start = 0, n = 1; start < ids.length; start += SYNC_BATCH, n += 1) {
      jobs.push({
        jobName: SEARCH_JOBS.sync,
        data: { serviceIds: ids.slice(start, start + SYNC_BATCH) },
        options: { jobId: queueJobId('reconcile', runId, n) },
      });
    }
    if (jobs.length > 0) await this.queues.addBulk('search-index', jobs);

    const [memory, version] = await Promise.all([
      this.client.metrics().catch(() => null),
      this.client.version().catch(() => null),
    ]);
    const now = this.clock.now();
    await writeIndexState(
      this.db.db,
      {
        documents: indexed.size,
        lastReconcileAt: now,
        ...(memory?.memoryAllocatedBytes == null ? {} : { memoryBytes: memory.memoryAllocatedBytes }),
        ...(version === null ? {} : { engineVersion: version }),
      },
      now,
    );
    this.metrics.indexDocuments.set(indexed.size);
    this.metrics.lastReconcile.set(Math.floor(now.getTime() / 1000));
    if (memory?.memoryAllocatedBytes != null) this.metrics.engineMemory.set(memory.memoryAllocatedBytes);
    if (ids.length > 0) {
      this.logger.log(
        `Search reconcile ${runId}: ${changed.length} changed, ${missing.length} missing, ${extra.length} extra documents queued for sync.`,
      );
    }
    return {
      outcome: 'reconciled',
      indexed: indexed.size,
      expected: expected.size,
      changed: changed.length,
      missing: missing.length,
      extra: extra.length,
      jobs: jobs.length,
    };
  }
}
