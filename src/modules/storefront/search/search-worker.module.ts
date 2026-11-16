// Nest module of the storefront search's worker side (feature 29, plan section 4.5): the sync, the settings push, the reconcile, the
// rebuild, the terms build and flush, their processors and schedules, and the boot reconcile. Import it in the worker process only.
import { randomUUID } from 'node:crypto';
import { Inject, Logger, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { JobSchedulerRegistry, QueueWorkers, QueuesService, queueJobId } from '../../../infra/queues';
import { JobRunsModule } from '../../health';
import { SearchLocks } from './application/search-locks';
import { SearchRebuild } from './application/search-rebuild';
import { SearchReconcile } from './application/search-reconcile';
import { SearchSettingsPush } from './application/search-settings-push';
import { SEARCH_JOBS } from './application/search-signals';
import { SearchSync } from './application/search-sync';
import { SearchTermsBuild } from './application/search-terms-build';
import { SearchTermsFlush } from './application/search-terms-flush';
import { SearchSettingsProcessor, SearchSyncProcessor } from './jobs/search-index.processor';
import {
  SearchRebuildProcessor,
  SearchReconcileProcessor,
  SearchTermsBuildProcessor,
  SearchTermsFlushProcessor,
  SearchTermsPurgeProcessor,
} from './jobs/search-maintenance.processors';
import { SearchIndexModule } from './search-index.module';

/**
 * The ids of the search's schedulers.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the ids are constants that docs and tests share.
 */
export const SEARCH_SCHEDULERS = {
  reconcile: 'search-reconcile',
  rebuild: 'search-rebuild-nightly',
  termsBuild: 'search-terms-build',
  termsFlush: 'search-terms-flush',
  termsPurge: 'search-terms-purge',
} as const;

/**
 * Provides the search's jobs and registers their schedules.
 *
 * Why: decision 038: the API never does slow work inline; the worker keeps the index in step with Postgres (sync, reconcile every
 * `SEARCH_RECONCILE_MINUTES`, nightly rebuild at 03:40 UTC, terms hourly at :20, the counters every 15 minutes, the purge daily at
 * 04:10 UTC). At boot it also queues one reconcile (job id `boot-<boot id>`), which starts a rebuild when the alias of the running schema
 * version is missing (a new deploy or a wiped volume heals by itself). The schedules are created by the worker on every boot.
 *
 * Side effects: scheduler registrations; one `search_reconcile` job per worker boot (only where the queue workers run).
 */
@Module({
  imports: [SearchIndexModule, JobRunsModule],
  providers: [
    SearchLocks,
    SearchSync,
    SearchSettingsPush,
    SearchReconcile,
    SearchRebuild,
    SearchTermsBuild,
    SearchTermsFlush,
    SearchSyncProcessor,
    SearchSettingsProcessor,
    SearchReconcileProcessor,
    SearchRebuildProcessor,
    SearchTermsBuildProcessor,
    SearchTermsFlushProcessor,
    SearchTermsPurgeProcessor,
  ],
  exports: [SearchSync, SearchSettingsPush, SearchReconcile, SearchRebuild, SearchTermsBuild, SearchTermsFlush],
})
export class SearchWorkerModule implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(SearchWorkerModule.name);

  constructor(
    private readonly schedulers: JobSchedulerRegistry,
    private readonly queues: QueuesService,
    private readonly moduleRef: ModuleRef,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Registers the schedules; the worker creates them in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: SEARCH_SCHEDULERS.reconcile,
      queue: 'maintenance',
      jobName: SEARCH_JOBS.reconcile,
      every: this.config.search.reconcileMinutes * 60_000,
      description:
        'Compares the search index with Postgres by document hash and queues search_sync jobs for the differences.',
    });
    this.schedulers.register({
      id: SEARCH_SCHEDULERS.rebuild,
      queue: 'maintenance',
      jobName: SEARCH_JOBS.rebuild,
      pattern: '40 3 * * *',
      description: 'Rebuilds the search index into a new collection and swaps the alias (nightly, 03:40 UTC).',
    });
    this.schedulers.register({
      id: SEARCH_SCHEDULERS.termsBuild,
      queue: 'maintenance',
      jobName: SEARCH_JOBS.termsBuild,
      pattern: '20 * * * *',
      description: 'Rebuilds the search completions (terms collection) from the catalog, synonyms and popular queries.',
    });
    this.schedulers.register({
      id: SEARCH_SCHEDULERS.termsFlush,
      queue: 'maintenance',
      jobName: SEARCH_JOBS.termsFlush,
      pattern: '*/15 * * * *',
      description: 'Copies the day search counters from Redis into search_terms_daily (absolute values).',
    });
    this.schedulers.register({
      id: SEARCH_SCHEDULERS.termsPurge,
      queue: 'maintenance',
      jobName: SEARCH_JOBS.termsPurge,
      pattern: '10 4 * * *',
      description: 'Deletes search_terms_daily rows older than 180 days.',
    });
  }

  /** Queues the boot reconcile in the worker process (where the queue workers run); never fails the boot. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.search.enabled || !this.hasQueueWorkers()) return;
    try {
      await this.queues.add(
        'maintenance',
        SEARCH_JOBS.reconcile,
        { reason: 'boot' },
        {
          jobId: queueJobId('boot', randomUUID()),
        },
      );
    } catch (error) {
      this.logger.warn(
        `The boot reconcile of the search index was not queued: ${error instanceof Error ? error.message : 'error'}`,
      );
    }
  }

  private hasQueueWorkers(): boolean {
    try {
      this.moduleRef.get(QueueWorkers, { strict: false });
      return true;
    } catch {
      return false;
    }
  }
}
