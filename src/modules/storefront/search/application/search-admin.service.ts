// SearchAdminService: the use cases of the console's search index tools (feature 29, plan sections 5.1 and 6): the index status and
// "Rebuild index". The rebuild request is one transaction: the audit row and the outbox event the worker's rebuild follows; nothing talks
// to the engine inside it. Decision 068 retired the synonym, pin, hidden-term and preview use cases.
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../../common/errors';
import { DbService } from '../../../../infra/db';
import { QueuesService } from '../../../../infra/queues';
import { TypesenseClient } from '../../../../infra/search';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { StorefrontServices } from '../../../catalog';
import { JobRunsService } from '../../../health';
import { AuditService } from '../../../platform';
import { listedServiceIds } from '../../infra/listing.repository';
import { SERVICES_SCHEMA_VERSION } from '../domain/services-schema';
import { readIndexState } from '../infra/search-tables.repository';
import { SearchCollections } from './search-collections';
import { SearchSignals } from './search-signals';
import { SearchableIds } from './searchable-ids';

/** The most services the index status counts (a page of ids at a time). */
const EXPECTED_PAGES = 20;
const EXPECTED_PAGE_SIZE = 1000;
const REBUILD_JOB = 'search_rebuild';

/**
 * Reports the index state and takes the console's rebuild request.
 *
 * Why: staff watch the index the shop search answers from and start a rebuild when they need one (owner question 5; decision 068 keeps
 * only this panel of the Search tab). The rebuild request is audited (`search_index`) and writes its event in its own transaction.
 *
 * Side effects: a rebuild request inserts a `job_runs` row (`search_rebuild`, manual), an `audit_logs` row and an `outbox_events` row;
 * the status reads the index state, the engine's health and the queue counts.
 *
 * @see docs/contract/endpoints/storefront.md (the `/admin/search` sections)
 */
@Injectable()
export class SearchAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly signals: SearchSignals,
    private readonly runs: JobRunsService,
    private readonly client: TypesenseClient,
    private readonly collections: SearchCollections,
    private readonly searchable: SearchableIds,
    private readonly services: StorefrontServices,
    private readonly queues: QueuesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Reads the index status.
   *
   * @returns the engine state, the counts the worker last wrote, the jobs and the last error
   */
  async indexStatus(): Promise<IndexStatusView> {
    const db = this.db.db;
    const [state, running, expected, jobs, status] = await Promise.all([
      readIndexState(db),
      this.runs.findRunning(REBUILD_JOB),
      this.expectedDocuments(),
      this.jobCounts(),
      this.engineStatus(),
    ]);
    return {
      engine: { status, version: state?.engineVersion ?? null, memoryBytes: state?.memoryBytes ?? null },
      schemaVersion: SERVICES_SCHEMA_VERSION,
      collection: state?.servicesCollection ?? null,
      documents: state?.documents ?? 0,
      expectedDocuments: expected,
      lastSyncAt: state?.lastSyncAt?.toISOString() ?? null,
      lastReconcileAt: state?.lastReconcileAt?.toISOString() ?? null,
      lastRebuildAt: state?.lastRebuildAt?.toISOString() ?? null,
      lastTermsBuildAt: state?.lastTermsBuildAt?.toISOString() ?? null,
      queued: jobs.queued,
      failed: jobs.failed,
      rebuild: { running: running !== undefined, startedAt: running?.startedAt.toISOString() ?? null },
      lastError: state?.lastError ?? null,
    };
  }

  /**
   * Asks for a rebuild of the index.
   *
   * Why: the route records the run first (`job_runs`, manual, one at a time), then writes the request event and the audit row in one
   * transaction; the worker's `search_rebuild` records its work on that run. The route never waits for the engine.
   *
   * @param staffId the staff member
   * @returns the running run
   * @throws {AppError} `JOB_ALREADY_RUNNING` (409); `UNAVAILABLE` (503) when search is switched off
   */
  async requestRebuild(staffId: number): Promise<{ running: boolean; startedAt: string }> {
    if (!this.config.search.enabled) {
      throw new AppError('UNAVAILABLE', {
        detail: 'Search is switched off (SEARCH_ENABLED=false): there is no index to rebuild.',
      });
    }
    const run = await this.runs.start({ job: REBUILD_JOB, trigger: 'manual', triggeredBy: staffId, overlap: 'refuse' });
    try {
      await this.db.runInTransaction(async ({ tx }) => {
        await this.signals.rebuildRequested(tx, staffId, run.id);
        await this.audit.record(tx, {
          action: 'asked for a rebuild of the search index',
          entityType: 'search_index',
          entityId: 1,
          entityLabel: 'Search index',
          after: { runId: run.id },
        });
      });
    } catch (error) {
      await this.runs.finish(run.id, { status: 'failed', error: 'The rebuild could not be requested.' });
      throw error;
    }
    return { running: true, startedAt: run.startedAt.toISOString() };
  }

  private async engineStatus(): Promise<'ok' | 'down' | 'not_ready' | 'disabled'> {
    if (!this.config.search.enabled) return 'disabled';
    try {
      const health = await this.client.health();
      if (!health.ok) return 'down';
      return (await this.client.getAlias(this.collections.names.alias('services'), { timeoutMs: 1000 })) === null
        ? 'not_ready'
        : 'ok';
    } catch {
      return 'down';
    }
  }

  private async jobCounts(): Promise<{ queued: number; failed: number }> {
    try {
      const counts = await Promise.all(
        (['search-index', 'maintenance'] as const).map((name) =>
          this.queues.queue(name).getJobCounts('waiting', 'delayed', 'prioritized', 'failed'),
        ),
      );
      return {
        queued: counts.reduce((sum, c) => sum + (c.waiting ?? 0) + (c.delayed ?? 0) + (c.prioritized ?? 0), 0),
        failed: counts.reduce((sum, c) => sum + (c.failed ?? 0), 0),
      };
    } catch {
      return { queued: 0, failed: 0 };
    }
  }

  /** How many services the shop may sell and has a switched-on page for: counted for at most 20 000 services. */
  private async expectedDocuments(): Promise<number> {
    const db = this.db.db;
    const groupId = await this.searchable.retailGroupId(db);
    if (groupId === undefined) return 0;
    let after = 0;
    let count = 0;
    for (let page = 0; page < EXPECTED_PAGES; page += 1) {
      const ids = await this.services.pricedPage(db, groupId, after, EXPECTED_PAGE_SIZE);
      if (ids.length === 0) break;
      count += (await listedServiceIds(db, ids)).size;
      after = ids[ids.length - 1]!;
      if (ids.length < EXPECTED_PAGE_SIZE) break;
    }
    return count;
  }
}

/** The index status as the console reads it. */
export interface IndexStatusView {
  readonly engine: {
    status: 'ok' | 'down' | 'not_ready' | 'disabled';
    version: string | null;
    memoryBytes: number | null;
  };
  readonly schemaVersion: number;
  readonly collection: string | null;
  readonly documents: number;
  readonly expectedDocuments: number;
  readonly lastSyncAt: string | null;
  readonly lastReconcileAt: string | null;
  readonly lastRebuildAt: string | null;
  readonly lastTermsBuildAt: string | null;
  readonly queued: number;
  readonly failed: number;
  readonly rebuild: { running: boolean; startedAt: string | null };
  readonly lastError: string | null;
}
